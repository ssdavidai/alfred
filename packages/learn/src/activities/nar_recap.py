"""NAR daily recap — classification layer + main activity (#584).

Reads pre-processed data from ``nar_data`` (pure reading/plumbing layer,
no clerk dependency) and uses the Hermes clerk to classify displacement
buckets for sessions and chore artifacts, then writes ``nar_entry`` rows
via ``POST /api/v1/state/nar-entries`` (ctrl-api, Lane I prerequisite).

Split from a monolithic 720-line module to keep both halves under the
600-LOC CI ceiling.  The data layer (``nar_data``) is independently
testable without the Temporal or clerk environments.
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import date, datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.activities.clerk import _call_clerk, _extract_json
from src.activities.nar_data import (
    BUCKET_MINUTES,
    FLOOR_MS,
    GAP_MS,
    HUMAN_SOURCES,  # noqa: F401 — re-exported for backward compat
    SUPPRESSION_RATE_MINUTES,
    VALID_BUCKETS,
    _ctrl_headers,
    _extract_session_context,
    _get_chore_runs,
    _get_human_sessions,
    _get_principal_decisions,
    _iso,
    _open_session_db,
    _VIGILANCE_TOKENS,
    cluster_bursts,
)
from src.config import load_config

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Session bucket classification (uses ask/delivery/failure_note framing).
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


# ---------------------------------------------------------------------------
# Chore bucket classification (autonomous, no conversation framing).
# ---------------------------------------------------------------------------

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


def _chore_is_vigilance_sweep(obs: dict[str, Any]) -> bool:
    """Return True if this chore ran, checked and found nothing actionable.

    Vigilance sweeps take the suppression rate per the NAR method doc (§1c) —
    they must never reach the bucket classifier.  Replaces the original
    ``_chore_has_artifact`` which returned True for "50 signals, no urgent
    notification", causing systematic over-counting.
    """
    body = str(obs.get("detail", "") or obs.get("summary", "")).lower()
    return any(tok in body for tok in _VIGILANCE_TOKENS)


# ---------------------------------------------------------------------------
# nar_entry upsert.
# ---------------------------------------------------------------------------

async def _upsert_nar_entry(config: Any, entry: dict[str, Any]) -> dict[str, Any]:
    """POST to /api/v1/state/nar-entries — upserts on dedup_key.

    Body shape: ``{"entries": [entry]}`` — the Lane I endpoint accepts a
    batch; we send single-entry batches per call so the caller loop stays
    simple.  Lane I endpoint merged and deployed as of PR #584 prerequisite:
    404/405 fallback retained for staging/canary environments that may not
    yet have the deploy.
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
                    "nar_recap: /api/v1/state/nar-entries not deployed — "
                    "dedup_key=%s logged only",
                    entry.get("dedup_key"),
                )
                return {"ok": False, "reason": "endpoint_not_deployed", "dedup_key": entry.get("dedup_key")}
            raise


# ---------------------------------------------------------------------------
# Main activity.
# ---------------------------------------------------------------------------

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

            # Acceptance depends on outcome (method doc §1b + §563):
            # failed/blocked → rejected, displaced forced to 0;
            # work delivered (bucket ≠ none) → accepted via inferred path;
            # discussion only (bucket = none) → unknown, no minutes claimed.
            if bucket_info.get("is_failed"):
                displaced = 0.0
                acc: str = "rejected"
                acc_path: str | None = "inferred"
                est_method: str | None = "model-estimate"
            elif displaced is not None:
                acc = "accepted"
                acc_path = "inferred"
                est_method = "model-estimate"
            else:
                acc = "unknown"
                acc_path = None
                est_method = None

            started_at = float(sess.get("started_at") or 0.0)
            occurred_at = datetime.fromtimestamp(started_at, tz=timezone.utc).isoformat()
            dedup_key = f"nar:session:{sess['id']}:{day_iso}"

            entry: dict[str, Any] = {
                "id": str(uuid.uuid5(uuid.NAMESPACE_DNS, dedup_key)),
                "dedup_key": dedup_key,
                "occurred_at": occurred_at,
                "action_class": "conversational",
                "summary": f"Session {sess['id'][:12]} ({sess['source']}) — bucket {bucket}",
                "evidence_kind": "session",
                "evidence_ref": sess["id"],
                "session_ref": sess["id"],
                "baseline_minutes": displaced,
                "estimation_method": est_method,
                "acceptance": acc,
                "acceptance_path": acc_path,
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
        decisions = await _get_principal_decisions(config.alfred_ctrl_url, since, until)
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
            "id": str(uuid.uuid5(uuid.NAMESPACE_DNS, dedup_key)),
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
        chore_obs = await _get_chore_runs(config.alfred_ctrl_url, since, until)
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
            # the bucket classifier.  The chore DID run and DID do real work
            # (checking is the work) so acceptance = accepted, inferred.
            cbucket = "none"
            cdisp: float | None = SUPPRESSION_RATE_MINUTES
            cmethod: str | None = "standard-time"
            cacc: str = "accepted"
            cacc_path: str | None = "inferred"
            cbasis = f"chore '{chore_name}' vigilance sweep — suppression rate"
            has_artifact = False
        else:
            # Artifact chore — use the chore-specific classifier (not the session
            # classifier, which models ask/delivery pairs and has no user turn).
            binfo = await _classify_chore_bucket(detail, chore_name)
            cbucket = binfo["bucket"]
            # Same three-way acceptance split as sessions:
            if binfo.get("is_failed"):
                cdisp = 0.0
                cmethod = "model-estimate"
                cacc, cacc_path = "rejected", "inferred"
            else:
                cdisp = BUCKET_MINUTES.get(cbucket)
                if cdisp is not None:
                    cmethod = "model-estimate"
                    cacc, cacc_path = "accepted", "inferred"
                else:
                    cmethod = None
                    cacc, cacc_path = "unknown", None
            cbasis = f"chore '{chore_name}' artifact — {binfo.get('reasoning', '')}"
            has_artifact = binfo.get("has_artifact", False)

        entry = {
            "id": str(uuid.uuid5(uuid.NAMESPACE_DNS, dedup_key)),
            "dedup_key": dedup_key,
            "occurred_at": ts_str,
            "action_class": "chore_run",
            "summary": f"Chore {chore_name}: {'artifact' if has_artifact else 'vigilance'}",
            "evidence_kind": "chore_run",
            "evidence_ref": obs["id"],
            "session_ref": None,
            "baseline_minutes": cdisp,
            "estimation_method": cmethod,
            "acceptance": cacc,
            "acceptance_path": cacc_path,
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
