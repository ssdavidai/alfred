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
import re
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

# Maximum signal age (by ``ts``) the briefing will surface. Anything
# older than this gets clamped out of the brief-visible window even if
# the workflow's ``prior_composed`` anchor points further back (e.g.
# after a briefing-chain reset, or a tenant that hadn't run for weeks).
#
# Override with the ``BRIEF_SIGNAL_MAX_AGE_DAYS`` env var. The cutoff
# only narrows the briefing's read window — aged rows remain queryable
# via direct SQL / ``GET /api/v1/signals`` for audit purposes.
#
# Rationale: writers sometimes create fresh signal rows that re-assert
# stale content (e.g. a gcal sweep that produces an RSVP-needed signal
# today for an event that happened months ago). Even when ``ts`` is
# fresh, this clamp ensures only signals from the last N days reach the
# brief composer. See PR `fix/learn-brief-signal-aging-cutoff` for the
# 2026-05-19 incident where April + December events leaked into the
# morning brief.
DEFAULT_BRIEF_SIGNAL_MAX_AGE_DAYS = 14


def _brief_signal_max_age_days() -> int:
    """Return the configured max signal age (days) for brief gathers.

    Defaults to ``DEFAULT_BRIEF_SIGNAL_MAX_AGE_DAYS`` (14d). Returns ``0``
    when explicitly disabled via ``BRIEF_SIGNAL_MAX_AGE_DAYS=0`` — the
    helpers below treat ``<= 0`` as "no cutoff".
    """
    raw = (os.environ.get("BRIEF_SIGNAL_MAX_AGE_DAYS") or "").strip()
    if not raw:
        return DEFAULT_BRIEF_SIGNAL_MAX_AGE_DAYS
    try:
        n = int(raw)
    except ValueError:
        logger.warning(
            "_brief_signal_max_age_days: invalid BRIEF_SIGNAL_MAX_AGE_DAYS=%r "
            "— falling back to default %d",
            raw, DEFAULT_BRIEF_SIGNAL_MAX_AGE_DAYS,
        )
        return DEFAULT_BRIEF_SIGNAL_MAX_AGE_DAYS
    return max(0, n)


def _clamp_window_start_for_signals(
    window_start: datetime,
    window_end: datetime,
) -> datetime:
    """Clamp ``window_start`` forward so signals older than N days drop out.

    The briefing's ``window_start`` is normally the prior briefing's
    ``composed_at``, which may be hours-to-days old. When the briefing
    chain breaks (or a tenant resumes after a long gap) the anchor can
    drift far enough back that stale signals leak into the brief. The
    clamp forces the effective start to be no earlier than
    ``window_end - N days``.

    ``BRIEF_SIGNAL_MAX_AGE_DAYS=0`` disables the clamp (returns the
    original ``window_start``) so operators can opt out for audit
    re-runs.
    """
    max_age_days = _brief_signal_max_age_days()
    if max_age_days <= 0:
        return window_start
    cutoff = window_end - timedelta(days=max_age_days)
    if cutoff > window_start:
        return cutoff
    return window_start


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
        logger.warning(
            "_load_soul_md: skipping SOUL.md (degraded) type=%s err=%s",
            type(exc).__name__, repr(exc),
        )
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


def _slug_from_matter_path(matter_path: str) -> str:
    s = (matter_path or "").strip()
    if s.endswith(".md"):
        s = s[:-3]
    if s.startswith("matter/"):
        s = s[len("matter/"):]
    return s


# --- STORE-P3-5: SQL read switch + row-to-record adapter ------------------
#
# When ``READERS_USE_SQL=1`` (default), signal gather paths inside the
# briefing activities pull rows from ctrl-api's ``GET /api/v1/signals``
# (STORE-P3-2) instead of walking ``/vault/signal/*.md``. The SQL row
# shape differs from the markdown record shape downstream code grew up
# against, so ``_sql_signal_to_record`` adapts each row into the same
# ``{path, frontmatter: {...}}`` dict the legacy markdown path returns.
# That keeps every downstream filter / pretty-printer unchanged.
#
# Setting ``READERS_USE_SQL=0`` reverts to the markdown walk for safety
# (the SQL backfill in STORE-P3-4 is recent — keep the fallback alive
# until we delete the markdown writers in a later phase).


