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
from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any
from zoneinfo import ZoneInfo

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
# SOUL.md loader — same pattern as signals._load_soul_md (Phase 3, #889).
# The voice guide lives in the tenant workspace; ctrl-api exposes a read
# at /api/v1/admin/workspace/SOUL.md. Best-effort: if it's unreachable or
# empty, we just compose without it and the prompt's voice rules carry.
# ---------------------------------------------------------------------------


async def _load_soul_md() -> str | None:
    """Read SOUL.md from the tenant workspace via ctrl-api.

    Returns the SOUL.md body or ``None`` if unreachable / empty. The
    briefing composer inlines this into the compose prompt so Alfred's
    written voice carries Sir's own register — the same pattern signal
    extraction uses (signals.py:1515).
    """
    cfg = load_config()
    base_url = getattr(cfg, "alfred_ctrl_url", None)
    if not base_url:
        return None
    api_key = os.environ.get("AAS_API_KEY", "")
    if not api_key:
        return None
    try:
        async with httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=5.0,
        ) as soul_client:
            resp = await soul_client.get("/api/v1/admin/workspace/SOUL.md")
            resp.raise_for_status()
            payload = resp.json()
            content = payload.get("content") if isinstance(payload, dict) else None
            if isinstance(content, str) and content.strip():
                return content.strip()
            return None
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("briefing._load_soul_md: skipping SOUL.md (degraded): %s", exc)
        return None


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


def _tenant_tz(config: Any = None) -> tzinfo:
    """Resolve the tenant's IANA timezone (env ``TENANT_TIMEZONE``, via
    ``Config.tenant_timezone``; default UTC). Falls back to UTC on an
    unknown / unloadable zone so a misconfigured tenant never wedges the
    brief.

    Chore schedules fire at tenant-local time (ctrl ``chores.ts``), so the
    brief's date/dateline + day-shape "today" must be derived in this zone,
    not in UTC — otherwise a non-UTC tenant gets a brief named/dated to the
    wrong calendar day (B7).
    """
    cfg = config or load_config()
    name = getattr(cfg, "tenant_timezone", None) or "UTC"
    try:
        return ZoneInfo(str(name))
    except Exception:  # noqa: BLE001 — bad zone string / missing tzdata
        logger.warning(
            "briefing: unknown TENANT_TIMEZONE=%r — falling back to UTC", name
        )
        return timezone.utc


