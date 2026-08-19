"""ctrl-api write client for the vault daemons (#327).

Sir's 2026-07-20 decision: daemons lose independent write access to
canonical vault records — every repair / link-write goes through
ctrl-api so it gets the promotion contract, state-field enforcement,
vault_index maintenance and steward-signal emission. The `alfred vault`
CLI remains ctrl-api's docker-exec BACKEND, which is why routing is
decided in vault/ops.py with a loop-breaker:

  * daemons (no ALFRED_CTRL_BACKEND in env, ALFRED_CTRL_URL set)
      → ops delegates here → HTTP → ctrl → docker-exec → CLI → file
  * ctrl's own exec (ALFRED_CTRL_BACKEND=1, set in VAULT_ENV)
      → ops writes directly, exactly as before

Sync httpx on purpose — every current caller is synchronous.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
import structlog

log = structlog.get_logger("alfred.ctrl_client")

_TIMEOUT = httpx.Timeout(60.0, connect=10.0)


def via_ctrl_enabled() -> bool:
    """True when writes must route through ctrl-api (#327)."""
    if os.environ.get("ALFRED_CTRL_BACKEND") == "1":
        return False  # we ARE ctrl's backend — write directly, no loop
    if os.environ.get("ALFRED_VAULT_DIRECT_WRITES") == "1":
        return False  # explicit operator escape hatch
    return bool(os.environ.get("ALFRED_CTRL_URL"))


def _client() -> httpx.Client:
    base = os.environ["ALFRED_CTRL_URL"].rstrip("/")
    headers = {}
    key = os.environ.get("AAS_API_KEY", "")
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return httpx.Client(base_url=base, headers=headers, timeout=_TIMEOUT)


def ctrl_edit(
    rel_path: str,
    *,
    set_fields: dict[str, Any] | None = None,
    body_append: str | None = None,
) -> dict:
    """PATCH a vault record through ctrl-api (§15.1 wrapped body shape).

    `set` and `json_set` are NOT interchangeable, and picking the wrong one
    fails loudly at the far end:

        set:      scalars only. ctrl stringifies each value for the vault
                  CLI's --set flag.
        json_set: lists, dicts, bools, numbers. Merged into frontmatter as
                  native YAML, shape preserved.

    Sending a list through `set` produced the JavaScript coercion `[object
    Object]` in the CLI argument, and the vault daemon rejected it with
    "Field 'relationships' must be a list, got str" — HTTP 500. On the dev
    tenant that was ~150 failed writes per 20 minutes, every one of them a
    surveyor entity-link update, which is exactly the payload most likely to
    be a list.

    So the split is made here rather than left to the caller: every value is
    routed by its own type.
    """
    payload: dict[str, Any] = {}
    if set_fields:
        scalars = {
            k: v for k, v in set_fields.items()
            if v is None or isinstance(v, (str, int, float, bool))
        }
        structured = {k: v for k, v in set_fields.items() if k not in scalars}
        if scalars:
            payload["set"] = scalars
        if structured:
            payload["json_set"] = structured
    if body_append:
        payload["body_append"] = body_append
    if not payload:
        return {"path": rel_path, "fields_changed": []}
    with _client() as c:
        resp = c.patch(f"/api/v1/vault/records/{rel_path}", json=payload)
        resp.raise_for_status()
        out = resp.json()
    return {
        "path": out.get("path", rel_path),
        "fields_changed": sorted((set_fields or {}).keys())
        + (["body"] if body_append else []),
    }


def ctrl_create(record_type: str, name: str, content: str) -> dict:
    """POST a new vault record through ctrl-api."""
    with _client() as c:
        resp = c.post(
            "/api/v1/vault/records",
            json={"type": record_type, "name": name, "content": content},
        )
        resp.raise_for_status()
        out = resp.json()
    return {"path": out.get("path", f"{record_type}/{name}.md")}


def ctrl_reconcile_index() -> None:
    """Best-effort post-sweep vault_index reconcile (#327 interim hardening)."""
    try:
        with _client() as c:
            c.post("/api/v1/vault-index/reconcile")
    except Exception as exc:  # noqa: BLE001
        log.warning("ctrl_client.reconcile_failed", err=str(exc)[:120])