def _readers_use_sql() -> bool:
    raw = (os.environ.get("READERS_USE_SQL") or "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _sql_signal_to_record(row: dict[str, Any]) -> dict[str, Any]:
    """Adapt one ctrl-api ``signal`` row into the legacy markdown record shape.

    Downstream code (``_record_targets_matter``, the gatherer filters,
    etc.) expects ``{path, frontmatter: {target_path, target_matter_path,
    applied_at, created, source_type, target_kind, classification,
    display_headline, display_body, name, reasoning, raw_quote,
    source_event_path, actor, decision_required}}``. Map every SQL field
    to its markdown frontmatter equivalent; ``ts`` is nanoseconds-since-
    epoch as a decimal string, which we convert to ISO-8601 UTC so the
    ``_parse_iso_or_none`` time filters keep working.
    """
    ts_raw = row.get("ts")
    created_iso: str = ""
    if ts_raw is not None:
        try:
            ts_ns = int(str(ts_raw))
            created_iso = (
                datetime.fromtimestamp(ts_ns / 1_000_000_000, tz=timezone.utc)
                .isoformat(timespec="seconds")
                .replace("+00:00", "Z")
            )
        except (TypeError, ValueError):
            created_iso = ""
    target_matter = row.get("target_matter") or ""
    # The legacy markdown frontmatter carried ``target_matter_path`` for the
    # matter binding and ``target_path`` for whatever was actually touched
    # (often a task). The SQL row only captures the matter, so we mirror it
    # into both — every consumer we touch here keys off either field.
    fm: dict[str, Any] = {
        "source_type": row.get("source_type") or "",
        "target_path": target_matter,
        "target_matter_path": target_matter,
        "target_kind": row.get("target_kind") or "",
        "actor": row.get("actor") or "",
        "decision_required": bool(row.get("decision_required") or 0),
        "display_headline": row.get("display_headline") or "",
        "display_body": row.get("display_body") or "",
        # The SQL row stores the markdown body verbatim — most consumers
        # treat that as ``reasoning`` so the prompt-text fields keep
        # rendering even when display_body is empty.
        "reasoning": row.get("body") or "",
        "raw_quote": "",
        "source_event_path": row.get("source_event") or "",
        # ``applied_at`` and ``created`` were two different timestamps in
        # the markdown world (one stamped on first write, one on apply).
        # The SQL row has a single ``ts``; populate both so the
        # window-filter checks behave like the markdown record.
        "applied_at": created_iso,
        "created": created_iso,
        # The legacy ``classification`` was set by the extractor for
        # anomaly detection. SQL rows surface ``classified_noise`` as a
        # 0/1 — map "noise" to a classification string so the anomaly
        # filter still matches on the expected vocabulary.
        "classification": (
            "noise" if bool(row.get("classified_noise") or 0) else ""
        ),
    }
    sig_id = str(row.get("id") or "").strip()
    # The legacy ``path`` is the markdown filename; ctrl-api gives us a
    # UUID. Mint a synthetic ``signal/<uuid>.md`` path so signal_paths
    # collected downstream still look like vault paths to log lines etc.
    path = f"signal/{sig_id}.md" if sig_id else ""
    return {"path": path, "frontmatter": fm, "created": created_iso}


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
                "list_active_matters_for_briefing failed type=%s err=%s",
                type(exc).__name__, repr(exc),
            )
            raise
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
                "get_prior_briefing: list_records failed slot=%s type=%s err=%s — "
                "treating as no prior briefing",
                target_slot, type(exc).__name__, repr(exc),
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
    # STORE-P3-5: activity-internal SQL read; no workflow.patched gate needed per CLAUDE.md.
    use_sql = _readers_use_sql()

    # PR fix/learn-brief-signal-aging-cutoff: clamp the signal window
    # forward when the workflow's anchor is older than the configured
    # max age — keeps stale-content signals (gcal RSVP sweeps re-asserting
    # past events, etc.) out of the brief-visible set without blocking
    # the SQL row from being written.
    effective_signal_start = _clamp_window_start_for_signals(
        window_start, window_end,
    )

    try:
        # --- Signals ----------------------------------------------------
        if use_sql:
            try:
                rows = await vault.list_signals(
                    target_matter=target_path,
                    since_ns=int(effective_signal_start.timestamp() * 1_000_000_000),
                    until_ns=int(window_end.timestamp() * 1_000_000_000),
                    limit=10_000,
                )
                signal_records: list[dict[str, Any]] = [
                    _sql_signal_to_record(r) for r in rows if isinstance(r, dict)
                ]
            except (httpx.HTTPError, AttributeError) as exc:
                logger.warning(
                    "gather_observed: SQL signal list failed target=%s type=%s err=%s",
                    target_path, type(exc).__name__, repr(exc),
                )
                signal_records = []
        else:
            try:
                signal_records = await vault.list_records(
                    "signal", limit=10_000,
                )
            except httpx.HTTPError as exc:
                logger.warning(
                    "gather_observed: signal list failed target=%s type=%s err=%s",
                    target_path, type(exc).__name__, repr(exc),
                )
                signal_records = []
        for rec in signal_records or []:
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
            # Use the age-clamped start so the markdown fallback gets the
            # same aging cutoff the SQL path enforces.
            if ts is None or ts < effective_signal_start or ts > window_end:
                continue
            path = str(rec.get("path") or fm.get("path") or "").strip()
            if path:
                signal_paths.append(path)

        # --- Decisions (still markdown; out of scope for P3-5) ---------
        try:
            decision_records = await vault.list_records(
                "decision", limit=10_000,
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "gather_observed: decision list failed target=%s type=%s err=%s",
                target_path, type(exc).__name__, repr(exc),
            )
            decision_records = []
        for rec in decision_records or []:
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


