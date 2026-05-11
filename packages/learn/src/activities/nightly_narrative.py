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
    last 24h, the workflow skips the LLM entirely. ``current_state``
    and ``as_of`` are left untouched — the narrative from the previous
    refresh is still the freshest available description.

All vault writes go through the ctrl-api VaultClient — never direct
filesystem writes. All LLM calls go through the OpenClaw gateway via
``clerk._call_clerk`` — never direct Anthropic API. These are the
two non-negotiable rules from ``CLAUDE.md``.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from temporalio import activity

from src.activities.clerk import _call_clerk
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

    config = load_config()
    client = VaultClient(config)
    try:
        try:
            records = await client.list_records("signal", limit=10_000)
        except httpx.HTTPError as exc:
            logger.warning(
                "nightly_narrative.load_matter_signals_24h: list failed matter=%s err=%s",
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
