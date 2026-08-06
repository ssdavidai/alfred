"""Burst detection for decision observations (#454, P1).

A backlog clear-out is ONE gesture, not N lessons. On 2026-07-15 Sir cleared
28 Desk cards in 23 minutes — all `intent: done` — and Reflection read that
as 28 independent pieces of evidence, inferring a suppression rule whose
`sender_domains` were simply whoever happened to be in the batch (including
his primary client). See #454.

This module marks such runs so Reflection can weigh them as a single
gesture.

DESIGN NOTE — annotate, never drop. It is tempting to collapse a burst to
one representative observation before handing the batch to the clerk. That
would break the bookkeeping: `ReflectionWorkflow` marks the observations it
fetched as processed, so any observation removed here would never be marked
and would be re-fetched forever, growing the backlog silently. Annotating
keeps every row in the batch (and therefore in the mark-processed set) while
still telling the model what it is looking at.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

#: Max gap between consecutive decisions for them to belong to the same
#: gesture. 2026-07-15's clear-out averaged ~50s between clicks.
BURST_GAP_SECONDS = 180

#: Minimum run length before we call it a burst rather than ordinary work.
BURST_MIN_SIZE = 5


def _parse_ts(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def annotate_decision_bursts(
    observations: list[dict[str, Any]],
    gap_seconds: int = BURST_GAP_SECONDS,
    min_size: int = BURST_MIN_SIZE,
) -> list[dict[str, Any]]:
    """Stamp `burst_id` / `burst_size` on observations that form a run.

    A run is >= ``min_size`` decision-sourced observations sharing the same
    ``intent``, each within ``gap_seconds`` of the previous one. Members get:

      ``burst_id``    stable id of the run (intent + first timestamp)
      ``burst_size``  how many observations the run contains

    Every input observation is returned, in the input order, mutated in
    place. Non-decision observations, and runs shorter than ``min_size``,
    are returned untouched.
    """
    by_intent: dict[str, list[dict[str, Any]]] = {}
    for obs in observations:
        fm = obs.get("frontmatter") or {}
        if str(fm.get("source_kind") or "").strip().lower() != "decision":
            continue
        intent = str(fm.get("intent") or "").strip().lower()
        if not intent:
            continue
        if _parse_ts(fm.get("created")) is None:
            continue
        by_intent.setdefault(intent, []).append(obs)

    for intent, group in by_intent.items():
        group.sort(key=lambda o: _parse_ts((o.get("frontmatter") or {}).get("created")))
        run: list[dict[str, Any]] = []

        def flush(run: list[dict[str, Any]]) -> None:
            if len(run) < min_size:
                return
            first = _parse_ts((run[0].get("frontmatter") or {}).get("created"))
            burst_id = f"{intent}-{first.isoformat()}"
            for member in run:
                fm = member.setdefault("frontmatter", {})
                fm["burst_id"] = burst_id
                fm["burst_size"] = len(run)

        for obs in group:
            ts = _parse_ts((obs.get("frontmatter") or {}).get("created"))
            if not run:
                run = [obs]
                continue
            prev = _parse_ts((run[-1].get("frontmatter") or {}).get("created"))
            if (ts - prev).total_seconds() <= gap_seconds:
                run.append(obs)
            else:
                flush(run)
                run = [obs]
        flush(run)

    return observations


def burst_summary(observations: list[dict[str, Any]]) -> dict[str, int]:
    """`{burst_id: size}` for the bursts present — for logging."""
    out: dict[str, int] = {}
    for obs in observations:
        fm = obs.get("frontmatter") or {}
        bid = fm.get("burst_id")
        if bid:
            out[str(bid)] = int(fm.get("burst_size") or 0)
    return out
