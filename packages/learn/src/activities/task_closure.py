"""TaskClosureWatcher activities — match inbound signals to open tasks.

The forward path (signal → needs_attention → click → decision → task)
has been wired since ARCH-11. The reverse path — inbound signal
satisfies a previously-opened task, so the task should close itself —
did not exist. This module is the backward arrow.

Per-tick flow:

  1. ``list_open_tasks`` — every task with state ∈ {pending, open,
     in_progress, todo} AND archived ≠ true. Filtered by ctrl-api.
  2. ``list_recent_matter_signals`` — for a given matter, signals
     created within the lookback window (default 30 min). We pre-bin
     by matter so the clerk's pair-up only happens within a matter,
     never across matters (drastic combinatorial cut, plus a stronger
     prior).
  3. ``assess_closure`` — clerk call. Given (task name + current_state)
     and (signal headline + body + kind), return JSON:
     ``{ closes: bool, confidence: 0..1, reasoning: str }``.
     Confidence ≥ ``HIGH_CONFIDENCE_THRESHOLD`` → auto-close.
  4. ``write_closure_decision`` — POST a decision via ctrl-api with
     intent=done, source=task, source_record=task/<id>.md,
     evidence=signal/<sig>.md, decision_origin=signal/<sig>.md.
     The DecisionRouterWorkflow (#231-#232) picks the decision up on
     its next 60s tick and flips the underlying task to state=done
     via its existing intent=done side-effect path — we don't double-
     write the task here.

Idempotency: this v1 does NOT track per-pair check history. It re-asks
the clerk on overlapping intervals. Worst case is a few wasted LLM
calls when a no-match pair keeps re-appearing; the auto-close is gated
on confidence so a false positive would need two consecutive runs to
agree, which is vanishingly unlikely on stable data. A future revision
can stamp ``closure_check_attempted_at`` on signals once we see the
re-check rate hurts.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from temporalio import activity

from src.activities.clerk import _call_clerk
from src.activities.state_mutator import (
    ObservedWindow,
    ProposedMutation,
    apply_state_change_v2,
    propose_fn,
)
from src.config import load_config


logger = logging.getLogger("task-closure")


HIGH_CONFIDENCE_THRESHOLD = 0.80
DEFAULT_SIGNAL_LOOKBACK_MIN = 30


# ---------------------------------------------------------------------------
# Closure predicates (LIFECYCLE-4) — deterministic fast-path.
# ---------------------------------------------------------------------------
#
# A task may carry a structured ``closure_predicate`` in its frontmatter,
# emitted at task-creation time by signal_extract / curator when the task
# has a natural completion event. The predicate is matched against
# inbound signals before the LLM clerk is asked — saves a clerk call,
# and a predicate match is auditable (deterministic + traceable).
#
# Predicate shape (frontmatter YAML):
#
#   closure_predicate:
#     kind: <one of the recognised kinds below>
#     fields:
#       <kind-specific match fields>
#
# Recognised kinds:
#
#   * gmail_thread_reply
#       fields: { thread_id: <str> }
#       matches a signal with source_type=composio-gmail-* whose
#       ``thread_id`` or raw.thread_id equals the given value.
#
#   * gmail_from_subject
#       fields: { from: <str email>, subject_contains: <str> }
#       matches a gmail signal whose ``from`` matches and whose subject
#       contains the substring (case-insensitive).
#
#   * calendar_event_accepted
#       fields: { event_id: <str> }
#       matches a googlecalendar signal with status=accepted on the
#       given event_id.
#
#   * payment_to_merchant
#       fields: { merchant: <str>, amount_min: <number?> }
#       matches a Sure / payments signal whose merchant contains the
#       string and (optionally) whose amount >= amount_min.
#
# Unrecognised predicate kinds are NOT auto-closed — they fall through
# to the LLM matcher. Same for missing predicates.


def _str_eq_ci(a: Any, b: Any) -> bool:
    return str(a or "").strip().lower() == str(b or "").strip().lower()


def _str_contains_ci(haystack: Any, needle: Any) -> bool:
    if not needle:
        return False
    return str(needle).strip().lower() in str(haystack or "").lower()


def _gmail_thread_match(predicate_fields: dict[str, Any], signal_fm: dict[str, Any]) -> bool:
    expected = str(predicate_fields.get("thread_id", "")).strip()
    if not expected:
        return False
    raw = signal_fm.get("raw") or {}
    if isinstance(raw, dict):
        for k in ("thread_id", "threadId"):
            if _str_eq_ci(raw.get(k), expected):
                return True
    for k in ("thread_id", "threadId"):
        if _str_eq_ci(signal_fm.get(k), expected):
            return True
    return False


def _gmail_from_subject_match(predicate_fields: dict[str, Any], signal_fm: dict[str, Any]) -> bool:
    expected_from = str(predicate_fields.get("from", "")).strip()
    expected_subject_sub = str(predicate_fields.get("subject_contains", "")).strip()
    if not expected_from or not expected_subject_sub:
        return False
    raw = signal_fm.get("raw") or {}
    sender = ""
    subject = ""
    if isinstance(raw, dict):
        sender = str(raw.get("from") or raw.get("sender") or "")
        subject = str(raw.get("subject") or "")
    sender = sender or str(signal_fm.get("from") or "")
    subject = subject or str(signal_fm.get("subject") or signal_fm.get("display_headline") or "")
    return _str_eq_ci(sender, expected_from) and _str_contains_ci(subject, expected_subject_sub)


def _calendar_accept_match(predicate_fields: dict[str, Any], signal_fm: dict[str, Any]) -> bool:
    expected = str(predicate_fields.get("event_id", "")).strip()
    if not expected:
        return False
    raw = signal_fm.get("raw") or {}
    event_id = ""
    status = ""
    if isinstance(raw, dict):
        event_id = str(raw.get("event_id") or raw.get("id") or "")
        status = str(raw.get("response_status") or raw.get("status") or "")
    if not _str_eq_ci(event_id, expected):
        return False
    return status.lower() in ("accepted", "yes")


def _payment_match(predicate_fields: dict[str, Any], signal_fm: dict[str, Any]) -> bool:
    expected_merchant = str(predicate_fields.get("merchant", "")).strip()
    if not expected_merchant:
        return False
    raw = signal_fm.get("raw") or {}
    merchant = ""
    amount = None
    if isinstance(raw, dict):
        merchant = str(raw.get("merchant") or raw.get("payee") or raw.get("description") or "")
        amount_raw = raw.get("amount")
        try:
            amount = float(amount_raw) if amount_raw is not None else None
        except (TypeError, ValueError):
            amount = None
    if not _str_contains_ci(merchant, expected_merchant):
        return False
    amount_min = predicate_fields.get("amount_min")
    if amount_min is not None and amount is not None:
        try:
            if amount < float(amount_min):
                return False
        except (TypeError, ValueError):
            pass
    return True


_PREDICATE_KINDS: dict[str, Any] = {
    "gmail_thread_reply": _gmail_thread_match,
    "gmail_from_subject": _gmail_from_subject_match,
    "calendar_event_accepted": _calendar_accept_match,
    "payment_to_merchant": _payment_match,
}


def evaluate_predicate(
    predicate: Any, signal_fm: dict[str, Any],
) -> dict[str, Any] | None:
    """Run a closure predicate against a signal's frontmatter.

    Returns ``{"closes": bool, "confidence": float, "reasoning": str}``
    on a recognised match, or ``None`` to indicate the predicate
    didn't apply and the caller should fall back to the LLM matcher.

    A predicate match returns confidence=1.0 — the predicate is
    structured and deterministic, so we trust it. ``reasoning`` is
    ``"predicate:<kind>"`` so the closure decision body records which
    rule fired.
    """
    if not isinstance(predicate, dict):
        return None
    kind = str(predicate.get("kind", "")).strip()
    if not kind:
        return None
    fn = _PREDICATE_KINDS.get(kind)
    if fn is None:
        return None
    fields = predicate.get("fields") or {}
    if not isinstance(fields, dict):
        return None
    try:
        matched = bool(fn(fields, signal_fm))
    except Exception as exc:  # noqa: BLE001
        logger.warning("evaluate_predicate(%s) raised: %s", kind, exc)
        return None
    if not matched:
        return {
            "closes": False,
            "confidence": 1.0,
            "reasoning": f"predicate:{kind}:no_match",
        }
    return {
        "closes": True,
        "confidence": 1.0,
        "reasoning": f"predicate:{kind}",
    }


# ---------------------------------------------------------------------------
# Data shapes (kept module-local; Temporal serialises plain dicts/lists).
# ---------------------------------------------------------------------------


@dataclass
class OpenTask:
    path: str
    stem: str
    name: str
    matter_ref: str  # canonical "matter/<id>.md" or "" if unrouted
    current_state: str
    as_of: str


@dataclass
class CandidateSignal:
    path: str
    stem: str
    headline: str
    body: str
    kind: str
    created: str


# ---------------------------------------------------------------------------
# ctrl-api helper — module-local to avoid coupling to the heavier
# VaultClient in alfred-learn (which is sync-only in places).
# ---------------------------------------------------------------------------


def _ctrl_headers() -> dict[str, str]:
    import os
    return {"Authorization": f"Bearer {os.environ.get('AAS_API_KEY', '')}"}


def _ctrl_base() -> str:
    return load_config().alfred_ctrl_url


def _is_archived_fm(fm: dict[str, Any]) -> bool:
    if fm.get("archived") is True:
        return True
    if str(fm.get("archived", "")).lower() == "true":
        return True
    state = str(fm.get("state", "")).lower().strip()
    if state in ("archived", "done", "completed", "complete"):
        return True
    status = str(fm.get("status", "")).lower().strip()
    if status in ("archived", "cancelled", "canceled", "completed", "complete", "done"):
        return True
    return False


def _extract_matter_ref(fm: dict[str, Any]) -> str:
    """Return canonical 'matter/<id>.md' or '' if no clean matter linkage."""
    for k in ("matter", "parent_matter", "project"):
        v = fm.get(k)
        if not v:
            continue
        s = str(v).strip()
        if not s or s == "null":
            continue
        if s.startswith("matter/"):
            return s if s.endswith(".md") else s + ".md"
        return f"matter/{s}.md"
    return ""


# ---------------------------------------------------------------------------
# Activities
# ---------------------------------------------------------------------------


@activity.defn
async def list_open_tasks() -> list[dict[str, Any]]:
    """Return the open task population from ctrl-api as a list of dicts.

    Open = state ∈ {pending, open, in_progress, todo, ""} AND not in
    any archived/done/cancelled convention. Tasks without a matter
    linkage are dropped — without a matter to bound the candidate
    signals we'd be matching against the whole world.
    """
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{_ctrl_base()}/api/v1/vault/list/task",
            headers=_ctrl_headers(),
        )
        resp.raise_for_status()
    data = resp.json()
    results = data.get("results", []) or []
    out: list[dict[str, Any]] = []
    for r in results:
        fm = r.get("frontmatter", {}) or {}
        if _is_archived_fm(fm):
            continue
        matter_ref = _extract_matter_ref(fm)
        if not matter_ref:
            continue
        path = r.get("path") or r.get("relPath") or ""
        if not path:
            continue
        stem = (
            r.get("stem")
            or path.removeprefix("task/").removesuffix(".md")
        )
        name = (
            str(fm.get("name") or fm.get("title") or fm.get("subject") or stem)
            .strip()
        )
        out.append({
            "path": path,
            "stem": stem,
            "name": name,
            "matter_ref": matter_ref,
            "current_state": str(fm.get("current_state") or "").strip(),
            "as_of": str(fm.get("as_of") or "").strip(),
            "closure_predicate": fm.get("closure_predicate"),
        })
    logger.info("list_open_tasks: %d open tasks", len(out))
    return out


@activity.defn
async def list_recent_signals(lookback_min: int = DEFAULT_SIGNAL_LOOKBACK_MIN) -> list[dict[str, Any]]:
    """Return signals created within the lookback window.

    We don't pre-filter by matter here — the workflow does the per-matter
    pair-up after collecting both halves. This way a single GET fetches
    the signal slice and the workflow does the join in memory.

    Storage cutover (#27): signals are state.db rows — query ctrl-api's
    /api/v1/state/signals (windowed via ``since``) instead of walking
    vault/signal/. ``path`` / ``stem`` are now the state.db signal ULID
    (the cross-record key), not a markdown path.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=lookback_min)
    from src.config import load_config
    from src.utils.signal_state import StateClient, signal_row_to_record

    cfg = load_config()
    async with StateClient(cfg) as sc:
        rows = await sc.list_signals(since=cutoff.isoformat(), limit=10_000)
    results = [signal_row_to_record(r) for r in rows]
    out: list[dict[str, Any]] = []
    for r in results:
        fm = r.get("frontmatter", {}) or {}
        created_raw = str(fm.get("created") or "").strip()
        if not created_raw:
            continue
        try:
            created = datetime.fromisoformat(created_raw.replace("Z", "+00:00"))
        except ValueError:
            continue
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        if created < cutoff:
            continue
        path = r.get("id") or r.get("path") or ""
        if not path:
            continue
        # Per-signal matter targets: target_candidates is the canonical
        # field from signal_extract. Multiple matters are possible.
        matters: list[str] = []
        candidates = fm.get("target_candidates")
        if isinstance(candidates, list):
            for c in candidates:
                if not isinstance(c, dict):
                    continue
                tp = str(c.get("path") or "").strip()
                if tp.startswith("matter/"):
                    matters.append(tp if tp.endswith(".md") else tp + ".md")
        out.append({
            "path": path,
            # ``stem`` is the cross-record key — now the state.db
            # signal ULID, identical to ``path``.
            "stem": path,
            "headline": str(fm.get("display_headline") or "").strip(),
            "body": str(fm.get("display_body") or fm.get("raw_quote") or "")[:1000],
            "kind": str(fm.get("source_type") or "").strip(),
            "created": created_raw,
            "matter_refs": matters,
            # Surface the full frontmatter for predicate matching. Limit
            # to a slim set of fields to keep the workflow payload small —
            # this is what the predicate evaluator actually reads.
            "fm": {
                "raw": fm.get("raw"),
                "thread_id": fm.get("thread_id"),
                "from": fm.get("from"),
                "subject": fm.get("subject"),
                "source_type": fm.get("source_type"),
                "display_headline": fm.get("display_headline"),
            },
        })
    logger.info(
        "list_recent_signals: %d signals in last %d min", len(out), lookback_min,
    )
    return out