# Section header pattern: a bold prose label like ``**Today.**`` or
# ``**Ma.**``. The label body is 1-30 chars, may include letters, an
# apostrophe ("Day's shape"), and a trailing period. Anchored to the
# start of a line because **bold** mid-sentence emphasis would otherwise
# match. The trailing punctuation lookbehind keeps the regex inert on
# inline emphasis where the bolded fragment is not a header.
_SECTION_HEADER_RE = re.compile(
    r"(?m)^\*\*(?P<label>[^\n*]{1,30}?\.)\*\*"
)


def _collapse_duplicate_section_headers(body: str) -> str:
    """Merge adjacent duplicate **X.** section headers.

    The composer prompt is a markdown skeleton with ``**Bold.**`` prose
    labels for each section (no markdown headings, per ABSOLUTE
    PROHIBITIONS rule 5). Some clerk emissions split one section into
    two blocks: a header + one-line preamble, then an empty header + the
    list payload. Observed example (rapali 2026-05-19-morning, Bug C):

        **Ma.** Négy sorba sorolom a legfontosabb teendőket.

        **Ma.**

        1. ...

    The second header is a render artefact — the section is one logical
    block, not two. This pass collapses the pair by emitting the first
    header, the first block's preamble, the empty line, and the second
    block's body (omitting the redundant header). Idempotent — repeated
    application produces the same output.

    Detection:
      * Two ``**X.**`` headers with identical label X.
      * Separation: ≤ 4 lines of content between them (so we don't
        merge legitimately distinct sections that happen to share a
        label later in the brief — those don't occur in practice but
        the bound is defensive).
      * The second header's line is "empty" — i.e. nothing follows it
        on its own line except optional whitespace. (A second header
        with a real preamble of its own is a different bug; we leave
        it alone rather than risk eating real content.)

    Returns the cleaned-up body. Best-effort: on regex failure the
    original body is returned unchanged.
    """
    if not body or "**" not in body:
        return body
    try:
        # Walk the body line-by-line so we can examine the exact line
        # the second header sits on (to enforce the "second header has
        # no trailing content" rule).
        lines = body.split("\n")
        out: list[str] = []
        i = 0
        n = len(lines)
        while i < n:
            line = lines[i]
            m = _SECTION_HEADER_RE.match(line)
            if not m:
                out.append(line)
                i += 1
                continue
            label = m.group("label")
            # The header opens this block. Look ahead up to 5 lines
            # for a second ``**<label>.**`` header.
            #
            # Within that window we accept either an empty header line
            # (``**label.**`` with nothing else after the closing **)
            # OR a header line where the only trailing content is
            # whitespace. In both cases the second occurrence is a
            # template artefact and must be dropped.
            collapsed = False
            for j in range(i + 1, min(i + 6, n)):
                next_line = lines[j]
                m2 = _SECTION_HEADER_RE.match(next_line)
                if not m2 or m2.group("label") != label:
                    continue
                # Reject the merge if the second header carries its
                # own preamble — that's a legitimately distinct block
                # we shouldn't touch.
                tail = next_line[m2.end():].strip()
                if tail:
                    break
                # Emit lines [i .. j-1] as-is, but skip line j (the
                # duplicate header). Anything past j stays. This
                # preserves the first header's preamble and reattaches
                # the list/body that followed the second header
                # directly underneath.
                out.extend(lines[i:j])
                i = j + 1
                collapsed = True
                break
            if not collapsed:
                out.append(line)
                i += 1
        return "\n".join(out)
    except Exception:  # noqa: BLE001
        # Never let a regex bug eat a brief — fail open.
        return body


