"""Audit a tenant's chore vault records for cron / description disagreement.

Read-only. For every vault record under ``/vault/chore/`` (or whatever the
tenant's vault path resolves to), parse the YAML frontmatter and run the
semantic-alignment validator from ``src.activities.chore_generation``.
Reports any cron expression that contradicts the ``user_facing_description``
field — the bug fixed in #478.

The script is intentionally non-destructive. Fixing a misalignment requires
either re-running Opus on the underlying chore opportunity (preferred) or a
human decision about which to trust. We just surface the disagreements so
the operator can pick.

USAGE
-----

Inside the ``alfred-learn`` container::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.audit_chore_description_cron_alignment

From a tenant VPS shell::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.audit_chore_description_cron_alignment \\
            --vault-path /vault \\
            --tenant david

Flags::

    --vault-path PATH      Override the vault path (default: $VAULT_PATH or
                           "/vault").
    --tenant NAME          Label used in the report header. Optional.
    --tenant-timezone TZ   IANA timezone (e.g. "Europe/Budapest"). Defaults
                           to $TENANT_TIMEZONE then "UTC".
    --json                 Emit machine-readable JSON instead of the
                           human-readable indented report.

EXIT CODES
----------

  0  No mismatches found.
  1  At least one chore mismatch detected.
  2  Vault path missing or unreadable.

The non-zero exit on mismatch makes it cheap to wire this into a fleet
audit cron later.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

# Make src.* importable when run as `python scripts/audit...py` from the
# package root (the more common dev path), in addition to the documented
# `python -m scripts.audit...` invocation that already has /app on sys.path
# inside the container.
_HERE = Path(__file__).resolve().parent
_PKG_ROOT = _HERE.parent
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))

from src.activities.chore_generation import (  # noqa: E402
    _validate_cron_matches_description,
)


_DEFAULT_VAULT_PATH = os.environ.get("VAULT_PATH", "/vault")


def _parse_frontmatter(text: str) -> dict[str, Any]:
    """Parse a YAML frontmatter block out of a markdown record.

    We use pyyaml when available (it is in alfred-learn's requirements.txt).
    Falls back to a tiny regex-based parser that handles the two fields we
    actually care about (``schedule`` and ``user_facing_description``) so
    the audit script remains usable in environments without pyyaml.
    """
    if not text.startswith("---"):
        return {}
    closing = text.find("\n---", 3)
    if closing == -1:
        return {}
    body = text[3:closing].lstrip("\n")

    try:
        import yaml  # type: ignore
        try:
            data = yaml.safe_load(body)
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    except ImportError:
        pass

    # Fallback: scrape just the keys we need from the body
    out: dict[str, Any] = {}
    import re as _re
    for key in ("schedule", "user_facing_description", "type", "slug",
                "module_name", "title", "name", "status"):
        m = _re.search(
            rf"^{_re.escape(key)}:\s*(?:\"([^\"]*)\"|'([^']*)'|([^\n]*))\s*$",
            body,
            _re.MULTILINE,
        )
        if m:
            out[key] = m.group(1) or m.group(2) or (m.group(3) or "").strip()
    return out


def _scan_chore_dir(chore_dir: Path) -> list[dict[str, Any]]:
    """Return one dict per .md record under chore_dir (best-effort)."""
    records: list[dict[str, Any]] = []
    if not chore_dir.exists():
        return records
    for path in sorted(chore_dir.rglob("*.md")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            records.append({"path": str(path), "error": f"read: {exc}"})
            continue
        fm = _parse_frontmatter(text)
        if not fm:
            continue
        # We only care about chore-typed records. The vault uses ``type: chore``
        # for both standard-template and generated chores.
        if fm.get("type") not in ("chore", None):
            continue
        records.append({
            "path": str(path),
            "slug": fm.get("slug") or path.stem,
            "module_name": fm.get("module_name", ""),
            "schedule": fm.get("schedule", ""),
            "user_facing_description": fm.get("user_facing_description", ""),
            "title": fm.get("title") or fm.get("name", ""),
            "status": fm.get("status", ""),
        })
    return records


def _audit(records: list[dict[str, Any]], tenant_timezone: str) -> list[dict[str, Any]]:
    """Run _validate_cron_matches_description over every record. Return mismatches."""
    mismatches: list[dict[str, Any]] = []
    for rec in records:
        if "error" in rec:
            mismatches.append({**rec, "kind": "read_error"})
            continue
        cron = (rec.get("schedule") or "").strip()
        desc = (rec.get("user_facing_description") or "").strip()
        if not cron or not desc:
            # Nothing to compare — skip silently. Standard-template chores
            # often don't carry a user_facing_description.
            continue
        ok, err = _validate_cron_matches_description(cron, desc, tenant_timezone)
        if not ok:
            mismatches.append({
                **rec,
                "kind": "mismatch",
                "error": err,
            })
    return mismatches


def _format_text_report(
    tenant_label: str,
    chore_dir: Path,
    tenant_timezone: str,
    records: list[dict[str, Any]],
    mismatches: list[dict[str, Any]],
) -> str:
    lines: list[str] = []
    lines.append(f"TENANT: {tenant_label}")
    lines.append(f"  vault chore dir: {chore_dir}")
    lines.append(f"  tenant timezone: {tenant_timezone}")
    lines.append(f"  scanned: {len(records)} chore record(s)")
    lines.append(f"  mismatches: {len(mismatches)}")
    if not mismatches:
        lines.append("  (no description / cron disagreements found)")
        return "\n".join(lines) + "\n"
    for m in mismatches:
        if m.get("kind") == "read_error":
            lines.append(f"  {m['path']}  READ-ERROR  {m['error']}")
            continue
        slug = m.get("slug") or Path(m["path"]).stem
        cron = m.get("schedule") or ""
        desc = (m.get("user_facing_description") or "").replace("\n", " ").strip()
        if len(desc) > 140:
            desc = desc[:137] + "..."
        lines.append(
            f"  {slug}  MISMATCH  \"{desc}\"  vs cron `{cron}`  -- {m['error']}"
        )
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--vault-path",
        default=_DEFAULT_VAULT_PATH,
        help="Vault root path (default: $VAULT_PATH or /vault).",
    )
    parser.add_argument(
        "--tenant",
        default=os.environ.get("TENANT_ID", "?"),
        help="Tenant label for the report header (default: $TENANT_ID or '?').",
    )
    parser.add_argument(
        "--tenant-timezone",
        default=os.environ.get("TENANT_TIMEZONE", "UTC"),
        help="IANA timezone (default: $TENANT_TIMEZONE or UTC).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON instead of human-readable text.",
    )
    args = parser.parse_args(argv)

    vault_path = Path(args.vault_path)
    if not vault_path.exists():
        sys.stderr.write(f"vault path missing: {vault_path}\n")
        return 2
    chore_dir = vault_path / "chore"
    if not chore_dir.exists():
        chore_dir_candidates = [chore_dir, vault_path / "chores"]
        for candidate in chore_dir_candidates:
            if candidate.exists():
                chore_dir = candidate
                break
        else:
            sys.stderr.write(
                f"no chore directory found under {vault_path} "
                f"(tried 'chore' and 'chores')\n"
            )
            return 2

    records = _scan_chore_dir(chore_dir)
    mismatches = _audit(records, args.tenant_timezone)

    if args.json:
        sys.stdout.write(json.dumps({
            "tenant": args.tenant,
            "vault_path": str(vault_path),
            "chore_dir": str(chore_dir),
            "tenant_timezone": args.tenant_timezone,
            "records_scanned": len(records),
            "mismatch_count": len(mismatches),
            "mismatches": mismatches,
        }, indent=2, default=str) + "\n")
    else:
        sys.stdout.write(_format_text_report(
            args.tenant, chore_dir, args.tenant_timezone, records, mismatches,
        ))

    return 1 if mismatches else 0


if __name__ == "__main__":
    raise SystemExit(main())