@activity.defn
async def assess_closure_predicate(
    task: dict[str, Any],
    signal: dict[str, Any],
) -> dict[str, Any] | None:
    """Activity wrapper around ``evaluate_predicate`` for the workflow.

    Returns the same shape as ``assess_closure`` (closes/confidence/
    reasoning) on a recognised match, or ``None`` if no predicate
    applies — caller falls back to the LLM matcher in that case.
    """
    predicate = task.get("closure_predicate")
    if predicate is None:
        return None
    signal_fm = signal.get("fm") or {}
    return evaluate_predicate(predicate, signal_fm)


@activity.defn
async def assess_closure(
    task: dict[str, Any],
    signal: dict[str, Any],
) -> dict[str, Any]:
    """Ask the clerk whether this signal closes this task.

    Returns ``{"closes": bool, "confidence": float, "reasoning": str}``.
    On parse failure the result is ``{"closes": false, "confidence":
    0.0, "reasoning": "parse_failure"}`` — we never auto-close on
    uncertainty.
    """
    prompt = f"""You are evaluating whether an inbound signal satisfies an open task.

OPEN TASK
=========
name: {task.get("name", "")}
current_state: {task.get("current_state", "(none)")}

INBOUND SIGNAL
==============
headline: {signal.get("headline", "")}
kind: {signal.get("kind", "")}
body:
{signal.get("body", "")}

QUESTION: Does this signal complete or otherwise satisfy the task?
A signal "satisfies" a task when the real-world thing the task was
waiting for has happened. Examples:
  - Task "Pay the Example Co invoice" + Signal kind=payment_confirmed
    referencing the same invoice → satisfies.
  - Task "RSVP to Tuesday lunch" + Signal kind=calendar_response_accepted
    for that event → satisfies.
  - Task "Reply to Anna's question" + Signal kind=gmail_sent reply
    to that thread → satisfies.
A loose topical match is NOT enough. The signal must represent the
specific completing event.

Respond with ONLY a JSON object on a single line:
{{"closes": true|false, "confidence": <0.0 to 1.0>, "reasoning": "<one sentence>"}}"""

    try:
        result = await _call_clerk(prompt)
    except Exception as exc:  # noqa: BLE001
        logger.warning("assess_closure: clerk error: %s", exc)
        return {"closes": False, "confidence": 0.0, "reasoning": f"clerk_error: {exc}"[:200]}

    # _call_clerk returns dict on parse success, str on raw — try to coerce.
    if isinstance(result, dict):
        return {
            "closes": bool(result.get("closes", False)),
            "confidence": float(result.get("confidence", 0.0) or 0.0),
            "reasoning": str(result.get("reasoning", ""))[:500],
        }
    if isinstance(result, str):
        try:
            parsed = json.loads(result.strip())
            return {
                "closes": bool(parsed.get("closes", False)),
                "confidence": float(parsed.get("confidence", 0.0) or 0.0),
                "reasoning": str(parsed.get("reasoning", ""))[:500],
            }
        except (json.JSONDecodeError, AttributeError, ValueError):
            pass
    return {"closes": False, "confidence": 0.0, "reasoning": "parse_failure"}


