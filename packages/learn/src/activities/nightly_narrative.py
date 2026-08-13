"""Activities backing the NightlyNarrativeWorkflow (RFC #884, Alfred Black 1.0).

This is the model-driven narrative layer described in Layer 4 of the
production spec. Each night the workflow walks every matter and asks
the clerk to write a 2-4 sentence ``current_state`` paragraph
describing where the matter stands today, given:

  * the signals routed to that matter in the last 24h, and
  * the task transitions that happened on tasks owned by that matter.

The composed narrative gets patched into the matter's frontmatter via
``patch_matter_narrative`` so the daily-digest composer (Workflow 3)
can read it directly instead of re-walking the same events.

Idempotency:
  * If the matter saw zero signals AND zero task transitions in the
    last 24h AND already has a ``current_state``, the workflow skips
    the LLM entirely. Cold-start exception (#564): if
    ``current_state`` is absent the LLM runs to write the first
    narrative; subsequent runs then short-circuit normally.

All vault writes go through the ctrl-api VaultClient — never direct
filesystem writes. All LLM calls go through the OpenClaw gateway via
``clerk._call_clerk`` — never direct Anthropic API. These are the
two non-negotiable rules from ``CLAUDE.md``.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from temporalio import activity

from src.activities.clerk import _call_clerk
from src.activities.state_mutator import (
    MutatorContentionError,
    ObservedWindow,
    ProposedMutation,
    apply_state_change_v2,
    propose_fn,
)
from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


# How far back the nightly run looks. The spec says "last 24h"; we read
# this as a UTC delta so the cron-fired clock (02:00 local) doesn't
# tilt the window when the tenant timezone shifts at DST boundaries.
LOOKBACK_WINDOW = timedelta(hours=24)

# Hard cap on the clerk's response. Matter records render in many
# surfaces (briefing, dashboard, vault preview) so we keep the
# paragraph tight even if the clerk gets chatty. Sliced AFTER the call
# so the activity still returns a usable string when the LLM ignores
# the instruction.
NARRATIVE_CHAR_CAP = 600


@dataclass
class SignalRecord:
    """A signal touching the matter in the lookback window."""

    path: str
    source_type: str
    effect: str
    reasoning: str
    raw_quote: str
    applied_at: str
    source_event_path: str
    target_path: str


@dataclass
class TaskTransition:
    """A task state change observed inside the lookback window."""

    task_path: str
    prior_state: str
    new_state: str
    decision: str
    reasoning: str
    evaluated_at: str
    current_state: str


@dataclass
class EventRecord:
    """A source event back-pointer-expanded from a signal."""

    path: str
    name: str
    body_preview: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso_or_none(ts: Any) -> datetime | None:
    if ts is None:
        return None
    if isinstance(ts, datetime):
        return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
    if not isinstance(ts, str):
        return None
    s = ts.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _normalize_matter_path(matter_path: str) -> str:
    """Coerce a matter reference to canonical ``matter/<slug>.md``."""
    s = (matter_path or "").strip()
    if not s:
        return ""
    s = s.strip('"').strip("'")
    if s.startswith("[[") and s.endswith("]]"):
        s = s[2:-2]
    if s.startswith("vault/"):
        s = s[len("vault/"):]
    if not s.startswith("matter/"):
        s = f"matter/{s}"
    if not s.endswith(".md"):
        s = f"{s}.md"
    return s


def _matter_targets_match(candidates: Any, matter_path: str) -> bool:
    """True iff any candidate entry in the signal points at this matter."""
    if not isinstance(candidates, list):
        return False
    for cand in candidates:
        if isinstance(cand, dict) and str(cand.get("path") or "").strip() == matter_path:
            return True
        if isinstance(cand, str) and cand.strip() == matter_path:
            return True
    return False


def _slug_from_matter_path(matter_path: str) -> str:
    s = (matter_path or "").strip()
    if s.endswith(".md"):
        s = s[:-3]
    if s.startswith("matter/"):
        s = s[len("matter/"):]
    return s


# ---------------------------------------------------------------------------
# Activity: list_active_matters
# ---------------------------------------------------------------------------


@activity.defn
async def list_active_matters() -> list[str]:
    """Enumerate every matter the workflow should refresh tonight.

    Returns canonical ``matter/<slug>.md`` paths for matters whose
    frontmatter ``state`` is not ``"done"``. We don't filter on
    ``status`` (legacy field) because matters use ``state`` per the
    Steward schema; tolerating an absent ``state`` field lets older
    matters still get a narrative refresh while migrations catch up.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        records = await client.list_records("matter", limit=10_000)
    except httpx.HTTPError as exc:
        logger.warning("nightly_narrative.list_active_matters: list failed: %s", exc)
        return []
    finally:
        await client.close()

    out: list[str] = []
    for rec in records:
        if not isinstance(rec, dict):
            continue
        fm = rec.get("frontmatter") or rec
        if not isinstance(fm, dict):
            fm = {}
        state = str(fm.get("state") or "").strip().lower()
        if state == "done":
            continue
        path = str(rec.get("path") or "").strip()
        if not path.startswith("matter/") or not path.endswith(".md"):
            continue
        out.append(path)
    out.sort()
    logger.info("nightly_narrative.list_active_matters: %d active matters", len(out))
    return out


