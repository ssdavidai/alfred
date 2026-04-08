"""Shared helpers for chore template workflows.

Templates call these as Temporal activities so they can do I/O (vault reads,
vault appends). The workflow itself stays deterministic; the activities do
the side effects.

Important: chore params are stored as a JSON-encoded string scalar in the
chore vault record (e.g. `params: '{"matter_domains": [...], ...}'`) because
the ctrl-api vault.ts frontmatter parser is intentionally flat-only and
flattens any nested YAML mapping to an empty list. Parsing the JSON happens
here in load_chore_context so individual templates always see a real dict.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient


def _coerce_params(raw: Any) -> dict[str, Any]:
    """Normalize whatever the vault parser returned for `params` into a dict.

    The vault.ts frontmatter parser can return:
      - dict: ideal (e.g. if the parser is upgraded one day, or pass-through)
      - str:  current canonical case — JSON-encoded params, parse it
      - list: a nested YAML mapping was flattened by the parser — treat as missing
      - anything else (None, etc.): return {}
    """
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return {}
        try:
            decoded = json.loads(s)
            return decoded if isinstance(decoded, dict) else {}
        except (json.JSONDecodeError, ValueError):
            return {}
    return {}


def _coerce_int(value: Any, default: int = 0) -> int:
    """Parse a YAML frontmatter value as an int, falling back to `default`.

    The vault.ts parser can return ints as strings ("3") or actual ints —
    we normalize to int. Negative values are clamped to 0 (quarantine
    counter should never go negative).
    """
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(0, n)


def _coerce_bool(value: Any, default: bool = False) -> bool:
    """Parse a YAML frontmatter value as a bool.

    The vault.ts parser typically returns "true"/"false" strings for
    bool frontmatter fields. Normalize to real bools.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "1"}
    return default


@activity.defn
async def load_chore_context(chore_slug: str) -> dict[str, Any]:
    """Read the chore vault record and return its frontmatter as a dict.

    Returns a flat dict with the keys the templates need:
        chore_slug: the slug we were asked to load
        template:   template id (e.g. "subscription_watcher")
        params:     dict of template-specific params
        last_run:   ISO timestamp of last run, or None
        status:     "active" | "paused" | "completed"
        generated:  bool — True if this chore is from the S4 generation pipeline
        quarantine: bool — True while the chore is in its quarantine period
        quarantine_remaining: int — number of dry-runs left before going live
        workflow_class_name: str — explicit class name (generated templates only)

    If the chore record cannot be found, returns status="completed" so
    callers fail-safe (silently exit) instead of crashing.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        try:
            record = await client.read_record(f"chore/{chore_slug}.md")
        except Exception:
            return {
                "chore_slug": chore_slug,
                "template": "",
                "params": {},
                "last_run": None,
                "status": "completed",
                "generated": False,
                "quarantine": False,
                "quarantine_remaining": 0,
                "workflow_class_name": "",
            }
        fm = record.get("frontmatter", {}) or {}
        return {
            "chore_slug": chore_slug,
            "template": fm.get("template", ""),
            "params": _coerce_params(fm.get("params")),
            "last_run": fm.get("last_run"),
            "status": fm.get("status", "active"),
            "generated": _coerce_bool(fm.get("generated"), default=False),
            "quarantine": _coerce_bool(fm.get("quarantine"), default=False),
            "quarantine_remaining": _coerce_int(fm.get("quarantine_remaining"), default=0),
            "workflow_class_name": str(fm.get("workflow_class_name") or ""),
        }
    finally:
        await client.close()


def is_quarantined(ctx: dict[str, Any]) -> bool:
    """Return True if the chore is still in its quarantine period.

    A chore is quarantined when `quarantine` is true AND
    `quarantine_remaining > 0`. While quarantined, chore workflows SHOULD
    take a minimal-side-effects path (no notifications, no vault writes)
    and return early after calling record_chore_run with a dry-run note.

    This helper is the single source of truth so templates and generated
    code never have to duplicate the check.
    """
    if not isinstance(ctx, dict):
        return False
    if not _coerce_bool(ctx.get("quarantine"), default=False):
        return False
    remaining = _coerce_int(ctx.get("quarantine_remaining"), default=0)
    return remaining > 0


@activity.defn
async def record_chore_run(
    chore_slug: str,
    result_summary: str,
    dry_run: bool = False,
) -> None:
    """Append a one-line run-log entry to the chore record body.

    Best-effort: if the append fails (vault offline, record gone, etc.) we
    swallow the error so the chore workflow as a whole still reports success.
    Updating frontmatter fields like last_run/last_result requires a separate
    endpoint we don't have yet — for now the body log is the audit trail.

    When `dry_run=True` the log line is prefixed with [dry-run] so the
    quarantine-log viewer (S4-10 ctrl-api route) can easily filter for
    quarantine-period runs. Counter decrement is handled separately
    by `decrement_quarantine_remaining` so this activity stays simple.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        ts = datetime.now(timezone.utc).isoformat()
        prefix = "[dry-run] " if dry_run else ""
        try:
            await client.update_record(
                f"chore/{chore_slug}.md",
                f"\n- {ts}: {prefix}{result_summary}",
            )
        except Exception:
            # Best-effort logging — never fail a chore run because of this.
            pass
    finally:
        await client.close()