@activity.defn
async def write_closure_decision(
    task: dict[str, Any],
    signal: dict[str, Any],
    assessment: dict[str, Any],
) -> dict[str, Any]:
    """POST a decision record via ctrl-api closing this task.

    The DecisionRouterWorkflow does the actual task-state flip on its
    next tick. We just write the gesture and let the existing wire
    propagate.
    """
    body = {
        "source": "task",
        "source_record": task.get("path", ""),
        "intent": "done",
        "source_headline": task.get("name", ""),
        "note": (
            f"auto-closed by signal {signal.get('stem', '')}: "
            f"{assessment.get('reasoning', '')}"[:500]
        ),
        "matter_ref": task.get("matter_ref", "") or None,
        # Provenance — the cross-record key is the state.db signal id
        # (storage cutover #27), not a vault path.
        "decision_origin": str(signal.get("stem", "")),
        "evidence": str(signal.get("stem", "")),
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{_ctrl_base()}/api/v1/decisions",
            headers={**_ctrl_headers(), "Content-Type": "application/json"},
            json=body,
        )
        try:
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            logger.warning("write_closure_decision failed: %s body=%s", exc, resp.text[:300])
            return {"ok": False, "error": str(exc)[:200]}
    return {"ok": True, "decision": resp.json().get("decision", {})}


