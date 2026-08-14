"""NAR data layer — pure reading and plumbing, no LLM calls (#584).

Exposes the shared constants, the engaged-time clustering algorithm, all
read-only data queries (Hermes session store + ctrl-api audit/observations),
and the session-context extraction helper used by the classification layer.

This module has no dependency on the clerk or Temporal — it is independently
testable and can be imported by tools and smoke scripts without the full
learn environment.

Implements the data inputs specified in ``docs/design/nar-method.md``.
"""
from __future__ import annotations

import logging
import os
import sqlite3
from datetime import date, datetime, timezone
from typing import Any

import httpx

logger = logging.getLogger("alfred-learn")

# ---------------------------------------------------------------------------
# Constants from docs/design/nar-method.md — DO NOT change without updating
# the method doc and writing a commit-level explanation.
# ---------------------------------------------------------------------------

# Bucket minutes (§1b).  "none" → 0 displaced.
BUCKET_MINUTES: dict[str, float] = {"S": 5.0, "M": 20.0, "L": 60.0, "XL": 120.0}
VALID_BUCKETS = frozenset(BUCKET_MINUTES) | {"none"}

# Suppression rate (§1a, from #582 rate card — 0.5 min/item).
SUPPRESSION_RATE_MINUTES = 0.5

# Engaged-time clustering parameters (§2).
GAP_MS = 10 * 60 * 1000   # 10-minute gap ends a burst
FLOOR_MS = 2 * 60 * 1000  # 2-minute floor per burst

# Human session sources allowlist (§2 — never use a denylist).
# `cli` is excluded per §2: "suspect and should be reviewed before being
# trusted as human."  Add sources here only when we have evidence they
# represent Sir typing, not a machine process.
HUMAN_SOURCES: frozenset[str] = frozenset({"web", "telegram", "slack"})

# Path to the Hermes main profile session store.
_DEFAULT_HERMES_CONFIG_DIR = "/hermes-state/profiles"
_SESSION_DB_FILENAME = "state.db"


# ---------------------------------------------------------------------------
# Engaged-time utility (port of engagedTime.ts:clusterBursts — same algo).
# ---------------------------------------------------------------------------

def cluster_bursts(timestamps_ms: list[float], gap_ms: float, floor_ms: float) -> float:
    """Cluster timestamps (epoch ms) into bursts; return total engaged ms.

    Mirrors ``clusterBursts`` in ``packages/ctrl/src/db/engagedTime.ts`` —
    same algorithm, same parameters.  Kept here for validation smoke evidence.
    """
    if not timestamps_ms:
        return 0.0
    sorted_ts = sorted(timestamps_ms)
    total = 0.0
    start = end = sorted_ts[0]
    for ts in sorted_ts[1:]:
        if ts - end <= gap_ms:
            end = ts
        else:
            total += max(end - start, floor_ms)
            start = end = ts
    total += max(end - start, floor_ms)
    return total


# ---------------------------------------------------------------------------
# Session store access (read-only sqlite).
# ---------------------------------------------------------------------------

def _session_db_path(profile: str = "main") -> str:
    config_dir = os.environ.get("HERMES_CONFIG_DIR", _DEFAULT_HERMES_CONFIG_DIR)
    return os.path.join(config_dir, profile, _SESSION_DB_FILENAME)


def _open_session_db(profile: str = "main") -> sqlite3.Connection | None:
    """Open the Hermes session store read-only.  Returns None on failure."""
    path = _session_db_path(profile)
    if not os.path.exists(path):
        logger.warning("nar_data: session db not found at %s — skipping sessions", path)
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        return conn
    except Exception as exc:  # noqa: BLE001
        logger.warning("nar_data: cannot open session db %s: %s", path, exc)
        return None


def _day_epoch_window(day: date) -> tuple[float, float]:
    """Return (start_epoch_s, end_epoch_s) for a full UTC calendar day."""
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    end = datetime(day.year, day.month, day.day, 23, 59, 59, 999999, tzinfo=timezone.utc)
    return start.timestamp(), end.timestamp()


def _iso(day: date, suffix: str = "T00:00:00Z") -> str:
    return f"{day.isoformat()}{suffix}"


def _get_human_sessions(db: sqlite3.Connection, day: date) -> list[dict[str, Any]]:
    """Return human sessions that started during the given UTC day.

    Filters to HUMAN_SOURCES allowlist.  A session belongs to the day it
    started — using overlap (``ended_at IS NULL OR ended_at >= start_s``)
    would match sessions with a NULL ended_at from any prior day, inflating
    counts by an unbounded amount on tenants with un-closed sessions.
    Missing columns degrade silently rather than crashing.
    """
    start_s, end_s = _day_epoch_window(day)
    try:
        rows = db.execute(
            """
            SELECT id, source, started_at, ended_at
            FROM sessions
            WHERE source IN ({placeholders})
              AND started_at >= ?
              AND started_at <= ?
            ORDER BY started_at ASC
            """.format(placeholders=",".join("?" * len(HUMAN_SOURCES))),
            (*HUMAN_SOURCES, start_s, end_s),
        ).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.warning("nar_data: sessions query failed: %s", exc)
        return []

    sessions = []
    for row in rows:
        sid = row["id"]
        try:
            msgs = db.execute(
                """
                SELECT role, content, timestamp
                FROM messages
                WHERE session_id = ?
                ORDER BY timestamp ASC
                """,
                (sid,),
            ).fetchall()
        except Exception as exc:  # noqa: BLE001
            logger.warning("nar_data: messages query for %s failed: %s", sid, exc)
            msgs = []

        sessions.append({
            "id": sid,
            "source": row["source"],
            "started_at": row["started_at"],
            "ended_at": row["ended_at"],
            "messages": [
                {"role": m["role"], "content": m["content"], "ts": m["timestamp"]}
                for m in msgs
            ],
        })
    return sessions


