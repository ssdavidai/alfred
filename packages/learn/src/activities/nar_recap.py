"""NAR daily recap — compute Net Attention Returned entries for one day (#584).

Reads three read-only sources for a given date and writes ``nar_entry`` rows
via ``POST /api/v1/state/nar-entries`` (ctrl-api, Lane I prerequisite):

  1. Hermes main profile session store — human-initiated conversational work.
  2. alfred-state.db audit — desk decisions made by the principal.
  3. alfred-state.db observations — autonomous chore-run artifacts.

Every output is one ``nar_entry`` row with a deterministic ``dedup_key`` so
re-running a date updates rather than duplicates.

**Read-only everywhere except nar_entry.** A missing Hermes profile or an
unexpected schema column degrades to a smaller result, never a crash.

Implements the method in ``docs/design/nar-method.md``.  That document is the
canonical spec — all constants, rates, and bucket sizes come from there.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
from datetime import date, datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.activities.clerk import _call_clerk, _extract_json
from src.config import load_config

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
        logger.warning("nar_recap: session db not found at %s — skipping sessions", path)
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        return conn
    except Exception as exc:  # noqa: BLE001
        logger.warning("nar_recap: cannot open session db %s: %s", path, exc)
        return None


def _day_epoch_window(day: date) -> tuple[float, float]:
    """Return (start_epoch_s, end_epoch_s) for a full UTC calendar day."""
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    end = datetime(day.year, day.month, day.day, 23, 59, 59, 999999, tzinfo=timezone.utc)
    return start.timestamp(), end.timestamp()


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
        logger.warning("nar_recap: sessions query failed: %s", exc)
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
            logger.warning("nar_recap: messages query for %s failed: %s", sid, exc)
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
# Clerk bucket classification.
# ---------------------------------------------------------------------------

_BUCKET_PROMPT = """\
You are classifying a single Alfred conversation to estimate the work it displaced.

Session scale: {user_turns} user turns · {assistant_msgs} assistant messages \
· {tool_calls} tool calls · {span_min:.0f} min wall-clock.

What was asked (first user turn):
{ask}

What was delivered (last substantive assistant response):
{delivery}

Failure signal: {failure_note}

Rules from the NAR method (apply them in order):
1. A quantity NAMED in an artifact is NOT displacement. Crediting the figure inside inflates.
2. Discussion with no artifact displaces NOTHING — return bucket "none".
3. A failed or blocked session costs ZERO displacement. IMPORTANT: bucket and is_failed are
   INDEPENDENT AXES. A session can be L-scale work that failed — set bucket=L AND is_failed=true.
   Never collapse a failed session to bucket="none"; displacement is forced to zero by the caller.
4. Scale signals matter: a 1-turn conversation cannot be XL; a 60-minute multi-step session
   with hundreds of tool calls is unlikely to be S.

Return a JSON object with exactly these keys:
  bucket: one of "S" | "M" | "L" | "XL" | "none"
  reasoning: one sentence
  has_artifact: true | false
  is_failed: true | false (true if failure signal present, even if work was partially done)

Bucket meanings (minutes of principal time displaced if delivered):
  S  =   5 min — quick email, short memo, simple fact lookup
  M  =  20 min — medium email, task plan, substantive synthesis
  L  =  60 min — complex document, multi-step research, large delegation
  XL = 120 min — work that would take most of a half-day by hand
  none = 0     — discussion only, or tool calls with no output