# ---------------------------------------------------------------------------
# Activity: load_matter_signals_24h
# ---------------------------------------------------------------------------


@activity.defn
async def load_matter_signals_24h(matter_path: str) -> list[dict[str, Any]]:
    """Read signal records touching this matter in the last 24h.

    Filter rules:
      * ``target_candidates[].path == matter_path`` (any candidate
        matches; signals carry resolved + unresolved candidates and
        any link counts).
      * ``applied_at`` is within the last 24h. The router stamps
        ``applied_at`` when it actually mutates a target — signals that
        were extracted but never applied still surface here when
        ``target_path`` matches and ``created`` is fresh, so we
        fall back to ``created`` when ``applied_at`` is null.

    Returns a list of dicts (one per signal) suitable for the
    ``generate_matter_narrative`` prompt.
    """
    canonical = _normalize_matter_path(matter_path)
    if not canonical:
        return []

    cutoff = _now_utc() - LOOKBACK_WINDOW

    # Signals are state.db rows (storage cutover #27) — query ctrl-api's
    # /api/v1/state/signals scoped to this matter + 24h window instead
    # of walking vault/signal/.
    config = load_config()
    try:
        from src.utils.signal_state import StateClient, signal_row_to_record

        async with StateClient(config) as sc:
            sig_rows = await sc.list_signals(
                matter=canonical,
                since=cutoff.isoformat(),
                limit=10_000,
            )
        records = [signal_row_to_record(r) for r in sig_rows]
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "nightly_narrative.load_matter_signals_24h: state.db query "
            "failed matter=%s err=%s", canonical, exc,
        )
        return []

    out: list[dict[str, Any]] = []
    for rec in records:
        if not isinstance(rec, dict):
            continue
        fm = rec.get("frontmatter") or {}
        if not isinstance(fm, dict):
            continue
        # Target match — either resolved target_path OR any candidate.
        target_path = str(fm.get("target_path") or "").strip()
        candidates = fm.get("target_candidates")
        if target_path != canonical and not _matter_targets_match(candidates, canonical):
            continue
        # Time match — prefer applied_at, fall back to created.
        ts_raw = fm.get("applied_at") or fm.get("created") or rec.get("created")
        ts = _parse_iso_or_none(ts_raw)
        if ts is None:
            # No usable timestamp — skip rather than guess. Older records
            # without applied_at will be picked up once they get routed.
            continue
        if ts < cutoff:
            continue
        out.append({
            "path": str(rec.get("path") or "").strip(),
            "source_type": str(fm.get("source_type") or "").strip(),
            "effect": str(fm.get("effect") or "").strip(),
            "reasoning": str(fm.get("reasoning") or "").strip()[:500],
            "raw_quote": str(fm.get("raw_quote") or "").strip()[:300],
            "applied_at": str(fm.get("applied_at") or "").strip(),
            "source_event_path": str(fm.get("source_event_path") or "").strip(),
            "target_path": target_path,
        })
    logger.info(
        "nightly_narrative.load_matter_signals_24h: matter=%s found=%d signals (cutoff=%s)",
        canonical, len(out), cutoff.isoformat(timespec="seconds"),
    )
    return out


# ---------------------------------------------------------------------------
# Activity: load_task_transitions_24h
# ---------------------------------------------------------------------------


