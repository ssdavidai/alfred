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
from pathlib import Path
from typing import Any

from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient


# S5-1: persistent chore run history used by the promotion reflection
# workflow (S5-2) to identify promotion candidates. One JSONL line per
# chore tick, lives on the encrypted volume so it survives restarts.
# Rotation is handled by nightly_maintenance (see S5-1 follow-up note).
_CHORE_RUN_HISTORY_PATH = Path("/alfred-data/chore-run-history.jsonl")


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


def _append_run_history(entry: dict[str, Any]) -> None:
    """Best-effort append to the chore run history JSONL file (S5-1).

    Used by record_chore_run to persist structured run metrics that the
    promotion reflection workflow (S5-2) reads for analytics. Failures
    are swallowed so a disk-full condition never blocks a chore run —
    the body log on the vault record remains the primary audit trail,
    this file is the machine-readable secondary source.

    Schema (one object per line):
        {
            "timestamp": float,        # epoch seconds
            "chore_slug": str,
            "result_summary": str,
            "was_dry_run": bool,
            "exception": bool,         # True if the run raised — set by caller
        }
    """
    try:
        _CHORE_RUN_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _CHORE_RUN_HISTORY_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, default=str) + "\n")
    except OSError:
        pass


@activity.defn
async def record_chore_run(
    chore_slug: str,
    result_summary: str,
    dry_run: bool = False,
) -> None:
    """Append a one-line run-log entry to the chore record body AND the
    machine-readable run history file.

    Two destinations:
      1. Vault chore record body (`chore/<slug>.md`) — human-readable,
         used by the dashboard + manual debugging
      2. `/alfred-data/chore-run-history.jsonl` — machine-readable, one
         JSONL line per run, used by the promotion reflection workflow
         (S5-2) to filter chores worth promoting to the standard library

    Both writes are best-effort: if the vault append fails (offline,
    record gone, etc.) we swallow the error so the chore as a whole
    still reports success. Same for the JSONL append on disk-full.

    When `dry_run=True`:
      - The vault log line is prefixed with `[dry-run]`
      - The history entry sets `was_dry_run: true` so the S5-2
        analytics path can exclude dry-runs from the "useful for
        promotion" calculation
    """
    import time

    ts_iso = datetime.now(timezone.utc).isoformat()
    ts_epoch = time.time()

    # 1. Vault body log (human) + frontmatter `last_run` / `last_result`.
    # Body append is the audit trail; the frontmatter fields are what the
    # dashboard + API list endpoints display, so they have to stay in
    # sync with reality. Both writes are best-effort — never fail a chore
    # run because the vault is briefly unreachable.
    config = load_config()
    client = VaultClient(config)
    try:
        prefix = "[dry-run] " if dry_run else ""
        try:
            await client.update_record(
                f"chore/{chore_slug}.md",
                f"\n- {ts_iso}: {prefix}{result_summary}",
            )
        except Exception:
            pass
        try:
            # Cap last_result at 200 chars so we don't accidentally splat
            # a multi-paragraph LLM digest into the frontmatter.
            short_result = (prefix + result_summary)[:200]
            await client.patch_frontmatter(
                f"chore/{chore_slug}.md",
                {"last_run": ts_iso, "last_result": short_result},
            )
        except Exception:
            pass
    finally:
        await client.close()

    # 2. JSONL run history (machine)
    _append_run_history({
        "timestamp": ts_epoch,
        "chore_slug": chore_slug,
        "result_summary": result_summary,
        "was_dry_run": bool(dry_run),
    })


@activity.defn
async def get_chore_run_statistics(
    chore_slug: str,
    since: str = "",
) -> dict[str, Any]:
    """Read the chore run history and return aggregate statistics.

    Used by the S5-2 promotion reflection workflow to decide whether a
    generated chore has enough proof-of-usefulness to be promoted to
    the standard library via a GitHub PR (S5-3).

    Args:
        chore_slug: filter to runs for this chore. Pass "" to aggregate
            across all chores (not typically useful but exposed for
            future analytics).
        since: ISO 8601 timestamp — only count runs newer than this.
            Empty string means no filter (all history).

    Returns:
        {
            "chore_slug": str,
            "total_runs": int,       # all runs including dry-runs
            "live_runs": int,        # runs where was_dry_run was False
            "dry_runs": int,         # was_dry_run == True
            "first_run": float|None, # epoch of earliest matching entry
            "last_run": float|None,  # epoch of latest matching entry
            "recent_runs": [         # last 10 result summaries
                {"timestamp": float, "result_summary": str, "was_dry_run": bool}
            ],
        }

    Returns zero counts if the history file doesn't exist or has no
    matching entries. Never raises on I/O — a corrupt line is skipped.
    """
    import time as _time

    since_epoch: float | None = None
    if since:
        try:
            since_epoch = datetime.fromisoformat(
                since.replace("Z", "+00:00")
            ).timestamp()
        except (ValueError, TypeError):
            since_epoch = None

    stats: dict[str, Any] = {
        "chore_slug": chore_slug,
        "total_runs": 0,
        "live_runs": 0,
        "dry_runs": 0,
        "first_run": None,
        "last_run": None,
        "recent_runs": [],
    }

    if not _CHORE_RUN_HISTORY_PATH.exists():
        return stats

    matching: list[dict[str, Any]] = []
    try:
        with _CHORE_RUN_HISTORY_PATH.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if not isinstance(entry, dict):
                    continue
                if chore_slug and entry.get("chore_slug") != chore_slug:
                    continue
                entry_ts = entry.get("timestamp")
                if not isinstance(entry_ts, (int, float)):
                    continue
                if since_epoch is not None and entry_ts < since_epoch:
                    continue
                matching.append(entry)
    except OSError:
        return stats

    if not matching:
        return stats

    matching.sort(key=lambda e: e.get("timestamp", 0))
    stats["total_runs"] = len(matching)
    stats["live_runs"] = sum(1 for e in matching if not e.get("was_dry_run"))
    stats["dry_runs"] = sum(1 for e in matching if e.get("was_dry_run"))
    stats["first_run"] = matching[0].get("timestamp")
    stats["last_run"] = matching[-1].get("timestamp")
    stats["recent_runs"] = [
        {
            "timestamp": e.get("timestamp"),
            "result_summary": str(e.get("result_summary", "")),
            "was_dry_run": bool(e.get("was_dry_run", False)),
        }
        for e in matching[-10:]
    ]

    return stats


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
