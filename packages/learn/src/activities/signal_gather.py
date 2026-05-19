"""Unified signal-gather activities for Steward Phase 6 (T6.2.1 + T6.2.2).

Phase 6 collapses the four legacy per-source gatherers
(``gather_signals_gmail`` / ``gather_signals_sure`` /
``gather_signals_ctrl_api_stream`` / ``gather_signals_vault_record``)
into ONE activity that reads the new ``signal/`` vault layer produced
by Phase 6.0's extraction pipeline. The Steward workflow no longer
talks to upstream sources directly — instead it consumes the
already-classified, target-resolved signal records and lets the
SignalRouterWorkflow (Phase 6.3) handle mutation/action dispatch.

Why the change:

  * One LLM classification per stream event, not one per task that
    happens to subscribe to overlapping queries (Phase 5 fan-out
    problem).
  * Signals carry pre-resolved ``target_path`` so any task or matter
    can ask "what do you have for me?" with a single equality check.
  * Workflow consumers stay decoupled from upstream API shapes —
    Sure / Gmail / openclaw all flow through the same uniform record.

Public surface:

  * ``gather_signals(task_path, since, limit=50)``
        Pull signal records targeting the given task. Drop-in
        replacement for the legacy ``gather_signals_*`` activities;
        same return contract so Steward's ``evaluate_task`` consumes
        without conditional branches.
  * ``gather_signals_for_matter(matter_path, since, limit=50)``
        The matter-targeted analogue. Used by Phase 6.3+ for
        matter-targeted mutations and Phase 6.4 for matter-targeted
        agent dispatch.

Both activities share ``_gather_for_target`` — the public functions
are thin canonicalize-and-delegate wrappers.

Filtering rules (per signal record, applied client-side):

  * ``frontmatter.target_path`` exactly matches the canonicalized
    target. The vault list endpoint can't filter by frontmatter, so
    we pull the page and filter in Python.
  * ``frontmatter.effect != "none"`` — noise classifications never
    surface as Steward signals (they exist on disk for audit only).
  * ``frontmatter.status != "applied"`` — signals already mutated by
    the router don't re-fire, otherwise the LLM would loop on the
    same evidence each tick.
  * ``frontmatter.created >= since`` (when provided). Strict ISO
    compare; malformed timestamps fail-open as "passes filter" so a
    bad stamp doesn't silently drop a real signal.
  * Newest-first sort, sliced to ``limit`` (default 50).

Hard rules (NON-NEGOTIABLE):

  1. NO mocks, NO prototypes — hits the real ctrl-api list endpoint.
  2. Output shape MUST match ``gather_signals_*``::
       {"signals": [...], "snapshots_path": "", "evaluated_sources": [...]}
  3. Uses ``httpx.AsyncClient`` directly (same pattern as
     ``signals.list_unprocessed_stream_events``). NO direct filesystem.
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

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Helpers — path canonicalization
# ---------------------------------------------------------------------------


def _normalize_task_path(task_path: str) -> str:
    """Coerce any task reference to canonical ``task/<slug>.md`` form.

    Accepts ``"foo"``, ``"task/foo"``, ``"task/foo.md"``, or with a
    leading vault prefix (``"vault/task/foo.md"``) — all yield
    ``"task/foo.md"``. Empty input yields ``""`` so the caller can
    no-op cleanly without a path-shape exception.

    This mirrors the ``_slug_from_task_path`` + ``_normalize_matter_id``
    pattern in ``steward.py`` — kept as a separate helper here so
    ``signal_gather`` doesn't import from steward (which would risk a
    circular dependency once steward.py imports gather_signals in
    T6.2.3).
    """
    s = (task_path or "").strip()
    if not s:
        return ""
    # Strip stray quotes / wikilink brackets that occasionally land on
    # vault-supplied paths.
    s = s.strip('"').strip("'")
    if s.startswith("[[") and s.endswith("]]"):
        s = s[2:-2]
    # Drop a leading "vault/" prefix if present (some upstream callers
    # prepend it; the ctrl-api list endpoint returns paths relative to
    # the vault root).
    if s.startswith("vault/"):
        s = s[len("vault/"):]
    if not s.startswith("task/"):
        s = f"task/{s}"
    if not s.endswith(".md"):
        s = f"{s}.md"
    return s


def _normalize_matter_path(matter_path: str) -> str:
    """Coerce any matter reference to canonical ``matter/<slug>.md`` form.

    Same shape rules as ``_normalize_task_path`` but for the matter
    namespace. Mirrors ``steward._normalize_matter_id`` — kept local
    to avoid a steward import.
    """
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


# ---------------------------------------------------------------------------
# Helpers — timestamp parsing
# ---------------------------------------------------------------------------


def _parse_iso_or_none(ts: str | None) -> datetime | None:
    """Parse an ISO8601 timestamp into a UTC-aware datetime; ``None`` on fail.

    Mirrors ``signals._parse_iso_or_none`` (kept local — copy is small
    enough that adding a cross-module import for one helper would be
    over-coupling). Naive timestamps are treated as UTC because vault
    records are UTC by convention.
    """
    if not ts:
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


# ---------------------------------------------------------------------------
# Helpers — signal record → Steward signal dict
# ---------------------------------------------------------------------------


def _signal_to_signal_dict(rec: dict[str, Any]) -> dict[str, Any] | None:
    """Convert a vault signal record into the Steward signal shape.

    Returns ``None`` when the record is structurally unusable (missing
    path / no body for a meaningful note) so the caller can drop it
    silently. Steward's evaluate_task only cares about a flat list of
    ``{source, ref, note}`` dicts.

    Source is rendered as ``"<source_type>:<short_quote>"`` so the LLM
    sees a human-readable provenance label without the caller having
    to round-trip back to the source record. Quote is sliced to 50
    chars (newlines collapsed) so a multi-paragraph email body doesn't
    blow out the prompt budget.
    """
    if not isinstance(rec, dict):
        return None
    fm = rec.get("frontmatter") or {}
    if not isinstance(fm, dict):
        fm = {}

    path = str(rec.get("path") or "").strip()
    if not path:
        return None

    source_type = str(fm.get("source_type") or "").strip() or "unknown"
    raw_quote = str(fm.get("raw_quote") or "")
    # Collapse internal whitespace / newlines so the source label stays
    # on one line. Slice to 50 chars per spec.
    quote_oneline = " ".join(raw_quote.split())[:50]
    source_label = f"{source_type}:{quote_oneline}" if quote_oneline else source_type

    reasoning = str(fm.get("reasoning") or "")[:500]

    return {
        "source": source_label,
        "ref": path,
        "note": reasoning,
    }


# ---------------------------------------------------------------------------
# Core — _gather_for_target
# ---------------------------------------------------------------------------


async def _gather_for_target(
    target_path: str,
    target_kind: str,
    since: str | None,
    limit: int,
) -> dict[str, Any]:
    """Read all signal records pointing at the given canonical target.

    Args:
      target_path: Canonical ``task/<slug>.md`` or ``matter/<slug>.md``.
        Empty string returns an empty result without making any HTTP
        calls (defensive — a legacy caller passing ``None`` shouldn't
        burn a ctrl-api round-trip).
      target_kind: ``"task"`` or ``"matter"`` — used for log labels and
        nothing else (the equality match on target_path is the actual
        filter; target_kind in the signal record can drift, target_path
        cannot).
      since: ISO8601 lower-bound on ``frontmatter.created``. ``None`` =
        no lower bound. Malformed inputs log a warning and disable the
        filter (fail-open — better to surface a few extra signals than
        to silently drop genuine ones because of a bad stamp upstream).
      limit: Max signals to return (newest-first slice). Negative or
        zero values yield an empty list.

    Returns the Steward gather contract::

        {
          "signals":           [{"source", "ref", "note"}, ...],
          "snapshots_path":    "",
          "evaluated_sources": [<distinct source_types observed>, ...],
        }

    Errors:
      ctrl-api unreachable / 5xx → log warning + return empty result.
      Same fail-open philosophy as ``list_unprocessed_stream_events``:
      Steward's tick cadence retries naturally; raising would force
      Temporal exponential backoff which we don't want for transient
      blips on a per-tick read path.
    """
    if not target_path:
        logger.info(
            "signal_gather: empty target_path (kind=%s) — returning empty",
            target_kind,
        )
        return {"signals": [], "snapshots_path": "", "evaluated_sources": []}

    safe_limit = max(0, int(limit) if limit is not None else 50)
    if safe_limit == 0:
        return {"signals": [], "snapshots_path": "", "evaluated_sources": []}

    since_dt = _parse_iso_or_none(since)
    if since is not None and since.strip() and since_dt is None:
        # Caller passed a non-empty since that didn't parse — log and
        # ignore the filter rather than dropping every signal.
        logger.warning(
            "signal_gather: malformed since=%r for target=%s — ignoring filter",
            since, target_path,
        )

    cfg = load_config()

    # Signals are state.db rows (storage cutover #27) — query ctrl-api's
    # /api/v1/state/signals scoped to ``target_path`` (the indexed
    # ``entity_ref`` column) instead of walking vault/signal/ and
    # filtering in Python. The rows are rehydrated into the legacy
    # {frontmatter} record shape so the downstream filter/collect loop
    # is untouched.
    raw_results: list[dict[str, Any]] = []
    try:
        from src.utils.signal_state import StateClient, signal_row_to_record

        # The steward/brief gather matches signals by ``target_path``
        # equality (task OR matter). ``list_signals`` has no entity
        # filter, and the Python ``target_path`` filter below is the
        # load-bearing one, so a single windowed pull (since=window)
        # is sufficient — the in-Python filter selects the matches.
        async with StateClient(cfg) as sc:
            sig_rows = await sc.list_signals(
                since=since if since_dt is not None else None,
                limit=10_000,
            )
        raw_results = [signal_row_to_record(r) for r in sig_rows]
    except httpx.HTTPError as exc:
        logger.warning(
            "signal_gather: state.db signal query failed target=%s err=%s",
            target_path, exc,
        )
        return {"signals": [], "snapshots_path": "", "evaluated_sources": []}
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "signal_gather: unexpected error target=%s err=%s",
            target_path, exc,
        )
        return {"signals": [], "snapshots_path": "", "evaluated_sources": []}

    # Filter + collect.
    matched: list[tuple[datetime | None, dict[str, Any], str]] = []
    seen_source_types: set[str] = set()

    for rec in raw_results:
        fm = rec.get("frontmatter") or {}
        if not isinstance(fm, dict):
            continue

        # 1. target_path equality match (the load-bearing filter).
        rec_target = fm.get("target_path")
        if not isinstance(rec_target, str):
            continue
        if rec_target.strip() != target_path:
            continue

        # 2. effect != "none" — noise classifications stay on disk for
        #    audit but don't surface as Steward signals.
        effect = str(fm.get("effect") or "").strip().lower()
        if effect == "none":
            continue
        # An empty effect means the extractor didn't classify cleanly;
        # treat as noise and skip rather than surfacing an unusable
        # record to the LLM.
        if not effect:
            continue

        # 3. status != "applied" — already-applied signals would loop
        #    the LLM if re-surfaced (the mutation they encoded already
        #    landed on the task; bringing them back as fresh evidence
        #    would re-trigger the same reasoning).
        status = str(fm.get("status") or "").strip().lower()
        if status == "applied":
            continue

        # 4. since lower bound (when parseable).
        created_raw = rec.get("created") or fm.get("created") or ""
        created_dt = _parse_iso_or_none(str(created_raw))
        if since_dt is not None:
            # Malformed created → fail-open (include). The alternative
            # (silently drop) loses real signals when an upstream
            # stamping bug hits.
            if created_dt is not None and created_dt < since_dt:
                continue

        # Track distinct source types for the evaluated_sources field.
        src_type = str(fm.get("source_type") or "").strip()
        if src_type:
            seen_source_types.add(src_type)

        matched.append((created_dt, rec, src_type))

    # Newest-first ordering. Records with no parseable created sort to
    # the end via a min-sentinel so they don't crowd out timestamped
    # ones at the top of the list.
    sentinel_min = datetime.min.replace(tzinfo=timezone.utc)
    matched.sort(key=lambda triple: triple[0] or sentinel_min, reverse=True)

    signals: list[dict[str, Any]] = []
    for _, rec, _src in matched[:safe_limit]:
        sig = _signal_to_signal_dict(rec)
        if sig is not None:
            signals.append(sig)

    logger.info(
        "signal_gather: target=%s kind=%s scanned=%d matched=%d returned=%d sources=%d",
        target_path,
        target_kind,
        len(raw_results),
        len(matched),
        len(signals),
        len(seen_source_types),
    )

    return {
        "signals": signals,
        "snapshots_path": "",
        "evaluated_sources": sorted(seen_source_types),
    }


# ---------------------------------------------------------------------------
# Activity: gather_signals (T6.2.1)
# ---------------------------------------------------------------------------


@activity.defn
async def gather_signals(
    task_path: str,
    since: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """Read all signal records targeting this task.

    Unified replacement for the legacy ``gather_signals_gmail`` /
    ``gather_signals_sure`` / ``gather_signals_ctrl_api_stream`` /
    ``gather_signals_vault_record`` activities. Reads the new
    ``signal/`` vault layer produced by Phase 6.0's extraction
    pipeline.

    Filtering rules: see ``_gather_for_target`` — equality match on
    ``frontmatter.target_path``, drop ``effect="none"``, drop
    ``status="applied"``, since lower bound, newest-first slice to
    ``limit``.

    Returns::

        {
          "signals": [
            {
              "source": "<source_type>:<first 50 chars of raw_quote>",
              "ref":    "<vault path of the signal record>",
              "note":   "<reasoning text, truncated to 500 chars>",
            }, ...
          ],
          "snapshots_path":    "",   # always empty — signal layer has no per-task state
          "evaluated_sources": ["gmail", "slack", ...],
        }

    Errors are absorbed (returns empty result + logs a warning) so a
    transient ctrl-api blip doesn't block Steward's tick.
    """
    canonical = _normalize_task_path(task_path)
    return await _gather_for_target(
        target_path=canonical,
        target_kind="task",
        since=since,
        limit=limit,
    )


# ---------------------------------------------------------------------------
# Activity: gather_signals_for_matter (T6.2.2)
# ---------------------------------------------------------------------------


@activity.defn
async def gather_signals_for_matter(
    matter_path: str,
    since: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """Read all signal records targeting this matter.

    Sister to ``gather_signals`` for matter-level consumers (Phase 6.3
    matter-targeted mutations, Phase 6.4 matter-targeted agent
    dispatch). Same filtering rules and return shape — the only
    difference is the canonical-path namespace.
    """
    canonical = _normalize_matter_path(matter_path)
    return await _gather_for_target(
        target_path=canonical,
        target_kind="matter",
        since=since,
        limit=limit,
    )