@activity.defn
async def load_task_transitions_24h(matter_path: str) -> list[dict[str, Any]]:
    """Read tasks linked to this matter whose state changed in 24h.

    A "transition" is any task whose ``last_steward_outcome.evaluated_at``
    is inside the lookback window. We don't try to diff prior_state
    against new_state — Steward already gates ``apply_state_change`` on
    a meaningful decision, so every fresh outcome with ``decision
    != "still_active"`` qualifies. ``still_active`` entries are filtered
    out so the narrative doesn't conflate "I checked and nothing moved"
    with "something actually changed".
    """
    canonical = _normalize_matter_path(matter_path)
    if not canonical:
        return []

    config = load_config()
    client = VaultClient(config)
    try:
        try:
            records = await client.list_records("task", limit=10_000)
        except httpx.HTTPError as exc:
            logger.warning(
                "nightly_narrative.load_task_transitions_24h: list failed matter=%s err=%s",
                canonical, exc,
            )
            return []
    finally:
        await client.close()

    cutoff = _now_utc() - LOOKBACK_WINDOW

    out: list[dict[str, Any]] = []
    for rec in records:
        if not isinstance(rec, dict):
            continue
        fm = rec.get("frontmatter") or {}
        if not isinstance(fm, dict):
            continue
        # Parent matter filter (canonical compare).
        parent = str(fm.get("parent_matter") or fm.get("matter") or "").strip()
        if parent and not parent.startswith("matter/"):
            parent = f"matter/{parent}" if not parent.startswith("matter/") else parent
        if not parent.endswith(".md") and parent:
            parent = f"{parent}.md"
        if parent != canonical:
            continue
        outcome = fm.get("last_steward_outcome")
        if not isinstance(outcome, dict):
            continue
        decision = str(outcome.get("decision") or "").strip().lower()
        # ``still_active`` is a no-op decision — filter it out so we only
        # surface real state-shifting transitions to the clerk.
        if decision in ("", "still_active"):
            continue
        evaluated_at = outcome.get("evaluated_at")
        ts = _parse_iso_or_none(evaluated_at)
        if ts is None or ts < cutoff:
            continue
        out.append({
            "task_path": str(rec.get("path") or "").strip(),
            "prior_state": "",  # unavailable post-mutation; clerk works without it
            "new_state": str(fm.get("state") or "").strip(),
            "decision": decision,
            "reasoning": str(outcome.get("reasoning") or "").strip()[:300],
            "evaluated_at": str(evaluated_at or "").strip(),
            "current_state": str(fm.get("current_state") or "").strip()[:300],
        })
    logger.info(
        "nightly_narrative.load_task_transitions_24h: matter=%s found=%d transitions",
        canonical, len(out),
    )
    return out


# ---------------------------------------------------------------------------
# Activity: load_source_events
# ---------------------------------------------------------------------------


@activity.defn
async def load_source_events(signal_paths: list[str]) -> list[dict[str, Any]]:
    """Back-pointer expand a list of signals into their source events.

    For each signal we read ``signal.source_event_path`` and fetch the
    referenced event/stream_event record. Failures (404, transport) are
    swallowed per-record so one missing source doesn't break the
    nightly run. Results are deduplicated by path.
    """
    if not signal_paths:
        return []

    config = load_config()
    client = VaultClient(config)
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    try:
        # Read each signal once to discover its source_event_path, then
        # fetch the source. The caller already loaded signal frontmatter
        # via load_matter_signals_24h so this could be folded in to save
        # a round-trip — keeping them separate keeps the activity
        # surfaces matching the spec.
        for sig_path in signal_paths:
            if not sig_path or sig_path in seen:
                continue
            seen.add(sig_path)
            try:
                sig_rec = await client.read_record(sig_path)
            except httpx.HTTPError:
                continue
            sig_fm = (sig_rec.get("frontmatter") or {}) if isinstance(sig_rec, dict) else {}
            source_event_path = str(sig_fm.get("source_event_path") or "").strip()
            if not source_event_path or source_event_path in seen:
                continue
            seen.add(source_event_path)
            try:
                evt_rec = await client.read_record(source_event_path)
            except httpx.HTTPError:
                continue
            if not isinstance(evt_rec, dict):
                continue
            evt_fm = evt_rec.get("frontmatter") or {}
            body = str(evt_rec.get("body") or "")
            out.append({
                "path": source_event_path,
                "name": str(evt_fm.get("name") or "").strip()[:160],
                "body_preview": body.strip()[:500],
            })
    finally:
        await client.close()
    logger.info(
        "nightly_narrative.load_source_events: expanded %d signals to %d events",
        len(signal_paths), len(out),
    )
    return out