# ---------------------------------------------------------------------------
# SM-D-W4 — state-mutator v2 propose function + activity wrapper.
# ---------------------------------------------------------------------------
#
# The legacy ``write_closure_decision`` writes a ``decision/<ts>.md``
# record (intent=done, source=task, evidence=signal). That record is
# the audit trail and feeds OBS-1's observation extraction. It does
# NOT, however, flip the task's frontmatter — the universal contract
# (STATE-MUTATION.md §7 W4) is what actually closes the task by
# routing the ``status="closed" + outcome="..."`` mutation through
# ``state_mutator.apply_state_change_v2``. The decision record stays
# alongside the v2 write so existing consumers (observation pool,
# /decisions feed) keep working unchanged.
#
# The propose function is keyed on the matcher's verdict — predicate
# hit or clerk assessment, both shapes are ``{closes, confidence,
# reasoning}``. ``confidence`` flows directly into the v2 envelope so
# the mode-resolution gate in ``apply_state_change_v2`` can still
# treat sub-threshold writes as ``pending_confirmation`` even though
# the workflow already gated on ``HIGH_CONFIDENCE_THRESHOLD`` (which
# is stricter — keeping the v2 default gate on as a safety belt).


@propose_fn("task_closure.match")
async def propose_task_closure(
    *,
    target: dict[str, Any],
    observed: ObservedWindow,
    args: dict[str, Any],
) -> ProposedMutation | None:
    """Translate a matched (task, signal, assessment) into a closure mutation.

    ``args`` carries:
      * ``signal_path`` (str) — the inbound signal that satisfied the task
      * ``signal_stem`` (str) — short id for the outcome string
      * ``assessment`` (dict) — ``{closes, confidence, reasoning}``

    Returns ``None`` when the assessment doesn't actually close the
    task (defensive — the workflow already filters on ``closes=True``
    + ``confidence >= HIGH_CONFIDENCE_THRESHOLD``, but the propose
    function re-asserts so it's safe to call out-of-band). Otherwise
    proposes ``status="closed"`` + ``outcome=<one-line summary>`` with
    the assessment's confidence; the mode-resolution gate inside
    ``apply_state_change_v2`` handles sub-threshold downgrades.

    The propose function is deliberately read-light — it does not
    re-read the task frontmatter. ``apply_state_change_v2`` already
    runs ``read_target`` immediately before invoking us; that snapshot
    is what ``target`` carries. We short-circuit when the task is
    already ``closed`` so a duplicate signal in the lookback window
    doesn't re-emit an identical state_change audit on the next tick.
    """
    assessment = args.get("assessment") or {}
    if not isinstance(assessment, dict):
        return None
    if not bool(assessment.get("closes")):
        return None

    confidence_raw = assessment.get("confidence", 0.0)
    try:
        confidence = float(confidence_raw or 0.0)
    except (TypeError, ValueError):
        confidence = 0.0
    if confidence <= 0.0:
        return None

    # If the task is already closed/archived, skip — duplicate inbound
    # signals during the lookback window shouldn't re-stamp the audit.
    fm = target.get("frontmatter") or {}
    if isinstance(fm, dict):
        current_status = str(fm.get("status") or "").strip().lower()
        if current_status in ("closed", "archived", "cancelled", "canceled", "done"):
            return None

    signal_stem = str(args.get("signal_stem") or "").strip()
    signal_path = str(args.get("signal_path") or "").strip()
    reasoning = str(assessment.get("reasoning") or "").strip()

    outcome = (
        f"auto-closed by signal {signal_stem}: {reasoning}"
        if signal_stem else f"auto-closed: {reasoning}"
    )[:500]

    reason = (
        f"TaskClosureWatcher matched signal {signal_path!r} against open "
        f"task; assessment closes=true confidence={confidence:.2f}: "
        f"{reasoning}"
    )[:500]

    return ProposedMutation(
        fields={"status": "closed", "outcome": outcome},
        reason=reason,
        confidence=confidence,
        fan_out=(),
    )