Return ONLY the JSON, no prose."""


def _extract_session_context(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Extract ask, delivery, failure_note, and scale signals from a session.

    Returns a dict with keys: ask, delivery, failure_note, user_turns,
    assistant_msgs, tool_calls, span_min.  Used to build the clerk prompt
    without feeding the entire message history — a tail window discards the
    scope of long sessions; ask + delivery + counts do not.

    failure_note surfaces concession signals so the clerk can set is_failed=true
    even when the last *substantive* message described completed work (common in
    sessions that succeed then fail at a final step).
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
    # that a brief "Sure, done." does not hide a failure admission above it.
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

    # Truly last assistant message — may be short if the session ended with a
    # brief failure admission after the substantive delivery above.
    final_msg = str(asst_msgs[-1].get("content", ""))[:400] if asst_msgs else ""

    # Scan the FINAL FEW assistant messages for concession language.
    # Scanning the full history would false-trigger on mid-session corrections
    # (a long successful session almost always contains "failed to" somewhere
    # mid-stream).  A real end-of-session failure lives in the last 3 messages.
    failure_excerpt = ""
    for msg in reversed(asst_msgs[-3:]):
        lowered = str(msg.get("content", "")).lower()
        if any(phrase in lowered for phrase in _CONCESSION_PHRASES):
            failure_excerpt = str(msg.get("content", ""))[:300]
            break

    if failure_excerpt:
        failure_note = f"YES — excerpt: {failure_excerpt}"
    elif final_msg and final_msg != delivery:
        # Last message was short (< 80 chars); expose it for the clerk.
        failure_note = f"Final message (may contain failure admission): {final_msg}"
    else:
        failure_note = "None detected."

    return {
        "ask": ask,
        "delivery": delivery,
        "failure_note": failure_note,
        "user_turns": len(user_msgs),
        "assistant_msgs": len(asst_msgs),
        "tool_calls": tool_count,
        "span_min": span_min,
    }


async def _classify_session_bucket(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Ask the clerk to classify the displacement bucket for a session.

    Context is ask + delivery + scale signals rather than a tail window —
    the tail of a 1000-message session looks routine even when the full span
    was a half-day delegation, so a tail window systematically under-sizes
    long sessions.  Falls back to ``{"bucket": "none"}`` on any error.
    """
    if not messages:
        return {"bucket": "none", "reasoning": "empty session", "has_artifact": False, "is_failed": False}

    ctx = _extract_session_context(messages)
    try:
        # Build prompt inside try/except: ask/delivery may contain literal
        # curly braces (e.g. JSON payloads) which would crash str.format().
        # The caller falls back to bucket="none" on any exception here.
        prompt = _BUCKET_PROMPT.format(**ctx)
        result = await _call_clerk(prompt, agent_id="learn-nar-bucket")
        if isinstance(result, str):
            result = _extract_json(result)
        bucket = str(result.get("bucket", "none"))
        if bucket not in VALID_BUCKETS:
            bucket = "none"
        return {
            "bucket": bucket,
            "reasoning": str(result.get("reasoning", "")),
            "has_artifact": bool(result.get("has_artifact", False)),
            "is_failed": bool(result.get("is_failed", False)),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("nar_recap: bucket classification failed: %s", exc)
        return {"bucket": "none", "reasoning": f"clerk error: {str(exc)[:100]}", "has_artifact": False, "is_failed": False}


_CHORE_BUCKET_PROMPT = """\
You are classifying an autonomous Alfred chore run to estimate the work it displaced.
This is NOT a conversation — Alfred ran this unattended. There is no user turn.
Classify ONLY the deliverable artifact produced, not the chore activity itself.

Chore: {chore_name}
Output: {detail}

Rules:
1. A quantity NAMED in an artifact is not displacement. Credit the production cost, not the contents.
2. If no deliverable artifact was produced (status-only, found nothing, failed), return "none".
3. A failed chore costs zero displacement — return "none" with is_failed=true.

Return a JSON object:
  bucket: one of "S" | "M" | "L" | "XL" | "none"
  reasoning: one sentence
  has_artifact: true | false
  is_failed: true | false

Bucket meanings (minutes of principal time the artifact would have taken by hand):
  S  =   5 min — short note, quick status, calendar entry
  M  =  20 min — briefing composition, medium report, data synthesis
  L  =  60 min — complex multi-source report or document
  XL = 120 min — half-day equivalent by hand
  none = 0     — vigilance, status-only, failed, or tool activity with no deliverable

Return ONLY the JSON, no prose."""


async def _classify_chore_bucket(detail: str, chore_name: str) -> dict[str, Any]:
    """Classify displacement bucket for a chore artifact.

    Uses a chore-specific prompt that does not model the output as a
    conversation — chores are autonomous and have no user turn.  The session
    classifier's ask/delivery/failure_note structure is inappropriate here.
    Falls back to ``{"bucket": "none"}`` on any error.
    """
    if not detail:
        return {"bucket": "none", "reasoning": "empty chore output", "has_artifact": False, "is_failed": False}
    try:
        # Build prompt inside try/except: detail may contain literal curly
        # braces (e.g. JSON chore output) which would crash str.format().
        prompt = _CHORE_BUCKET_PROMPT.format(
            chore_name=chore_name[:100],
            detail=detail[:800],
        )
        result = await _call_clerk(prompt, agent_id="learn-nar-chore")
        if isinstance(result, str):
            result = _extract_json(result)
        bucket = str(result.get("bucket", "none"))
        if bucket not in VALID_BUCKETS:
            bucket = "none"
        return {
            "bucket": bucket,
            "reasoning": str(result.get("reasoning", "")),
            "has_artifact": bool(result.get("has_artifact", False)),
            "is_failed": bool(result.get("is_failed", False)),
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("nar_recap: chore bucket classification failed: %s", exc)
        return {"bucket": "none", "reasoning": f"clerk error: {str(exc)[:100]}", "has_artifact": False, "is_failed": False}


# ---------------------------------------------------------------------------
# ctrl-api helpers.
# ---------------------------------------------------------------------------

def _ctrl_headers() -> dict[str, str]:
    api_key = os.environ.get("AAS_API_KEY", "")
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


async def _get_principal_decisions(config: Any, since: str, until: str) -> list[dict[str, Any]]:
    """Fetch principal desk decisions from the audit table for the given range."""
    async with httpx.AsyncClient(
        base_url=config.alfred_ctrl_url, timeout=30.0, headers=_ctrl_headers(),
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


async def _get_chore_runs(config: Any, since: str, until: str) -> list[dict[str, Any]]:
    """Fetch chore-run observations for the given date range."""
    async with httpx.AsyncClient(
        base_url=config.alfred_ctrl_url, timeout=30.0, headers=_ctrl_headers(),
    ) as http:
        resp = await http.get("/api/v1/state/observations", params={
            "kind": "chore_run",
            "since": since,
            "until": until,
            "limit": 200,
        })
        resp.raise_for_status()
        return resp.json().get("observations", [])


async def _upsert_nar_entry(config: Any, entry: dict[str, Any]) -> dict[str, Any]:
    """POST to /api/v1/state/nar-entries — upserts on dedup_key.

    Body shape: ``{"entries": [entry]}`` — the Lane I endpoint accepts a
    batch; we send single-entry batches per call so the caller loop stays
    simple.  This endpoint is the Lane I prerequisite (#584): when not yet
    deployed (404/405), logs a warning and returns a stub so the rest of the
    recap still runs for local validation.
    """
    async with httpx.AsyncClient(
        base_url=config.alfred_ctrl_url, timeout=30.0, headers=_ctrl_headers(),
    ) as http:
        try:
            resp = await http.post("/api/v1/state/nar-entries", json={"entries": [entry]})
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in (404, 405):
                logger.warning(
                    "nar_recap: /api/v1/state/nar-entries not deployed "
                    "(Lane I prerequisite) — dedup_key=%s logged only",
                    entry.get("dedup_key"),
                )
                return {"ok": False, "reason": "endpoint_not_deployed", "dedup_key": entry.get("dedup_key")}
            raise


# ---------------------------------------------------------------------------
# Main activity.
# ---------------------------------------------------------------------------

def _iso(day: date, suffix: str = "T00:00:00Z") -> str:
    return f"{day.isoformat()}{suffix}"


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

# Phrases that signal an assistant turn conceding an error.
_CONCESSION_PHRASES = (
    "i was wrong", "i made an error", "i must concede", "i concede",
    "i realize i", "i was mistaken", "i apologize", "i'm sorry i",
    "unable to complete", "failed to", "could not complete",
    "encountered an error", "pipeline failure",
    "didn't work", "couldn't complete", "i should note that i",
)


def _chore_is_vigilance_sweep(obs: dict[str, Any]) -> bool:
    """Return True if this chore ran, checked and found nothing actionable.

    Vigilance sweeps take the suppression rate per the NAR method doc (§1c) —
    they must never reach the bucket classifier.  Replaces the original
    ``_chore_has_artifact`` which returned True for "50 signals, no urgent
    notification", causing systematic over-counting.
    """
    body = str(obs.get("detail", "") or obs.get("summary", "")).lower()
    return any(tok in body for tok in _VIGILANCE_TOKENS)


@activity.defn
async def compute_nar_day(day_iso: str) -> dict[str, Any]:
    """Compute and write nar_entry rows for one UTC calendar day.

    ``day_iso`` is ``YYYY-MM-DD``.
    Returns a summary dict with counts and validation figures.
    """
    config = load_config()
    day = date.fromisoformat(day_iso)
    since = _iso(day, "T00:00:00Z")
    until = _iso(day, "T23:59:59Z")

    results: dict[str, Any] = {
        "date": day_iso,
        "sessions_processed": 0,
        "decisions_processed": 0,
        "chore_runs_processed": 0,
        "entries_written": 0,
        "entries_skipped": 0,
        "engaged_ms": 0.0,
        "displaced_minutes": 0.0,
    }

    all_timestamps_ms: list[float] = []

    # ── 1. Conversational sessions ────────────────────────────────────
    db = _open_session_db("main")
    if db is not None:
        try:
            sessions = _get_human_sessions(db, day)
        finally:
            db.close()

        for sess in sessions:
            results["sessions_processed"] += 1
            messages = sess["messages"]

            # Collect user-turn timestamps for engaged-time computation.
            all_timestamps_ms.extend(
                m["ts"] * 1000
                for m in messages
                if m.get("role") == "user" and m.get("ts") is not None
            )

            bucket_info = await _classify_session_bucket(messages)
            bucket = bucket_info["bucket"]
            displaced: float | None = BUCKET_MINUTES.get(bucket)
            # Method doc rule 3: failed/blocked sessions cost ZERO displacement
            # regardless of bucket size.  bucket and is_failed are independent.
            if bucket_info.get("is_failed"):
                displaced = 0.0

            started_at = float(sess.get("started_at") or 0.0)
            occurred_at = datetime.fromtimestamp(started_at, tz=timezone.utc).isoformat()
            dedup_key = f"nar:session:{sess['id']}:{day_iso}"

            entry: dict[str, Any] = {
                "dedup_key": dedup_key,
                "occurred_at": occurred_at,
                "action_class": "conversational",
                "summary": f"Session {sess['id'][:12]} ({sess['source']}) — bucket {bucket}",
                "evidence_kind": "session",
                "evidence_ref": sess["id"],
                "session_ref": sess["id"],
                "baseline_minutes": displaced,
                "estimation_method": "model-estimate" if displaced is not None else None,
                "acceptance": "inferred",
                "acceptance_path": "inferred" if displaced is not None else None,
                "acceptance_basis": bucket_info.get("reasoning", ""),
                "displaced_minutes": displaced,
                "notes": json.dumps({"bucket": bucket, "has_artifact": bucket_info.get("has_artifact")}),
            }
            out = await _upsert_nar_entry(config, entry)
            if out.get("reason") == "endpoint_not_deployed":
                results["entries_skipped"] += 1
            else:
                results["entries_written"] += 1
            if displaced is not None:
                results["displaced_minutes"] += displaced

    # ── 2. Desk decisions ─────────────────────────────────────────────
    try:
        decisions = await _get_principal_decisions(config, since, until)
    except Exception as exc:  # noqa: BLE001
        logger.warning("nar_recap: decisions fetch failed: %s", exc)
        decisions = []

    for dec in decisions:
        results["decisions_processed"] += 1
        # The audit API returns intent inside `payload_json`, not `payload`.
        payload = dec.get("payload_json") or dec.get("payload") or {}
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except Exception:  # noqa: BLE001
                payload = {}
        intent = payload.get("intent") or dec.get("intent") or ""
        ts_str = dec.get("ts") or dec.get("created_at") or since
        dedup_key = f"nar:decision:{dec['id']}"

        # Decision timestamps contribute to engaged time (method doc §2:
        # "human conversation turns plus desk decisions, merged and sorted").
        try:
            dec_epoch_s = datetime.fromisoformat(
                ts_str.replace("Z", "+00:00")
            ).timestamp()
            all_timestamps_ms.append(dec_epoch_s * 1000)
        except Exception:  # noqa: BLE001
            pass

        if intent == "noise":
            disp: float | None = SUPPRESSION_RATE_MINUTES
            method: str | None = "standard-time"
            acceptance_path = "explicit"
            basis = "principal marked noise; suppression rate 0.5 min/item"
        else:
            disp = None
            method = None
            acceptance_path = "explicit"
            basis = f"principal decided intent={intent!r}; no established rate"

        entry = {
            "dedup_key": dedup_key,
            "occurred_at": ts_str,
            "action_class": "desk_decision",
            "summary": f"Desk decision {intent or '(unknown)'}",
            "evidence_kind": "decision",
            "evidence_ref": dec.get("id", ""),
            "session_ref": None,
            "baseline_minutes": disp,
            "estimation_method": method,
            "acceptance": "accepted",
            "acceptance_path": acceptance_path,
            "acceptance_basis": basis,
            "displaced_minutes": disp,
            "notes": json.dumps({"intent": intent}),
        }
        out = await _upsert_nar_entry(config, entry)
        if out.get("reason") == "endpoint_not_deployed":
            results["entries_skipped"] += 1
        else:
            results["entries_written"] += 1
        if disp is not None:
            results["displaced_minutes"] += disp

    # ── 3. Chore runs ─────────────────────────────────────────────────
    try:
        chore_obs = await _get_chore_runs(config, since, until)
    except Exception as exc:  # noqa: BLE001
        logger.warning("nar_recap: chore runs fetch failed: %s", exc)
        chore_obs = []

    for obs in chore_obs:
        results["chore_runs_processed"] += 1
        ts_str = obs.get("ts") or obs.get("created_at") or since
        dedup_key = f"nar:chore_run:{obs['id']}"
        chore_name = str(obs.get("subject_ref") or obs.get("summary") or obs.get("id", ""))
        detail = str(obs.get("detail") or obs.get("summary") or "")
        is_vigilance = _chore_is_vigilance_sweep(obs)

        if is_vigilance:
            # Method doc §1c: "a chore that ran, checked and found nothing →
            # suppression rate (vigilance)".  Vigilance sweeps must never reach
            # the bucket classifier.
            cbucket = "none"
            cdisp: float | None = SUPPRESSION_RATE_MINUTES
            cmethod: str | None = "standard-time"
            cbasis = f"chore '{chore_name}' vigilance sweep — suppression rate"
            has_artifact = False
        else:
            # Artifact chore — use the chore-specific classifier (not the session
            # classifier, which models ask/delivery pairs and has no user turn).
            binfo = await _classify_chore_bucket(detail, chore_name)
            cbucket = binfo["bucket"]
            cdisp = BUCKET_MINUTES.get(cbucket)
            if binfo.get("is_failed"):
                cdisp = 0.0
            cmethod = "model-estimate" if cdisp else "standard-time"
            cbasis = f"chore '{chore_name}' artifact — {binfo.get('reasoning', '')}"
            has_artifact = binfo.get("has_artifact", False)

        entry = {
            "dedup_key": dedup_key,
            "occurred_at": ts_str,
            "action_class": "chore_run",
            "summary": f"Chore {chore_name}: {'artifact' if has_artifact else 'vigilance'}",
            "evidence_kind": "chore_run",
            "evidence_ref": obs["id"],
            "session_ref": None,
            "baseline_minutes": cdisp,
            "estimation_method": cmethod,
            "acceptance": "inferred",
            "acceptance_path": "inferred",
            "acceptance_basis": cbasis,
            "displaced_minutes": cdisp,
            "notes": json.dumps({"has_artifact": has_artifact, "bucket": cbucket}),
        }
        out = await _upsert_nar_entry(config, entry)
        if out.get("reason") == "endpoint_not_deployed":
            results["entries_skipped"] += 1
        else:
            results["entries_written"] += 1
        if cdisp is not None:
            results["displaced_minutes"] += cdisp

    # ── Engaged time (validation figure, not written to nar_entry) ────
    results["engaged_ms"] = cluster_bursts(all_timestamps_ms, GAP_MS, FLOOR_MS)
    results["engaged_hours"] = round(results["engaged_ms"] / 3_600_000, 3)
    results["displaced_hours"] = round(results["displaced_minutes"] / 60.0, 3)

    activity.logger.info(
        "nar_recap: date=%s sessions=%d decisions=%d chores=%d "
        "entries=%d displaced=%.1fmin engaged=%.2fh",
        day_iso,
        results["sessions_processed"],
        results["decisions_processed"],
        results["chore_runs_processed"],
        results["entries_written"],
        results["displaced_minutes"],
        results["engaged_hours"],
    )
    return results