@activity.defn
async def decrement_quarantine_remaining(chore_slug: str) -> dict[str, Any]:
    """Read the chore record, decrement quarantine_remaining, rewrite it.

    Called after a successful dry-run in quarantine mode. When the
    counter hits 0, also flips `quarantine: false` so the next run
    goes live for real.

    Returns:
        {
            "ok": bool,
            "previous": int,
            "remaining": int,
            "released": bool,  # True if quarantine ended on this call
            "error": str,      # on failure
        }

    Not a critical-path activity — if this fails the chore re-runs in
    dry-run mode on the next schedule tick and we try again. The only
    downside is the chore takes longer to go live than 3 attempts.

    Implementation note: updating frontmatter in-place would require a
    new ctrl-api endpoint. For now we do a full read → rewrite cycle
    via the write_record endpoint, keeping only the frontmatter we
    know about. Body content is preserved as-is.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        try:
            record = await client.read_record(f"chore/{chore_slug}.md")
        except Exception as exc:
            return {
                "ok": False,
                "previous": 0,
                "remaining": 0,
                "released": False,
                "error": f"read failed: {exc}",
            }

        fm = record.get("frontmatter", {}) or {}
        previous = _coerce_int(fm.get("quarantine_remaining"), default=0)
        if previous <= 0:
            return {
                "ok": True,
                "previous": previous,
                "remaining": 0,
                "released": False,
            }

        remaining = previous - 1
        released = remaining == 0

        # Build the new frontmatter. Preserve every field the existing
        # record has; just update the quarantine fields (and flip the
        # `quarantine` flag when we've released).
        new_fm = dict(fm)
        new_fm["quarantine_remaining"] = remaining
        if released:
            new_fm["quarantine"] = False

        body = record.get("body", "") or ""

        # Rewrite using the vault client's write_record (it upserts by
        # path). The body stays intact; only frontmatter fields change.
        # Note: write_record expects a raw markdown string, so we need
        # to serialize the frontmatter ourselves.
        try:
            new_content = _rebuild_markdown(new_fm, body)
            await client.write_record("chore", chore_slug, new_content)
        except Exception as exc:
            return {
                "ok": False,
                "previous": previous,
                "remaining": previous,  # not actually changed
                "released": False,
                "error": f"write failed: {exc}",
            }

        return {
            "ok": True,
            "previous": previous,
            "remaining": remaining,
            "released": released,
        }
    finally:
        await client.close()


def _rebuild_markdown(frontmatter: dict[str, Any], body: str) -> str:
    """Serialize {frontmatter, body} back into markdown with YAML frontmatter.

    Uses the same flat YAML conventions as assign_chores._build_chore_content:
    strings quoted, lists rendered as `[a, b, c]`, bools as lowercase.
    Never introduces nested mappings (the vault parser can't handle them).
    """
    lines = ["---"]
    for key, value in frontmatter.items():
        lines.append(f"{key}: {_format_frontmatter_value(value)}")
    lines.append("---")
    lines.append("")
    lines.append(body.lstrip("\n"))
    return "\n".join(lines)


def _format_frontmatter_value(value: Any) -> str:
    """Render a frontmatter value as a flat YAML scalar/list.

    - bool → lowercase true/false
    - int/float → decimal
    - None → null
    - list → `[a, b, c]` (each elt wrapped same way)
    - str → single-quoted if it looks structural (contains {, [, :, etc.)
            otherwise bare. Embedded single quotes are escaped.
    - dict → NEVER emit nested dicts; fall back to JSON-string scalar.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return "[" + ", ".join(_format_frontmatter_value(v) for v in value) + "]"
    if isinstance(value, dict):
        # Serialize nested dict as a JSON-encoded string scalar so the
        # flat parser on the read side can round-trip via _coerce_params
        return "'" + json.dumps(value, default=str).replace("'", "''") + "'"
    s = str(value)
    # Quote strings that look structural / multiline / start with special chars
    if any(c in s for c in "{}[]:,#&*!|>'\"%@`") or s.strip() != s or not s:
        return "'" + s.replace("'", "''") + "'"
    return s