def _tenant_local(dt: datetime, config: Any = None) -> datetime:
    """Convert an instant to the tenant's local wall-clock time."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_tenant_tz(config))


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

    # Signals are state.db rows now (storage cutover #27) — query
    # ctrl-api's /api/v1/state/signals scoped to this matter instead of
    # walking vault/signal/. ctrl-api filters on the indexed
    # ``matter_ref`` column. Decisions stay canonical vault markdown.
    try:
        from src.utils.signal_state import StateClient, signal_row_to_record

        async with StateClient(config) as sc:
            try:
                sig_rows = await sc.list_signals(
                    matter=target_path,
                    since=_iso(window_start),
                    limit=10_000,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "briefing.gather_observed: state.db signal query "
                    "failed target=%s err=%s", target_path, exc,
                )
                sig_rows = []
        for row in sig_rows:
            rec = signal_row_to_record(row)
            fm = rec.get("frontmatter") or {}
            # matter filter is server-side, but a signal can also touch
            # the matter via target_candidates / related_matters — keep
            # the structural check for those.
            if not _record_targets_matter(fm, target_path):
                # ``matter_ref`` matched server-side; trust it.
                if str(fm.get("target_matter_path") or "").strip() != target_path:
                    continue
            ts_raw = fm.get("applied_at") or fm.get("created") or rec.get("created")
            ts = _parse_iso_or_none(ts_raw)
            if ts is None or ts < window_start or ts > window_end:
                continue
            sid = str(rec.get("id") or "").strip()
            if sid:
                signal_paths.append(sid)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "briefing.gather_observed: signal gather failed target=%s err=%s",
            target_path, exc,
        )

    try:
        try:
            records = await vault.list_records("decision", limit=10_000)
        except httpx.HTTPError as exc:
            logger.warning(
                "briefing.gather_observed: decision list failed target=%s "
                "err=%s", target_path, exc,
            )
            records = []
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
                decision_paths.append(path)
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


def _strip_compose_preamble(body: str) -> str:
    """Drop model-emitted chatter that sometimes lands above the brief.

    Some models prepend a meta-line like "Let me draft your afternoon brief."
    followed by a `---` separator and only then the real prose. The
    separator can be `---`, `***`, or `___` on its own line. If we find
    such a separator within the first ~300 characters, treat everything
    before it as preamble and return the rest.
    """
    if not body:
        return body
    head_window = 300
    for sep in ("\n---\n", "\n***\n", "\n___\n"):
        idx = body.find(sep)
        if 0 <= idx < head_window:
            after = body[idx + len(sep):].lstrip()
            if len(after) > 80:
                return after
    return body


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
    soul_md: str | None = None,
    window_signals: list[dict[str, Any]] | None = None,
    window_decisions: list[dict[str, Any]] | None = None,
    waiting_on_you: list[dict[str, Any]] | None = None,
    prior_today_text: str = "",
    in_flight_agents: list[dict[str, Any]] | None = None,
    money_envelope: dict[str, Any] | None = None,
    day_shape: dict[str, Any] | None = None,
) -> str:
    """Compose the prompt asking the clerk for the brief body.

    The brief reads like a chief-of-staff briefing, not a narration of
    static state: today's decisions first, flags, autonomous actions,
    a one-line summary of holding matters, sign-off. Empty sections are
    omitted entirely — silence is the signal. See package CLAUDE.md
    plus the discussion that produced this prompt for the design.

    Wikilinks use the matter *name* ([[Robin's First Year]]) — the
    SaaS Markdown renderer's `getVaultTitleIndex` (XC #873) resolves
    title→slug for navigation. The clerk sees only post-mutation
    matter snapshots so the prose can't drift from current_state.
    """
    pending_top = pending_decisions[:3]
    window_signals = window_signals or []
    window_decisions = window_decisions or []
    waiting_on_you = waiting_on_you or []
    in_flight_agents = in_flight_agents or []
    money_envelope = money_envelope or {"integration_available": False, "items": []}
    day_shape = day_shape or {"integration_available": False, "events_today": [], "events_tomorrow": []}
    day_events_today = day_shape.get("events_today") or []
    money_items = money_envelope.get("items") or []
    holding_names = [
        s.get("name") for s in matter_snapshots
        if not s.get("state_changed_this_brief")
        and not any(
            (p.get("target_path") or "").lower() == (s.get("path") or "").lower()
            for p in pending_top
        )
    ]
    holding_names = [n for n in holding_names if n]

    lines: list[str] = [
        f"You are Alfred. You write Sir's {slot} brief.",
        "",
        "════════════════════════════════════════════════════════════",
        "ABSOLUTE PROHIBITIONS — violating any of these voids the brief:",
        "",
        "1. NO WEATHER. You have no weather feed. Never name temperature,",
        "   conditions ('light rain', 'overcast'), or season. If you find",
        "   yourself writing °C, ° F, 'sunny', 'rain', 'cool', 'warm', stop.",
        "2. NO CITY COLOUR. Do not name Budapest, Hungary, the river, the",
        "   light, the streets — you do not see them.",
        "3. NO INVENTED CALENDAR. You have no calendar feed. Never name a",
        "   meeting, an appointment, or a time unless it appears verbatim",
        "   in a signal or matter snapshot below.",
        "4. NO PEOPLE you did not see in a signal. If the name isn't in",
        "   the data below, it does not belong in the brief.",
        "5. NO MARKDOWN HEADINGS (# or ##). Only **bold prose labels**.",
        "════════════════════════════════════════════════════════════",
        "",
        "You are a butler handing Sir his day on one page. Your job is to",
        "LOAD HIS CONTEXT so he wakes up oriented: where his live matters",
        "stand right now, what's on today, what's waiting on his call, what",
        "crossed his money, what you handled for him. Movement is ONE input,",
        "not the filter — a matter that did not move still belongs in the",
        "brief if it is live, because Sir needs to hold its state in his",
        "head. Even a quiet day gets a substantive orientation. A one-line",
        "shrug is a failure: you have his matters, his decisions, his",
        "signals below — use them.",
        "",
    ]

    if soul_md:
        lines.extend([
            "─" * 60,
            "### SOUL.md — Sir's voice guide. This shapes HOW you speak,",
            "not WHAT you cover. The data below decides what you cover;",
            "SOUL decides the texture of every sentence.",
            "",
            soul_md,
            "",
            "─" * 60,
            "",
        ])

    lines.extend([
        f"WINDOW: {window_start_iso} → {window_end_iso}",
        "",
        "What moved in this window:",
        f"  - State changes recorded:           {state_changes_count}",
        f"  - Signals observed (24h):           {signals_count}",
        f"  - Decisions Sir made (24h):         {decisions_count}",
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
        f"SIGNALS IN WINDOW (full set, {len(window_signals)} items — what",
        "actually landed in Sir's world: emails, calendar moves, vexa",
        "transcripts, omi captures, his own outbound). Most recent first.",
        "Use these to write specific, concrete prose. Do NOT just count",
        "them.",
        json.dumps(window_signals[:30], indent=2, default=str)[:6000],
        "",
        f"DECISIONS SIR MADE IN WINDOW (full set, {len(window_decisions)}",
        "items — what Sir told the system to do, with his note and outcome.",
        "Close the loop on each that matters: 'yesterday you asked me to",
        "X — that's now Y'.",
        json.dumps(window_decisions[:20], indent=2, default=str)[:4000],
        "",
        f"WAITING ON YOU ({len(waiting_on_you)} items) — counterparties whose",
        "ball is in Sir's court. Each is a signal that needed his response",
        "and he hasn't acted on yet (no closing decision, not already in",
        "PENDING DECISIONS above):",
        json.dumps(waiting_on_you[:8], indent=2, default=str)[:2500],
        "",
        f"PRIOR BRIEF — YESTERDAY'S §Today ({len(prior_today_text)} chars).",
        "These are the items the principal woke up to yesterday morning.",
        "Compare them against PENDING DECISIONS + DECISIONS SIR MADE +",
        "MATTER SNAPSHOTS to decide which are now closed, which are still",
        "open, which were superseded:",
        prior_today_text[:1200] or "(no prior brief in record)",
        "",
        f"IN FLIGHT — ephemeral agents currently working ({len(in_flight_agents)}):",
        "Long-running delegations Alfred is still resolving. Distinct from",
        "I-HANDLED-AUTONOMOUSLY (those are already done):",
        json.dumps(in_flight_agents[:6], indent=2, default=str)[:1500],
        "",
        f"MONEY ENVELOPE (integration_available={money_envelope.get('integration_available')}",
        f", {len(money_items)} items) — recent transactions / upcoming",
        "subscription renewals / declines via Composio. Omit §Money if",
        "integration_available is False or items is empty.",
        json.dumps(money_envelope, indent=2, default=str)[:2000],
        "",
        f"DAY SHAPE (integration_available={day_shape.get('integration_available')}",
        f", {len(day_events_today)} events today, "
        f"{len(day_shape.get('events_tomorrow') or [])} tomorrow) — today's",
        "Google Calendar. Use events_today to name the day's centerpiece",
        "in §Day's shape. Omit §Day's shape if integration_available is",
        "False or events_today is empty.",
        json.dumps(day_shape, indent=2, default=str)[:2500],
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
        "headings (# / ##). Each section's emit-rule is explicit below;",
        "follow it literally. REQUIRED sections cannot be merged into other",
        "sections or dropped.",
        "",
        "FORMAT NOTE: your FIRST output character must be the first letter",
        "of the greeting sentence. Do NOT prepend a preamble such as 'Let",
        "me draft your brief.' or '---' or any meta-commentary. Do NOT end",
        "with a meta-line. Output only the brief, starting at §1.",
        "",
        "1. ONE-SENTENCE OPENING. REQUIRED.",
        "   Greet Sir by name and name the day's WEIGHT and SHAPE — what is",
        "   ahead of him — drawn from the counts and matters below. Name how",
        "   many live matters he's carrying, whether anything wants his call",
        '   today, what is on. Examples of tone: "a full desk — nine matters',
        '   live and three wanting your call before lunch", "a steady morning',
        '   — your matters are holding, nothing demands you yet". NEVER',
        "   describe the day as empty or as 'nothing'; he is carrying live",
        "   matters and you owe him their state. ONE sentence only. DO NOT",
        "   extend with weather, temperature, °C, °F, sunshine, rain, fog,",
        "   city, river, season, or any meteorological or geographical",
        "   detail. You do not have that data. If you write weather, the",
        "   brief is invalid.",
        "",
        f"1b. **Where things stand.** — REQUIRED whenever POST-MUTATION "
        f"matter snapshots has ≥1 entry (currently {len(matter_snapshots)} "
        "matters). This is the spine of the brief — never omit it.",
        "    Walk Sir's LIVE matters and give him each one's standing in ONE",
        "    short line: lead with the matter as [[<matter name>]], then a",
        "    clause drawn from its `current_state` (paraphrase in your",
        "    voice, do not dump the raw snapshot). This is orientation, not",
        "    news — surface a matter EVEN IF it did not move this window,",
        "    because Sir needs to know where it sits. Lead with the matters",
        "    that moved or that surface_class marks most consequential, then",
        "    the steady ones. Cap the detailed lines at the 8 most material",
        "    matters; if more remain, roll the tail into one closing line:",
        '    "and four others holding — [[Foo]], [[Bar]], … steady." Ground',
        "    every clause in the snapshot's current_state — invent nothing.",
        "",
        "2. **Day's shape.** — REQUIRED if DAY SHAPE has "
        f"integration_available=True AND events_today has ≥1 entry "
        f"(currently {len(day_events_today)} events today).",
        "   ONE or TWO sentences naming the centerpiece of today: the",
        "   anchor meeting, the standing block, the appointment that",
        "   shapes the day. Quote times in 12h with am/pm. If two events",
        "   are roughly equal weight, name both; otherwise pick the one",
        "   that costs the most attention. Skip recurring tiny items",
        '   (15-min standups). Example: "Centrepiece today is your 3pm',
        '   makerspace pitch with Example Bank — a full hour, three on the',
        '   other side." OMIT entirely if events_today is empty.',
        "",
        f"3. **Today.** — REQUIRED if pending_decisions has ≥1 item "
        f"(currently {len(pending_decisions)}).",
        "   1–3 most material as a short numbered list. Each item ONE",
        "   sentence: the matter, the question, the recommended action if",
        "   you have one. Wikilink the matter as [[<matter name>]]. Omit",
        "   the section only if pending_decisions is empty.",
        "",
        f"4. **Waiting on you.** — REQUIRED if WAITING ON YOU has ≥1 "
        f"item (currently {len(waiting_on_you)}).",
        "   Threads where the ball is in Sir's court — someone wrote to",
        "   him, he hasn't replied. Bullet list, one line each. Lead with",
        '   the person ("Alex on Slack since Tuesday — the kindergarten',
        '   forms."). Cluster two-from-same-person on one line. Cap at 5',
        "   bullets; if more, end with 'and three other quieter threads.'",
        "   Distinct from §Today (decisions) and §What landed (info-only).",
        "",
        "5. **Since yesterday.** — REQUIRED if PRIOR BRIEF §Today has "
        "content AND any item in it is unresolved or worth a status note.",
        "   Walk yesterday's §Today items one by one. Report each: closed,",
        "   still open, or superseded. ONE bullet per item, past-tense.",
        '   Examples: "Yesterday\'s Example Co EIN — still open." /',
        '   "Yesterday\'s npm renewal — done, the token is rotated." If',
        "   EVERY prior item is fully closed and surfaced under §You",
        "   acted on already, OMIT this section to avoid duplication.",
        "",
        f"6. **You acted on.** — REQUIRED if DECISIONS SIR MADE has ≥1 "
        f"item (currently {len(window_decisions)}).",
        "   Walk the DECISIONS SIR MADE list. For each decision worth",
        "   surfacing, write ONE sentence closing the loop: what Sir asked",
        "   + what is now true. Examples of tone:",
        '     - "Yesterday you delegated the Example Co RSVP — that\'s now',
        '       confirmed."',
        '     - "You marked the Screen Studio renewal not-needed; the',
        '       reminder is queued on Slack."',
        '     - "You held the Acme Co offer for review — it\'s still on',
        '       your desk."',
        "   Group by matter when natural. Cover at least half the",
        "   decisions in the list; do NOT collapse many decisions into one",
        "   sentence. Bullet or paragraph — pick what reads cleanest.",
        "",
        f"7. **What landed.** — REQUIRED if SIGNALS IN WINDOW has ≥1 "
        f"item (currently {len(window_signals)}).",
        "   Cluster the SIGNALS IN WINDOW by target_matter, lead with the",
        "   most consequential, and write 2–5 short sentences of prose a",
        "   butler would say. Each meaningful cluster gets at least one",
        "   sentence; wikilink the matter by name. Prefer the signal's",
        "   `headline` over its `body` for what to surface. Do NOT just",
        "   pick one signal and skip the rest — a 24h window with many",
        "   signals should produce a paragraph, not a sentence.",
        "",
        "8. **Money.** — REQUIRED if MONEY ENVELOPE has "
        f"integration_available=True AND items has ≥1 entry "
        f"(currently {len(money_items)} items).",
        "   ONE or TWO sentences. Surface what crossed Sir's accounts in",
        "   plain English: 'Two charges yesterday — Stripe $1,200 from",
        "   Example Bank, and the A Soft Murmur renewal at $9. Nothing declined.'",
        "   Or for renewals: 'Notion Pro renews tomorrow for $10 — your",
        "   call.' OMIT entirely if integration_available is False.",
        "",
        f"9. **Flags.** — REQUIRED if anomalies has ≥1 item (currently "
        f"{len(anomalies)}).",
        "   Bullet list, one line each. Lead each bullet with the problem",
        '   verb ("Card declined…", "Signal source absent…", "Auth expired',
        '   on…"). Omit only if anomalies is empty.',
        "",
        f"10. **I handled.** — REQUIRED if autonomous_actions has ≥1 "
        f"item (currently {len(autonomous_actions)}).",
        "    Bullet list, past tense, one line each. Never fabricate to",
        "    fill it. Omit only if the array is empty.",
        "",
        f"11. **In flight.** — REQUIRED if IN FLIGHT has ≥1 item "
        f"(currently {len(in_flight_agents)}).",
        "    Long-running delegations Alfred is still working. Bullet",
        '    list, present continuous. Examples: "Still working on the',
        '    Stripe-to-Maybe transaction mapping." / "Drafting the EIN',
        '    update letter for Example Co." Omit if empty.',
        "",
        "12. **Looking ahead.** — OPTIONAL. Emit only if you can point at",
        "    a specific deadline, milestone, or surface_class hint in the",
        "    MATTER SNAPSHOTS above. ONE or TWO sentences. Quote the",
        "    matter by [[name]]. If no such grounding exists, omit. Do",
        "    NOT invent calendar events here — §Day's shape covers today.",
        "",
        "13. **Quiet.** — OPTIONAL, and only for matters NOT already named",
        f"in §1b (currently {len(holding_names)} holding). §Where things",
        "    stand already carries the live matters; use this ONLY to sweep",
        "    up a truly inert tail you chose not to detail above, in ONE",
        '    sentence: "The rest are holding — I\'ll surface them when',
        '    something moves." Omit if §1b already covered everything.',
        "",
        "14. SIGN-OFF. REQUIRED.",
        '    One short line, no flourish. ("Standing by." / "Yours, ready.")',
        "",
        "─" * 60,
        "HARD RULES.",
        "",
        "- Section emit-rules above are CONTRACTS. If a section is marked",
        "  REQUIRED and its triggering array is non-empty, emitting the",
        "  brief without that section is a failure. Do not collapse",
        "  required sections into the opening or sign-off.",
        "- Length floor: UNCONDITIONAL. Whenever there is ANY live context "
        f"to load (matters {len(matter_snapshots)}, signals "
        f"{len(window_signals)}, decisions {len(window_decisions)}, pending "
        f"{len(pending_decisions)}), the brief body MUST be a substantive "
        "orientation of at least 700 characters and MUST include §1 + §1b "
        "(Where things stand) plus every REQUIRED section whose array is "
        "non-empty. A one-line 'quiet morning' brief is a FAILURE — you are "
        "leaving Sir's standing context on the floor.",
        f"- Length cap: {BRIEF_BODY_CHAR_CAP} characters. Be ruthless on",
        "  prose flourish, never on coverage.",
        "- Wikilinks use the matter NAME. Write [[Robin's First Year]],",
        "  not [[matter/family-life-robins-first-year]].",
        "- Past events are past. If a date in your snapshot is older than",
        "  the window, do not surface it.",
        "- Do NOT invent facts you cannot point at in the data above —",
        "  no weather, no city colour, no calendar events, no person you",
        "  did not see in a signal. RE-READ the ABSOLUTE PROHIBITIONS at",
        "  the top of this prompt before you write the opening sentence.",
        "- Voice: Alfred — the voice in SOUL.md. Calm, specific, low-key.",
        "  Plain language. Never engineer-speak ('cloud recording capability",
        "  restored' → 'your Zoom recordings are back online'). Never",
        "  Wodehousian. A real butler, not a parody.",
        '- Never write that something "rests serene" or "lingers in',
        '  abeyance" or "shows no motion." A matter that didn\'t move still',
        "  belongs in §1b (Where things stand) with its current state —",
        "  give Sir its standing, not a euphemism for silence.",
        "- No JSON, no YAML, no markdown headings. Only **bold** labels",
        "  and prose / bullets.",
    ])
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
    """Signals classified as anomaly/system_error inside the window.

    Storage cutover (#27): signals are state.db rows — query ctrl-api's
    /api/v1/state/signals (windowed via ``since``) instead of walking
    vault/signal/. The ``vault`` argument is kept for signature
    stability but is no longer used here.
    """
    try:
        from src.utils.signal_state import StateClient, signal_row_to_record

        config = load_config()
        async with StateClient(config) as sc:
            rows = await sc.list_signals(since=_iso(window_start), limit=400)
        records = [signal_row_to_record(r) for r in rows]
    except Exception as exc:  # noqa: BLE001
        logger.warning("_gather_signal_anomalies: state.db query failed err=%s", exc)
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


async def _gather_window_signals(
    vault: VaultClient,
    window_start: datetime,
    window_end: datetime,
    limit: int = 40,
) -> list[dict[str, Any]]:
    """All signals inside the window — full display copy, not just a count.

    The compose prompt needs to see what actually came in (what Sir asked,
    what other people said, what the world surfaced) so the brief can
    reference real movement rather than counters.

    Storage cutover (#27): signals are state.db rows — query ctrl-api's
    /api/v1/state/signals (windowed via ``since``) instead of walking
    vault/signal/. The ``vault`` argument is kept for signature
    stability but is no longer used here.
    """
    try:
        from src.utils.signal_state import StateClient, signal_row_to_record

        config = load_config()
        async with StateClient(config) as sc:
            rows = await sc.list_signals(since=_iso(window_start), limit=600)
        records = [signal_row_to_record(r) for r in rows]
    except Exception as exc:  # noqa: BLE001
        logger.warning("_gather_window_signals: state.db query failed err=%s", exc)
        return []
    out: list[dict[str, Any]] = []
    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        fm = rec.get("frontmatter") if isinstance(rec.get("frontmatter"), dict) else {}
        ts_raw = fm.get("created") or rec.get("created") or ""
        ts = _parse_iso_or_none(ts_raw)
        if ts is None or ts < window_start or ts > window_end:
            continue
        out.append({
            "when": str(ts_raw)[:19],
            "actor": str(fm.get("actor") or "counterparty"),
            "headline": (
                fm.get("display_headline")
                or fm.get("name")
                or "(unnamed signal)"
            ),
            "body": (fm.get("display_body") or fm.get("reasoning") or "")[:280],
            "target_matter": (fm.get("target_matter_path") or "").rsplit("/", 1)[-1].removesuffix(".md"),
            "decision_required": bool(fm.get("decision_required", True)),
        })
        if len(out) >= limit:
            break
    # Most recent first — Alfred should lead with what just landed.
    out.sort(key=lambda s: s.get("when") or "", reverse=True)
    return out


async def _gather_window_decisions(
    vault: VaultClient,
    window_start: datetime,
    window_end: datetime,
    limit: int = 30,
) -> list[dict[str, Any]]:
    """Decisions Sir made inside the window — drives the §You acted on. loop.

    Each decision carries: intent (delegate/done/noise/defer), Sir's note,
    the matter (if any), and outcome state. The compose prompt uses this
    to close the loop on what Sir told the system to do — without it the
    brief can't say "yesterday you delegated X — that's now confirmed."
    """
    try:
        records = await vault.list_records("decision", limit=600)
    except httpx.HTTPError as exc:
        logger.warning("_gather_window_decisions: list failed err=%s", exc)
        return []
    out: list[dict[str, Any]] = []
    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        fm = rec.get("frontmatter") if isinstance(rec.get("frontmatter"), dict) else {}
        ts_raw = fm.get("created") or rec.get("created") or ""
        ts = _parse_iso_or_none(ts_raw)
        if ts is None or ts < window_start or ts > window_end:
            continue
        matter_ref = fm.get("matter_ref") or ""
        matter_slug = (matter_ref or "").rsplit("/", 1)[-1].removesuffix(".md")
        out.append({
            "when": str(ts_raw)[:19],
            "intent": str(fm.get("intent") or "?"),
            "note": (fm.get("note") or "")[:240],
            "matter": matter_slug,
            "completed_at": str(fm.get("completed_at") or "")[:19],
            "outcome_record": (fm.get("outcome_record") or "").rsplit("/", 1)[-1].removesuffix(".md"),
        })
        if len(out) >= limit:
            break
    out.sort(key=lambda d: d.get("when") or "", reverse=True)
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


# ---------------------------------------------------------------------------
# Chief-of-staff gatherers — A/B/C/D/E sections of the brief.
# ---------------------------------------------------------------------------


async def _ctrl_call(
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    params: dict[str, str] | None = None,
    timeout: float = 30.0,
) -> dict[str, Any] | None:
    """Best-effort ctrl-api call from briefing.py — same pattern as
    ``_load_soul_md`` but reusable across gatherers. Returns None on any
    failure so callers can degrade to empty sections.
    """
    cfg = load_config()
    base_url = getattr(cfg, "alfred_ctrl_url", None)
    if not base_url:
        return None
    api_key = os.environ.get("AAS_API_KEY", "")
    if not api_key:
        return None
    try:
        async with httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
        ) as http:
            if method.upper() == "GET":
                resp = await http.get(path, params=params)
            else:
                resp = await http.post(path, json=body or {})
            resp.raise_for_status()
            return resp.json() if resp.text else {}
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("briefing._ctrl_call %s %s degraded: %s", method, path, exc)
        return None


# ----- A: Waiting on you -----

async def _gather_waiting_on_you(
    window_signals: list[dict[str, Any]],
    window_decisions: list[dict[str, Any]],
    pending_decisions: list[dict[str, Any]],
    limit: int = 6,
) -> list[dict[str, Any]]:
    """Signals from a counterparty that look like they're waiting on Sir.

    Heuristic: a window signal qualifies as a "waiting on you" item when:
      * actor is not 'principal' / 'alfred' / 'system' (someone outside),
      * decision_required is true (the extractor flagged it as needing
        Sir's response),
      * Sir hasn't already acted on it inside the window (no matching
        decision-record by ``target_matter``), and
      * it isn't already surfaced in §Today (top pending decisions).

    Returns a list of small dicts ready for the compose prompt: actor,
    headline, target_matter, when. Most-recent first, capped at limit.
    """
    if not window_signals:
        return []
    acted_on_matters = {
        (d.get("matter") or "").strip().lower()
        for d in (window_decisions or [])
        if (d.get("matter") or "").strip()
    }
    pending_keys = {
        (p.get("target_path") or "").rsplit("/", 1)[-1].removesuffix(".md").lower()
        for p in (pending_decisions or [])
    }
    out: list[dict[str, Any]] = []
    for sig in window_signals:
        actor = (sig.get("actor") or "").strip().lower()
        if actor in {"principal", "sir", "alfred", "system", ""}:
            continue
        if not sig.get("decision_required"):
            continue
        matter_key = (sig.get("target_matter") or "").strip().lower()
        if matter_key and matter_key in acted_on_matters:
            continue
        if matter_key and matter_key in pending_keys:
            # Already surfaced in §Today — don't double-count.
            continue
        out.append({
            "when": sig.get("when"),
            "actor": sig.get("actor") or "counterparty",
            "headline": sig.get("headline") or "(unnamed)",
            "target_matter": sig.get("target_matter") or "",
        })
        if len(out) >= limit:
            break
    return out


# ----- B: Since yesterday's brief -----

async def _load_prior_brief_today(
    vault: VaultClient,
    prior_briefing_path: str | None,
) -> str:
    """Load the prior brief body and return only its §Today section.

    Yesterday's §Today items are the ones we want to report status on
    today — they're the carry-overs the principal opened the morning with.
    The composer compares them to today's pending_decisions + window_decisions
    to write the §Since-yesterday paragraph.

    Returns the raw §Today block text (up to ~1200 chars) or empty string
    on any failure.
    """
    if not prior_briefing_path:
        return ""
    try:
        rec = await vault.read_record(prior_briefing_path)
    except httpx.HTTPError as exc:
        logger.info("_load_prior_brief_today: read failed err=%s", exc)
        return ""
    body = ""
    if isinstance(rec, dict):
        body = str(rec.get("content") or rec.get("body") or "")
    if not body:
        return ""
    # Strip frontmatter if present.
    if body.startswith("---"):
        parts = body.split("---", 2)
        if len(parts) >= 3:
            body = parts[2]
    # Find §Today block — bounded by next **bold-label** line or end-of-body.
    marker = "**Today.**"
    idx = body.find(marker)
    if idx < 0:
        return ""
    rest = body[idx:]
    # Stop at next bold label (e.g. "**You acted on.**", "**What landed.**").
    next_label_idx = -1
    cursor = len(marker)
    while True:
        nxt = rest.find("\n**", cursor)
        if nxt < 0:
            break
        # Ensure it's a label, not a stray **word** mid-sentence.
        tail = rest[nxt + 1 : nxt + 60]
        if tail.startswith("**") and "**" in tail[2:]:
            next_label_idx = nxt
            break
        cursor = nxt + 1
    today_block = rest if next_label_idx < 0 else rest[:next_label_idx]
    return today_block.strip()[:1200]


# ----- C: In-flight delegations -----

async def _gather_in_flight_agents(limit: int = 8) -> list[dict[str, Any]]:
    """Ephemeral agents currently running on behalf of Sir.

    Hits ctrl-api ``GET /api/v1/openclaw/agents/ephemeral`` which reads
    the openclaw-workers gateway config (filtered to ``exec-*`` ids) and
    returns the live ephemeral registry. Each entry is a delegation
    Alfred is still working through; they're torn down by the dispatch
    cleanup once the subagent finishes.
    """
    payload = await _ctrl_call(
        "GET", "/api/v1/openclaw/agents/ephemeral", timeout=10.0,
    )
    if not isinstance(payload, dict):
        return []
    agents_list = payload.get("agents")
    if not isinstance(agents_list, list):
        return []
    out: list[dict[str, Any]] = []
    for a in agents_list:
        if not isinstance(a, dict):
            continue
        aid = str(a.get("id") or "")
        if not aid.startswith("exec-"):
            continue
        out.append({
            "id": aid,
            "purpose": str(a.get("name") or "")[:200],
            "status": "running",
            "started_at": str(a.get("started_at_hint") or "")[:19],
        })
        if len(out) >= limit:
            break
    return out


# ----- D: Money -----

_MONEY_COMPOSIO_ACTIONS = (
    # Try Maybe Finance first (Sir's primary finance system), then
    # generic provider actions as fallbacks. The first action that
    # returns a non-error envelope wins; the rest are skipped.
    "MAYBE_FINANCE_LIST_TRANSACTIONS",
    "STRIPE_LIST_SUBSCRIPTIONS",
)


async def _gather_money_envelope(
    window_start: datetime,
    window_end: datetime,
) -> dict[str, Any]:
    """Last-24h money activity surfaced for §Money.

    Probes a small set of Composio actions in order and returns the first
    non-empty envelope. Degrades cleanly to ``{"integration_available": False}``
    when nothing is wired — the prompt then omits §Money.

    Action names are best-guess until Sir confirms which finance integration
    to surface. See briefing.py changelog (2026-05-14) for context.
    """
    for action in _MONEY_COMPOSIO_ACTIONS:
        try:
            result = await _ctrl_call(
                "POST",
                "/api/v1/integrations/execute",
                body={
                    "action": action,
                    "arguments": {
                        "start_date": window_start.date().isoformat(),
                        "end_date": window_end.date().isoformat(),
                        "limit": 20,
                    },
                },
                timeout=15.0,
            )
        except Exception as exc:  # noqa: BLE001
            logger.info("_gather_money_envelope: %s degraded err=%s", action, exc)
            continue
        if not isinstance(result, dict):
            continue
        if result.get("error"):
            continue
        data = result.get("data") or result.get("result") or result
        if not data:
            continue
        # Return a normalised envelope the prompt can render.
        return {
            "integration_available": True,
            "source_action": action,
            "items": data if isinstance(data, list) else [data],
        }
    return {"integration_available": False, "source_action": None, "items": []}


# ----- E: Day's shape -----

async def _gather_day_shape(now: datetime | None = None) -> dict[str, Any]:
    """Today's calendar centerpiece from Google Calendar via Composio.

    Same proven pattern the legacy daily_digest used (chore_actions.py
    `_gather_signal_bundle`). Returns ``{integration_available, events_today,
    events_tomorrow}`` — empty events list when no commitments. The
    composer uses events_today to name the day's anchor in §Day's shape.
    """
    # ``now`` carries the tenant-local wall clock (passed by the caller).
    # Anchor "today" to its own tzinfo so the day boundaries are the
    # tenant's local midnight, not UTC midnight — otherwise events get
    # bucketed into the wrong calendar day for non-UTC tenants (B7).
    now = now or _now_utc()
    tz = now.tzinfo or timezone.utc
    today = now.date()
    day_start = datetime(today.year, today.month, today.day, tzinfo=tz)
    time_min = day_start.isoformat()
    time_max = (day_start + timedelta(days=2)).isoformat()
    result = await _ctrl_call(
        "POST",
        "/api/v1/integrations/execute",
        body={
            "action": "GOOGLECALENDAR_EVENTS_LIST",
            "arguments": {
                "calendar_id": "primary",
                "time_min": time_min,
                "time_max": time_max,
                "max_results": 50,
                "single_events": True,
                "order_by": "startTime",
            },
        },
        timeout=15.0,
    )
    shape: dict[str, Any] = {
        "integration_available": False,
        "events_today": [],
        "events_tomorrow": [],
    }
    if not isinstance(result, dict):
        return shape
    if result.get("error"):
        return shape
    data = result.get("data") if isinstance(result.get("data"), dict) else None
    items = (data or {}).get("items") or (data or {}).get("event_list") or []
    if not data:
        return shape
    shape["integration_available"] = True
    for item in items:
        if not isinstance(item, dict):
            continue
        start = item.get("start") or {}
        start_str = start.get("dateTime") or start.get("date") or ""
        try:
            start_dt = datetime.fromisoformat(str(start_str).replace("Z", "+00:00"))
            if start_dt.tzinfo is None:
                start_dt = start_dt.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
        summary = {
            "title": item.get("summary") or "(no title)",
            "start": start_str,
            "attendees": [
                (a.get("email") or a.get("displayName") or "")
                for a in (item.get("attendees") or [])[:5]
            ],
        }
        if start_dt.date() == today:
            shape["events_today"].append(summary)
        elif start_dt.date() == today + timedelta(days=1):
            shape["events_tomorrow"].append(summary)
    return shape


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
        # the briefing frontmatter's ``observed.signals_count`` /
        # ``decisions_count`` fields. Not load-bearing for the prose
        # itself. Storage cutover (#27): the signal count comes from
        # state.db (windowed query); the decision count still walks the
        # canonical vault ``decision/`` type.
        try:
            from src.utils.signal_state import StateClient as _SC

            async with _SC(config) as _sc_cnt:
                _sig_rows = await _sc_cnt.list_signals(
                    since=_iso(window_start), limit=10_000,
                )
            sig_count = 0
            for row in _sig_rows:
                ts = _parse_iso_or_none(row.get("ts"))
                if ts is None or ts < window_start or ts > window_end:
                    continue
                sig_count += 1
            signals_count_total = sig_count
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "compose_and_write_briefing: signal count query failed "
                "err=%s", exc,
            )

        try:
            records = await vault.list_records("decision", limit=10_000)
        except httpx.HTTPError:
            records = []
        dcount = 0
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
            dcount += 1
        decisions_count_total = dcount

        # Phase 2a' — Chief-of-staff context: what Sir must rule on, what
        # broke, what Alfred handled, plus the full signal + decision
        # window so the compose prompt can write real prose instead of
        # paraphrasing counters. All best-effort; an empty list just
        # makes the matching prompt section omit itself.
        pending_decisions = await _gather_pending_decisions(vault, limit=5)
        signal_anomalies = await _gather_signal_anomalies(
            vault, window_start=window_start, window_end=window_end,
        )
        autonomous_actions = await _gather_autonomous_actions(
            vault, window_start=window_start, window_end=window_end,
        )
        inbox_unresolved_count = await _gather_inbox_unresolved_count(vault)
        window_signals = await _gather_window_signals(
            vault, window_start=window_start, window_end=window_end,
        )
        window_decisions = await _gather_window_decisions(
            vault, window_start=window_start, window_end=window_end,
        )
        # Chief-of-staff section gatherers (#893 follow-up).
        waiting_on_you = await _gather_waiting_on_you(
            window_signals=window_signals,
            window_decisions=window_decisions,
            pending_decisions=pending_decisions,
        )
        prior_today_text = await _load_prior_brief_today(vault, prior_briefing_path)
    finally:
        await vault.close()

    # The remaining gatherers don't need the vault client — they hit ctrl-api
    # / Composio directly. Keep them after vault.close() so a long-running
    # Composio call doesn't keep the vault HTTP client pinned.
    in_flight_agents = await _gather_in_flight_agents()
    money_envelope = await _gather_money_envelope(
        window_start=window_start, window_end=window_end,
    )
    day_shape = await _gather_day_shape(now=_tenant_local(_now_utc(), config))

    visit_anomalies = _derive_anomalies_from_visits(visit_results)
    anomalies = visit_anomalies + signal_anomalies

    # SOUL.md — Sir's voice guide, inlined for the compose prompt so the
    # brief sounds like Alfred-to-Sir rather than a generic butler bot.
    # Best-effort: a missing SOUL.md falls back to the prompt's voice
    # rules. Same pattern as signals._load_soul_md (#889, Phase 3).
    soul_md = await _load_soul_md()

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
        soul_md=soul_md,
        window_signals=window_signals,
        window_decisions=window_decisions,
        waiting_on_you=waiting_on_you,
        prior_today_text=prior_today_text,
        in_flight_agents=in_flight_agents,
        money_envelope=money_envelope,
        day_shape=day_shape,
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
    body_text = _strip_compose_preamble(body_text)
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
    # The brief's calendar day is the TENANT-LOCAL day of window_end — chore
    # schedules fire at tenant-local time, so a UTC date mis-names the brief
    # for non-UTC tenants (B7). composed_at stays the true UTC instant.
    date_str = _tenant_local(window_end, config).date().isoformat()
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