# ---------------------------------------------------------------------------
# Activity: generate_matter_narrative
# ---------------------------------------------------------------------------


def _build_narrative_prompt(
    matter_summary: dict[str, Any],
    signals: list[dict[str, Any]],
    transitions: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> str:
    """Compose the prompt body sent to the clerk.

    Voice: courteous, precise, lightly old-fashioned — Alfred speaks as
    himself; the clerk drafts on his behalf. We feed the JSON exhibits
    inline so the clerk can pick the right details and we ask for a
    paragraph (no JSON envelope) so the response slots directly into
    frontmatter.
    """
    import json

    matter_name = str(matter_summary.get("name") or matter_summary.get("path") or "").strip()
    prior_state = str(matter_summary.get("current_state") or "").strip()

    lines = [
        "You are Alfred's clerk drafting a one-paragraph status note about a matter.",
        "",
        f"MATTER: {matter_name}",
    ]
    if prior_state:
        lines.append(f"PREVIOUS CURRENT_STATE (for context only): {prior_state}")
    lines.extend([
        "",
        "SIGNALS routed to this matter in the last 24h:",
        json.dumps(signals, indent=2, default=str)[:4000],
        "",
        "TASK TRANSITIONS on this matter in the last 24h:",
        json.dumps(transitions, indent=2, default=str)[:2000],
        "",
        "SOURCE EVENTS (back-pointer expanded from signals):",
        json.dumps(events, indent=2, default=str)[:2000],
        "",
        "Write a 2-4 sentence paragraph in Alfred's voice — courteous,",
        "precise, lightly old-fashioned — describing where the matter",
        "stands today. Reference concrete developments (a paid invoice,",
        "an awaited reply, a draft prepared). Do not speculate beyond",
        "what the signals and transitions show. Address sir as 'sir'",
        f"when appropriate. Hard cap: {NARRATIVE_CHAR_CAP} characters.",
        "Respond with the paragraph only — no JSON, no headers, no quotes.",
    ])
    return "\n".join(lines)


@activity.defn
async def generate_matter_narrative(
    matter_summary: dict[str, Any],
    signals: list[dict[str, Any]],
    transitions: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> str:
    """Single clerk call producing the matter's current_state paragraph.

    Returns the trimmed string; raises on clerk failures so the workflow
    can decide whether to patch or skip.
    """
    prompt = _build_narrative_prompt(matter_summary, signals, transitions, events)
    result = await _call_clerk(prompt, raw=True)
    if not isinstance(result, str):
        # Defensive — raw=True forces _call_clerk to return a string but
        # legacy callers occasionally produce dicts. Stringify so the
        # downstream patch still has SOMETHING to write.
        result = str(result)
    trimmed = result.strip().strip('"').strip("'").strip()
    if len(trimmed) > NARRATIVE_CHAR_CAP:
        trimmed = trimmed[:NARRATIVE_CHAR_CAP].rstrip() + "..."
    return trimmed


# ---------------------------------------------------------------------------
# Activity: patch_matter_narrative
# ---------------------------------------------------------------------------


@activity.defn
async def patch_matter_narrative(
    matter_path: str,
    current_state: str,
    as_of: str,
    signal_count_24h: int,
) -> None:
    """Atomically patch the matter's narrative frontmatter fields.

    Writes three scalar fields:
      * ``current_state`` — the clerk-drafted paragraph
      * ``as_of`` — ISO-8601 timestamp for the rewrite
      * ``signal_count_24h`` — bookkeeping for the next run

    All vault writes go through ctrl-api PATCH per the alfred-learn
    hard rule.
    """
    canonical = _normalize_matter_path(matter_path)
    if not canonical:
        return

    config = load_config()
    client = VaultClient(config)
    try:
        await client.patch_frontmatter(
            canonical,
            {
                "current_state": current_state,
                "as_of": as_of,
                "signal_count_24h": signal_count_24h,
            },
        )
        logger.info(
            "nightly_narrative.patch_matter_narrative: matter=%s signals_24h=%d as_of=%s",
            canonical, signal_count_24h, as_of,
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "nightly_narrative.patch_matter_narrative: PATCH failed matter=%s err=%s",
            canonical, exc,
        )
        raise
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Activity: read_matter_summary
# ---------------------------------------------------------------------------


@activity.defn
async def read_matter_summary(matter_path: str) -> dict[str, Any]:
    """Read the matter record and return a compact summary for the prompt."""
    canonical = _normalize_matter_path(matter_path)
    if not canonical:
        return {"path": "", "name": "", "current_state": ""}

    config = load_config()
    client = VaultClient(config)
    try:
        try:
            rec = await client.read_record(canonical)
        except httpx.HTTPError as exc:
            logger.warning(
                "nightly_narrative.read_matter_summary: read failed matter=%s err=%s",
                canonical, exc,
            )
            return {"path": canonical, "name": _slug_from_matter_path(canonical), "current_state": ""}
    finally:
        await client.close()

    fm = (rec.get("frontmatter") or {}) if isinstance(rec, dict) else {}
    if not isinstance(fm, dict):
        fm = {}
    return {
        "path": canonical,
        "name": str(fm.get("name") or _slug_from_matter_path(canonical)),
        "current_state": str(fm.get("current_state") or "").strip()[:600],
    }


# ---------------------------------------------------------------------------
# Phase C — state-mutator v2 retrofit (SM-C2/C3)
# ---------------------------------------------------------------------------
#
# Under the universal state-mutation contract (#889) every matter
# ``current_state`` + ``as_of`` write must flow through
# ``apply_state_change_v2`` so we get a ``state_change`` timeline entry
# + ``event/state-change-*`` audit record. This block adds the propose
# function the mutator invokes and the per-matter wrapper activity the
# patched branch of ``NightlyNarrativeWorkflow.run`` dispatches.
#
# The legacy ``generate_matter_narrative`` / ``patch_matter_narrative``
# activities are NOT modified — they remain registered and continue to
# run on the unpatched branch for histories started before the patched
# gate landed. Replay determinism requires their bytes stay stable.

# Default confidence for clerk-drafted narratives when the clerk does
# not self-report one. Narrative drafting is intrinsically subjective
# (the clerk picks what to highlight, not a binary fact) so we default
# to a confidence comfortably above the standard 0.6 live-mode gate but
# below the 0.85 HC-only threshold — under HC-only env vetoes the write
# lands as ``pending_confirmation`` for sir to confirm, which is the
# correct cautious posture for a generated paragraph.
DEFAULT_NARRATIVE_CONFIDENCE = 0.85


def _extract_confidence_and_narrative(
    raw: str,
) -> tuple[str | None, float | None]:
    """Parse the clerk's response into ``(narrative, confidence_or_None)``.

    The propose prompt instructs the clerk to reply with either:
      * ``NO_CHANGE`` (case-insensitive) when nothing material moved
      * A JSON object ``{"narrative": "...", "confidence": 0.0-1.0}``
      * A bare paragraph (legacy fallback)

    We accept all three shapes so a clerk that ignores the JSON
    instruction still produces a usable mutation. Returns
    ``(None, None)`` for the no-change signal.
    """
    text = (raw or "").strip()
    if not text:
        return None, None
    # Reject clerk-failure sentinels so the failure text doesn't become
    # the matter's current_state. Mirror briefing.py:_is_clerk_failure.
    low = text.lower()
    if (
        "assistant turn failed" in low
        or "tool use failed" in low
        or low.startswith("[error")
        or low.startswith("[failed")
        or low.startswith("[empty")
        or (text.startswith("[") and text.endswith("]") and len(text) < 120)
    ):
        return None, None
    if text.upper().startswith("NO_CHANGE") or text.upper() == "NO CHANGE":
        return None, None
    # Strip a fenced ``` json ``` envelope if the clerk wrapped its JSON.
    if text.startswith("```"):
        # remove first fence + optional lang marker
        nl = text.find("\n")
        if nl != -1:
            text = text[nl + 1 :]
        if text.endswith("```"):
            text = text[: -3].rstrip()
    # JSON object path.
    if text.lstrip().startswith("{"):
        try:
            obj = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            obj = None
        if isinstance(obj, dict):
            raw_narrative = obj.get("narrative")
            raw_conf = obj.get("confidence")
            if isinstance(raw_narrative, str) and raw_narrative.strip():
                conf: float | None
                if isinstance(raw_conf, (int, float)) and 0.0 <= float(raw_conf) <= 1.0:
                    conf = float(raw_conf)
                else:
                    conf = None
                return raw_narrative.strip(), conf
            # JSON with no usable narrative → fall through to None
            return None, None
    # Bare paragraph fallback — treat the whole response as the narrative.
    return text, None


def _build_propose_prompt(
    matter_summary: dict[str, Any],
    prior_as_of: str | None,
    signals: list[dict[str, Any]],
    transitions: list[dict[str, Any]],
    events: list[dict[str, Any]],
    *,
    cold_start: bool = False,
) -> str:
    """Compose the propose-side prompt.

    ``cold_start=True`` suppresses the NO_CHANGE escape hatch so the
    clerk always writes a first narrative for a matter with no prior
    ``current_state``.
    """
    matter_name = str(matter_summary.get("name") or matter_summary.get("path") or "").strip()
    prior_state = str(matter_summary.get("current_state") or "").strip()

    lines = [
        "You are Alfred's clerk reviewing a matter's narrative.",
        "",
        f"MATTER: {matter_name}",
        f"PRIOR as_of: {prior_as_of or 'none — first draft'}",
    ]
    if prior_state:
        lines.append(f"PRIOR current_state: {prior_state}")
    lines.extend([
        "",
        f"SIGNALS since prior as_of ({len(signals)} total):",
        json.dumps(signals, indent=2, default=str)[:4000],
        "",
        f"TASK TRANSITIONS since prior as_of ({len(transitions)} total):",
        json.dumps(transitions, indent=2, default=str)[:2000],
        "",
        "SOURCE EVENTS (back-pointer expanded):",
        json.dumps(events, indent=2, default=str)[:2000],
        "",
    ])
    if cold_start:
        lines.extend([
            "No prior narrative exists (cold start). Write an initial",
            "paragraph. If nothing has happened yet, say so plainly.",
            "NO_CHANGE is not an option for a first draft.",
        ])
    else:
        lines.extend([
            "Decide: should the narrative change? If nothing material has",
            "happened, respond with the single token NO_CHANGE.",
        ])
    lines.extend([
        "",
        "If the narrative should change, respond with JSON of the shape:",
        '  {"narrative": "<paragraph>", "confidence": 0.0-1.0}',
        "",
        "Voice: courteous, precise, lightly old-fashioned — Alfred",
        "speaks as himself; you draft on his behalf. 2-4 sentences",
        "referencing concrete developments. Address sir as 'sir' when",
        f"appropriate. Hard cap on the narrative: {NARRATIVE_CHAR_CAP}",
        "characters. Confidence reflects your certainty that this is",
        "the right framing — pass below 0.85 when the picture is",
        "ambiguous so sir can confirm.",
    ])
    return "\n".join(lines)


@propose_fn("nightly_narrative.propose_matter_narrative")
async def propose_matter_narrative(
    *,
    target: dict[str, Any],
    observed: ObservedWindow,
    args: dict[str, Any],
) -> ProposedMutation | None:
    """Propose a new matter narrative — or ``None`` for no-change.

    Contract matches the universal propose-fn signature (spec §4.1 +
    §6.1). ``args`` carries the pre-loaded ``signals``, ``transitions``,
    ``events``, plus ``matter_path`` and ``matter_name`` so the propose
    function avoids re-reading vault inside the mutator's read-reason-
    write cycle (the v2 ``read_target`` already gives us prior_fm; the
    24h window walks live outside).

    Logic:
      * Both signals + transitions empty AND a prior narrative exists →
        return None (idempotency — re-drafting "nothing changed" adds
        no value). Cold-start exception (#564): if ``current_state``
        is absent, proceed so the matter gets a first narrative.
      * Build clerk prompt → parse NO_CHANGE / JSON / bare paragraph.
      * On no-change → None (no PATCH, no audit).
      * On narrative → ProposedMutation with clerk confidence.
    """
    signals = args.get("signals") or []
    transitions = args.get("transitions") or []
    events = args.get("events") or []
    matter_path = str(args.get("matter_path") or target.get("path") or "")

    if not isinstance(signals, list):
        signals = []
    if not isinstance(transitions, list):
        transitions = []
    if not isinstance(events, list):
        events = []

    target_fm = target.get("frontmatter") if isinstance(target, dict) else None
    if not isinstance(target_fm, dict):
        target_fm = {}
    prior_current_state = str(target_fm.get("current_state") or "").strip()
    cold_start = not prior_current_state

    # Idempotency gate — short-circuit only when a narrative already
    # exists AND the observation window is empty.  A cold-start matter
    # (no prior current_state) must run the clerk regardless.
    if not signals and not transitions and not cold_start:
        logger.info(
            "nightly_narrative.propose: matter=%s no signals/transitions — no change",
            matter_path,
        )
        return None

    prior_as_of = target.get("as_of") if isinstance(target, dict) else None
    matter_name = str(args.get("matter_name") or target_fm.get("name") or matter_path)

    matter_summary = {
        "name": matter_name,
        "path": matter_path,
        "current_state": prior_current_state,
    }

    prompt = _build_propose_prompt(
        matter_summary,
        str(prior_as_of) if prior_as_of else None,
        signals,
        transitions,
        events,
        cold_start=cold_start,
    )

    result = await _call_clerk(prompt, raw=True)
    if not isinstance(result, str):
        result = str(result)

    narrative, clerk_confidence = _extract_confidence_and_narrative(result)
    if narrative is None or not narrative.strip():
        logger.info(
            "nightly_narrative.propose: matter=%s clerk returned NO_CHANGE or empty",
            matter_path,
        )
        return None

    trimmed = narrative.strip().strip('"').strip("'").strip()
    if len(trimmed) > NARRATIVE_CHAR_CAP:
        trimmed = trimmed[:NARRATIVE_CHAR_CAP].rstrip() + "..."

    # The state-mutator stamps as_of from the envelope's "fields.as_of"
    # if present; otherwise ctrl-api stamps observed_window.end. We
    # pass an explicit ISO timestamp from observed.end so the workflow's
    # deterministic ``workflow.now()`` value wins (replay-stable).
    end_iso = observed.end.astimezone(timezone.utc).isoformat(timespec="seconds")
    if end_iso.endswith("+00:00"):
        end_iso = end_iso[:-6] + "Z"

    confidence = (
        clerk_confidence
        if clerk_confidence is not None
        else DEFAULT_NARRATIVE_CONFIDENCE
    )

    return ProposedMutation(
        fields={
            "current_state": trimmed,
            "as_of": end_iso,
        },
        reason=(
            f"Refreshed narrative after {len(signals)} signal(s) and "
            f"{len(transitions)} task transition(s) since prior as_of."
        )[:500],
        confidence=confidence,
        fan_out=(),
    )


@dataclass
class MatterNarrativeOutcome:
    """Result of one matter's v2 retrofit pass.

    ``status`` is one of:
      * ``"mutated"`` — propose returned a mutation and ctrl-api wrote it.
      * ``"no_change"`` — propose returned None (no signals, or clerk
        decided the prior narrative still stands).
      * ``"error"`` — the v2 round-trip raised (contention exhausted,
        clerk failure, HTTP failure, etc.).
    """

    matter_path: str
    status: str
    audit_record_path: str | None = None
    new_as_of: str | None = None
    retried_count: int = 0
    error_message: str | None = None


@activity.defn
async def apply_matter_narrative_v2(
    matter_path: str,
    observed_end_iso: str,
) -> dict[str, Any]:
    """Per-matter v2 retrofit entry point — single activity the patched
    workflow branch dispatches.

    Wraps the read-reason-write cycle inside one activity (rather than
    fan-out across read_target → gather_observed → execute_activity
    chain) so the workflow surface stays small and the patched branch
    is a single new ``execute_activity`` call per matter — minimum
    surface area for replay-safety review.

    Logic per matter:
      1. Read the matter summary + signals + transitions + events via
         the legacy loader activities (same as the pre-patch path).
      2. Pre-compute the ObservedWindow with end stamped from the
         workflow's clock (passed in as ``observed_end_iso`` so the
         value is deterministic across retries).
      3. Call ``apply_state_change_v2`` with
         ``propose_fn_name="nightly_narrative.propose_matter_narrative"``.
         The mutator handles read_target, propose invocation, ctrl-api
         POST, optimistic-concurrency retries.
      4. Map the result into a ``MatterNarrativeOutcome`` dict the
         workflow aggregates into its return value.
    """
    canonical = _normalize_matter_path(matter_path)
    if not canonical:
        return MatterNarrativeOutcome(
            matter_path=matter_path,
            status="error",
            error_message="invalid matter_path",
        ).__dict__

    try:
        summary = await read_matter_summary(canonical)
        signals = await load_matter_signals_24h(canonical)
        transitions = await load_task_transitions_24h(canonical)
        signal_paths = [s.get("path", "") for s in signals if s.get("path")]
        events = await load_source_events(signal_paths) if signal_paths else []
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "nightly_narrative.apply_matter_narrative_v2: load failed matter=%s err=%s",
            canonical, exc,
        )
        return MatterNarrativeOutcome(
            matter_path=canonical,
            status="error",
            error_message=f"load_failed: {exc}"[:300],
        ).__dict__

    # Idempotency gate (#564): skip only when prior narrative exists AND
    # the observation window is empty (cold-start must proceed).
    prior_state = str((summary or {}).get("current_state") or "").strip()
    if not signals and not transitions and prior_state:
        logger.info(
            "nightly_narrative.apply_matter_narrative_v2: matter=%s no activity — no change",
            canonical,
        )
        return MatterNarrativeOutcome(
            matter_path=canonical, status="no_change",
        ).__dict__

    # Parse the workflow-supplied ISO timestamp for observed.end so
    # retries see the same value (Temporal-determinism friendly).
    end_dt = _parse_iso_or_none(observed_end_iso) or _now_utc()
    # ObservedWindow.start defaults to the matter's prior as_of. If
    # absent (fresh matter) fall back to the 24h lookback window so the
    # state_mutator audit still has a sane start anchor.
    target_fm = summary if isinstance(summary, dict) else {}
    prior_as_of_raw = target_fm.get("as_of")
    start_dt = _parse_iso_or_none(prior_as_of_raw) or (end_dt - LOOKBACK_WINDOW)
    observed = ObservedWindow(
        start=start_dt,
        end=end_dt,
        signal_paths=signal_paths,
        decision_paths=[],
        other_refs=[e.get("path", "") for e in events if e.get("path")],
    )

    propose_args = {
        "signals": signals,
        "transitions": transitions,
        "events": events,
        "matter_path": canonical,
        "matter_name": str(summary.get("name") or _slug_from_matter_path(canonical)),
    }

    expected_as_of = (
        str(prior_as_of_raw).strip()
        if isinstance(prior_as_of_raw, str) and prior_as_of_raw
        else None
    )

    try:
        result = await apply_state_change_v2(
            target_path=canonical,
            source="nightly_narrative",
            observed=observed,
            propose_fn_name="nightly_narrative.propose_matter_narrative",
            propose_fn_args=propose_args,
            mode="live",
            expected_as_of=expected_as_of,
        )
    except MutatorContentionError as exc:
        logger.warning(
            "nightly_narrative.apply_matter_narrative_v2: 409 retries exhausted "
            "matter=%s err=%s",
            canonical, exc,
        )
        return MatterNarrativeOutcome(
            matter_path=canonical,
            status="error",
            error_message=f"contention_exhausted: {exc}"[:300],
        ).__dict__
    except httpx.HTTPError as exc:
        logger.warning(
            "nightly_narrative.apply_matter_narrative_v2: v2 HTTP failed matter=%s err=%s",
            canonical, exc,
        )
        return MatterNarrativeOutcome(
            matter_path=canonical,
            status="error",
            error_message=f"http_error: {exc}"[:300],
        ).__dict__
    except Exception as exc:  # noqa: BLE001 — defensive: don't kill the night
        logger.warning(
            "nightly_narrative.apply_matter_narrative_v2: unexpected error matter=%s err=%r",
            canonical, exc,
        )
        return MatterNarrativeOutcome(
            matter_path=canonical,
            status="error",
            error_message=f"unexpected: {type(exc).__name__}: {exc}"[:300],
        ).__dict__

    if not result.applied:
        logger.info(
            "nightly_narrative.apply_matter_narrative_v2: matter=%s no change warranted",
            canonical,
        )
        return MatterNarrativeOutcome(
            matter_path=canonical,
            status="no_change",
            retried_count=result.retried_count,
        ).__dict__

    logger.info(
        "nightly_narrative.apply_matter_narrative_v2: matter=%s mutated "
        "audit=%s retries=%d",
        canonical, result.audit_record_path, result.retried_count,
    )
    return MatterNarrativeOutcome(
        matter_path=canonical,
        status="mutated",
        audit_record_path=result.audit_record_path,
        new_as_of=result.new_as_of,
        retried_count=result.retried_count,
    ).__dict__
