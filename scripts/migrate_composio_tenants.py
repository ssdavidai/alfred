#!/usr/bin/env python3
"""Migrate existing Composio connected_accounts from the shared "default"
namespace to per-tenant user_ids.

Background (see GH #408): every tenant shared a single Composio namespace
because COMPOSIO_USER_ID defaulted to "default" (or was unset). As a result,
if David connected Notion, Miguel and Rapali saw it as ACTIVE on their
Apps page and could silently execute against David's account.

After the fix, every tenant gets a unique COMPOSIO_USER_ID
(``alfred-<slug>-<id>``). This script attempts to reassign existing
connected_accounts from "default" to the correct per-tenant user_id via
Composio's PATCH endpoint.

USAGE
-----
1. Dry-run for a single tenant (recommended first):

    python3 scripts/migrate_composio_tenants.py \
        --tenant alfred-david-99 \
        --legacy default \
        --dry-run

2. Apply the migration for a specific tenant (multiple legacy IDs):

    python3 scripts/migrate_composio_tenants.py \
        --tenant alfred-david-99 \
        --legacy default \
        --legacy david@szabostuban.com \
        --api-key "$COMPOSIO_API_KEY"

3. Apply across the whole fleet from a config file:

    python3 scripts/migrate_composio_tenants.py --config tenants.json

Expected config file shape (tenants.json)::

    {
      "api_key": "ak_...",                 // platform-shared Composio API key
      "tenants": [
        {"user_id": "alfred-david-99",  "legacy_emails": ["david@szabostuban.com"]},
        {"user_id": "alfred-miguel-103", "legacy_emails": ["miguel@upstring.com"]},
        {"user_id": "alfred-rapali-101", "legacy_emails": []}
      ]
    }

The script enumerates every connected_account under "default" (and any
legacy emails listed per tenant), and for each one attempts::

    PATCH /api/v3/connected_accounts/{id}  { "user_id": "<tenant-uid>" }

If Composio's API rejects the PATCH (e.g. field is immutable), the script
logs the account id + toolkit and recommends reconnect-from-scratch via
the tenant's dashboard.

This script is IDEMPOTENT — re-running it is safe. Already-migrated
accounts are skipped.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any
import urllib.error
import urllib.parse
import urllib.request

COMPOSIO_API_V3 = "https://backend.composio.dev/api/v3"


def _request(method: str, url: str, api_key: str, body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("x-api-key", api_key)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode() or "{}")
        except Exception:
            payload = {"error": str(e)}
        return e.code, payload
    except urllib.error.URLError as e:
        return 0, {"error": str(e)}


def list_accounts_for(api_key: str, user_id: str) -> list[dict[str, Any]]:
    """List connected_accounts whose Composio user_id matches ``user_id``."""
    # URL-encode — legacy IDs may be emails (contain '@', '+', '.') or other
    # characters that would otherwise break the query string.
    query = urllib.parse.urlencode({"user_id": user_id})
    url = f"{COMPOSIO_API_V3}/connected_accounts?{query}"
    status, data = _request("GET", url, api_key)
    if status != 200:
        print(f"  ! list(user_id={user_id}) failed: {status} {data}", file=sys.stderr)
        return []
    items = data.get("items") or []
    # Defense-in-depth client-side filter — some API versions ignore the filter.
    return [a for a in items if (a.get("user_id") or a.get("member_id")) == user_id]


def patch_user_id(api_key: str, account_id: str, new_user_id: str) -> tuple[bool, str]:
    """Attempt to reassign a connected_account to a new user_id.

    Returns (success, human-readable-note).
    """
    url = f"{COMPOSIO_API_V3}/connected_accounts/{account_id}"
    status, data = _request("PATCH", url, api_key, {"user_id": new_user_id})
    if 200 <= status < 300:
        return True, f"patched → {new_user_id}"
    return False, f"PATCH {status}: {json.dumps(data)[:200]}"


def migrate_tenant(
    api_key: str,
    tenant_user_id: str,
    legacy_ids: list[str],
    dry_run: bool,
) -> dict[str, Any]:
    """Migrate one tenant's accounts from each legacy id to the new user_id."""
    result: dict[str, Any] = {
        "tenant": tenant_user_id,
        "migrated": [],
        "skipped": [],
        "failed": [],
    }
    for legacy in legacy_ids:
        if legacy == tenant_user_id:
            result["skipped"].append({
                "legacy": legacy,
                "reason": "legacy_equals_target",
            })
            continue
        print(f"[{tenant_user_id}] scanning legacy={legacy!r}")
        accounts = list_accounts_for(api_key, legacy)
        for acct in accounts:
            acct_id = acct.get("id", "")
            toolkit = (acct.get("toolkit") or {}).get("slug") or acct.get("appName") or "?"
            status = acct.get("status", "?")
            label = f"{toolkit}:{acct_id}"
            acct_owner = acct.get("user_id") or acct.get("member_id") or ""
            # Already migrated to the target — nothing to do.
            if acct_owner == tenant_user_id:
                print(f"  = {label} already on {tenant_user_id}, skipping")
                result["skipped"].append({
                    "id": acct_id,
                    "toolkit": toolkit,
                    "reason": "already_on_target",
                })
                continue
            # Inactive/expired accounts on the legacy namespace: reassigning
            # is pointless — the tenant will need to reconnect anyway.
            if acct_owner == legacy and status != "ACTIVE":
                print(f"  = {label} inactive on legacy ({status}), skipping")
                result["skipped"].append({
                    "id": acct_id,
                    "toolkit": toolkit,
                    "reason": f"inactive_on_legacy:{status}",
                })
                continue
            if dry_run:
                print(f"  [dry-run] would PATCH {label} ({status}) → {tenant_user_id}")
                result["migrated"].append({"id": acct_id, "toolkit": toolkit, "note": "dry-run"})
                continue
            ok, note = patch_user_id(api_key, acct_id, tenant_user_id)
            if ok:
                print(f"  ✓ {label} → {tenant_user_id}")
                result["migrated"].append({"id": acct_id, "toolkit": toolkit, "note": note})
            else:
                print(f"  ✗ {label}: {note}")
                result["failed"].append({"id": acct_id, "toolkit": toolkit, "note": note})
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate Composio connected_accounts per-tenant (GH #408).")
    parser.add_argument("--api-key", help="Composio platform API key (overrides config + env)")
    parser.add_argument("--tenant", help="Target user_id, e.g. alfred-david-99")
    parser.add_argument(
        "--legacy",
        action="append",
        default=[],
        help="Legacy user_id to scan for accounts to reassign (repeatable). Defaults to 'default'.",
    )
    parser.add_argument("--config", help="Path to tenants JSON config")
    parser.add_argument("--dry-run", action="store_true", help="Do not PATCH, just report")
    args = parser.parse_args()

    cfg: dict[str, Any] = {}
    if args.config:
        with open(args.config) as f:
            cfg = json.load(f)

    import os
    api_key = args.api_key or cfg.get("api_key") or os.environ.get("COMPOSIO_API_KEY", "")
    if not api_key:
        print("ERROR: Composio API key required (--api-key, config.api_key, or COMPOSIO_API_KEY)", file=sys.stderr)
        return 2

    results: list[dict[str, Any]] = []

    if args.tenant:
        legacies = args.legacy or ["default"]
        results.append(migrate_tenant(api_key, args.tenant, legacies, args.dry_run))
    elif cfg.get("tenants"):
        for t in cfg["tenants"]:
            uid = t.get("user_id")
            if not uid:
                continue
            legacies = t.get("legacy_ids") or t.get("legacy_emails") or ["default"]
            # Always include "default" — it's where every pre-#408 account lives.
            if "default" not in legacies:
                legacies = [*legacies, "default"]
            results.append(migrate_tenant(api_key, uid, legacies, args.dry_run))
    else:
        print("ERROR: provide --tenant or --config", file=sys.stderr)
        return 2

    print()
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    for r in results:
        print(
            f"  {r['tenant']}: migrated={len(r['migrated'])}  "
            f"failed={len(r['failed'])}  skipped={len(r['skipped'])}"
        )
        for f in r["failed"]:
            print(f"    ! {f['toolkit']} {f['id']}: {f['note']}")
            print(f"      → ask the tenant to reconnect this app from the Apps page.")

    if args.dry_run:
        print("\n(dry-run — nothing was changed)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
