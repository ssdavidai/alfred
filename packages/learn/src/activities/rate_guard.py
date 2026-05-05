"""Steward rate-guard (#841 Phase 5).

Per-tenant rolling counters for LLM dispatch from Steward's
``evaluate_task`` activity. The point is observability + backpressure
under the ChatGPT Pro / OpenAI Codex subscription model: there is no
per-call dollar charge, so the natural ceiling is provider rate limits +
common-sense per-task / per-matter caps.

State persists to ``/alfred-data/state/steward/rate-guard.json`` (atomic
rename on every write). The shape is::

    {
      "events": [
        {"ts": 1714867200.123, "task": "task/foo.md", "matter": "matter/foo.md"},
        ...
      ],
      "rate_429_until": 1714867260.0,    # epoch seconds; 0 if no active backoff
      "rate_429_last_event_ts": 0.0,     # epoch of last recorded 429 (telemetry)
      "rate_429_count": 0                # cumulative 429s observed (telemetry)
    }

Only events newer than the longest window (``per_day``) are retained;
on every read the helper prunes older entries before answering. Concurrent
writes from multiple Temporal activity workers race on os.replace which
gives last-writer-wins semantics — acceptable here because the worst case
is the loss of a single event from one of the rolling counters, which has
negligible effect on the rate-cap arithmetic. We do NOT use file locking
because a stuck lock would silently break Steward's perception loop on
every tick. A few lost events trumps a stalled steward.

Caps (RFC #832 §7):

* 60 LLM dispatches per minute per tenant.
* 600 LLM dispatches per hour per tenant.
* 6000 LLM dispatches per day per tenant.
* 6 LLM dispatches per task per day (noise control, not cost).
* 50 LLM dispatches per matter per day.

When any cap is hit, ``check_and_reserve`` returns False and the caller
short-circuits the LLM call, returning a low-confidence "rate_guarded"
decision. The decision lands as ``pending`` (Phase 3's confidence
threshold gates it out of any auto-action) and the next tick will retry
once the rolling window clears.

When the provider returns a 429 (clerk wraps that into a RuntimeError
whose message contains the status), ``record_429`` is called with
``Retry-After`` (in seconds). Until the wallclock passes that deadline,
``check_and_reserve`` returns False regardless of the rolling counters.
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Optional

from src.config import load_config

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Caps
# ---------------------------------------------------------------------------

# Per RFC #832 §7. The per-minute / per-hour / per-day sliding windows are
# observability counters; per-task and per-matter daily caps are
# noise-control. None of them are dollar-driven — Sir's stack runs on a
# subscription and the constraint is provider rate-limits, not cost.
LIMITS: dict[str, int] = {
    "per_minute": 60,
    "per_hour": 600,
    "per_day": 6000,
    "per_task_per_day": 6,
    "per_matter_per_day": 50,
}

WINDOW_SECONDS: dict[str, int] = {
    "per_minute": 60,
    "per_hour": 60 * 60,
    "per_day": 24 * 60 * 60,
    "per_task_per_day": 24 * 60 * 60,
    "per_matter_per_day": 24 * 60 * 60,
}

# Longest window — anything older than this can be pruned every read.
MAX_WINDOW_SECONDS = max(WINDOW_SECONDS.values())

# Hard cap on stored events to prevent the file growing without bound on a
# pathologically active tenant — well above the per_day cap so it never
# trims a real rolling-window query but bounds memory.
MAX_RETAINED_EVENTS = 20_000


# ---------------------------------------------------------------------------
# State path + I/O
# ---------------------------------------------------------------------------

def _state_path(cfg) -> str:
    return os.path.join(cfg.alfred_data_dir, "state", "steward", "rate-guard.json")


def _empty_state() -> dict[str, Any]:
    return {
        "events": [],
        "rate_429_until": 0.0,
        "rate_429_last_event_ts": 0.0,
        "rate_429_count": 0,
    }


def _read_state(cfg) -> dict[str, Any]:
    path = _state_path(cfg)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return _empty_state()
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("rate_guard: read failed path=%s err=%s", path, exc)
        return _empty_state()
    if not isinstance(data, dict):
        return _empty_state()
    out = _empty_state()
    events = data.get("events")
    if isinstance(events, list):
        out["events"] = [e for e in events if isinstance(e, dict)]
    for k in ("rate_429_until", "rate_429_last_event_ts"):
        v = data.get(k)
        if isinstance(v, (int, float)):
            out[k] = float(v)
    rc = data.get("rate_429_count")
    if isinstance(rc, int):
        out["rate_429_count"] = rc
    return out


def _write_state(cfg, state: dict[str, Any]) -> None:
    path = _state_path(cfg)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, sort_keys=True, default=str)
        os.replace(tmp, path)
    except OSError as exc:
        logger.warning("rate_guard: write failed path=%s err=%s", path, exc)


def _prune_events(events: list[dict[str, Any]], now: float) -> list[dict[str, Any]]:
    """Drop entries older than the longest window. Cap retained count.

    Pure function — caller persists the result. Event dicts without a
    parseable ``ts`` field are dropped (they can't contribute to any
    rolling window calculation).
    """
    cutoff = now - MAX_WINDOW_SECONDS
    out: list[dict[str, Any]] = []
    for e in events:
        ts = e.get("ts")
        if not isinstance(ts, (int, float)):
            continue
        if ts < cutoff:
            continue
        out.append(e)
    if len(out) > MAX_RETAINED_EVENTS:
        # Newest first wins under saturation — slice from the tail.
        out.sort(key=lambda x: x.get("ts", 0))
        out = out[-MAX_RETAINED_EVENTS:]
    return out


def _count_in_window(
    events: list[dict[str, Any]],
    *,
    now: float,
    window_s: int,
    task_path: Optional[str] = None,
    matter_path: Optional[str] = None,
) -> int:
    """Count events in the trailing ``window_s`` seconds, optionally
    scoped to a task or matter.
    """
    cutoff = now - window_s
    n = 0
    for e in events:
        ts = e.get("ts")
        if not isinstance(ts, (int, float)) or ts < cutoff:
            continue
        if task_path is not None and str(e.get("task") or "") != task_path:
            continue
        if matter_path is not None and str(e.get("matter") or "") != matter_path:
            continue
        n += 1
    return n


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

@dataclass
class RateDecision:
    """Result of a ``check_and_reserve`` call.

    ``allowed`` — True when the LLM call may proceed. False means a cap
    was hit (or a 429 backoff is active).
    ``reason`` — human-readable string for logs / observability records.
    ``cap`` — the specific cap that fired (one of LIMITS keys), or
    ``"rate_429"`` for a provider backoff. Empty string when allowed.
    ``backoff_until`` — epoch float; >0 only when the 429 backoff is active.
    ``counts`` — snapshot of (window, count) pairs at the time of decision.
    """
    allowed: bool
    reason: str
    cap: str
    backoff_until: float
    counts: dict[str, int]


class RateGuard:
    """Per-tenant rolling counters for LLM dispatch."""

    def __init__(self, cfg=None) -> None:
        self.cfg = cfg or load_config()

    def _now(self) -> float:
        return time.time()

    async def check_and_reserve(
        self,
        task_path: str,
        matter_path: str,
    ) -> RateDecision:
        """Return a decision; reserve a slot if allowed.

        Sliding-window check across every cap in ``LIMITS``. Atomic-rename
        write on success so the next ``check_and_reserve`` (in the same
        tick or another worker's tick) sees the reserved slot.

        Concurrency note: two workers can race here. The lost-update case
        is bounded — at worst, two extra calls slip through right at a
        cap boundary. That's acceptable; the cap exists to prevent
        runaway, not to enforce perfect arithmetic.
        """
        now = self._now()
        state = _read_state(self.cfg)

        # 1) Honour an active 429 backoff (highest priority).
        backoff_until = float(state.get("rate_429_until") or 0.0)
        if backoff_until > now:
            counts = self._snapshot_counts(state["events"], now, task_path, matter_path)
            logger.warning(
                "rate_guard: blocked task=%s matter=%s reason=429_backoff until=%.0f (in %.0fs)",
                task_path, matter_path, backoff_until, backoff_until - now,
            )
            return RateDecision(
                allowed=False,
                reason=f"provider 429 backoff active for {int(backoff_until - now)}s",
                cap="rate_429",
                backoff_until=backoff_until,
                counts=counts,
            )

        events = _prune_events(state.get("events") or [], now)

        # 2) Walk the caps in order of decreasing window so a per-day cap
        #    miss surfaces before the per-minute cap fires (better signal
        #    in logs).
        #
        #    Ordered evaluation:
        #      a) per_task_per_day      (most surgical — rules out repeat-evals)
        #      b) per_matter_per_day
        #      c) per_minute, per_hour, per_day  (tenant-wide rolling windows)
        check_order = [
            ("per_task_per_day", task_path, None),
            ("per_matter_per_day", None, matter_path),
            ("per_minute", None, None),
            ("per_hour", None, None),
            ("per_day", None, None),
        ]
        counts_snapshot: dict[str, int] = {}
        for key, scope_task, scope_matter in check_order:
            window = WINDOW_SECONDS[key]
            limit = LIMITS[key]
            n = _count_in_window(
                events,
                now=now,
                window_s=window,
                task_path=scope_task,
                matter_path=scope_matter,
            )
            counts_snapshot[key] = n
            if n >= limit:
                # Block — persist pruned event list so we don't re-prune
                # on every tick, but DO NOT reserve.
                state["events"] = events
                _write_state(self.cfg, state)
                logger.warning(
                    "rate_guard: blocked task=%s matter=%s cap=%s count=%d/%d window_s=%d",
                    task_path, matter_path, key, n, limit, window,
                )
                return RateDecision(
                    allowed=False,
                    reason=f"cap {key} hit ({n}/{limit} in last {window}s)",
                    cap=key,
                    backoff_until=0.0,
                    counts=counts_snapshot,
                )

        # 3) All caps clear — reserve a slot.
        events.append({
            "ts": now,
            "task": str(task_path or ""),
            "matter": str(matter_path or ""),
        })
        events = _prune_events(events, now)
        state["events"] = events
        _write_state(self.cfg, state)

        # Update the snapshot to include the just-added event.
        for k in counts_snapshot:
            counts_snapshot[k] = counts_snapshot[k] + 1
        return RateDecision(
            allowed=True,
            reason="ok",
            cap="",
            backoff_until=0.0,
            counts=counts_snapshot,
        )

    async def record_429(self, retry_after_seconds: int) -> None:
        """Note a provider 429. Sets a hard backoff until ``now + retry_after``.

        The next ``check_and_reserve`` will return False until the
        deadline passes. ``retry_after_seconds`` is clamped to a sane
        range — the provider can give us minutes-long windows but a
        zero-or-negative value is treated as a 60s default (the standard
        OpenAI back-off).
        """
        try:
            secs = int(retry_after_seconds)
        except (TypeError, ValueError):
            secs = 60
        if secs <= 0:
            secs = 60
        if secs > 60 * 60 * 24:
            secs = 60 * 60 * 24  # cap at 24h — no provider back-off should be longer

        now = self._now()
        state = _read_state(self.cfg)
        state["rate_429_until"] = now + secs
        state["rate_429_last_event_ts"] = now
        state["rate_429_count"] = int(state.get("rate_429_count") or 0) + 1
        # Prune events while we're writing.
        state["events"] = _prune_events(state.get("events") or [], now)
        _write_state(self.cfg, state)

        # Telemetry stream: append a JSONL line so the dashboard can
        # surface "rate-skip count" without scanning every audit record.
        try:
            os.makedirs(self.cfg.streams_dir, exist_ok=True)
            stream_path = os.path.join(self.cfg.streams_dir, "rate-events.jsonl")
            record = {
                "ts": now,
                "kind": "provider_429",
                "retry_after_seconds": secs,
                "until": state["rate_429_until"],
            }
            with open(stream_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
        except OSError as exc:
            logger.warning("rate_guard: stream append failed err=%s", exc)

        logger.warning(
            "rate_guard: provider 429 recorded retry_after=%ds — backoff until %.0f",
            secs, state["rate_429_until"],
        )

    async def record_cap_skip(
        self,
        task_path: str,
        matter_path: str,
        cap: str,
    ) -> None:
        """Append a cap-skip event to the rate-events stream.

        Call this when ``check_and_reserve`` returns False due to a
        local cap (per_minute / per_task_per_day / etc) — the dashboard's
        "rate-skip count" widget reads from this stream. We don't write
        to the rate-guard state file because the local cap blocking is
        a derived property of the events list, not a separate field.
        """
        try:
            os.makedirs(self.cfg.streams_dir, exist_ok=True)
            stream_path = os.path.join(self.cfg.streams_dir, "rate-events.jsonl")
            record = {
                "ts": self._now(),
                "kind": "cap_skip",
                "cap": cap,
                "task": task_path,
                "matter": matter_path,
            }
            with open(stream_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
        except OSError as exc:
            logger.warning("rate_guard: cap-skip stream append failed err=%s", exc)

    def _snapshot_counts(
        self,
        events: list[dict[str, Any]],
        now: float,
        task_path: str,
        matter_path: str,
    ) -> dict[str, int]:
        """Build a counts-by-window snapshot for diagnostics."""
        return {
            "per_minute": _count_in_window(events, now=now, window_s=WINDOW_SECONDS["per_minute"]),
            "per_hour": _count_in_window(events, now=now, window_s=WINDOW_SECONDS["per_hour"]),
            "per_day": _count_in_window(events, now=now, window_s=WINDOW_SECONDS["per_day"]),
            "per_task_per_day": _count_in_window(
                events,
                now=now,
                window_s=WINDOW_SECONDS["per_task_per_day"],
                task_path=task_path,
            ),
            "per_matter_per_day": _count_in_window(
                events,
                now=now,
                window_s=WINDOW_SECONDS["per_matter_per_day"],
                matter_path=matter_path,
            ),
        }


# ---------------------------------------------------------------------------
# 429 detection helper
# ---------------------------------------------------------------------------

def parse_retry_after_from_exc(exc: BaseException) -> Optional[int]:
    """Extract a ``Retry-After`` integer from an exception, if present.

    Recognises:
      * ``httpx.HTTPStatusError`` with a 429 response and ``Retry-After``
        header (integer seconds OR HTTP-date — we handle integer only;
        HTTP-date falls back to ``None``, caller defaults to 60s).
      * Any exception whose ``str()`` contains ``"429"`` (clerk wraps the
        upstream RuntimeError message; we fall back to the default).

    Returns ``None`` if no 429 is detected at all (caller doesn't trigger
    record_429). Returns ``0`` if 429 detected but no usable Retry-After
    (caller will use the 60s default inside record_429).
    """
    # Direct httpx path — preferred when available.
    try:
        import httpx  # local import; this module avoids hard dep on httpx
    except ImportError:
        httpx = None  # type: ignore[assignment]

    if httpx is not None and isinstance(exc, httpx.HTTPStatusError):
        resp = exc.response
        if resp is not None and resp.status_code == 429:
            ra = resp.headers.get("Retry-After") or resp.headers.get("retry-after")
            if ra:
                try:
                    return int(ra)
                except ValueError:
                    return 0
            return 0
        return None

    # String-fallback — clerk surfaces upstream provider errors as
    # ``RuntimeError("Clerk LLM billing error: ...")`` etc. The clerk
    # response inspector explicitly looks for "insufficient credits" and
    # related strings; rate-limit errors from the OpenAI API typically
    # contain "rate limit" or "429" in the body.
    msg = str(exc).lower()
    if "429" in msg or "rate limit" in msg or "rate_limit" in msg:
        return 0
    return None


# ---------------------------------------------------------------------------
# Module-level convenience for callers that don't want to instantiate
# ---------------------------------------------------------------------------

_singleton: Optional[RateGuard] = None


def get_rate_guard(cfg=None) -> RateGuard:
    """Return a process-singleton RateGuard.

    Per-process is sufficient — Temporal worker activities all run in
    one Python process per pod, and cross-process consistency is handled
    by the on-disk state file's atomic-rename write. Tests can pass an
    explicit ``cfg`` to bypass the singleton.
    """
    global _singleton
    if cfg is not None:
        return RateGuard(cfg)
    if _singleton is None:
        _singleton = RateGuard()
    return _singleton