# Section header pattern — used by the dedup pass to partition the brief
# body into sections. Same shape as the headers the composer prompt
# emits: ``**Label.**`` at line start, body 1-30 chars, ending in a
# period.
_BRIEF_SECTION_HEADER_RE = re.compile(
    r"(?m)^\*\*(?P<label>[^\n*]{1,30}?\.)\*\*"
)

# Wikilink pattern — ``[[Some Name]]``. The dedup pass keys off these
# because the composer prompt explicitly tells the clerk to wikilink
# matters by name (HARD RULES, "Wikilinks use the matter NAME").
_WIKILINK_RE = re.compile(r"\[\[([^\]\n]+?)\]\]")

# Section priority for the dedup pass. A matter referenced in an earlier
# section is suppressed when it reappears in a later section. The single
# exception is the §Quiet enumeration, which is name-only and may
# include matters that appear elsewhere — it is intentionally OMITTED
# from this list so the dedup pass leaves it alone.
#
# Labels are matched as a lowercased prefix against the actual ``**X.**``
# header text the clerk emits. Matching is loose-prefix to tolerate
# minor variations like "Day's shape" vs "Day shape", "What landed."
# vs "Landed today.", and the Hungarian renderings (the clerk picks the
# label vocabulary from SOUL.md and the prior brief). For Hungarian and
# other localised briefs the priority below still applies in the
# emitted ORDER — the dedup walker visits whatever sections show up,
# left-to-right, and treats earlier-emitted sections as higher priority.
_DEDUP_SECTION_ORDER_HINT = (
    "today",
    "ma",         # Hungarian "Today"
    "day",        # Day's shape — items here can also appear in Today
    "waiting",
    "flag",
    "you acted",
    "yesterday",  # Since yesterday
    "landed",     # What landed
    "i handled",
    "in flight",
    "money",
    "looking",
)

_DEDUP_SECTION_SKIP_HINTS = (
    "quiet",      # name-only enumeration, exempt
)


def _section_label_priority(label: str) -> int:
    """Return a priority rank for a section label (lower = higher priority).

    Used as a tiebreaker — the dedup pass primarily uses emit order
    (earlier sections in the body win), but when two sections appear in
    an unusual order we still want to prefer the more actionable one.
    Sections we don't recognise get the lowest priority (most
    suppressible), which means in the unusual case where an unknown
    section emits first, a known higher-priority section after it can
    still claim the matter. Practically: emit order dominates.
    """
    low = label.lower().strip(" .*")
    for idx, hint in enumerate(_DEDUP_SECTION_ORDER_HINT):
        if low.startswith(hint):
            return idx
    return 99


def _is_dedup_skip_section(label: str) -> bool:
    """True for §Quiet (and any other exempt sections)."""
    low = label.lower().strip(" .*")
    return any(low.startswith(h) for h in _DEDUP_SECTION_SKIP_HINTS)


# Forbidden passive phrasings the post-LLM voice-fix pass rewrites.
# Each entry is (regex, replacement). The replacement is a deliberately
# neutral "I suggest …" phrasing — Alfred's first-person stance — which
# is language-neutral enough to land in any locale the brief might be
# composed in.
#
# These mirror the FORBIDDEN list in the composer prompt's
# "ACTION VOICE — PRINCIPAL DIRECT" rule. The prompt covers compliance
# at draft time; this pass rewrites whatever survives.
_PASSIVE_REWRITE_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    # "someone should check X" / "someone should look at X"
    (
        re.compile(r"\bsomeone\s+should\s+", re.IGNORECASE),
        "I suggest ",
    ),
    # "someone needs to X"
    (
        re.compile(r"\bsomeone\s+needs\s+to\s+", re.IGNORECASE),
        "I suggest ",
    ),
    # "it might be worth X-ing"
    (
        re.compile(r"\bit\s+might\s+be\s+worth\s+", re.IGNORECASE),
        "I suggest ",
    ),
    # "maybe check X" / "maybe look at X"
    (
        re.compile(r"\bmaybe\s+check(ing)?\s+", re.IGNORECASE),
        "I suggest checking ",
    ),
    (
        re.compile(r"\bmaybe\s+look(ing)?\s+at\s+", re.IGNORECASE),
        "I suggest looking at ",
    ),
    # "worth a look" / "worth checking" as standalone phrases
    (
        re.compile(r"\b(it\s+is\s+|it's\s+)?worth\s+a\s+look\b", re.IGNORECASE),
        "I suggest a look",
    ),
    (
        re.compile(r"\b(it\s+is\s+|it's\s+)?worth\s+checking\b", re.IGNORECASE),
        "I suggest checking",
    ),
    # "could be checked"
    (
        re.compile(r"\bcould\s+be\s+checked\b", re.IGNORECASE),
        "I will check unless you say otherwise",
    ),
)