# ---------------------------------------------------------------------------
# Failure detection constants.
# ---------------------------------------------------------------------------

# Phrases that signal an assistant turn conceding an error or inability to
# complete a task.  Used by ``_extract_session_context`` to build the
# failure_note passed to the clerk.
_CONCESSION_PHRASES = (
    "i was wrong", "i made an error", "i must concede", "i concede",
    "i realize i", "i was mistaken", "i apologize", "i'm sorry i",
    "unable to complete", "failed to", "could not complete",
    "encountered an error", "pipeline failure",
    "didn't work", "couldn't complete", "i should note that i",
)

# Tokens that flag a chore observation as a vigilance sweep — the chore ran,
# checked, and found nothing actionable.  Vigilance sweeps take the
# suppression rate directly and NEVER reach the bucket classifier.
_VIGILANCE_TOKENS = frozenset({
    # "Found nothing" family
    "found nothing", "no issues", "no items", "nothing to report",
    "no results", "0 items", "nothing found", "all clear",
    # Signal-scan vigilance patterns observed in production
    "no urgent notification", "urgent=0", "notified=f",
    "below threshold",
    "no relationship cand",
    "0 candidates",
    "0 messages checked",
    "0 signals",
    "no operations threat",
    "no ntp client",
})


# ---------------------------------------------------------------------------
# Session context extraction (used by the classification layer).
# ---------------------------------------------------------------------------

def _extract_session_context(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Extract ask, delivery, failure_note, and scale signals from a session.

    Returns a dict with keys: ask, delivery, failure_note, user_turns,
    assistant_msgs, tool_calls, span_min.  Used to build the clerk prompt
    without feeding the entire message history — a tail window discards the
    scope of long sessions; ask + delivery + counts do not.

    failure_note is set ONLY when an explicit concession phrase appears in the
    final 3 assistant messages.  We do NOT expose "short final message" as a
    hint — "Done.", "Understood.", "Igen." are positive confirmations, not
    failure admissions, and giving the clerk that hint causes false positives
    on the majority of well-executed long sessions.
    """
    user_msgs = [m for m in messages if m.get("role") == "user" and m.get("content")]
    asst_msgs = [m for m in messages if m.get("role") == "assistant" and m.get("content")]
    # tool role OR messages that look like tool calls
    tool_count = sum(
        1 for m in messages
        if m.get("role") == "tool" or bool(m.get("tool_calls"))
    )

    timestamps = [m["ts"] for m in messages if m.get("ts") is not None]
    span_min = (max(timestamps) - min(timestamps)) / 60.0 if len(timestamps) >= 2 else 0.0

    ask = str(user_msgs[0].get("content", ""))[:800] if user_msgs else "(no user turn)"

    # Last substantive assistant response — skip very short acknowledgments so
    # that a brief "Sure, done." does not hide the real deliverable above it.
    delivery = ""
    for msg in reversed(asst_msgs):
        content = str(msg.get("content", ""))
        if len(content) > 80:
            delivery = content[:1200]
            break
    if not delivery and asst_msgs:
        delivery = str(asst_msgs[-1].get("content", ""))[:1200]
    if not delivery:
        delivery = "(no assistant response)"

    # Scan the FINAL FEW assistant messages for explicit concession language.
    # A real end-of-session failure lives in the tail; scanning all messages
    # false-triggers on mid-session corrections in long successful sessions.
    failure_excerpt = ""
    for msg in reversed(asst_msgs[-3:]):
        lowered = str(msg.get("content", "")).lower()
        if any(phrase in lowered for phrase in _CONCESSION_PHRASES):
            failure_excerpt = str(msg.get("content", ""))[:300]
            break

    failure_note = f"YES — excerpt: {failure_excerpt}" if failure_excerpt else "None detected."

    return {
        "ask": ask,
        "delivery": delivery,
        "failure_note": failure_note,
        "user_turns": len(user_msgs),
        "assistant_msgs": len(asst_msgs),
        "tool_calls": tool_count,
        "span_min": span_min,
    }


# ---------------------------------------------------------------------------
# ctrl-api data helpers.
# ---------------------------------------------------------------------------

def _ctrl_headers() -> dict[str, str]:
    api_key = os.environ.get("AAS_API_KEY", "")
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


async def _get_principal_decisions(
    ctrl_url: str, since: str, until: str,
) -> list[dict[str, Any]]:
    """Fetch principal desk decisions from the audit table for the given range."""
    async with httpx.AsyncClient(
        base_url=ctrl_url, timeout=30.0, headers=_ctrl_headers(),
    ) as http:
        resp = await http.get("/api/v1/state/audit", params={
            "action_type": "decision",
            "actor": "principal",
            "since": since,
            "until": until,
            "limit": 500,
        })
        resp.raise_for_status()
        return resp.json().get("entries", [])


async def _get_chore_runs(
    ctrl_url: str, since: str, until: str,
) -> list[dict[str, Any]]:
    """Fetch chore-run observations for the given date range."""
    async with httpx.AsyncClient(
        base_url=ctrl_url, timeout=30.0, headers=_ctrl_headers(),
    ) as http:
        resp = await http.get("/api/v1/state/observations", params={
            "kind": "chore_run",
            "since": since,
            "until": until,
            "limit": 200,
        })
        resp.raise_for_status()
        return resp.json().get("observations", [])