@activity.defn
async def apply_task_closure_v2(
    task_path: str,
    signal_path: str,
    signal_stem: str,
    assessment: dict[str, Any],
    mode: str = "live",
) -> dict[str, Any]:
    """Workflow-callable wrapper around ``apply_state_change_v2`` for closure.

    Returns a small dict (``applied``, ``audit_record_path``,
    ``timeline_entry_id``, ``new_as_of``, ``effective_mode``,
    ``pending_confirmation``) so the workflow can log + count without
    having to deserialise the full ``MutationResult`` dataclass.

    Failures from the underlying v2 call are caught and surfaced as
    ``{applied: False, error: <str>}`` so a transient ctrl-api blip on
    one task in the pair list doesn't break the rest of the tick.
    """
    if mode not in ("shadow", "live"):
        mode = "live"

    now = datetime.now(timezone.utc)
    observed = ObservedWindow(
        start=now,
        end=now,
        signal_paths=[signal_path] if signal_path else [],
        decision_paths=[],
        other_refs=[],
    )

    try:
        result = await apply_state_change_v2(
            target_path=task_path,
            source="task_closure.match",
            observed=observed,
            propose_fn_name="task_closure.match",
            propose_fn_args={
                "signal_path": signal_path,
                "signal_stem": signal_stem,
                "assessment": dict(assessment) if isinstance(assessment, dict) else {},
            },
            mode=mode,  # type: ignore[arg-type]
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "task_closure.apply_task_closure_v2: v2 call failed task=%s "
            "signal=%s err=%s",
            task_path, signal_path, exc,
        )
        return {"applied": False, "error": str(exc)[:300]}

    return {
        "applied": bool(result.applied),
        "audit_record_path": result.audit_record_path,
        "timeline_entry_id": result.timeline_entry_id,
        "new_as_of": result.new_as_of,
        "effective_mode": result.effective_mode,
        "pending_confirmation": result.pending_confirmation,
    }