def _rewrite_passive_to_principal_directed(body: str) -> str:
    """Rewrite forbidden passive phrasings into Alfred-direct form.

    The composer prompt instructs the clerk to phrase actions as
    'Sir, do X' or 'I suggest X — approve and I will act'. When that
    instruction is not followed (observed in miguel's 2026-05-19-morning
    brief: "someone should check the Retool app"), this pass rewrites
    the survivors. Patterns are language-bound (English) — Hungarian /
    Spanish briefs are unaffected since the rules look for English
    fragment matches.

    Idempotent: replacement strings do not themselves match the
    patterns, so running the pass twice produces the same output.
    """
    if not body:
        return body
    out = body
    for pattern, replacement in _PASSIVE_REWRITE_RULES:
        out = pattern.sub(replacement, out)
    return out


def _split_into_sections(body: str) -> list[tuple[str, str, str]]:
    """Partition the brief body into (label, header_line, content) tuples.

    Order preserved. The pre-section preamble (everything before the
    first ``**X.**`` header — typically the opening greeting) is
    returned with an empty label and header line so the caller can
    reattach it as-is.
    """
    if not body:
        return []
    sections: list[tuple[str, str, str]] = []
    lines = body.split("\n")
    cur_label = ""
    cur_header = ""
    cur_content: list[str] = []
    for line in lines:
        m = _BRIEF_SECTION_HEADER_RE.match(line)
        if m:
            # Flush the previous block.
            sections.append((cur_label, cur_header, "\n".join(cur_content)))
            cur_label = m.group("label")
            cur_header = line
            cur_content = []
        else:
            cur_content.append(line)
    sections.append((cur_label, cur_header, "\n".join(cur_content)))
    return sections


def _extract_section_wikilinks(content: str) -> list[set[str]]:
    """For each non-empty content line, return the set of wikilink names.

    Names are lowercased + whitespace-collapsed so 'Hanna's First Year'
    and 'hannas first year' don't drift apart. Returns one set per
    line so the caller can drop individual bullets without rewriting
    surrounding lines.
    """
    out: list[set[str]] = []
    for line in content.split("\n"):
        if not line.strip():
            out.append(set())
            continue
        names: set[str] = set()
        for m in _WIKILINK_RE.finditer(line):
            name = m.group(1).strip().lower()
            name = re.sub(r"\s+", " ", name)
            if name:
                names.add(name)
        out.append(names)
    return out


