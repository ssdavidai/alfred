"""Defer resurface — parse the principal's "when" note into a real
datetime, then resurface needs_attention cards when their resurface_at
falls due.

When the principal clicks Defer on the Desk and types something like
"not relevant until July" or "after Madrid trip" or "next Tuesday", the
intent shouldn't just be audited and forgotten — Alfred should put the
card back on the Desk at roughly that time. This module supplies the
two activities the DecisionRouterWorkflow + a small hourly workflow
need to make that work:

1. ``parse_resurface_time`` — clerk call that turns a free-text "when"
   string into an ISO datetime, given today's date as anchor. Returns
   None when the note isn't time-bearing (e.g. "I don't care, just go
   away").

2. ``resurface_due_needs_attention`` — scans skipped records, flips
   anything whose ``resurface_at`` has passed back to ``pending`` so it
   re-appears on /desk. Idempotent — once flipped, the next pass skips
   it (status != skipped).

The principal's original note is preserved on the resurfaced card so
the UI can render a hint ("Resurfaced — you said: 'after Madrid'").
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config

logger = logging.getLogger("defer-resurface")


def _http() -> httpx.AsyncClient:
    cfg = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    return httpx.AsyncClient(
        base_url=cfg.alfred_ctrl_url, headers=headers, timeout=60.0
    )


_PARSE_PROMPT = """You are Alfred, the principal's agentic butler.

The principal just deferred a task on their Desk with the note:

  "{note}"

Today is {today_iso} (UTC).

Convert their note into a concrete ISO 8601 datetime in UTC that says *when this should resurface back on their Desk*. Treat the principal's local intent generously — "next week" means Monday 09:00, "in July" means July 1st 09:00, "after Madrid" or any other event-based reference where the date is unknown means default to 30 days out at 09:00, "in a few days" means 3 days out at 09:00. Always resurface at 09:00 local-ish (the principal's morning).

If the note is NOT time-bearing — e.g. it's just acknowledgement ("ok skip"), commentary ("Alfred already handled this"), or a vague non-answer ("whenever") — emit null and the card stays deferred indefinitely.

Emit STRICT JSON, no preamble:

{{
  "resurface_at": "<ISO 8601 UTC datetime, or null>",
  "reasoning": "<one short sentence — what you inferred from the note>"
}}
"""


# Stricter prompt for the **delegate** intent. The principal's default is
# "execute now"; only honour a future time if the note *names one
# explicitly*. The defer prompt is lenient (it interprets vague phrases
# like "in a few days" as 3 days) — that's wrong for delegate, where
# "Send me a reminder on Telegram" with no time MUST mean now, not
# auto-default to 7 days out. Empirical case: plex card delegate on
# 2026-05-13 auto-scheduled to 2026-05-20 because the lenient prompt
# guessed a default for a non-time-bearing note. Sir's rule: no explicit
# time → fire now.
_PARSE_PROMPT_DELEGATE = """You are Alfred, the principal's agentic butler.

The principal just delegated a task on their Desk with the note:

  "{note}"

Today is {today_iso} (UTC).

**Default: the principal expects the task to be dispatched immediately.** Only return a future datetime if the note *explicitly names a time* — examples that DO name a time: "tomorrow at 9am", "in 3 hours", "next Tuesday morning", "Friday afternoon", "in two weeks", "on May 25th". Examples that do NOT name a time (return null → dispatch now): "Send me a reminder on Telegram", "ping me about this", "handle this", "remind me", "follow up on this".

A "reminder" alone is not a time. "Remind me on Friday" is a time. "Remind me" is not.

Emit STRICT JSON, no preamble:

{{
  "resurface_at": "<ISO 8601 UTC datetime if the note explicitly names one, else null>",
  "reasoning": "<one short sentence — what you inferred from the note>"
}}
"""


@activity.defn
async def parse_resurface_time(
    note: str,
    today_iso: str | None = None,
    intent: str = "defer",
) -> dict[str, Any]:
    """Ask the clerk to turn a defer/delegate note into a concrete resurface datetime.

    ``intent`` selects the parsing prompt:

    - ``defer`` (default) — lenient. Vague phrases like "in a few days"
      get interpreted as ~3 days. Used by the actual /desk Defer button.
    - ``delegate`` — strict. Only returns a non-null datetime if the
      note *explicitly* names a time. Default is null → dispatch now.
      Used by the decision_router's delegate path so "Send me a
      reminder on Telegram" with no time fires immediately, not 7 days
      out.
    """
    if not note or not note.strip():
        return {"resurface_at": None, "reasoning": "empty note"}
    today = today_iso or datetime.now(timezone.utc).date().isoformat()
    template = (
        _PARSE_PROMPT_DELEGATE if intent == "delegate" else _PARSE_PROMPT
    )
    prompt = template.format(note=note.strip(), today_iso=today)
    try:
        from src.activities.clerk import _call_clerk
        result = await _call_clerk(prompt)
    except Exception as exc:  # noqa: BLE001
        logger.warning("parse_resurface_time: clerk failed: %s", exc)
        return {"resurface_at": None, "reasoning": f"clerk error: {exc}"}
    if not isinstance(result, dict):
        return {"resurface_at": None, "reasoning": "non-dict response"}
    raw = result.get("resurface_at")
    if not isinstance(raw, str) or not raw.strip():
        return {
            "resurface_at": None,
            "reasoning": str(result.get("reasoning") or "non-time-bearing"),
        }
    # Basic validation — round-trip through datetime parser.
    try:
        # Accept both Z and +00:00 suffixes.
        normalized = raw.strip().replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return {
            "resurface_at": parsed.astimezone(timezone.utc).isoformat(),
            "reasoning": str(result.get("reasoning") or ""),
        }
    except ValueError as exc:
        logger.warning("parse_resurface_time: bad datetime %r: %s", raw, exc)
        return {"resurface_at": None, "reasoning": f"bad iso: {raw}"}


@activity.defn
async def stamp_resurface_on_needs_attention(
    needs_attention_id: str,
    resurface_at: str,
    defer_note: str,
) -> dict[str, Any]:
    """PATCH the needs_attention record with resurface_at + defer_note."""
    if not needs_attention_id or not resurface_at:
        return {"ok": False, "reason": "missing args"}
    async with _http() as client:
        resp = await client.patch(
            f"/api/v1/vault/records/needs_attention/{needs_attention_id}.md",
            json={
                "set": {
                    "resurface_at": resurface_at,
                    "defer_note": defer_note or "",
                },
            },
        )
        if resp.status_code >= 400:
            return {"ok": False, "status": resp.status_code}
    logger.info(
        "stamp_resurface: %s -> %s", needs_attention_id, resurface_at,
    )
    return {"ok": True, "resurface_at": resurface_at}


@activity.defn
async def resurface_due_needs_attention() -> dict[str, Any]:
    """Scan deferred records across types, flip due ones back to surface.

    Two record types are checked:

    1. ``needs_attention`` with ``status=skipped`` — flipped back to
       ``pending`` so the card reappears on /desk.
    2. ``decision_pattern`` with ``status=deferred`` — flipped back to
       ``proposed`` so the pattern card reappears.

    A record is "due" when ``resurface_at <= now()``. We also stamp
    ``resurfaced_at`` so the UI can show "Resurfaced — you said: '...'".
    """
    now = datetime.now(timezone.utc)
    flipped_na = 0
    flipped_pp = 0
    examined = 0
    async with _http() as client:
        # ---- needs_attention skipped records ----
        resp = await client.get(
            "/api/v1/admin/needs-attention?include=all&limit=500",
        )
        resp.raise_for_status()
        recs = resp.json().get("records", []) or []
        for r in recs:
            if r.get("status") != "skipped":
                continue
            ra = r.get("resurface_at")
            if not isinstance(ra, str) or not ra.strip():
                continue
            try:
                normalized = ra.strip().replace("Z", "+00:00")
                due = datetime.fromisoformat(normalized)
                if due.tzinfo is None:
                    due = due.replace(tzinfo=timezone.utc)
            except ValueError:
                continue
            examined += 1
            if due > now:
                continue
            na_id = r.get("id")
            if not isinstance(na_id, str):
                continue
            patch = await client.patch(
                f"/api/v1/vault/records/needs_attention/{na_id}.md",
                json={
                    "set": {
                        "status": "pending",
                        "resurfaced_at": now.isoformat(),
                        "resolved_at": "",
                        "resolution_note": "",
                    },
                },
            )
            if patch.status_code < 400:
                flipped_na += 1
                logger.info(
                    "resurface: needs_attention/%s skipped->pending (was due %s)",
                    na_id, ra,
                )

        # ---- decision_pattern deferred records ----
        pp_resp = await client.get(
            "/api/v1/vault/list/decision_pattern?preview=500",
        )
        if pp_resp.status_code < 400:
            patterns = pp_resp.json().get("results", []) or []
            for p in patterns:
                fm = p.get("frontmatter") if isinstance(p, dict) else None
                if not isinstance(fm, dict):
                    continue
                if fm.get("status") != "deferred":
                    continue
                ra = fm.get("resurface_at")
                if not isinstance(ra, str) or not ra.strip():
                    continue
                try:
                    normalized = ra.strip().replace("Z", "+00:00")
                    due = datetime.fromisoformat(normalized)
                    if due.tzinfo is None:
                        due = due.replace(tzinfo=timezone.utc)
                except ValueError:
                    continue
                examined += 1
                if due > now:
                    continue
                pp_path = p.get("path")
                if not isinstance(pp_path, str):
                    continue
                patch = await client.patch(
                    f"/api/v1/vault/records/{pp_path}",
                    json={
                        "set": {
                            "status": "proposed",
                            "resurfaced_at": now.isoformat(),
                        },
                    },
                )
                if patch.status_code < 400:
                    flipped_pp += 1
                    logger.info(
                        "resurface: %s deferred->proposed (was due %s)",
                        pp_path, ra,
                    )
    if flipped_na or flipped_pp or examined:
        logger.info(
            "defer_resurface: examined=%d flipped_na=%d flipped_pp=%d",
            examined, flipped_na, flipped_pp,
        )
    return {
        "examined": examined,
        "flipped_needs_attention": flipped_na,
        "flipped_pattern_proposal": flipped_pp,
    }
