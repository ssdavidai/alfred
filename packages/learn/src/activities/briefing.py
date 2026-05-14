"""Briefing composer activities — Phase E of the state-mutation contract (#893).

The morning + evening briefings are two writers among many under the
universal contract (docs/STATE-MUTATION.md §8). Each briefing slot is a
two-phase write:

  * **Phase 1 — Mutation.** Walk every active matter, propose+apply a
    state change through ``state_mutator.apply_state_change_v2`` with
    ``source=briefing.<slot>``. The clerk decides per matter whether
    anything material has happened in the observed window; non-changes
    return None and skip the round-trip entirely.
  * **Phase 2 — Composition.** Re-read every matter (post-mutation) and
    compose the brief body from the *current* state. The brief snapshot
    record (``briefing/<YYYY-MM-DD>-<slot>.md``) joins the post-mutation
    matter set with the observed-window's signals / decisions / prior
    briefing.

The two phases are decoupled on purpose: a matter that mutated *during*
the mutation pass is then composed from the freshly-written state, so
"the brief said X but the matter says Y" drift cannot happen. See spec
§8.3.

Activity inventory (registered in worker.py):

  * ``list_active_matters_for_briefing`` — enumerator (skips done /
    archived; canonical paths sorted for replay determinism).
  * ``get_prior_briefing`` — returns the most-recent briefing record
    for the given slot, or None if this is the first run for that slot.
  * ``briefing_visit_matter`` — wrapper that runs read → gather_observed
    → apply_state_change_v2 for a single matter, returning a small dict
    the workflow can aggregate.
  * ``compose_and_write_briefing`` — Phase 2 composer. Re-reads every
    matter, asks the clerk for the brief body, writes the snapshot.
  * propose function ``briefing.propose_matter_update`` — clerk-driven,
    NO_CHANGE / JSON / bare-paragraph escape hatches.

The propose function is NOT a Temporal activity — the state-mutator
dispatches it in-process by name (spec §6.2). Keep both the decorator
registration and the activity body in this module so the worker import
populates the registry alongside the activities.
"""
from __future__ import annotations

import json
import logging
import os
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


# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

# Hard cap on the clerk-drafted narrative paragraph (per matter). Matches
# the cap used by nightly_narrative so matter records render uniformly
# regardless of which writer produced the current_state.
NARRATIVE_CHAR_CAP = 600

# Default confidence for clerk-drafted briefing narratives when the
# clerk does not self-report one. Higher than nightly_narrative's 0.85
# would imply over-confidence here — keep parity so HC-only env vetoes
# behave consistently across writers.
DEFAULT_BRIEFING_CONFIDENCE = 0.85

# Default fallback window if there is no prior briefing (e.g. first run).
DEFAULT_FALLBACK_WINDOW = timedelta(hours=24)