def _dedupe_matters_across_sections(body: str) -> str:
    """Suppress lines that re-reference a matter already covered upstream.

    The composer prompt's "ONE MATTER, ONE SECTION" rule defines the
    contract: each matter belongs in exactly one prose section. When
    the clerk produces redundancy anyway (observed in miguel's
    2026-05-19-morning brief: the Retool npm incident appeared in both
    §What landed and §Flags), this pass walks sections in emit order
    and drops lower-section lines whose wikilink set is a subset of
    matters already named in earlier sections.

    Conservative by design:

      * Dedup operates on ``[[wikilinks]]`` only. A line with no
        wikilinks is never touched (we cannot tell which matter it
        belongs to without re-doing the LLM's clustering).
      * §Quiet is exempt (it's the enumeration).
      * A line is suppressed only when its wikilinks are a non-empty
        subset of the seen-set. A line that introduces a new matter
        (even if it also mentions a seen one) survives.
      * Bullet markers ('- ', '* ', '1. ') are recognised so the pass
        drops the bullet, not whole paragraphs of context.
      * Idempotent — once a body has no duplicate wikilink references,
        the pass is a no-op.
    """
    if not body or "[[" not in body:
        return body
    sections = _split_into_sections(body)
    if not sections:
        return body

    seen_wikilinks: set[str] = set()
    out_sections: list[tuple[str, str, str]] = []

    for label, header, content in sections:
        if not label:
            # Pre-section preamble — no dedup, no seen-set update.
            out_sections.append((label, header, content))
            continue
        if _is_dedup_skip_section(label):
            # §Quiet is the enumeration — leave it alone and do NOT
            # add its wikilinks to the seen-set (they're meant to be
            # name-only mentions of holding matters).
            out_sections.append((label, header, content))
            continue
        # Walk the content lines. A bullet whose wikilinks are all
        # already in seen_wikilinks gets dropped. Non-wikilink lines
        # and lines that introduce a new matter survive.
        section_lines = content.split("\n")
        per_line_links = _extract_section_wikilinks(content)
        kept: list[str] = []
        for line, links in zip(section_lines, per_line_links, strict=True):
            if not links:
                kept.append(line)
                continue
            new_matters = links - seen_wikilinks
            if not new_matters:
                # Every matter on this line is already covered in a
                # prior section. Drop the bullet.
                continue
            # Line introduces at least one new matter — keep it.
            seen_wikilinks |= links
            kept.append(line)
        out_sections.append((label, header, "\n".join(kept)))

    # Reassemble. Trim trailing/leading whitespace per section to avoid
    # producing huge blank gaps where bullets were dropped.
    rebuilt: list[str] = []
    for label, header, content in out_sections:
        if header:
            rebuilt.append(header)
        content_stripped = content.strip("\n")
        if content_stripped:
            rebuilt.append(content_stripped)
        rebuilt.append("")  # paragraph spacer
    # Drop the trailing empty + collapse triple newlines.
    out = "\n".join(rebuilt).rstrip() + "\n"
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out


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
            "briefing_visit_matter: read failed matter=%s type=%s err=%s",
            canonical, type(exc).__name__, repr(exc),
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
            "briefing_visit_matter: v2 HTTP failed matter=%s type=%s err=%s",
            canonical, type(exc).__name__, repr(exc),
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

    Wikilinks use the matter *name* ([[Hanna's First Year]]) — the
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
        "You are a butler handing Sir his day on one page. Thorough but",
        "unhurried. Cover what moved, in order, in his voice. Static state",
        "is never news. If a matter did not move, it belongs in §Quiet or",
        "not at all.",
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
        "   Greet Sir by name. Name the day's character from the counts",
        '   above — "a quiet morning", "a full desk", "three things wanting',
        '   your call before lunch". ONE sentence only. DO NOT extend with',
        "   weather, temperature, °C, °F, sunshine, rain, fog, city, river,",
        "   season, or any meteorological or geographical detail. You do",
        "   not have that data. If you write weather, the brief is invalid.",
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
        '   makerspace pitch with Erste — a full hour, three on the',
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
        '   the person ("Viki on Slack since Tuesday — the kindergarten',
        '   forms."). Cluster two-from-same-person on one line. Cap at 5',
        "   bullets; if more, end with 'and three other quieter threads.'",
        "   Distinct from §Today (decisions) and §What landed (info-only).",
        "",
        "5. **Since yesterday.** — REQUIRED if PRIOR BRIEF §Today has "
        "content AND any item in it is unresolved or worth a status note.",
        "   Walk yesterday's §Today items one by one. Report each: closed,",
        "   still open, or superseded. ONE bullet per item, past-tense.",
        '   Examples: "Yesterday\'s Firstbase EIN — still open." /',
        '   "Yesterday\'s npm renewal — done, the token is rotated." If',
        "   EVERY prior item is fully closed and surfaced under §You",
        "   acted on already, OMIT this section to avoid duplication.",
        "",
        f"6. **You acted on.** — REQUIRED if DECISIONS SIR MADE has ≥1 "
        f"item (currently {len(window_decisions)}).",
        "   Walk the DECISIONS SIR MADE list. For each decision worth",
        "   surfacing, write ONE sentence closing the loop: what Sir asked",
        "   + what is now true. Examples of tone:",
        '     - "Yesterday you delegated the Firstbase RSVP — that\'s now',
        '       confirmed."',
        '     - "You marked the Screen Studio renewal not-needed; the',
        '       reminder is queued on Slack."',
        '     - "You held the Kondorosi offer for review — it\'s still on',
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
        "   Erste, and the A Soft Murmur renewal at $9. Nothing declined.'",
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
        '    update letter for Firstbase." Omit if empty.',
        "",
        "12. **Looking ahead.** — OPTIONAL. Emit only if you can point at",
        "    a specific deadline, milestone, or surface_class hint in the",
        "    MATTER SNAPSHOTS above. ONE or TWO sentences. Quote the",
        "    matter by [[name]]. If no such grounding exists, omit. Do",
        "    NOT invent calendar events here — §Day's shape covers today.",
        "",
        f"13. **Quiet.** — REQUIRED if NAMES OF HOLDING MATTERS has ≥3 "
        f"items (currently {len(holding_names)}).",
        '    ONE sentence: "Eight matters holding their state — [[Foo]],',
        '    [[Bar]], [[Baz]]. I\'ll surface them when something moves."',
        "    Do not list more than 4 names. Wikilink each.",
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
        f"- Length floor: if SIGNALS IN WINDOW + DECISIONS SIR MADE "
        f"together exceed 5 items (currently "
        f"{len(window_signals) + len(window_decisions)}), the brief body "
        f"must be at least 600 characters. Anything shorter is leaving "
        f"data on the floor.",
        f"- Length cap: {BRIEF_BODY_CHAR_CAP} characters. Be ruthless on",
        "  prose flourish, never on coverage.",
        "- Wikilinks use the matter NAME. Write [[Hanna's First Year]],",
        "  not [[matter/family-life-hannas-first-year]].",
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
        '  abeyance" or "shows no motion." If a matter didn\'t move, it',
        "  belongs in §13 (Quiet) or not at all.",
        "- No JSON, no YAML, no markdown headings. Only **bold** labels",
        "  and prose / bullets.",
        "",
        "- ONE MATTER, ONE SECTION. Each matter appears in at most ONE",
        "  prose section. If a matter belongs in §Today, it does NOT also",
        "  appear in §Waiting on you, §Since yesterday, §You acted on,",
        "  §What landed, or §Flags. Pick the most actionable section for",
        "  each matter and surface it there only. The single exception is",
        "  §Quiet, which is a name-only enumeration and may list matters",
        "  that appear elsewhere. Priority when deciding where a matter",
        "  belongs (highest first): §Today → §Waiting on you → §Flags →",
        "  §You acted on → §What landed → §I handled → §In flight.",
        "",
        "- ACTION VOICE — PRINCIPAL DIRECT. Every actionable item in",
        "  §Today, §Waiting on you, and §Flags must either name Sir",
        "  directly ('Sir, approve the Retool app fix') or phrase the",
        "  action as something Alfred can do on Sir's behalf ('I suggest",
        "  rotating the npm token — approve and I will act.'). The",
        "  following passive phrasings are FORBIDDEN: 'someone should',",
        "  'someone needs to', 'it might be worth', 'maybe check',",
        "  'worth a look', 'worth checking', 'could be checked'. Replace",
        "  each with either the principal-direct form or the",
        "  I-suggest-and-act form.",
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
        logger.warning(
            "_gather_pending_decisions: list failed type=%s err=%s",
            type(exc).__name__, repr(exc),
        )
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
    # PR fix/learn-brief-signal-aging-cutoff: clamp the brief-visible
    # window forward by BRIEF_SIGNAL_MAX_AGE_DAYS (default 14) so a
    # stretched-out workflow anchor can't surface old anomalies.
    effective_start = _clamp_window_start_for_signals(window_start, window_end)
    # STORE-P3-5: activity-internal SQL read; no workflow.patched gate needed per CLAUDE.md.
    if _readers_use_sql():
        try:
            rows = await vault.list_signals(
                since_ns=int(effective_start.timestamp() * 1_000_000_000),
                until_ns=int(window_end.timestamp() * 1_000_000_000),
                limit=400,
            )
            records = [
                _sql_signal_to_record(r) for r in rows if isinstance(r, dict)
            ]
        except (httpx.HTTPError, AttributeError) as exc:
            logger.warning(
                "_gather_signal_anomalies: SQL list failed type=%s err=%s",
                type(exc).__name__, repr(exc),
            )
            return []
    else:
        try:
            records = await vault.list_records("signal", limit=400)
        except httpx.HTTPError as exc:
            logger.warning(
                "_gather_signal_anomalies: list failed type=%s err=%s",
                type(exc).__name__, repr(exc),
            )
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
        if ts is None or ts < effective_start or ts > window_end:
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
        logger.warning(
            "_gather_autonomous_actions: list failed type=%s err=%s",
            type(exc).__name__, repr(exc),
        )
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
    """
    # PR fix/learn-brief-signal-aging-cutoff: clamp the brief's read
    # window forward so stale rows don't leak into the compose prompt
    # even when the workflow's anchor reaches back further than the
    # configured signal-age ceiling.
    effective_start = _clamp_window_start_for_signals(window_start, window_end)
    # STORE-P3-5: activity-internal SQL read; no workflow.patched gate needed per CLAUDE.md.
    if _readers_use_sql():
        try:
            rows = await vault.list_signals(
                since_ns=int(effective_start.timestamp() * 1_000_000_000),
                until_ns=int(window_end.timestamp() * 1_000_000_000),
                limit=600,
            )
            records = [
                _sql_signal_to_record(r) for r in rows if isinstance(r, dict)
            ]
        except (httpx.HTTPError, AttributeError) as exc:
            logger.warning(
                "_gather_window_signals: SQL list failed type=%s err=%s",
                type(exc).__name__, repr(exc),
            )
            return []
    else:
        try:
            records = await vault.list_records("signal", limit=600)
        except httpx.HTTPError as exc:
            logger.warning(
                "_gather_window_signals: list failed type=%s err=%s",
                type(exc).__name__, repr(exc),
            )
            return []
    out: list[dict[str, Any]] = []
    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        fm = rec.get("frontmatter") if isinstance(rec.get("frontmatter"), dict) else {}
        ts_raw = fm.get("created") or rec.get("created") or ""
        ts = _parse_iso_or_none(ts_raw)
        if ts is None or ts < effective_start or ts > window_end:
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
        logger.warning(
            "_gather_window_decisions: list failed type=%s err=%s",
            type(exc).__name__, repr(exc),
        )
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
        logger.warning(
            "_gather_inbox_unresolved_count: list failed type=%s err=%s",
            type(exc).__name__, repr(exc),
        )
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
        logger.warning(
            "_ctrl_call degraded type=%s err=%s method=%s path=%s",
            type(exc).__name__, repr(exc), method, path,
        )
        raise


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
        logger.warning(
            "_load_prior_brief_today: read failed type=%s err=%s",
            type(exc).__name__, repr(exc),
        )
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
    now = now or _now_utc()
    today = now.date()
    time_min = datetime(today.year, today.month, today.day, tzinfo=timezone.utc).isoformat()
    time_max = (
        datetime(today.year, today.month, today.day, tzinfo=timezone.utc)
        + timedelta(days=2)
    ).isoformat()
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
                    "compose_and_write_briefing: read failed matter=%s type=%s err=%s",
                    mpath, type(exc).__name__, repr(exc),
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
        #
        # PR fix/learn-brief-signal-aging-cutoff: align the signals
        # counter with the gather-side age clamp so the frontmatter's
        # ``signals_count`` doesn't suggest more activity than the brief
        # body actually saw. Decisions retain the raw window because the
        # cutoff is a signal-aging policy, not a decision-aging policy.
        signal_start = _clamp_window_start_for_signals(window_start, window_end)
        for record_type, counter_setter in (
            ("signal", "signals"),
            ("decision", "decisions"),
        ):
            try:
                records = await vault.list_records(record_type, limit=10_000)
            except httpx.HTTPError as exc:
                logger.warning(
                    "compose_and_write_briefing: %s count failed type=%s err=%s",
                    record_type, type(exc).__name__, repr(exc),
                )
                continue
            effective_start = (
                signal_start if record_type == "signal" else window_start
            )
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
                if ts is None or ts < effective_start or ts > window_end:
                    continue
                count += 1
            if counter_setter == "signals":
                signals_count_total = count
            else:
                decisions_count_total = count

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
    day_shape = await _gather_day_shape(now=_now_utc())

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
    body_text = _collapse_duplicate_section_headers(body_text)
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
    # Post-LLM scrubbers (Bug A + Bug B in the brief composer):
    #
    #  * _dedupe_matters_across_sections enforces the "one matter, one
    #    section" rule from the composer prompt's HARD RULES — even
    #    when the clerk drafts the same matter into both §Waiting on
    #    you and §What landed, only the upstream mention survives.
    #  * _rewrite_passive_to_principal_directed enforces the
    #    ACTION VOICE rule by rewriting the forbidden passive phrasings
    #    ("someone should check", "maybe check", etc.) into Alfred's
    #    first-person stance ("I suggest checking …").
    #
    # Both passes are fail-open (return the original body on any
    # internal error) and idempotent.
    body_text = _dedupe_matters_across_sections(body_text)
    body_text = _rewrite_passive_to_principal_directed(body_text)
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