# Hard cap on the composed brief body. Pre-cut by the clerk if it
# overruns — letterpress prose, not a transcript.
BRIEF_BODY_CHAR_CAP = 4000


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _parse_iso_or_none(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        return None
    s = value.strip()
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


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat(timespec="seconds").replace("+00:00", "Z")


def _slug_from_matter_path(matter_path: str) -> str:
    s = (matter_path or "").strip()
    if s.endswith(".md"):
        s = s[:-3]
    if s.startswith("matter/"):
        s = s[len("matter/"):]
    return s


def _is_matter_active(fm: dict[str, Any]) -> bool:
    """Active-matter filter for the briefing walk.

    Mirrors the filter logic used by ``decay_watcher.list_active_matters_for_decay``
    (deliberately copied, not imported — the decay version is gated by
    ``DECAY_WATCHER_MATTER_PASS_ENABLED`` and we don't want to entangle
    the briefing flow with that env switch). A matter is "active" for
    briefing purposes when both:

      * ``state`` (Steward schema) is not ``done`` or ``archived``
      * ``status`` (legacy field) is not ``done``/``archived``/``completed``
    """
    state = str(fm.get("state") or "").strip().lower()
    if state in ("done", "archived"):
        return False
    status = str(fm.get("status") or "").strip().lower()
    if status in ("done", "archived", "completed"):
        return False
    return True


# ---------------------------------------------------------------------------
# Activity: list_active_matters_for_briefing
# ---------------------------------------------------------------------------


@activity.defn
async def list_active_matters_for_briefing() -> list[str]:
    """Enumerate every matter the briefing should visit.

    Returns canonical ``matter/<slug>.md`` paths sorted alphabetically
    (deterministic Temporal replay). Skips matters in a terminal state
    so a finished matter doesn't churn a no-op state-change entry on
    every briefing tick.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        try:
            records = await client.list_records("matter", limit=10_000)
        except httpx.HTTPError as exc:
            logger.warning(
                "briefing.list_active_matters_for_briefing: list failed: %s", exc,
            )
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
        if not _is_matter_active(fm):
            continue
        path = str(rec.get("path") or "").strip()
        if not path.startswith("matter/") or not path.endswith(".md"):
            continue
        out.append(path)
    out.sort()
    logger.info(
        "briefing.list_active_matters_for_briefing: %d active matters",
        len(out),
    )
    return out


# ---------------------------------------------------------------------------
# Activity: get_prior_briefing
# ---------------------------------------------------------------------------


def _parse_briefing_filename(path: str) -> tuple[str, str] | None:
    """Extract ``(date, slot)`` from ``briefing/<YYYY-MM-DD>-<slot>.md``.

    Returns ``None`` if the filename doesn't fit the slot-bearing
    convention (e.g. a legacy briefing record from an upgrade path).
    """
    if not path:
        return None
    s = path.strip()
    if s.startswith("briefing/"):
        s = s[len("briefing/"):]
    if s.endswith(".md"):
        s = s[:-3]
    parts = s.rsplit("-", 1)
    if len(parts) != 2:
        return None
    date_part, slot_part = parts
    slot = slot_part.strip().lower()
    if slot not in ("morning", "evening"):
        return None
    if len(date_part) != 10 or date_part[4] != "-" or date_part[7] != "-":
        return None
    return date_part, slot


@activity.defn
async def get_prior_briefing(slot: str) -> dict[str, Any] | None:
    """Return the most-recent ``briefing/<*>-<slot>.md`` record summary.

    Returned shape: ``{path, composed_at}`` or ``None`` when no prior
    briefing exists for this slot (e.g. the workflow's first run on a
    fresh tenant).

    Uses ``vault_client.list_records("briefing")`` — the type was added
    to the ctrl-api ``KNOWN_TYPES`` in Phase A (#889) and the listing
    endpoint accepts it. If listing fails (transport, 404 from a stale
    ctrl-api that doesn't know the type yet), we degrade gracefully to
    ``None`` rather than hard-failing the workflow — the briefing run
    can still proceed using a fallback window.
    """
    target_slot = str(slot or "").strip().lower()
    if target_slot not in ("morning", "evening"):
        return None

    config = load_config()
    client = VaultClient(config)
    records: list[dict[str, Any]] = []
    try:
        try:
            records = await client.list_records("briefing", limit=10_000)
        except httpx.HTTPError as exc:
            logger.warning(
                "briefing.get_prior_briefing: list_records failed slot=%s err=%s — "
                "treating as no prior briefing",
                target_slot, exc,
            )
            return None
    finally:
        await client.close()

    best_path: str | None = None
    best_composed: datetime | None = None
    for rec in records:
        if not isinstance(rec, dict):
            continue
        path = str(rec.get("path") or "").strip()
        if not path:
            continue
        parsed = _parse_briefing_filename(path)
        if parsed is None:
            continue
        _date, rec_slot = parsed
        if rec_slot != target_slot:
            continue
        fm = rec.get("frontmatter") or rec
        if not isinstance(fm, dict):
            fm = {}
        composed_raw = fm.get("composed_at") or fm.get("created")
        composed = _parse_iso_or_none(composed_raw)
        if composed is None:
            # Fall back to date in the filename so a record missing
            # composed_at still sorts; use 00:00:00Z so it loses to a
            # record with a real timestamp on the same date.
            composed = _parse_iso_or_none(f"{_date}T00:00:00Z")
        if composed is None:
            continue
        if best_composed is None or composed > best_composed:
            best_composed = composed
            best_path = path

    if best_path is None or best_composed is None:
        return None

    return {
        "path": best_path,
        "composed_at": _iso(best_composed),
    }


# ---------------------------------------------------------------------------
# Observed-window gather (in-process; mirrors state_mutator.gather_observed)
# ---------------------------------------------------------------------------


def _record_targets_matter(fm: dict[str, Any], target_path: str) -> bool:
    """True iff a signal/decision/event record references ``target_path``."""
    tp = str(fm.get("target_path") or "").strip()
    if tp == target_path:
        return True
    parent = str(fm.get("parent_matter") or fm.get("matter") or "").strip()
    if parent == target_path:
        return True
    related = fm.get("related_matters")
    if isinstance(related, list):
        for r in related:
            if isinstance(r, str) and r.strip() == target_path:
                return True
    cands = fm.get("target_candidates")
    if isinstance(cands, list):
        for c in cands:
            if isinstance(c, dict) and str(c.get("path") or "").strip() == target_path:
                return True
            if isinstance(c, str) and c.strip() == target_path:
                return True
    return False


async def _gather_observed_for_matter(
    *,
    target_path: str,
    window_start: datetime,
    window_end: datetime,
    prior_briefing_path: str | None,
) -> ObservedWindow:
    """Walk signals + decisions touching ``target_path`` in the window.

    The briefing's observed window is anchored to ``window_start`` /
    ``window_end`` (from the workflow), NOT the matter's prior as_of —
    the briefing reasons over what's arrived since the previous brief,
    not since the matter was last touched by another writer.

    ``other_refs`` carries the prior briefing path (if known) so the
    state-change audit record links the briefing chain together.
    """
    config = load_config()
    vault = VaultClient(config)
    signal_paths: list[str] = []
    decision_paths: list[str] = []

    try:
        for record_type, sink in (
            ("signal", signal_paths),
            ("decision", decision_paths),
        ):
            try:
                records = await vault.list_records(record_type, limit=10_000)
            except httpx.HTTPError as exc:
                logger.warning(
                    "briefing.gather_observed: %s list failed target=%s err=%s",
                    record_type, target_path, exc,
                )
                continue
            for rec in records:
                if not isinstance(rec, dict):
                    continue
                fm = rec.get("frontmatter") or rec
                if not isinstance(fm, dict):
                    fm = {}
                if not _record_targets_matter(fm, target_path):
                    continue
                ts_raw = (
                    fm.get("applied_at")
                    or fm.get("created")
                    or rec.get("created")
                )
                ts = _parse_iso_or_none(ts_raw)
                if ts is None or ts < window_start or ts > window_end:
                    continue
                path = str(rec.get("path") or fm.get("path") or "").strip()
                if path:
                    sink.append(path)
    finally:
        await vault.close()

    other_refs: list[str] = []
    if prior_briefing_path:
        other_refs.append(prior_briefing_path)

    return ObservedWindow(
        start=window_start,
        end=window_end,
        signal_paths=signal_paths,
        decision_paths=decision_paths,
        other_refs=other_refs,
    )


# ---------------------------------------------------------------------------
# Propose function: briefing.propose_matter_update
# ---------------------------------------------------------------------------


_CLERK_FAILURE_PATTERNS = (
    "assistant turn failed",
    "tool use failed",
    "no response",
    "error:",
    "[error",
    "[empty",
    "[failed",
    "rate limit",
    "timeout",
)


def _is_clerk_failure(raw: str) -> bool:
    """True when clerk returned an obvious failure sentinel rather than prose.

    Catches the openclaw-workers '[assistant turn failed before producing
    content]' pattern + adjacent bracketed error markers + short bracketed
    strings of any kind. Treat these as failures, NOT as valid bare-paragraph
    narratives (which would otherwise leak straight into matter current_state).
    """
    text = (raw or "").strip()
    if not text:
        return True
    low = text.lower()
    for pat in _CLERK_FAILURE_PATTERNS:
        if pat in low:
            return True
    # Short bracketed sentinel: a clerk response that's just `[something]` and
    # under 120 chars is almost certainly an error envelope, not a narrative.
    if text.startswith("[") and text.endswith("]") and len(text) < 120:
        return True
    return False


def _extract_propose_response(raw: str) -> tuple[str | None, float | None]:
    """Parse the clerk's response into ``(narrative, confidence_or_None)``.

    Mirrors nightly_narrative's parser so the two writers share an
    interface contract with the clerk:

      * Clerk failure sentinel (e.g. ``[assistant turn failed]``) → (None, None).
      * ``NO_CHANGE`` (case-insensitive) → (None, None) → no mutation.
      * ``{"narrative": "...", "confidence": 0.0-1.0}`` → JSON path.
      * Bare paragraph → fallback (legacy clerk path).
    """
    text = (raw or "").strip()
    if _is_clerk_failure(text):
        return None, None
    if text.upper().startswith("NO_CHANGE") or text.upper() == "NO CHANGE":
        return None, None
    if text.startswith("```"):
        nl = text.find("\n")
        if nl != -1:
            text = text[nl + 1:]
        if text.endswith("```"):
            text = text[:-3].rstrip()
    if text.lstrip().startswith("{"):
        try:
            obj = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            obj = None
        if isinstance(obj, dict):
            raw_narrative = obj.get("narrative")
            raw_conf = obj.get("confidence")
            if (
                isinstance(raw_narrative, str)
                and raw_narrative.strip()
                and not _is_clerk_failure(raw_narrative)
            ):
                conf: float | None = None
                if isinstance(raw_conf, (int, float)) and 0.0 <= float(raw_conf) <= 1.0:
                    conf = float(raw_conf)
                return raw_narrative.strip(), conf
            return None, None
    return text, None


def _build_propose_prompt(
    *,
    slug: str,
    prior_state: str,
    prior_as_of: str | None,
    slot: str,
    observed_events: list[dict[str, Any]],
) -> str:
    """Compose the propose-side prompt for the briefing pass.

    The clerk gets:
      * the matter slug + prior current_state (for grounding)
      * a structured list of events that arrived in the window
      * an explicit NO_CHANGE escape hatch so quiet matters don't churn
    """
    lines = [
        "You are Alfred's clerk reviewing a matter for the "
        f"{slot} briefing.",
        "",
        f"MATTER: {slug}",
        f"PRIOR as_of: {prior_as_of or 'none — first review'}",
    ]
    if prior_state:
        lines.append(f"PRIOR current_state: {prior_state}")
    lines.extend([
        "",
        f"EVENTS that arrived in the briefing window ({len(observed_events)} total):",
        json.dumps(observed_events, indent=2, default=str)[:4000],
        "",
        "Decide: given what you knew at PRIOR as_of, and what arrived in",
        "the briefing window, should the matter's narrative change?",
        "",
        "If nothing material has happened, respond with the single token",
        "NO_CHANGE.",
        "",
        "If the narrative should change, respond with JSON of the shape:",
        '  {"narrative": "<paragraph>", "confidence": 0.0-1.0}',
        "",
        "Voice: courteous, precise, lightly old-fashioned — Alfred speaks",
        "as himself; you draft on his behalf. 2-4 sentences referencing",
        "concrete developments. Address sir as 'sir' when appropriate.",
        f"Hard cap on the narrative: {NARRATIVE_CHAR_CAP} characters.",
        "Confidence reflects your certainty that this is the right",
        "framing — pass below 0.85 when the picture is ambiguous so sir",
        "can confirm.",
    ])
    return "\n".join(lines)


@propose_fn("briefing.propose_matter_update")
async def propose_briefing_matter_update(
    *,
    target: dict[str, Any],
    observed: ObservedWindow,
    args: dict[str, Any],
) -> ProposedMutation | None:
    """Propose a per-matter state change for the briefing slot.

    Contract matches the universal propose-fn signature (spec §4.1 +
    §6.1). ``args`` carries:

      * ``slot`` — "morning" | "evening" for prompt voice.
      * ``prior_state`` — pre-loaded current_state string (avoids
        rereading vault inside the propose hot path).
      * ``as_of`` — prior as_of string for the prompt.

    Logic:
      * Both signals + decisions empty → return None (idempotent gate).
      * Build clerk prompt with prior_state + observed event metadata.
      * Parse response: NO_CHANGE / JSON / bare paragraph.
      * On no-change → return None.
      * On narrative → build ``ProposedMutation`` with
        ``{current_state, as_of, last_briefing_at}`` — last_briefing_at
        was added to MATTER_STATE_FIELDS in Phase A specifically so the
        briefing can stamp it as part of the same atomic write.
    """
    slot = str(args.get("slot") or "morning").strip().lower()
    if slot not in ("morning", "evening"):
        slot = "morning"

    prior_state = str(args.get("prior_state") or "").strip()
    prior_as_of = args.get("as_of")
    if isinstance(prior_as_of, datetime):
        prior_as_of = _iso(prior_as_of)
    prior_as_of_str = str(prior_as_of).strip() if prior_as_of else None

    target_path = ""
    if isinstance(target, dict):
        fm = target.get("frontmatter") or {}
        if not isinstance(fm, dict):
            fm = {}
        target_path = str(fm.get("path") or target.get("path") or "").strip()
    slug = _slug_from_matter_path(target_path) if target_path else (
        str(args.get("matter_slug") or "").strip()
    )

    # Idempotency gate — nothing happened in the window → no rewrite.
    if not observed.signal_paths and not observed.decision_paths:
        logger.info(
            "briefing.propose_matter_update: slug=%s slot=%s no signals/decisions",
            slug, slot,
        )
        return None

    # Build a compact view of observed events so the clerk has enough
    # context to decide whether the framing changed, without flooding
    # the prompt with the entire vault.
    observed_events = [
        {"kind": "signal", "path": p} for p in observed.signal_paths
    ] + [
        {"kind": "decision", "path": p} for p in observed.decision_paths
    ]

    prompt = _build_propose_prompt(
        slug=slug or target_path,
        prior_state=prior_state,
        prior_as_of=prior_as_of_str,
        slot=slot,
        observed_events=observed_events,
    )

    try:
        result = await _call_clerk(prompt, raw=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "briefing.propose_matter_update: clerk call failed slug=%s err=%s",
            slug, exc,
        )
        return None

    if not isinstance(result, str):
        result = str(result)

    narrative, clerk_confidence = _extract_propose_response(result)
    if narrative is None or not narrative.strip():
        logger.info(
            "briefing.propose_matter_update: slug=%s clerk returned NO_CHANGE",
            slug,
        )
        return None

    trimmed = narrative.strip().strip('"').strip("'").strip()
    if len(trimmed) > NARRATIVE_CHAR_CAP:
        trimmed = trimmed[:NARRATIVE_CHAR_CAP].rstrip() + "..."

    # Stamp as_of + last_briefing_at from observed.end so retries see
    # the same value (Temporal-determinism friendly).
    end_iso = _iso(observed.end)
    confidence = (
        clerk_confidence
        if clerk_confidence is not None
        else DEFAULT_BRIEFING_CONFIDENCE
    )

    return ProposedMutation(
        fields={
            "current_state": trimmed,
            "as_of": end_iso,
            "last_briefing_at": end_iso,
        },
        reason=(
            f"briefing.{slot}: refreshed narrative after "
            f"{len(observed.signal_paths)} signal(s) and "
            f"{len(observed.decision_paths)} decision(s) in window."
        )[:500],
        confidence=confidence,
        fan_out=(),
    )


# ---------------------------------------------------------------------------
# Activity: briefing_visit_matter
# ---------------------------------------------------------------------------


@activity.defn
async def briefing_visit_matter(
    matter_path: str,
    slot: str,
    window_start_iso: str,
    window_end_iso: str,
    prior_briefing_path: str | None = None,
) -> dict[str, Any]:
    """Run the read-reason-write cycle for one matter (Phase 1 step).

    Returns a small aggregate the composer step joins on:

        {
          "matter_path": "matter/<slug>.md",
          "applied": bool,
          "state_changed": bool,
          "audit_record_path": str | None,
          "new_as_of": str | None,
          "retried_count": int,
          "error_message": str | None,
        }

    Errors are swallowed and reported via ``error_message`` so one
    misbehaving matter doesn't kill the whole briefing.
    """
    canonical = (matter_path or "").strip()
    if not canonical or not canonical.startswith("matter/") or not canonical.endswith(".md"):
        return {
            "matter_path": matter_path,
            "applied": False,
            "state_changed": False,
            "audit_record_path": None,
            "new_as_of": None,
            "retried_count": 0,
            "error_message": "invalid matter_path",
        }

    slot_norm = str(slot or "").strip().lower()
    if slot_norm not in ("morning", "evening"):
        slot_norm = "morning"

    window_start = _parse_iso_or_none(window_start_iso) or (
        _now_utc() - DEFAULT_FALLBACK_WINDOW
    )
    window_end = _parse_iso_or_none(window_end_iso) or _now_utc()

    # Pre-read so we can pass prior_state + as_of to the propose fn
    # without forcing the clerk prompt to re-walk vault. The state
    # mutator does its own read_target internally, so this pre-read is
    # purely for the propose function's prompt context.
    config = load_config()
    vault = VaultClient(config)
    prior_fm: dict[str, Any] = {}
    try:
        try:
            record = await vault.read_record(canonical)
        except httpx.HTTPStatusError as exc:
            if exc.response is not None and exc.response.status_code == 404:
                return {
                    "matter_path": canonical,
                    "applied": False,
                    "state_changed": False,
                    "audit_record_path": None,
                    "new_as_of": None,
                    "retried_count": 0,
                    "error_message": "matter not found",
                }
            raise
        if isinstance(record, dict):
            fm_raw = record.get("frontmatter")
            if isinstance(fm_raw, dict):
                prior_fm = fm_raw
    except httpx.HTTPError as exc:
        logger.warning(
            "briefing_visit_matter: read failed matter=%s err=%s",
            canonical, exc,
        )
        return {
            "matter_path": canonical,
            "applied": False,
            "state_changed": False,
            "audit_record_path": None,
            "new_as_of": None,
            "retried_count": 0,
            "error_message": f"read_failed: {exc}"[:300],
        }
    finally:
        await vault.close()

    prior_as_of_raw = prior_fm.get("as_of")
    expected_as_of = (
        str(prior_as_of_raw).strip()
        if isinstance(prior_as_of_raw, str) and prior_as_of_raw
        else None
    )
    prior_state = str(prior_fm.get("current_state") or "").strip()

    observed = await _gather_observed_for_matter(
        target_path=canonical,
        window_start=window_start,
        window_end=window_end,
        prior_briefing_path=prior_briefing_path,
    )

    try:
        result = await apply_state_change_v2(
            target_path=canonical,
            source=f"briefing.{slot_norm}",
            observed=observed,
            propose_fn_name="briefing.propose_matter_update",
            propose_fn_args={
                "slot": slot_norm,
                "prior_state": prior_state,
                "as_of": expected_as_of,
                "matter_slug": _slug_from_matter_path(canonical),
            },
            mode="live",
            expected_as_of=expected_as_of,
        )
    except MutatorContentionError as exc:
        logger.warning(
            "briefing_visit_matter: 409 retries exhausted matter=%s err=%s",
            canonical, exc,
        )
        return {
            "matter_path": canonical,
            "applied": False,
            "state_changed": False,
            "audit_record_path": None,
            "new_as_of": None,
            "retried_count": 3,
            "error_message": f"contention_exhausted: {exc}"[:300],
        }
    except httpx.HTTPError as exc:
        logger.warning(
            "briefing_visit_matter: v2 HTTP failed matter=%s err=%s",
            canonical, exc,
        )
        return {
            "matter_path": canonical,
            "applied": False,
            "state_changed": False,
            "audit_record_path": None,
            "new_as_of": None,
            "retried_count": 0,
            "error_message": f"http_error: {exc}"[:300],
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "briefing_visit_matter: unexpected matter=%s err=%r",
            canonical, exc,
        )
        return {
            "matter_path": canonical,
            "applied": False,
            "state_changed": False,
            "audit_record_path": None,
            "new_as_of": None,
            "retried_count": 0,
            "error_message": f"unexpected: {type(exc).__name__}: {exc}"[:300],
        }

    return {
        "matter_path": canonical,
        "applied": bool(result.applied),
        "state_changed": bool(result.applied),
        "audit_record_path": result.audit_record_path,
        "new_as_of": result.new_as_of,
        "retried_count": int(result.retried_count or 0),
        "error_message": None,
    }


# ---------------------------------------------------------------------------
# Activity: compose_and_write_briefing  (Phase 2 — two-phase write)
# ---------------------------------------------------------------------------


def _build_composition_prompt(
    *,
    slot: str,
    window_start_iso: str,
    window_end_iso: str,
    matter_snapshots: list[dict[str, Any]],
    state_changes_count: int,
    signals_count: int,
    decisions_count: int,
    pending_decisions: list[dict[str, Any]],
    anomalies: list[dict[str, Any]],
    autonomous_actions: list[dict[str, Any]],
    inbox_unresolved_count: int,
) -> str:
    """Compose the prompt asking the clerk for the brief body.

    The brief reads like a chief-of-staff briefing, not a narration of
    static state: today's decisions first, flags, autonomous actions,
    a one-line summary of holding matters, sign-off. Empty sections are
    omitted entirely — silence is the signal. See package CLAUDE.md
    plus the discussion that produced this prompt for the design.

    Wikilinks use the matter *name* ([[Hanna's First Year]]) — the
    SaaS Markdown renderer's `getVaultTitleIndex` (XC #873) resolves
    title→slug for navigation. The clerk sees only post-mutation
    matter snapshots so the prose can't drift from current_state.
    """
    pending_top = pending_decisions[:3]
    holding_names = [
        s.get("name") for s in matter_snapshots
        if not s.get("state_changed_this_brief")
        and not any(
            (p.get("target_path") or "").lower() == (s.get("path") or "").lower()
            for p in pending_top
        )
    ]
    holding_names = [n for n in holding_names if n]
    lines = [
        f"You are Alfred. You write Sir's {slot} brief.",
        "",
        "You are not a narrator. You are a chief of staff handing Sir his",
        "day on one page. Every line earns its place. Static state is not",
        "news. If nothing happened to a matter, do not write about it.",
        "",
        f"WINDOW: {window_start_iso} → {window_end_iso}",
        "",
        "What moved in this window:",
        f"  - State changes recorded:           {state_changes_count}",
        f"  - Signals observed (24h):           {signals_count}",
        f"  - Decisions logged (24h):           {decisions_count}",
        f"  - Pending in Sir's decision queue:  {len(pending_decisions)}",
        f"  - Inbox items unresolved:           {inbox_unresolved_count}",
        "",
        "POST-MUTATION matter snapshots (current state — wikilink them by",
        "[[name]], not by slug):",
        json.dumps(matter_snapshots, indent=2, default=str)[:5000],
        "",
        f"PENDING DECISIONS Sir must rule on (top {len(pending_top)} by",
        "recency, with the question each is asking):",
        json.dumps(pending_top, indent=2, default=str)[:2500],
        "",
        "ANOMALIES the system detected (card declines, missing data feeds,",
        "failed integrations, expired auth, brief gather errors):",
        json.dumps(anomalies, indent=2, default=str)[:1500],
        "",
        "THINGS I HANDLED AUTONOMOUSLY in this window (state changes Sir",
        "did not have to make):",
        json.dumps(autonomous_actions, indent=2, default=str)[:1500],
        "",
        f"NAMES OF HOLDING MATTERS (no-change, for the §Quiet line): "
        f"{json.dumps(holding_names[:12])}",
        "",
        "─" * 60,
        "WRITE THE BRIEF AS FOLLOWS — keep this skeleton, in this order.",
        "Use **bold** prose labels for the section names. No markdown",
        "headings (# / ##).",
        "",
        "1. ONE-SENTENCE OPENING.",
        "   Greet Sir, date, and the weather of the day's load",
        '   (e.g. "a quiet morning", "an unusually busy desk", "three',
        '   things wanting your call before lunch"). Skip if nothing follows.',
        "",
        "2. **Today.** — what needs Sir's hand.",
        "   If pending_decisions is non-empty: 1–3 most material as a short",
        "   numbered list. Each item ONE sentence: the matter, the question,",
        "   the recommended action if you have one. Wikilink the matter as",
        "   [[<matter name>]]. If the queue is empty, OMIT this section.",
        "",
        "3. **Flags.** — anomalies.",
        "   Only if anomalies is non-empty. Bullet list, one line each.",
        '   Lead each bullet with the problem verb ("Card declined…",',
        '   "Signal source absent…", "Auth expired on…"). Skip section if',
        '   empty. Never write "everything is fine."',
        "",
        "4. **I handled.** — what you did so Sir didn't have to.",
        "   Only if autonomous_actions is non-empty. Bullet list, past",
        "   tense, one line each. Never fabricate to fill it.",
        "",
        "5. **Quiet.** — single line summarising no-change matters.",
        '   ONE sentence at most, e.g.: "Eight matters holding their state',
        '   — <names>. I\'ll surface them when something moves." Wikilink',
        "   only if natural; do not list 12 names.",
        "",
        "6. SIGN-OFF.",
        '   One short line, no flourish. ("Standing by." / "Yours, ready.")',
        "",
        "─" * 60,
        "HARD RULES.",
        "",
        "- If a section has no content, OMIT IT. Do not write \"Nothing",
        '  today" or "All quiet on X." Silence is the signal.',
        '- Never write that something "rests serene" or "lingers in',
        '  abeyance" or "shows no motion." If a matter didn\'t move, it',
        "  belongs in §5 or not at all.",
        "- Wikilinks use the matter NAME. Write [[Hanna's First Year]],",
        "  not [[matter/family-life-hannas-first-year]].",
        "- Past events are past. If a date in your snapshot is older than",
        "  the window, do not surface it.",
        "- Voice: courteous, dry, present-tense, short sentences. You are",
        "  a British chief of staff briefing a busy principal at 06:30.",
        "  You are not Wodehouse.",
        f"- Hard cap: {BRIEF_BODY_CHAR_CAP} characters. Be ruthless.",
        "- No JSON, no YAML, no markdown headings. Only **bold** labels",
        "  and prose / bullets.",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Composer gatherers — feed the new prompt's "Today / Flags / I handled"
# sections. All best-effort: a failure in any gather returns an empty list
# and the matching prompt section omits itself.
# ---------------------------------------------------------------------------


async def _gather_pending_decisions(
    vault: VaultClient, limit: int = 5,
) -> list[dict[str, Any]]:
    """Top-N pending needs_attention records, most recent first."""
    try:
        records = await vault.list_records(
            "needs_attention", status="pending", limit=100,
        )
    except httpx.HTTPError as exc:
        logger.warning("_gather_pending_decisions: list failed err=%s", exc)
        return []
    items: list[dict[str, Any]] = []
    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        fm = rec.get("frontmatter") if isinstance(rec.get("frontmatter"), dict) else {}
        created_raw = fm.get("created") or rec.get("created") or ""
        items.append({
            "path": rec.get("path"),
            "headline": (
                fm.get("display_headline")
                or fm.get("action_what")
                or "(no headline)"
            ),
            "body": (
                fm.get("display_body")
                or fm.get("reasoning")
                or ""
            )[:300],
            "target_path": fm.get("target_path") or "",
            "suggested_actor": fm.get("suggested_actor") or "",
            "created": str(created_raw),
        })
    items.sort(key=lambda x: x.get("created") or "", reverse=True)
    return items[:limit]


def _derive_anomalies_from_visits(
    visit_results: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Surface briefing_visit errors as anomalies the brief should flag."""
    out: list[dict[str, Any]] = []
    for entry in visit_results or []:
        if not isinstance(entry, dict):
            continue
        err = entry.get("error_message")
        if not err:
            continue
        out.append({
            "kind": "brief_gather_error",
            "matter_path": entry.get("matter_path"),
            "message": str(err)[:240],
        })
    return out


async def _gather_signal_anomalies(
    vault: VaultClient,
    window_start: dt.datetime,
    window_end: dt.datetime,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Signals classified as anomaly/system_error inside the window."""
    try:
        records = await vault.list_records("signal", limit=400)
    except httpx.HTTPError as exc:
        logger.warning("_gather_signal_anomalies: list failed err=%s", exc)
        return []
    out: list[dict[str, Any]] = []
    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        fm = rec.get("frontmatter") if isinstance(rec.get("frontmatter"), dict) else {}
        classification = str(fm.get("classification") or "").lower()
        target_kind = str(fm.get("target_kind") or "").lower()
        if classification not in {"anomaly", "system_error"} and target_kind != "system":
            continue
        ts_raw = fm.get("created") or rec.get("created") or ""
        ts = _parse_iso_or_none(ts_raw)
        if ts is None or ts < window_start or ts > window_end:
            continue
        out.append({
            "kind": classification or target_kind or "signal_anomaly",
            "headline": (
                fm.get("display_headline")
                or fm.get("name")
                or "(unnamed signal)"
            ),
            "body": (fm.get("display_body") or fm.get("reasoning") or "")[:240],
        })
        if len(out) >= limit:
            break
    return out


def _is_autonomous_source(source: str | None) -> bool:
    """Source strings starting with ``manual.`` are Sir; everything else
    is autonomous (briefing.*, steward.*, decision_router.*, etc.)."""
    s = str(source or "").strip().lower()
    if not s:
        return False
    return not s.startswith("manual.")


async def _gather_autonomous_actions(
    vault: VaultClient,
    window_start: dt.datetime,
    window_end: dt.datetime,
    limit: int = 15,
) -> list[dict[str, Any]]:
    """State-change audit records in window where source != manual.*."""
    try:
        records = await vault.list_records("event", limit=400)
    except httpx.HTTPError as exc:
        logger.warning("_gather_autonomous_actions: list failed err=%s", exc)
        return []
    out: list[dict[str, Any]] = []
    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        path = str(rec.get("path") or "")
        # state_mutator audits land at event/state-change-*.md
        if "state-change-" not in path:
            continue
        fm = rec.get("frontmatter") if isinstance(rec.get("frontmatter"), dict) else {}
        ts_raw = fm.get("applied_at") or fm.get("created") or rec.get("created")
        ts = _parse_iso_or_none(ts_raw)
        if ts is None or ts < window_start or ts > window_end:
            continue
        source = fm.get("source")
        if not _is_autonomous_source(source):
            continue
        out.append({
            "source": str(source),
            "target_path": fm.get("target_path") or "",
            "reason": (fm.get("reason") or "")[:160],
            "applied_at": str(ts_raw)[:40],
        })
        if len(out) >= limit:
            break
    return out


async def _gather_inbox_unresolved_count(vault: VaultClient) -> int:
    """Count of inbox items still awaiting Sir's review."""
    try:
        records = await vault.list_records("inbox_item", limit=500)
    except httpx.HTTPError as exc:
        logger.warning("_gather_inbox_unresolved_count: list failed err=%s", exc)
        return 0
    count = 0
    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        fm = rec.get("frontmatter") if isinstance(rec.get("frontmatter"), dict) else {}
        status = str(fm.get("status") or rec.get("status") or "").lower()
        if status in {"", "pending", "open", "unresolved", "needs_review"}:
            count += 1
    return count


@activity.defn
async def compose_and_write_briefing(
    slot: str,
    window_start_iso: str,
    window_end_iso: str,
    visit_results: list[dict[str, Any]],
    prior_briefing_path: str | None = None,
) -> str:
    """Phase 2 — re-read each matter, compose the brief, write the snapshot.

    Spec §8.3 — the brief body is composed from the post-mutation
    matter set, not the pre-mutation snapshot. Even if a matter
    mutated during Phase 1, Phase 2 reads it back from disk before
    composing prose about it.

    Returns the briefing record path (``briefing/<YYYY-MM-DD>-<slot>.md``).
    """
    slot_norm = str(slot or "").strip().lower()
    if slot_norm not in ("morning", "evening"):
        slot_norm = "morning"

    window_start = _parse_iso_or_none(window_start_iso) or (
        _now_utc() - DEFAULT_FALLBACK_WINDOW
    )
    window_end = _parse_iso_or_none(window_end_iso) or _now_utc()
    window_start_iso_norm = _iso(window_start)
    window_end_iso_norm = _iso(window_end)

    # Phase 2a — re-read every matter (post-mutation).
    config = load_config()
    vault = VaultClient(config)
    matter_snapshots: list[dict[str, Any]] = []
    observed_matters: list[dict[str, Any]] = []
    state_changes_count = 0
    signals_count_total = 0
    decisions_count_total = 0

    try:
        for entry in visit_results or []:
            if not isinstance(entry, dict):
                continue
            mpath = str(entry.get("matter_path") or "").strip()
            if not mpath:
                continue
            state_changed = bool(entry.get("state_changed") or entry.get("applied"))
            audit_path = entry.get("audit_record_path")
            if state_changed:
                state_changes_count += 1
            observed_matters.append({
                "path": mpath,
                "state_changed": state_changed,
                "state_change_audit": audit_path if state_changed else None,
            })
            try:
                rec = await vault.read_record(mpath)
            except httpx.HTTPError as exc:
                logger.warning(
                    "compose_and_write_briefing: read failed matter=%s err=%s",
                    mpath, exc,
                )
                continue
            fm = rec.get("frontmatter") if isinstance(rec, dict) else None
            if not isinstance(fm, dict):
                fm = {}
            matter_snapshots.append({
                "path": mpath,
                "slug": _slug_from_matter_path(mpath),
                "name": str(fm.get("name") or _slug_from_matter_path(mpath)),
                "current_state": str(fm.get("current_state") or "").strip()[:600],
                "as_of": str(fm.get("as_of") or "").strip(),
                "surface_class": str(fm.get("surface_class") or "").strip(),
                "state_changed_this_brief": state_changed,
            })

        # Best-effort signal/decision count over the window — purely for
        # the briefing frontmatter's ``observed.signals_count`` / ``decisions_count``
        # fields. Not load-bearing for the prose itself.
        for record_type, counter_setter in (
            ("signal", "signals"),
            ("decision", "decisions"),
        ):
            try:
                records = await vault.list_records(record_type, limit=10_000)
            except httpx.HTTPError:
                continue
            count = 0
            for rec in records:
                if not isinstance(rec, dict):
                    continue
                fm = rec.get("frontmatter") or rec
                if not isinstance(fm, dict):
                    fm = {}
                ts_raw = (
                    fm.get("applied_at")
                    or fm.get("created")
                    or rec.get("created")
                )
                ts = _parse_iso_or_none(ts_raw)
                if ts is None or ts < window_start or ts > window_end:
                    continue
                count += 1
            if counter_setter == "signals":
                signals_count_total = count
            else:
                decisions_count_total = count

        # Phase 2a' — Chief-of-staff context: what Sir must rule on, what
        # broke, what Alfred handled. All best-effort; an empty list just
        # makes the matching prompt section omit itself.
        pending_decisions = await _gather_pending_decisions(vault, limit=5)
        signal_anomalies = await _gather_signal_anomalies(
            vault, window_start=window_start, window_end=window_end,
        )
        autonomous_actions = await _gather_autonomous_actions(
            vault, window_start=window_start, window_end=window_end,
        )
        inbox_unresolved_count = await _gather_inbox_unresolved_count(vault)
    finally:
        await vault.close()

    visit_anomalies = _derive_anomalies_from_visits(visit_results)
    anomalies = visit_anomalies + signal_anomalies

    # Phase 2b — clerk composes the brief body from post-mutation state.
    composition_prompt = _build_composition_prompt(
        slot=slot_norm,
        window_start_iso=window_start_iso_norm,
        window_end_iso=window_end_iso_norm,
        matter_snapshots=matter_snapshots,
        state_changes_count=state_changes_count,
        signals_count=signals_count_total,
        decisions_count=decisions_count_total,
        pending_decisions=pending_decisions,
        anomalies=anomalies,
        autonomous_actions=autonomous_actions,
        inbox_unresolved_count=inbox_unresolved_count,
    )

    try:
        body_text = await _call_clerk(composition_prompt, raw=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "compose_and_write_briefing: clerk failed slot=%s err=%s — "
            "writing a stub body",
            slot_norm, exc,
        )
        body_text = (
            "Sir — the brief composer was unable to reach the clerk; "
            "matter state below is current but the prose is missing."
        )
    if not isinstance(body_text, str):
        body_text = str(body_text)
    body_text = body_text.strip()
    # If clerk returned a failure sentinel ('[assistant turn failed...]' or
    # similar), don't let it become the brief body — replace with a stub that
    # makes the failure visible without polluting the snapshot with garbage.
    if _is_clerk_failure(body_text):
        logger.warning(
            "compose_and_write_briefing: clerk returned failure sentinel "
            "slot=%s body=%r — writing a stub body so the brief record is "
            "salvageable", slot_norm, body_text[:200],
        )
        body_text = (
            "Sir — the brief composer received an empty turn from the "
            "clerk and could not compose prose for this slot. Matter state "
            "snapshots below are current; please regenerate when the gateway "
            "is healthy."
        )
    if len(body_text) > BRIEF_BODY_CHAR_CAP:
        body_text = body_text[:BRIEF_BODY_CHAR_CAP].rstrip() + "..."

    # Phase 2c — write the snapshot record.
    composed_at_iso = _iso(window_end)
    date_str = window_end.date().isoformat()
    record_name = f"{date_str}-{slot_norm}"
    chore_run_ref = (
        f"alfred-data/chore-run-history.jsonl#daily-{slot_norm}-briefing@"
        f"{composed_at_iso}"
    )

    # Build frontmatter manually (the ctrl-api ``write_record`` endpoint
    # passes the full markdown payload through; flat YAML scalars are
    # the safe shape the parser handles uniformly).
    fm_lines: list[str] = [
        "---",
        "record_type: briefing",
        f"slot: {slot_norm}",
        f"composed_at: {composed_at_iso}",
        f"prior_briefing: {prior_briefing_path or ''}",
        f"window_start: {window_start_iso_norm}",
        f"window_end: {window_end_iso_norm}",
        f"observed_matters_count: {len(observed_matters)}",
        f"state_changes_count: {state_changes_count}",
        f"signals_count: {signals_count_total}",
        f"decisions_count: {decisions_count_total}",
        f"chore_run: {chore_run_ref}",
        # Structured `window` + `observed` blocks live in the body as
        # YAML for the dashboard to pluck out — the flat parser would
        # collapse them to empty lists otherwise. We keep the scalar
        # mirrors above so flat consumers (list endpoints, search) still
        # render the right counts.
        "---",
    ]
    fm_block = "\n".join(fm_lines)
    # The brief body is just the letterpress prose. No embedded HTML-comment
    # structured-shape block — the structured join data lives in frontmatter
    # via observed_matters_count + observed_matters_paths (below) so the body
    # stays clean letterpress, not a YAML dump leaking into the page.
    content = "\n".join([
        fm_block,
        "",
        body_text,
        "",
    ])

    config = load_config()
    vault = VaultClient(config)
    try:
        path = await vault.write_record("briefing", record_name, content)
    finally:
        await vault.close()
    logger.info(
        "compose_and_write_briefing: wrote slot=%s path=%s matters=%d "
        "state_changes=%d signals=%d decisions=%d",
        slot_norm, path, len(observed_matters),
        state_changes_count, signals_count_total, decisions_count_total,
    )
    return path


__all__ = [
    "BRIEF_BODY_CHAR_CAP",
    "DEFAULT_BRIEFING_CONFIDENCE",
    "DEFAULT_FALLBACK_WINDOW",
    "NARRATIVE_CHAR_CAP",
    "briefing_visit_matter",
    "compose_and_write_briefing",
    "get_prior_briefing",
    "list_active_matters_for_briefing",
    "propose_briefing_matter_update",
]
