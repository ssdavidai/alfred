"""Activities backing the StewardWorkflow (#835 Phase 0 + Phase 0.5 + #837 Phase 1).

Steward is Alfred's per-matter perception-and-action loop. Every matter
gets its own ``StewardWorkflow`` Temporal Schedule that fires every 30
minutes (default cadence — Phase 1 introduces per-class cadence + the
no-signal backoff specified in RFC #832 §3).

Phase 0 (#835) shipped the schema + scaffold (zero LLM calls).
Phase 0.5 (#836) added ``apply_state_change`` — the audit-trail
emitter. In ``mode="shadow"`` it writes one ``event/steward-action-*.md``
record per Steward decision but mutates NO task state and posts NO
Plane comments. The signature is forward-compatible with Phase 3's
``mode="live"`` cutover.

Phase 1 (#837) replaces the ``evaluate_task`` no-op with real signal
gathering + a single shadow LLM evaluation per task that has fresh
signals (or whose ``surface_class == "high"`` — those evaluate every
tick because they ride the briefing and need fresh context). It adds
two new activities:

* ``gather_signals_vault_record`` — the first signal source. Diffs the
  task's referenced ``vault:record:<path>`` sources against a snapshot
  on disk under ``/alfred-data/state/steward/<task_id>/`` and emits a
  signal entry per source whose frontmatter or body content hash has
  changed since ``last_steward_check_at``.

* ``evaluate_state`` — wraps ``clerk._call_clerk`` with a tight,
  Steward-specific prompt + strict-JSON schema enforcement. Returns
  the structured decision. Phase 1 still routes the result through
  ``apply_state_change(mode="shadow")`` so no task state mutates and
  no Plane writes happen.

All vault writes go through ctrl-api PATCH (``VaultClient.patch_frontmatter``)
or POST (``VaultClient.write_record``) per the alfred-learn hard rule —
NEVER direct filesystem writes. The snapshot-diff state file under
``/alfred-data/`` is the only on-disk write Steward owns; that path is
controlled by alfred-learn (not the vault) so direct fs writes are
correct here, mirroring the session-state.json + observation-queue.jsonl
patterns elsewhere in this package.
"""
from __future__ import annotations

import glob
import hashlib
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient

# State-mutation Phase B (#890): Steward retrofitted onto the universal
# ``apply_state_change_v2`` primitive. We import the v2 call + the
# decorator and dataclasses needed to register Steward's propose
# function. Steward's v1 ``apply_state_change`` becomes a backwards-compat
# shim that delegates the core state-field write to v2 while keeping
# Plane fan-out, the legacy ``event/steward-action-*.md`` audit shape,
# and the dependency-signal cascade Steward-specific.
from src.activities.state_mutator import (
    MutatorContentionError,
    ObservedWindow,
    ProposedMutation,
    apply_state_change_v2,
    propose_fn,
)

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Layer 3 default cadence — every 30 min for ``surface_class: high``
# (matters that ride the next briefing). Backoff and per-class cadences
# arrive in Phase 2 / Phase 5; for Phase 0 every task gets the same
# next-check stamp regardless of class.
STEWARD_DEFAULT_INTERVAL = timedelta(minutes=30)


def _now_utc_iso() -> str:
    """Current UTC time as an ISO-8601 string with second precision.

    Matches the format used elsewhere in alfred-learn (archive_orphan_tasks,
    plane_sync) so timestamps round-trip cleanly through YAML frontmatter.
    """
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _next_check_iso(interval: timedelta = STEWARD_DEFAULT_INTERVAL) -> str:
    return (datetime.now(timezone.utc) + interval).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_matter_id(matter_id: str) -> str:
    """Normalize a matter id to its canonical ``matter/<slug>.md`` form.

    StewardWorkflow accepts any of:
      * ``"client-x"`` (bare slug)
      * ``"matter/client-x"`` (no extension)
      * ``"matter/client-x.md"`` (canonical)

    Returns the canonical form. The empty string is preserved as-is so
    callers can detect it explicitly.
    """
    if not matter_id:
        return ""
    s = matter_id.strip()
    if not s.startswith("matter/"):
        s = f"matter/{s}"
    if not s.endswith(".md"):
        s = f"{s}.md"
    return s


def _resolve_parent_matter(fm: dict[str, Any]) -> Optional[str]:
    """Pull the canonical parent_matter ref out of task frontmatter.

    Phase 0 has migrated every task to ``parent_matter: matter/<slug>.md``
    (see ``scripts/migrate_inbox_matter.py``), but during the first run
    on a tenant — and on any task that lands between the migration and
    a Phase 0 deploy — we may still see legacy fields. Honor them all
    with the same precedence ``plane_sync._resolve_task_matter`` uses.
    """
    direct = fm.get("parent_matter")
    if isinstance(direct, str) and direct.strip():
        s = direct.strip().strip('"').strip("'")
        if s.startswith("[[") and s.endswith("]]"):
            s = s[2:-2]
        if not s.startswith("matter/"):
            s = f"matter/{s}"
        if not s.endswith(".md"):
            s = f"{s}.md"
        return s
    # Legacy fallbacks — older tasks may carry `matter` / `related_matters`
    # without a `parent_matter` field. We never write these back, just
    # read them so a freshly-imported task isn't misclassified as orphan
    # before the inbox migration has run.
    matter = fm.get("matter")
    if isinstance(matter, str) and matter.strip():
        return _normalize_matter_id(matter)
    rm = fm.get("related_matters")
    if isinstance(rm, list) and rm:
        first = rm[0]
        if isinstance(first, str) and first.strip():
            return _normalize_matter_id(first)
    return None


# ---------------------------------------------------------------------------
# Phase 2: matter-level cadence state (Layer 3 backoff)
# ---------------------------------------------------------------------------

# RFC #832 §3 — matter-aggregate backoff: every three consecutive
# no-signal ticks for the matter as a whole, double the schedule
# cadence, capped at 4h. Any signal arrival resets to base cadence.
#
# The state file lives under ALFRED_DATA_DIR (alfred-learn-owned, not
# vault) so it's a single shared truth across worker restarts. Per-
# task cadence is computed independently in ``_next_check_after``;
# this matter-level state drives Temporal Schedule cadence updates
# (Phase 5 will wire the `temporal schedule update` call — Phase 2
# stops short of mutating the schedule and just exposes the state for
# observability + the workflow's own decision-making).

MATTER_CADENCE_BASE_INTERVAL = timedelta(minutes=30)
MATTER_CADENCE_MAX_INTERVAL = timedelta(hours=4)
MATTER_NO_SIGNAL_BACKOFF_THRESHOLD = 3


def _matter_cadence_state_path(cfg) -> str:
    """Path to the matter-cadence state file."""
    return os.path.join(cfg.alfred_data_dir, "state", "steward", "matter-cadence.json")


def _read_matter_cadence_state(cfg) -> dict[str, Any]:
    """Load the matter-cadence state map. Returns {} on miss / read error."""
    path = _matter_cadence_state_path(cfg)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("steward.matter_cadence: read failed path=%s err=%s", path, exc)
        return {}


def _write_matter_cadence_state(cfg, state: dict[str, Any]) -> None:
    """Persist the matter-cadence state map atomically. Best-effort."""
    path = _matter_cadence_state_path(cfg)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, sort_keys=True, default=str)
        os.replace(tmp, path)
    except OSError as exc:
        logger.warning("steward.matter_cadence: write failed path=%s err=%s", path, exc)


def _compute_matter_cadence(
    streak: int,
    *,
    base: timedelta = MATTER_CADENCE_BASE_INTERVAL,
    cap: timedelta = MATTER_CADENCE_MAX_INTERVAL,
) -> timedelta:
    """Pure function: cadence = base * 2^(streak // 3), capped."""
    if streak < MATTER_NO_SIGNAL_BACKOFF_THRESHOLD:
        return base
    multiplier = 2 ** (streak // MATTER_NO_SIGNAL_BACKOFF_THRESHOLD)
    interval = base * multiplier
    return cap if interval > cap else interval


@activity.defn
async def update_matter_cadence(
    matter_id: str,
    had_signal: bool,
) -> dict[str, Any]:
    """Update the matter-cadence streak + return the new cadence.

    Called once per Steward tick after the per-task evaluation loop
    finishes. ``had_signal=True`` resets the streak; ``False`` increments.

    Returns::

        {
          "matter_id":             "matter/<slug>.md",
          "no_signal_streak":      <int>,
          "cadence_seconds":       <int>,
          "base_seconds":          <int>,
          "transitioned":          <bool>,
          "previous_cadence_secs": <int>,
        }

    The activity is idempotent — calling it twice with the same args
    advances the streak by two, which is the desired semantic for a
    workflow that ticks at fixed intervals.
    """
    cfg = load_config()
    state = _read_matter_cadence_state(cfg)
    target = _normalize_matter_id(matter_id) or matter_id or ""
    entry = state.get(target) or {}
    if not isinstance(entry, dict):
        entry = {}
    prev_streak = int(entry.get("no_signal_streak") or 0) if entry.get("no_signal_streak") not in (None, "") else 0
    prev_cadence_secs = int(entry.get("cadence_seconds") or int(MATTER_CADENCE_BASE_INTERVAL.total_seconds()))

    if had_signal:
        new_streak = 0
    else:
        new_streak = max(0, prev_streak) + 1
    if new_streak > 100:
        new_streak = 100  # corrupt-counter guard; matches per-task behaviour

    cadence = _compute_matter_cadence(new_streak)
    cadence_secs = int(cadence.total_seconds())
    transitioned = cadence_secs != prev_cadence_secs

    entry.update({
        "no_signal_streak": new_streak,
        "cadence_seconds": cadence_secs,
        "base_seconds": int(MATTER_CADENCE_BASE_INTERVAL.total_seconds()),
        "last_tick_at": _now_utc_iso(),
        "last_had_signal": bool(had_signal),
    })
    state[target] = entry
    _write_matter_cadence_state(cfg, state)

    if transitioned:
        logger.info(
            "steward.matter_cadence: matter=%s streak=%d cadence=%ds (was %ds)",
            target, new_streak, cadence_secs, prev_cadence_secs,
        )

    return {
        "matter_id": target,
        "no_signal_streak": new_streak,
        "cadence_seconds": cadence_secs,
        "base_seconds": int(MATTER_CADENCE_BASE_INTERVAL.total_seconds()),
        "transitioned": transitioned,
        "previous_cadence_secs": prev_cadence_secs,
    }


# ---------------------------------------------------------------------------
# Activity: load_matter_tasks
# ---------------------------------------------------------------------------

@activity.defn
async def load_matter_tasks(matter_id: str) -> list[dict[str, Any]]:
    """Return every task whose ``parent_matter`` resolves to ``matter_id``.

    Reads via ctrl-api ``GET /api/v1/vault/list/task`` and filters
    in-process. Each returned dict carries::

        {
            "id":          "<task-slug>",
            "path":        "task/<slug>.md",
            "frontmatter": { ... },
        }

    Errors from ctrl-api propagate so Temporal's retry policy can
    take over.
    """
    target = _normalize_matter_id(matter_id)
    if not target:
        logger.warning("steward.load_matter_tasks: empty matter_id — returning []")
        return []

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        # preview=0 keeps the response small — we don't need body text
        # in Phase 0; the no-op evaluator only inspects frontmatter.
        resp = await client._client.get(
            "/api/v1/vault/list/task", params={"preview": 0}
        )
        resp.raise_for_status()
        records = resp.json().get("results", [])
    except httpx.HTTPError as exc:
        logger.error(
            "steward.load_matter_tasks: ctrl-api list/task failed for matter=%s: %s",
            target, exc,
        )
        raise
    finally:
        await client.close()

    matched: list[dict[str, Any]] = []
    for rec in records:
        path = rec.get("path") or ""
        if not path.startswith("task/") or not path.endswith(".md"):
            continue
        fm = rec.get("frontmatter") or {}
        parent = _resolve_parent_matter(fm)
        if parent != target:
            continue
        slug = path[len("task/"):-len(".md")]
        matched.append({
            "id": slug,
            "path": path,
            "frontmatter": fm,
        })

    logger.info(
        "steward.load_matter_tasks: matter=%s tasks=%d",
        target, len(matched),
    )
    return matched


# ---------------------------------------------------------------------------
# Activity: list_due_steward_matters (StewardSweepWorkflow — issue #52)
# ---------------------------------------------------------------------------

def _next_check_elapsed(value: Any, now: datetime) -> bool:
    """Return True iff ``next_check_after`` is empty or refers to <= now.

    Mirrors ``StewardWorkflow._next_check_due`` exactly so the sweep's
    pre-filter and the per-matter loop's per-task gate agree on what
    "due" means. A missing or unparseable cursor counts as due (a
    malformed cursor must never pin a task forever).
    """
    if value is None:
        return True
    if isinstance(value, datetime):
        ref = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return ref <= now
    if not isinstance(value, str):
        return True
    s = value.strip()
    if not s:
        return True
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return True
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt <= now


def _task_is_terminal(fm: dict[str, Any]) -> bool:
    """Tasks in ``done`` / ``archived`` state are never due.

    Mirrors ``StewardWorkflow._is_terminal_state`` so the sweep's
    pre-filter excludes the same tasks the per-matter loop would skip.
    """
    state = fm.get("state")
    if isinstance(state, str):
        return state.strip().lower() in ("done", "archived")
    return False


@activity.defn
async def list_due_steward_matters(batch_limit: int = 200) -> list[str]:
    """Return matter ids that have >=1 task whose Steward check is due.

    Single ctrl-api ``GET /api/v1/vault/list/task`` scan — the same call
    ``load_matter_tasks`` makes, but done once for the whole sweep
    instead of once per matter. Tasks are grouped by their resolved
    ``parent_matter``; a matter is "due" iff at least one of its
    non-terminal tasks has an elapsed (or missing) ``next_check_after``
    cursor.

    The returned list is the work set for one ``StewardSweepWorkflow``
    run. It is capped at ``batch_limit`` matters per tick so a fleet
    with hundreds of matters drains across consecutive 30-min ticks
    rather than wedging one run — exactly the BATCH_LIMIT discipline
    ``SignalExtractWorkflow`` uses. Matters are returned in sorted slug
    order so the cap is deterministic across ticks (no starvation: a
    capped-out matter sorts to the same position next tick and the
    backlog drains predictably).

    Errors from ctrl-api propagate so Temporal's retry policy can take
    over — better to retry the whole listing than to sweep a partial
    matter set.
    """
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        resp = await client._client.get(
            "/api/v1/vault/list/task", params={"preview": 0}
        )
        resp.raise_for_status()
        records = resp.json().get("results", [])
    except httpx.HTTPError as exc:
        logger.error(
            "steward.list_due_steward_matters: ctrl-api list/task failed: %s",
            exc,
        )
        raise
    finally:
        await client.close()

    now = datetime.now(timezone.utc)
    due_matters: set[str] = set()
    for rec in records:
        path = rec.get("path") or ""
        if not path.startswith("task/") or not path.endswith(".md"):
            continue
        fm = rec.get("frontmatter") or {}
        if not isinstance(fm, dict):
            continue
        if _task_is_terminal(fm):
            continue
        parent = _resolve_parent_matter(fm)
        if not parent:
            continue
        if parent in due_matters:
            # Already known due — no need to re-check the cursor.
            continue
        if _next_check_elapsed(fm.get("next_check_after"), now):
            due_matters.add(parent)

    ordered = sorted(due_matters)
    capped = ordered[: max(0, int(batch_limit))]
    logger.info(
        "steward.list_due_steward_matters: due=%d returned=%d (cap=%d)",
        len(ordered), len(capped), batch_limit,
    )
    return capped


# ---------------------------------------------------------------------------
# Phase 1: cadence helpers
# ---------------------------------------------------------------------------

# Layer 3 base cadences from RFC #832 §3. Each entry is the interval in
# minutes between checks; backoff doubles the interval after 3 consecutive
# no-signal ticks (capped at LAYER_3_MAX_INTERVAL).
LAYER_3_HIGH_SURFACE_INTERVAL = timedelta(minutes=30)
LAYER_3_DUE_SOON_INTERVAL = timedelta(hours=1)
LAYER_3_DEFAULT_INTERVAL = timedelta(hours=4)
LAYER_3_MAX_INTERVAL = timedelta(hours=24)
LAYER_3_TERMINAL_INTERVAL = timedelta(days=365 * 10)  # effectively never

# Confidence floor for the "we couldn't parse the LLM output" fallback.
# Stays below 0.6 (RFC §10) so a malformed evaluation never auto-acts in
# a future Phase 3 live deploy. Below 0.5 = "speculative" per the prompt.
LLM_FALLBACK_CONFIDENCE = 0.3

# Calibration window from RFC §2 — first N ticks of a new signal source
# track contribution before the source moves to ``live`` (or ``pruned``
# in Phase 5 if it produced zero signals across the window).
CALIBRATION_TICK_WINDOW = 3

# ---------------------------------------------------------------------------
# Phase 5 (#841): source-confidence EMA + hysteresis thresholds
# ---------------------------------------------------------------------------
#
# After every ``evaluate_state`` call the LLM returns
# ``source_contributions: { name: 0.0..1.0 }``. We update each source's
# running confidence with an exponential moving average:
#
#   confidence = 0.9 * confidence + 0.1 * contribution
#
# Then apply hysteresis:
#   - confidence < 0.2 for ``LOW_CONFIDENCE_PRUNE_TICKS`` consecutive
#     ticks → prune (calibration_status = pruned).
#   - confidence > 0.9 → "pinned" (status stays ``live`` and the
#     low-confidence streak is irrelevant until confidence drops
#     below 0.5 — avoids flapping at the prune boundary).
#
# Sir-declared sources (``pinned: true`` in their frontmatter) skip the
# whole loop and stay live indefinitely.
EMA_DECAY = 0.9
EMA_LIFT = 0.1
PRUNE_CONFIDENCE_FLOOR = 0.2
PIN_CONFIDENCE_CEIL = 0.9
PIN_HYSTERESIS_FLOOR = 0.5  # pinned sources only re-enter normal scoring
                            # once confidence drops below this
LOW_CONFIDENCE_PRUNE_TICKS = 3  # consecutive low-confidence ticks
                                # before a live source is pruned

# Phase 6.7 (T6.7.5) — reversal-driven negative feedback. When Sir undoes a
# Steward action (or a signal-routed mutation gets reversed), the contributing
# source's confidence drops by this flat amount. NOT an EMA: reversals are
# rare, high-information events and deserve an immediate hit. Floor at 0.0.
NEGATIVE_FEEDBACK_PENALTY = 0.1


def _next_check_after(
    state: str,
    surface_class: str,
    has_signals: bool,
    no_signal_streak: int,
    *,
    snooze_until: Optional[str] = None,
    due_at: Optional[str] = None,
    now: Optional[datetime] = None,
) -> datetime:
    """Compute the next-check timestamp for a task per RFC #832 §3.

    Pure function — all inputs explicit, no I/O. ``now`` defaults to the
    current UTC clock when omitted; tests pass it explicitly for
    determinism.

    Layer 3 rules:
      * ``state in {done, archived}`` → never (return far-future stamp).
      * ``state == snoozed`` → ``snooze_until`` if parseable, else default.
      * ``surface_class == high`` → 30 min base.
      * ``due_at`` parseable + within 24 h → 1 h base.
      * default open → 4 h base.

    Backoff (RFC §3 last paragraph): every 3 consecutive no-signal ticks
    doubles the interval. ``has_signals=True`` resets the streak (the
    caller passes ``no_signal_streak=0`` in that case). Cap at 24 h.
    """
    ref = now if isinstance(now, datetime) else datetime.now(timezone.utc)
    if ref.tzinfo is None:
        ref = ref.replace(tzinfo=timezone.utc)

    # Terminal states — never re-check. The workflow already filters
    # these via ``_is_terminal_state`` but we honor them here too so a
    # caller that forgets the filter still gets a sane stamp.
    s = (state or "").strip().lower()
    if s in ("done", "archived"):
        return ref + LAYER_3_TERMINAL_INTERVAL

    if s == "snoozed":
        snooze_dt = _parse_iso(snooze_until)
        if snooze_dt is not None and snooze_dt > ref:
            return snooze_dt
        # Fall through to default cadence if snooze_until is malformed
        # or already past — Steward will pick the task back up.

    sc = (surface_class or "").strip().lower()
    if sc == "high":
        base = LAYER_3_HIGH_SURFACE_INTERVAL
    elif _is_due_within(due_at, ref, hours=24):
        base = LAYER_3_DUE_SOON_INTERVAL
    else:
        base = LAYER_3_DEFAULT_INTERVAL

    # Backoff: multiplier doubles every CALIBRATION_TICK_WINDOW (3) ticks
    # of no-signal. Streak resets on signal arrival.
    streak = max(0, int(no_signal_streak)) if not has_signals else 0
    multiplier = 1
    if streak >= 3:
        # 3 → 2x, 6 → 4x, 9 → 8x, etc.
        multiplier = 2 ** (streak // 3)
    interval = base * multiplier
    if interval > LAYER_3_MAX_INTERVAL:
        interval = LAYER_3_MAX_INTERVAL
    return ref + interval


def _parse_iso(value: Any) -> Optional[datetime]:
    """Parse an ISO-8601 string into a tz-aware UTC datetime.

    Tolerates ``Z`` suffix and naive timestamps (assumed UTC). Returns
    ``None`` for anything we can't interpret — Steward never crashes on
    a malformed cursor.
    """
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
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _is_due_within(due_at: Any, now: datetime, *, hours: int) -> bool:
    """Return True iff ``due_at`` is parseable and falls within ``hours``
    of ``now``. Past-due tasks count as "within" (their cadence should
    tighten, not loosen).
    """
    dt = _parse_iso(due_at)
    if dt is None:
        return False
    return dt <= now + timedelta(hours=hours)


# ---------------------------------------------------------------------------
# Phase 1: snapshot state directory helpers
# ---------------------------------------------------------------------------

def _steward_state_dir(cfg, task_id: str) -> str:
    """Path to the per-task Steward state directory.

    Mirrors the session-state.json / observation-queue.jsonl convention —
    state under ``/alfred-data/state/steward/<task_id>/`` is owned by
    alfred-learn (not the vault), so direct filesystem reads/writes are
    correct here. Vault records still go through ctrl-api.
    """
    safe_id = _safe_filename_slug(task_id)
    return os.path.join(cfg.alfred_data_dir, "state", "steward", safe_id)


def _read_snapshots(cfg, task_id: str) -> dict[str, Any]:
    """Load the prior vault-record snapshot map for a task.

    Returns ``{}`` if the file is missing or unreadable. Snapshots are
    keyed by ``"vault:record:<path>"`` so the on-disk shape matches the
    source name in frontmatter, making lookups O(1).
    """
    path = os.path.join(_steward_state_dir(cfg, task_id), "vault-snapshots.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "steward.gather_signals: snapshot read failed task=%s path=%s err=%s",
            task_id, path, exc,
        )
    return {}


def _write_snapshots(cfg, task_id: str, snapshots: dict[str, Any]) -> str:
    """Persist the snapshot map. Returns the on-disk path written.

    Atomic-ish: write to ``<path>.tmp`` then rename. Best-effort —
    a write failure is logged but not raised so a transient disk
    issue can't break the whole tick. Next gather will re-snapshot.
    """
    state_dir = _steward_state_dir(cfg, task_id)
    path = os.path.join(state_dir, "vault-snapshots.json")
    try:
        os.makedirs(state_dir, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snapshots, f, indent=2, sort_keys=True, default=str)
        os.replace(tmp, path)
    except OSError as exc:
        logger.warning(
            "steward.gather_signals: snapshot write failed task=%s path=%s err=%s",
            task_id, path, exc,
        )
    return path


def _content_hash(s: Any) -> str:
    """SHA-256 of a string (or JSON-serialised structure). 16-char prefix
    is enough — collisions on a per-task source basis are functionally
    impossible at our scale."""
    if not isinstance(s, str):
        s = json.dumps(s, sort_keys=True, default=str, ensure_ascii=False)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


def _frontmatter_changes(prior_fm: dict[str, Any], current_fm: dict[str, Any]) -> list[str]:
    """Return the list of frontmatter keys whose values differ between
    the prior snapshot and the current record. Compares serialised JSON
    representations so nested-list / nested-dict diffs are caught
    without needing deep equality. Bounded to the first 5 keys for
    log/note hygiene — enough signal for the LLM, not so much that the
    note becomes unreadable.
    """
    if not isinstance(prior_fm, dict):
        prior_fm = {}
    if not isinstance(current_fm, dict):
        current_fm = {}
    changed: list[str] = []
    all_keys = set(prior_fm.keys()) | set(current_fm.keys())
    for k in sorted(all_keys):
        a = prior_fm.get(k)
        b = current_fm.get(k)
        try:
            sa = json.dumps(a, sort_keys=True, default=str, ensure_ascii=False)
            sb = json.dumps(b, sort_keys=True, default=str, ensure_ascii=False)
        except TypeError:
            sa = str(a)
            sb = str(b)
        if sa != sb:
            changed.append(k)
        if len(changed) >= 5:
            break
    return changed


def _parse_vault_record_source(source: dict[str, Any]) -> tuple[str, str]:
    """Pull ``(name, vault_path)`` out of a frontmatter source entry.

    Accepts both shapes the RFC's frontmatter spec allows::

        - { name: "vault:record:matter/foo.md", confidence: ... }
        - { name: "vault:record", ref: "matter/foo.md", ... }

    Returns ``("", "")`` if the entry doesn't look like a vault:record
    source so the caller can skip it cleanly.
    """
    if not isinstance(source, dict):
        return "", ""
    raw_name = str(source.get("name") or "").strip()
    if not raw_name:
        return "", ""
    if raw_name.startswith("vault:record:"):
        path = raw_name[len("vault:record:"):].strip()
        return raw_name, path
    if raw_name == "vault:record":
        ref = str(source.get("ref") or "").strip()
        if ref:
            return f"vault:record:{ref}", ref
    return "", ""


# ---------------------------------------------------------------------------
# Activity: gather_signals_vault_record (Phase 1)
# ---------------------------------------------------------------------------

@activity.defn
async def gather_signals_vault_record(
    task_path: str,
    sources: list[dict[str, Any]],
    since: str,
) -> dict[str, Any]:
    """Diff each ``vault:record:<path>`` source against the prior snapshot.

    For each source whose name starts with ``vault:record:``:
      1. Resolve the referenced vault record via ctrl-api.
      2. Read the prior snapshot (if any) from
         ``/alfred-data/state/steward/<task_id>/vault-snapshots.json``.
      3. Compare frontmatter + content hash against the snapshot.
      4. If different — or if ``since`` is empty (first run) — emit a
         signal with the source ref + a brief note describing what
         changed.
      5. Update the snapshot file in place.

    First-run behaviour: when ``since`` is empty every source emits a
    signal so the very first Steward tick on a brand-new task always
    reaches the LLM (cold-start context per RFC §3, accepted in shadow
    mode).

    Returns::

        {
          "signals": [{"source": "vault:record:matter/foo.md",
                       "ref": "matter/foo.md",
                       "note": "frontmatter keys changed: state, due_at"}, ...],
          "snapshots_path": "/alfred-data/state/steward/<task_id>/vault-snapshots.json",
          "evaluated_sources": ["vault:record:matter/foo.md", ...],
        }

    Vault-record reads that 404 are treated as "the source disappeared";
    we emit a signal noting the deletion so the LLM has a chance to
    archive a now-orphaned task. Other read errors are swallowed (with
    a log line) so a transient ctrl-api blip on one of N sources can't
    starve the rest of the tick.
    """
    slug = _slug_from_task_path(task_path)
    if not slug:
        logger.warning(
            "steward.gather_signals: empty task_path — returning no signals"
        )
        return {
            "signals": [],
            "snapshots_path": "",
            "evaluated_sources": [],
        }

    sources = sources or []
    cfg = load_config()
    snapshots = _read_snapshots(cfg, slug)
    is_first_run = not (since or "").strip()

    signals: list[dict[str, Any]] = []
    evaluated: list[str] = []
    new_snapshots = dict(snapshots)  # Start from existing; overwrite on each hit

    client = VaultClient(cfg)
    try:
        for src in sources:
            name, vpath = _parse_vault_record_source(src)
            if not name or not vpath:
                continue
            evaluated.append(name)

            prior = snapshots.get(name) or {}
            current_fm: dict[str, Any] = {}
            current_body_hash: str = ""
            note: str = ""
            record_existed = True

            try:
                record = await client.read_record(vpath)
            except httpx.HTTPStatusError as exc:
                if exc.response is not None and exc.response.status_code == 404:
                    record_existed = False
                    record = {}
                else:
                    logger.warning(
                        "steward.gather_signals: read failed task=%s source=%s err=%s",
                        slug, name, exc,
                    )
                    continue
            except httpx.HTTPError as exc:
                logger.warning(
                    "steward.gather_signals: read failed task=%s source=%s err=%s",
                    slug, name, exc,
                )
                continue

            if record_existed:
                fm = record.get("frontmatter")
                current_fm = fm if isinstance(fm, dict) else {}
                body = record.get("content") or record.get("body") or ""
                if not isinstance(body, str):
                    body = str(body)
                current_body_hash = _content_hash(body)

            current_snapshot = {
                "frontmatter": current_fm,
                "body_hash": current_body_hash,
                "exists": record_existed,
                "checked_at": _now_utc_iso(),
            }

            # Decide whether to emit a signal.
            emit = False
            if is_first_run:
                emit = True
                note = (
                    "first observation of source"
                    if record_existed
                    else "first observation of source (record missing)"
                )
            elif not prior:
                # No snapshot yet but this isn't the first run — treat as
                # a fresh signal so the LLM sees the source content.
                emit = True
                note = "newly tracked source"
            else:
                prior_existed = bool(prior.get("exists", True))
                if prior_existed and not record_existed:
                    emit = True
                    note = "vault record was deleted since last check"
                elif not prior_existed and record_existed:
                    emit = True
                    note = "vault record was created since last check"
                elif record_existed:
                    prior_body_hash = str(prior.get("body_hash") or "")
                    prior_fm = prior.get("frontmatter")
                    prior_fm = prior_fm if isinstance(prior_fm, dict) else {}
                    body_changed = current_body_hash != prior_body_hash
                    fm_changes = _frontmatter_changes(prior_fm, current_fm)
                    if body_changed and fm_changes:
                        emit = True
                        note = (
                            "body and frontmatter changed (keys: "
                            + ", ".join(fm_changes) + ")"
                        )
                    elif body_changed:
                        emit = True
                        note = "body content changed"
                    elif fm_changes:
                        emit = True
                        note = "frontmatter keys changed: " + ", ".join(fm_changes)

            if emit:
                signals.append({
                    "source": name,
                    "ref": vpath,
                    "note": note,
                })

            new_snapshots[name] = current_snapshot
    finally:
        await client.close()

    snapshots_path = _write_snapshots(cfg, slug, new_snapshots)

    logger.info(
        "steward.gather_signals: task=%s sources=%d signals=%d first_run=%s",
        slug, len(evaluated), len(signals), is_first_run,
    )

    return {
        "signals": signals,
        "snapshots_path": snapshots_path,
        "evaluated_sources": evaluated,
    }


# ---------------------------------------------------------------------------
# Phase 2: shared helpers for stream-backed signal gatherers
# ---------------------------------------------------------------------------

def _parse_iso_to_epoch(value: Any) -> Optional[float]:
    """Parse an ISO-8601 / unix-seconds value into a UTC epoch float.

    Returns ``None`` for unparseable input. Tolerates the same shapes
    ``_parse_iso`` does plus bare integer / float epoch seconds (Plane
    occasionally returns those for legacy fields).
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # Treat large epoch-millisecond values gracefully — anything past
        # year 5000 in seconds is almost certainly milliseconds.
        v = float(value)
        if v > 1e11:
            v /= 1000.0
        return v
    dt = _parse_iso(value)
    if dt is None:
        return None
    return dt.timestamp()


def _read_jsonl_since(path: str, since_epoch: Optional[float]) -> list[dict[str, Any]]:
    """Tail a JSONL file, returning records newer than ``since_epoch``.

    The file is read whole-cloth — for the streams alfred-learn currently
    consumes (composio gmail, plane, ctrl-api) the per-tenant volumes are
    in the low thousands of events and routinely rotated. If/when this
    becomes hot we'll switch to a tail-from-mtime read; for Phase 2 the
    simple loop is correct and bounded.

    Records lacking a parseable timestamp are kept (so a stream emitter
    that doesn't stamp every event still surfaces signals — better to
    over-emit than silently swallow).
    """
    out: list[dict[str, Any]] = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(rec, dict):
                    continue
                if since_epoch is None:
                    out.append(rec)
                    continue
                ts = (
                    rec.get("received_at")
                    or rec.get("ts")
                    or rec.get("timestamp")
                    or rec.get("created_at")
                )
                ts_epoch = _parse_iso_to_epoch(ts)
                if ts_epoch is None or ts_epoch >= since_epoch:
                    out.append(rec)
    except FileNotFoundError:
        return []
    except OSError as exc:
        logger.warning("steward.gather_signals: stream read failed path=%s err=%s", path, exc)
        return []
    return out


def _haystack_for_gmail_event(rec: dict[str, Any]) -> dict[str, str]:
    """Build the searchable views of a gmail event for query matching.

    Returns a dict with keys ``subject``, ``from``, ``to``, ``snippet``,
    ``body``, ``labels`` (joined). Empty string when a field is missing.
    """
    raw = rec.get("raw") or {}
    if not isinstance(raw, dict):
        raw = {}
    md = rec.get("metadata") or {}
    if not isinstance(md, dict):
        md = {}
    subject = str(raw.get("subject") or md.get("subject") or "")
    sender = str(raw.get("from") or md.get("from") or "")
    recipient = str(raw.get("to") or md.get("to") or "")
    snippet = str(raw.get("snippet") or "")
    body = ""
    payload = raw.get("payload") or raw.get("body")
    if isinstance(payload, dict):
        # Gmail full-format messages put the text body under
        # payload.parts[i].body.data (base64). We don't decode here —
        # the snippet is already a server-side-rendered preview and is
        # what Gmail uses for its own search ranking. If a query is so
        # narrow that snippet doesn't catch it, we fall back to the live
        # API path below.
        snippet = snippet or str(payload.get("snippet") or "")
    elif isinstance(payload, str):
        body = payload
    labels = raw.get("labelIds") or md.get("labels") or []
    if isinstance(labels, list):
        labels_str = " ".join(str(x) for x in labels)
    else:
        labels_str = str(labels)
    return {
        "subject": subject,
        "from": sender,
        "to": recipient,
        "snippet": snippet,
        "body": body,
        "labels": labels_str,
    }


def _gmail_query_matches(query: str, fields: dict[str, str]) -> bool:
    """Lightweight Gmail-search-syntax matcher.

    Supported tokens:
      * ``from:<x>``       — substring match on the From header.
      * ``to:<x>``         — substring match on the To header.
      * ``subject:<x>``    — substring match on the Subject.
      * ``label:<x>``      — substring match on label list.
      * bare token         — substring match anywhere.

    All comparisons case-insensitive. Multiple tokens AND together.
    Empty / whitespace-only queries match nothing (refusing to fan
    out a wildcard signal across every Gmail event would be footgun
    behaviour).
    """
    if not query or not query.strip():
        return False
    haystack_all = " ".join(v for v in fields.values()).lower()
    qlow = query.lower().strip()
    # Tokenise on whitespace; each token must match.
    for token in qlow.split():
        if not token:
            continue
        if ":" in token:
            key, _, val = token.partition(":")
            target = fields.get(key, "").lower()
            if val and val not in target:
                return False
            continue
        if token not in haystack_all:
            return False
    return True


# ---------------------------------------------------------------------------
# Activity: gather_signals_gmail (Phase 2)
# ---------------------------------------------------------------------------

# Stream files are written by streams.ts as ``<safe_id>.jsonl`` under
# ALFRED_DATA_DIR/streams, and their configs live alongside under
# ``streams/configs/<safe_id>.json`` (see ctrl-api streams.ts —
# ``getStreamConfigPath`` / ``getStreamEventsPath``).
#
# Historically we matched gmail streams by *filename* (``composio-gmail*``,
# ``gmail.jsonl``, ``gmail-*``). That works only when auto-config wrote
# the canonical id ``composio-gmail-gmail-fetch-emails``. UI-created or
# UUID-id streams (e.g. ``f7446eaf-…``) write to a sibling JSONL that
# none of those globs touch, so steward read a 4-day-stale legacy file
# and reported "stale gmail stream" while the real Composio pull was
# alive and well in a UUID-named JSONL. Discovery #293, fix landed via
# Composio recurring-break PR.
#
# The correct selector is ``composio_action == "GMAIL_FETCH_EMAILS"``
# on the stream config — that's tenant-agnostic and survives the legacy
# auto-config ↔ UI naming split. We walk ``streams/configs/`` for any
# config carrying that action and resolve the matching ``<id>.jsonl``.
# The legacy filename globs remain a fallback for tenants whose configs
# dir is empty (early pre-auto-config tenants, dev fixtures, etc.).
_GMAIL_COMPOSIO_ACTION = "GMAIL_FETCH_EMAILS"

_GMAIL_STREAM_GLOBS = (
    "composio-gmail*.jsonl",
    "gmail.jsonl",
    "gmail-*.jsonl",
)


def _list_gmail_stream_files(streams_dir: str) -> list[str]:
    """Return absolute paths of every gmail-shaped JSONL stream file.

    Primary selector: any stream config under ``<streams_dir>/configs/``
    whose ``composio_action`` is ``GMAIL_FETCH_EMAILS``. The config's
    ``id`` (after the same safe-filename pass as ctrl-api streams.ts)
    resolves to ``<streams_dir>/<safe_id>.jsonl``.

    Fallback: legacy filename glob (``composio-gmail*.jsonl`` etc.) —
    kept so a tenant whose configs dir is missing (pre-auto-config or
    fixture-only) still picks up canonical-id JSONLs.

    Files that don't exist on disk yet (stream config exists, JSONL not
    written) are silently dropped — the freshness check downstream
    handles the "no data yet" state.
    """
    out: list[str] = []

    # Primary: walk stream configs, select by composio_action.
    configs_dir = os.path.join(streams_dir, "configs")
    try:
        config_names = os.listdir(configs_dir)
    except OSError:
        config_names = []
    for name in config_names:
        if not name.endswith(".json"):
            continue
        cfg_path = os.path.join(configs_dir, name)
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        if not isinstance(cfg, dict):
            continue
        if cfg.get("composio_action") != _GMAIL_COMPOSIO_ACTION:
            continue
        stream_id = cfg.get("id") or os.path.splitext(name)[0]
        if not isinstance(stream_id, str) or not stream_id:
            continue
        # Mirror ctrl-api streams.ts getStreamEventsPath sanitisation
        # (``[^a-zA-Z0-9_-]`` → ``_``) so we land on the same file.
        safe_id = re.sub(r"[^a-zA-Z0-9_-]", "_", stream_id)
        jsonl_path = os.path.join(streams_dir, f"{safe_id}.jsonl")
        if os.path.exists(jsonl_path):
            out.append(jsonl_path)

    # Fallback: legacy filename glob — covers tenants without a configs
    # dir and the canonical auto-config id case.
    for pattern in _GMAIL_STREAM_GLOBS:
        out.extend(glob.glob(os.path.join(streams_dir, pattern)))

    # Dedup while preserving order (config-driven hits take precedence).
    seen: set[str] = set()
    uniq: list[str] = []
    for p in out:
        if p in seen:
            continue
        seen.add(p)
        uniq.append(p)
    return uniq


def _stream_freshness_seconds(streams_dir: str, files: list[str]) -> Optional[float]:
    """Newest mtime across ``files``, in seconds-since-epoch.

    Returns ``None`` when no files exist. Used by ``gather_signals_gmail``
    to decide whether the polled stream is fresh enough that we trust
    it OR fall through to a live API call (rare; logged + skipped in
    Phase 2 per the issue spec).
    """
    newest: Optional[float] = None
    for p in files:
        try:
            st = os.stat(p)
        except OSError:
            continue
        if newest is None or st.st_mtime > newest:
            newest = st.st_mtime
    return newest


@activity.defn
async def gather_signals_gmail(
    task_path: str,
    sources: list[dict[str, Any]],
    since: str,
) -> dict[str, Any]:
    """Match gmail signal sources against the composio gmail event stream.

    Each source's ``name`` MUST start with ``gmail:`` — everything after
    the prefix is treated as a Gmail-search-syntax query (see
    ``_gmail_query_matches``). Sources not matching the prefix are
    skipped silently so this activity coexists with vault:record /
    sure: / ctrl-api:stream: sources on the same task.

    Behaviour:
      * Reads every ``composio-gmail*.jsonl`` (and legacy ``gmail.jsonl``)
        under ``$ALFRED_DATA_DIR/streams``.
      * Filters to events whose timestamp >= ``since`` (parseable ISO).
      * Per source, scans the filtered events and emits one signal per
        matching event — capped at ``MAX_SIGNALS_PER_SOURCE`` so a
        flood of incoming gmail can't blow up the audit record body.
      * If the stream's newest mtime is older than 10 minutes, logs a
        ``stale_stream`` warning and emits no signals for that gather
        cycle. The Gmail poller normally runs every 5 min so a >10 min
        gap means the poller is sick — Phase 2 declines to fire a live
        API fallback (would be redundant with the existing pull cron
        and risk Gmail rate limits).

    The returned shape mirrors ``gather_signals_vault_record``::

        {"signals": [...], "snapshots_path": "", "evaluated_sources": [...]}

    Snapshots aren't applicable — JSONL is the snapshot. We still
    return the empty string so the caller can treat all gatherers
    uniformly.
    """
    MAX_SIGNALS_PER_SOURCE = 5
    STALE_STREAM_SECS = 10 * 60

    slug = _slug_from_task_path(task_path)
    sources = sources or []
    cfg = load_config()

    gmail_sources: list[tuple[str, str]] = []
    for s in sources:
        if not isinstance(s, dict):
            continue
        name = str(s.get("name") or "").strip()
        if not name.startswith("gmail:"):
            continue
        query = name[len("gmail:"):].strip()
        if not query:
            continue
        gmail_sources.append((name, query))

    if not gmail_sources:
        return {"signals": [], "snapshots_path": "", "evaluated_sources": []}

    files = _list_gmail_stream_files(cfg.streams_dir)
    evaluated = [name for name, _ in gmail_sources]
    if not files:
        logger.info(
            "steward.gather_signals_gmail: task=%s no gmail stream files in %s",
            slug, cfg.streams_dir,
        )
        return {"signals": [], "snapshots_path": "", "evaluated_sources": evaluated}

    newest_mtime = _stream_freshness_seconds(cfg.streams_dir, files)
    now = time.time()
    if newest_mtime is None or (now - newest_mtime) > STALE_STREAM_SECS:
        logger.warning(
            "steward.gather_signals_gmail: task=%s stale gmail stream (newest=%s, age=%.0fs) — skipping live API fallback",
            slug,
            datetime.fromtimestamp(newest_mtime, tz=timezone.utc).isoformat() if newest_mtime else "(none)",
            (now - newest_mtime) if newest_mtime else -1,
        )
        return {"signals": [], "snapshots_path": "", "evaluated_sources": evaluated}

    since_epoch = _parse_iso_to_epoch(since) if since else None

    # Read every file once; reuse the parsed records across sources.
    all_records: list[dict[str, Any]] = []
    for path in files:
        all_records.extend(_read_jsonl_since(path, since_epoch))

    if not all_records:
        return {"signals": [], "snapshots_path": "", "evaluated_sources": evaluated}

    signals: list[dict[str, Any]] = []
    # Dedup signals by (source, gmail_message_id) so the same email
    # showing up in multiple stream files (the composio poller can
    # rewrite history on backfills) emits exactly once per source.
    emitted: set[tuple[str, str]] = set()

    for src_name, query in gmail_sources:
        per_source = 0
        for rec in all_records:
            if per_source >= MAX_SIGNALS_PER_SOURCE:
                break
            fields = _haystack_for_gmail_event(rec)
            if not _gmail_query_matches(query, fields):
                continue
            raw = rec.get("raw") or {}
            msg_id = ""
            if isinstance(raw, dict):
                msg_id = str(raw.get("id") or raw.get("messageId") or "")
            if not msg_id:
                msg_id = str(rec.get("id") or "")
            dedup_key = (src_name, msg_id) if msg_id else (src_name, json.dumps(rec, sort_keys=True, default=str)[:200])
            if dedup_key in emitted:
                continue
            emitted.add(dedup_key)
            note_subject = fields["subject"][:120] or "(no subject)"
            note_from = fields["from"][:80] or "(unknown sender)"
            signals.append({
                "source": src_name,
                "ref": f"gmail:{msg_id}" if msg_id else f"gmail:{src_name}",
                "note": f"matched: from={note_from} subject={note_subject}",
            })
            per_source += 1

    logger.info(
        "steward.gather_signals_gmail: task=%s sources=%d records=%d signals=%d",
        slug, len(gmail_sources), len(all_records), len(signals),
    )
    return {"signals": signals, "snapshots_path": "", "evaluated_sources": evaluated}


# ---------------------------------------------------------------------------
# Activity: gather_signals_sure (Phase 2)
# ---------------------------------------------------------------------------

# Module-level cache: identical (source_name, since) tuples within
# SURE_CACHE_TTL_SECS reuse the prior result. Keeps Sure's REST happy
# under fleet load — RFC #832 §2 risk note.
_SURE_CACHE: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}
SURE_CACHE_TTL_SECS = 15 * 60


def _parse_sure_source(name: str) -> Optional[dict[str, str]]:
    """Decode a sure source name into its query bits.

    Supported shapes:
      ``sure:account:<id>``                     — all transactions on that account
      ``sure:transaction:match:<predicate>``    — predicate is a substring matched
                                                  against name/merchant/category
      ``sure:transaction:category:<id>``        — transactions in a category
      ``sure:transaction:tag:<id>``             — transactions carrying a tag

    Returns ``None`` for unrecognised shapes so the caller can skip cleanly.
    """
    if not name.startswith("sure:"):
        return None
    rest = name[len("sure:"):]
    if rest.startswith("account:"):
        acct = rest[len("account:"):].strip()
        if not acct:
            return None
        return {"kind": "account", "value": acct}
    if rest.startswith("transaction:match:"):
        pred = rest[len("transaction:match:"):].strip()
        if not pred:
            return None
        return {"kind": "transaction_match", "value": pred}
    if rest.startswith("transaction:category:"):
        cat = rest[len("transaction:category:"):].strip()
        if not cat:
            return None
        return {"kind": "transaction_category", "value": cat}
    if rest.startswith("transaction:tag:"):
        tag = rest[len("transaction:tag:"):].strip()
        if not tag:
            return None
        return {"kind": "transaction_tag", "value": tag}
    return None


async def _fetch_sure_transactions(
    client: VaultClient,
    parsed: dict[str, str],
    since: str,
) -> list[dict[str, Any]]:
    """Hit ctrl-api's Sure transactions proxy, filtered for the predicate.

    ctrl-api forwards ``GET /api/v1/sure/transactions`` to the Sure
    REST API; we reuse the same VaultClient (which carries the
    ``Authorization: Bearer <AAS_API_KEY>`` header) since the SaaS
    proxy is uniformly authenticated by that key.
    """
    params: dict[str, str] = {}
    if since:
        # Sure accepts ISO-8601 ``start_date`` / ``end_date`` filters; we
        # pass the start so the response stays bounded.
        params["start_date"] = since
    if parsed["kind"] == "account":
        params["account_ids"] = parsed["value"]
    elif parsed["kind"] == "transaction_category":
        params["category_ids"] = parsed["value"]
    elif parsed["kind"] == "transaction_tag":
        params["tag_ids"] = parsed["value"]
    # transaction_match has no native Sure filter; we pull recent and filter
    # client-side below.

    try:
        resp = await client._client.get("/api/v1/sure/transactions", params=params)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning(
            "steward.gather_signals_sure: ctrl-api sure call failed kind=%s value=%s err=%s",
            parsed["kind"], parsed["value"], exc,
        )
        return []
    payload = resp.json()
    if isinstance(payload, dict):
        records = payload.get("results") or payload.get("transactions") or payload.get("data") or []
    elif isinstance(payload, list):
        records = payload
    else:
        records = []
    if not isinstance(records, list):
        return []
    out: list[dict[str, Any]] = []
    for r in records:
        if isinstance(r, dict):
            out.append(r)
    return out


def _sure_record_matches(rec: dict[str, Any], parsed: dict[str, str]) -> bool:
    """Apply the predicate-side filter (transaction_match) — the other
    kinds are already filtered server-side.
    """
    if parsed["kind"] != "transaction_match":
        return True
    pred = parsed["value"].lower()
    haystack_parts: list[str] = []
    for k in ("name", "description", "merchant_name", "merchant", "payee", "category", "category_name", "notes"):
        v = rec.get(k)
        if isinstance(v, str):
            haystack_parts.append(v.lower())
        elif isinstance(v, dict):
            inner = v.get("name")
            if isinstance(inner, str):
                haystack_parts.append(inner.lower())
    return pred in " ".join(haystack_parts)


@activity.defn
async def gather_signals_sure(
    task_path: str,
    sources: list[dict[str, Any]],
    since: str,
) -> dict[str, Any]:
    """Pull recent Sure transactions matching each ``sure:*`` source.

    Per-source result is cached for 15 min by (source_name, since)
    so a Steward tick that fires across multiple tasks watching the
    same account doesn't hammer Sure's REST.

    Phase 2 emits one signal per matching transaction up to a per-
    source cap. The note carries amount + merchant + date so the LLM
    has enough to reason without a second API round-trip.

    Returns the same shape as ``gather_signals_vault_record``.
    """
    MAX_SIGNALS_PER_SOURCE = 5

    slug = _slug_from_task_path(task_path)
    sources = sources or []

    sure_sources: list[tuple[str, dict[str, str]]] = []
    for s in sources:
        if not isinstance(s, dict):
            continue
        name = str(s.get("name") or "").strip()
        parsed = _parse_sure_source(name)
        if not parsed:
            continue
        sure_sources.append((name, parsed))

    if not sure_sources:
        return {"signals": [], "snapshots_path": "", "evaluated_sources": []}

    cfg = load_config()
    client = VaultClient(cfg)
    signals: list[dict[str, Any]] = []
    evaluated: list[str] = []
    now = time.time()

    try:
        for src_name, parsed in sure_sources:
            evaluated.append(src_name)
            cache_key = (src_name, since or "")
            cached = _SURE_CACHE.get(cache_key)
            if cached and (now - cached[0]) < SURE_CACHE_TTL_SECS:
                records = cached[1]
            else:
                records = await _fetch_sure_transactions(client, parsed, since or "")
                _SURE_CACHE[cache_key] = (now, records)

            per_source = 0
            for rec in records:
                if per_source >= MAX_SIGNALS_PER_SOURCE:
                    break
                if not _sure_record_matches(rec, parsed):
                    continue
                txn_id = str(rec.get("id") or rec.get("transaction_id") or "")
                amount = rec.get("amount")
                amount_str = ""
                if isinstance(amount, (int, float)):
                    amount_str = f"{amount:.2f}"
                elif isinstance(amount, str):
                    amount_str = amount
                merchant = ""
                if isinstance(rec.get("merchant"), dict):
                    merchant = str((rec["merchant"]).get("name") or "")
                merchant = merchant or str(rec.get("merchant_name") or rec.get("payee") or rec.get("name") or "")
                date_str = str(rec.get("date") or rec.get("posted_at") or rec.get("created_at") or "")
                note_parts: list[str] = []
                if amount_str:
                    note_parts.append(f"amount={amount_str}")
                if merchant:
                    note_parts.append(f"merchant={merchant[:80]}")
                if date_str:
                    note_parts.append(f"date={date_str[:32]}")
                signals.append({
                    "source": src_name,
                    "ref": f"sure:transaction:{txn_id}" if txn_id else f"sure:{src_name}",
                    "note": "; ".join(note_parts) or "matched transaction",
                })
                per_source += 1
    finally:
        await client.close()

    logger.info(
        "steward.gather_signals_sure: task=%s sources=%d signals=%d",
        slug, len(sure_sources), len(signals),
    )
    return {"signals": signals, "snapshots_path": "", "evaluated_sources": evaluated}


# ---------------------------------------------------------------------------
# Activity: gather_signals_ctrl_api_stream (Phase 2)
# ---------------------------------------------------------------------------

@activity.defn
async def gather_signals_ctrl_api_stream(
    task_path: str,
    sources: list[dict[str, Any]],
    since: str,
) -> dict[str, Any]:
    """Read events from a tenant-local ctrl-api stream JSONL file.

    Source names of the form ``ctrl-api:stream:<stream_id>`` map onto
    the JSONL files ctrl-api persists at ``$ALFRED_DATA_DIR/streams/
    <safe_id>.jsonl`` (see ``streams.ts::getStreamEventsPath``). We read
    the file directly — alfred-learn shares the same volume mount as
    ctrl-api on every tenant — and emit one signal per event newer than
    ``since``.

    Capping behaviour mirrors the gmail / sure paths: at most
    ``MAX_SIGNALS_PER_SOURCE`` per source per tick so a backed-up
    stream doesn't crash the audit record.
    """
    MAX_SIGNALS_PER_SOURCE = 5

    slug = _slug_from_task_path(task_path)
    sources = sources or []

    stream_sources: list[tuple[str, str]] = []
    for s in sources:
        if not isinstance(s, dict):
            continue
        name = str(s.get("name") or "").strip()
        if not name.startswith("ctrl-api:stream:"):
            continue
        stream_id = name[len("ctrl-api:stream:"):].strip()
        if not stream_id:
            continue
        stream_sources.append((name, stream_id))

    if not stream_sources:
        return {"signals": [], "snapshots_path": "", "evaluated_sources": []}

    cfg = load_config()
    since_epoch = _parse_iso_to_epoch(since) if since else None
    signals: list[dict[str, Any]] = []
    evaluated: list[str] = []

    for src_name, stream_id in stream_sources:
        evaluated.append(src_name)
        # Mirror ctrl-api's ``getStreamEventsPath``: replace any non
        # [a-zA-Z0-9_-] with underscores.
        safe = re.sub(r"[^a-zA-Z0-9_-]", "_", stream_id)
        path = os.path.join(cfg.streams_dir, f"{safe}.jsonl")
        records = _read_jsonl_since(path, since_epoch)
        per_source = 0
        for rec in records:
            if per_source >= MAX_SIGNALS_PER_SOURCE:
                break
            event_id = str(rec.get("id") or "")
            stream_type = str(rec.get("stream_type") or "")
            summary = str(rec.get("summary") or "")[:200]
            source_ref = str(rec.get("source_ref") or "")
            note_parts: list[str] = []
            if stream_type:
                note_parts.append(f"type={stream_type}")
            if summary:
                note_parts.append(summary)
            elif source_ref:
                note_parts.append(f"source_ref={source_ref}")
            signals.append({
                "source": src_name,
                "ref": f"ctrl-api:stream:{stream_id}:{event_id}" if event_id else src_name,
                "note": "; ".join(note_parts) or "stream event",
            })
            per_source += 1

    logger.info(
        "steward.gather_signals_ctrl_api_stream: task=%s sources=%d signals=%d",
        slug, len(stream_sources), len(signals),
    )
    return {"signals": signals, "snapshots_path": "", "evaluated_sources": evaluated}


# ---------------------------------------------------------------------------
# Activity: evaluate_state (Phase 1)
# ---------------------------------------------------------------------------

# Strict allow-list of decision strings — enforced after JSON parse so a
# clerk that hallucinates ``"complete"`` instead of ``"likely_done"``
# doesn't slip into the audit trail.
_ALLOWED_DECISIONS = (
    "still_active",
    "likely_done",
    "needs_input",
    "stale_archive_candidate",
)


def _build_evaluate_state_prompt(
    task_path: str,
    task_frontmatter: dict[str, Any],
    signals: list[dict[str, Any]],
    is_warm: bool,
    *,
    stricter: bool = False,
) -> str:
    """Build the Steward evaluation prompt.

    ``stricter=True`` is used on retry after a malformed first response —
    it pre-pends an explicit reminder to emit JSON only and adds a
    pseudo-example to anchor the format.
    """
    fm = task_frontmatter or {}
    name = (
        fm.get("title")
        or fm.get("name")
        or fm.get("summary")
        or task_path
    )
    state = fm.get("state") or "open"
    parent_matter = fm.get("parent_matter") or ""
    description = (
        fm.get("description")
        or fm.get("summary")
        or fm.get("body")
        or ""
    )
    if not isinstance(description, str):
        description = json.dumps(description, ensure_ascii=False)

    last_outcome = fm.get("last_steward_outcome")
    last_check = fm.get("last_steward_check_at") or ""
    if last_check:
        last_check_disp = last_check
    else:
        last_check_disp = "(no prior check — first evaluation)"

    if isinstance(last_outcome, dict):
        last_outcome_json = json.dumps(last_outcome, ensure_ascii=False, indent=2)
    elif last_outcome:
        last_outcome_json = json.dumps(last_outcome, ensure_ascii=False)
    else:
        last_outcome_json = "null"

    signals_json = json.dumps(signals or [], ensure_ascii=False, indent=2)
    since_disp = last_check or "(first run)"

    header = ""
    if stricter:
        header = (
            "RETRY NOTICE: your previous response was not valid JSON or "
            "was missing required keys. Return ONLY the JSON object — "
            "no markdown, no prose, no commentary. Every key listed below "
            "is REQUIRED.\n\n"
        )

    schema_hint = ""
    if stricter:
        schema_hint = (
            "\n\nFOR REFERENCE, a minimal valid response looks like:\n"
            "{\n"
            '  "decision": "still_active",\n'
            '  "confidence": 0.5,\n'
            '  "evidence": [],\n'
            '  "reasoning": "No new signals; default to still active.",\n'
            '  "source_contributions": {}\n'
            "}\n"
        )

    warm_clause = (
        "This is a re-evaluation — there is a prior outcome you can compare against."
        if is_warm
        else "This is the FIRST evaluation of this task — there is no prior outcome."
    )

    prompt = f"""{header}You are Steward, Alfred's task-lifecycle agent. You watch a task and decide if its state has changed.

{warm_clause}

TASK: {name}
TASK_PATH: {task_path}
STATE: {state}  (last checked at {last_check_disp})
PARENT_MATTER: {parent_matter}

DESCRIPTION:
{description}

LAST OUTCOME (if any):
{last_outcome_json}

NEW SIGNALS SINCE {since_disp}:
{signals_json}

Your job: decide the new state of this task based on the signals. You may use your read tools to inspect the referenced vault records if you need more context — they are mounted at workspace/vault/<path> and vault/<path>.

Decision values:
  - "still_active"            — task remains open and relevant
  - "likely_done"             — evidence suggests the work is complete
  - "needs_input"             — Sir's attention is required to move forward
  - "stale_archive_candidate" — task has gone cold; recommend archiving

Confidence rules:
  - 1.0          — certain (e.g. a confirmed payment matches the invoice we were waiting for)
  - 0.7..0.9     — strong evidence
  - 0.5..0.7     — probable
  - < 0.5        — speculative; Steward will land this as pending_confirmation rather than auto-acting

source_contributions: how much each signal source contributed to your decision (0 = irrelevant, 1 = decisive). This drives the calibration loop — be honest, even contributions of 0.0 are useful signal.

Return ONLY valid JSON matching this schema:
{{
  "decision": "still_active" | "likely_done" | "needs_input" | "stale_archive_candidate",
  "confidence": 0.0..1.0,
  "evidence": [{{"source": "<source_name>", "ref": "<ref>", "note": "<one-sentence why this matters>"}}],
  "reasoning": "<one-paragraph why this decision>",
  "source_contributions": {{"<source_name>": 0.0..1.0, ...}}
}}{schema_hint}

Return JSON only. No prose."""
    return prompt


def _validate_evaluate_state_response(raw: Any) -> Optional[dict[str, Any]]:
    """Validate + normalise a clerk response against the Phase 1 schema.

    Returns a clean dict on success, ``None`` on validation failure
    (caller decides whether to retry or fall back). Coerces numeric
    confidence to a clamped float in [0, 1] and drops malformed evidence
    entries instead of failing the whole response.
    """
    if not isinstance(raw, dict):
        return None
    decision = raw.get("decision")
    if not isinstance(decision, str) or decision not in _ALLOWED_DECISIONS:
        return None
    try:
        confidence = float(raw.get("confidence", 0.0))
    except (TypeError, ValueError):
        return None
    if confidence < 0.0:
        confidence = 0.0
    elif confidence > 1.0:
        confidence = 1.0

    evidence_in = raw.get("evidence") or []
    evidence: list[dict[str, Any]] = []
    if isinstance(evidence_in, list):
        for e in evidence_in:
            if not isinstance(e, dict):
                continue
            evidence.append({
                "source": str(e.get("source") or ""),
                "ref": str(e.get("ref") or ""),
                "note": str(e.get("note") or ""),
            })

    reasoning = raw.get("reasoning") or ""
    if not isinstance(reasoning, str):
        reasoning = json.dumps(reasoning, ensure_ascii=False)

    contributions_in = raw.get("source_contributions") or {}
    contributions: dict[str, float] = {}
    if isinstance(contributions_in, dict):
        for k, v in contributions_in.items():
            try:
                fv = float(v)
            except (TypeError, ValueError):
                continue
            if fv < 0.0:
                fv = 0.0
            elif fv > 1.0:
                fv = 1.0
            contributions[str(k)] = fv

    return {
        "decision": decision,
        "confidence": round(confidence, 4),
        "evidence": evidence,
        "reasoning": reasoning,
        "source_contributions": contributions,
    }


@activity.defn
async def evaluate_state(
    task_path: str,
    task_frontmatter: dict[str, Any],
    signals: list[dict[str, Any]],
    is_warm: bool,
) -> dict[str, Any]:
    """Run a single Clerk LLM call to decide a task's state.

    Returns the validated structured decision::

        {
          "decision":             "still_active" | "likely_done" | "needs_input" | "stale_archive_candidate",
          "confidence":           0.0..1.0,
          "evidence":             [{"source": ..., "ref": ..., "note": ...}, ...],
          "reasoning":            "...",
          "source_contributions": {"<source>": 0.0..1.0, ...}
        }

    On a malformed first response, retries once with a stricter prompt.
    On a second malformed response, returns ``decision=still_active``
    with ``confidence=LLM_FALLBACK_CONFIDENCE`` (0.3) — low enough that
    no Phase 3 auto-action will ever fire, so a flaky LLM session can't
    cause Steward to start mass-archiving things.

    Vault writes are NOT performed here — this activity is pure
    perception. ``apply_state_change`` (called from ``evaluate_task``)
    handles the audit trail.
    """
    # Lazy import — activity-only, never imported by a workflow file,
    # so the clerk module never enters Temporal's deterministic-import
    # contract.
    from src.activities.clerk import _call_clerk

    # First attempt — normal prompt.
    prompt = _build_evaluate_state_prompt(
        task_path, task_frontmatter, signals, is_warm, stricter=False,
    )
    try:
        raw_first = await _call_clerk(prompt)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "steward.evaluate_state: clerk call failed task=%s err=%s",
            task_path, exc,
        )
        return {
            "decision": "still_active",
            "confidence": LLM_FALLBACK_CONFIDENCE,
            "evidence": [],
            "reasoning": f"clerk call failed: {exc}"[:500],
            "source_contributions": {},
            "fallback": True,
        }

    cleaned = _validate_evaluate_state_response(raw_first)
    if cleaned is not None:
        return cleaned

    logger.warning(
        "steward.evaluate_state: malformed clerk response on first attempt task=%s — retrying with stricter prompt",
        task_path,
    )

    # Second attempt — stricter prompt.
    prompt2 = _build_evaluate_state_prompt(
        task_path, task_frontmatter, signals, is_warm, stricter=True,
    )
    try:
        raw_second = await _call_clerk(prompt2)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "steward.evaluate_state: stricter retry failed task=%s err=%s",
            task_path, exc,
        )
        return {
            "decision": "still_active",
            "confidence": LLM_FALLBACK_CONFIDENCE,
            "evidence": [],
            "reasoning": f"clerk retry failed: {exc}"[:500],
            "source_contributions": {},
            "fallback": True,
        }

    cleaned2 = _validate_evaluate_state_response(raw_second)
    if cleaned2 is not None:
        return cleaned2

    logger.error(
        "steward.evaluate_state: clerk returned unparseable JSON twice task=%s — returning fallback decision",
        task_path,
    )
    return {
        "decision": "still_active",
        "confidence": LLM_FALLBACK_CONFIDENCE,
        "evidence": [],
        "reasoning": "Clerk returned malformed JSON on both attempts; defaulting to still_active at fallback confidence.",
        "source_contributions": {},
        "fallback": True,
    }


# ---------------------------------------------------------------------------
# Activity: evaluate_task (Phase 1 — real signal gathering + shadow LLM eval)
# ---------------------------------------------------------------------------

def _coerce_float(value: Any, default: float = 0.0) -> float:
    """Coerce arbitrary frontmatter values to float, clamped to [0, 1]."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


def _update_calibration(
    sources: list[Any],
    signal_source_names: set[str],
    source_contributions: Optional[dict[str, float]] = None,
    negative_signal: bool = False,
) -> tuple[list[dict[str, Any]], list[str], list[dict[str, Any]]]:
    """Advance the calibration tracker for each signal source on this tick.

    Returns ``(updated_sources, transitions, prune_events)``:

      * ``updated_sources`` — the new ``signal_sources`` list with
        ``calibration_status``, ``tick_count``, ``signal_count``,
        ``confidence``, and ``low_confidence_streak`` rewritten.
      * ``transitions`` — human-readable list of status changes for
        logging.
      * ``prune_events`` — one dict per source pruned this tick, in the
        shape ``apply_state_change``'s audit emitter expects::

          {
            "source_name":      "...",
            "reason":           "low_confidence" | "no_signals_after_calibration",
            "final_confidence": 0.15,
            "ticks_observed":   12,
            "total_signals":    0,
          }

        The caller awaits ``_emit_source_pruned_audit`` per entry to write
        the ``event/steward-source-pruned-<ts>.md`` vault record. Doing the
        I/O outside this pure function keeps it test-friendly.

    State machine (Phase 5 — superset of Phase 1):

        pending → live   when tick_count >= CALIBRATION_TICK_WINDOW
                         and signal_count >= 1
        pending → pruned when tick_count >= CALIBRATION_TICK_WINDOW
                         and signal_count == 0
                                              (no_signals_after_calibration)
        live    → pruned when low_confidence_streak >= LOW_CONFIDENCE_PRUNE_TICKS
                                              (low_confidence)

    Confidence EMA (Phase 5):

        confidence = EMA_DECAY * prior + EMA_LIFT * contribution
                                              clamped to [0, 1]

    Pinned sources (confidence > PIN_CONFIDENCE_CEIL) keep ``live``
    status and have their low-confidence streak frozen at 0 — they only
    re-enter normal scoring after confidence falls below
    PIN_HYSTERESIS_FLOOR. Sir-declared sources with frontmatter
    ``pinned: true`` skip the streak check entirely.

    Pruned sources are returned untouched — they're already terminal,
    we just preserve them in the output list so the frontmatter round-
    trip is lossless.

    Phase 6.7 (T6.7.5) ``negative_signal=True`` mode:

        When a Steward action is reversed (Sir clicks Undo on the
        dashboard, or a signal-routed mutation is undone), the
        contributing source's confidence is dropped by a flat
        ``NEGATIVE_FEEDBACK_PENALTY`` (default 0.1). This is
        deliberately NOT an EMA path — the EMA's smoothing would dilute
        a clear "Sir reversed me" signal across multiple ticks before it
        moves the needle. Reversals are rare and high-information; we
        want the per-source confidence to react fast. Floor at 0.0.

        In this mode we DON'T advance ``tick_count`` / ``signal_count``
        (a reversal isn't a tick), DON'T touch
        ``low_confidence_streak`` directly (the next normal tick will
        recompute it from the new lower confidence), DON'T transition
        ``calibration_status`` here (let the next normal tick prune via
        the regular hysteresis path so we stay on a single state
        machine). We DO stamp ``last_negative_at`` (ISO timestamp) and
        increment ``negative_count`` so the dashboard can surface
        per-source reversal stats.
    """
    contribs = source_contributions or {}
    if not isinstance(contribs, dict):
        contribs = {}

    out: list[dict[str, Any]] = []
    transitions: list[str] = []
    prune_events: list[dict[str, Any]] = []

    for raw_src in sources or []:
        if not isinstance(raw_src, dict):
            # Preserve unknown shapes verbatim — Steward shouldn't lose
            # frontmatter content it doesn't understand.
            out.append(raw_src if isinstance(raw_src, dict) else {"name": str(raw_src)})
            continue
        src = dict(raw_src)
        name = str(src.get("name") or "").strip()
        if not name:
            out.append(src)
            continue
        status = str(src.get("calibration_status") or "pending").strip().lower()
        tick_count = int(src.get("tick_count") or 0)
        signal_count = int(src.get("signal_count") or 0)
        prior_conf = _coerce_float(src.get("confidence"), 0.5)
        low_streak = int(src.get("low_confidence_streak") or 0)
        manually_pinned = bool(src.get("pinned", False))
        had_signal = name in signal_source_names

        if status == "pruned":
            # Don't touch — terminal state.
            out.append(src)
            continue

        # Phase 6.7 (T6.7.5) — reversal-driven negative feedback.
        # Apply BEFORE the tick-counter advance because a reversal
        # is not a tick. We deliberately skip the EMA path here:
        # reversals are rare, high-information events and deserve
        # an immediate confidence drop; the EMA's 0.9/0.1 smoothing
        # would dilute the signal across many ticks. Floor at 0.0
        # so a series of reversals can't drive confidence negative.
        if negative_signal:
            new_conf = prior_conf - NEGATIVE_FEEDBACK_PENALTY
            if new_conf < 0.0:
                new_conf = 0.0
            src["confidence"] = round(new_conf, 4)
            src["last_negative_at"] = (
                datetime.now(timezone.utc)
                .isoformat(timespec="seconds")
            )
            src["negative_count"] = int(src.get("negative_count") or 0) + 1
            transitions.append(
                f"{name}: reversal penalty -{NEGATIVE_FEEDBACK_PENALTY:.2f} "
                f"({prior_conf:.2f} -> {new_conf:.2f})"
            )
            # Preserve everything else — tick_count, signal_count,
            # low_confidence_streak, calibration_status all stay put.
            # The next normal tick will recompute the streak from the
            # new lower confidence and prune via the usual hysteresis.
            out.append(src)
            continue

        tick_count += 1
        if had_signal:
            signal_count += 1

        # 1. Pending → live | pruned at the calibration window boundary.
        if status == "pending" and tick_count >= CALIBRATION_TICK_WINDOW:
            if signal_count == 0:
                src["calibration_status"] = "pruned"
                src["tick_count"] = tick_count
                src["signal_count"] = signal_count
                # Confidence stays at its prior; we still record the
                # final value for audit completeness.
                src["confidence"] = round(prior_conf, 4)
                src["low_confidence_streak"] = low_streak
                transitions.append(
                    f"{name}: pending->pruned (0 signals in {tick_count} ticks)"
                )
                prune_events.append({
                    "source_name": name,
                    "reason": "no_signals_after_calibration",
                    "final_confidence": round(prior_conf, 4),
                    "ticks_observed": tick_count,
                    "total_signals": signal_count,
                })
                out.append(src)
                continue
            src["calibration_status"] = "live"
            transitions.append(
                f"{name}: pending->live ({signal_count}/{tick_count} ticks produced signals)"
            )
            status = "live"

        # 2. EMA update — applied to every non-pruned source on every
        #    tick where we have a contribution map (i.e. the LLM ran).
        #    When the no-signal gate skipped the LLM, contribs is empty
        #    and we leave confidence alone — that's correct: no new
        #    information should not move the EMA.
        if contribs:
            contribution = _coerce_float(contribs.get(name), 0.0)
            new_conf = EMA_DECAY * prior_conf + EMA_LIFT * contribution
            if new_conf < 0.0:
                new_conf = 0.0
            if new_conf > 1.0:
                new_conf = 1.0
            src["confidence"] = round(new_conf, 4)
        else:
            new_conf = prior_conf
            src["confidence"] = round(prior_conf, 4)

        # 3. Hysteresis: pinned sources (high confidence OR Sir-declared)
        #    have their low_confidence_streak held at 0. They re-enter
        #    normal scoring only after confidence drops below the
        #    hysteresis floor (PIN_HYSTERESIS_FLOOR=0.5).
        is_pinned_by_confidence = new_conf > PIN_CONFIDENCE_CEIL
        is_in_pin_hysteresis = (
            (new_conf > PIN_HYSTERESIS_FLOOR)
            and (prior_conf > PIN_CONFIDENCE_CEIL)
        )
        if manually_pinned or is_pinned_by_confidence or is_in_pin_hysteresis:
            low_streak = 0
        elif new_conf < PRUNE_CONFIDENCE_FLOOR:
            low_streak += 1
        else:
            low_streak = 0

        # 4. Live → pruned if the low-confidence streak meets the
        #    threshold AND the source isn't manually pinned.
        if (
            status == "live"
            and not manually_pinned
            and low_streak >= LOW_CONFIDENCE_PRUNE_TICKS
        ):
            src["calibration_status"] = "pruned"
            src["tick_count"] = tick_count
            src["signal_count"] = signal_count
            src["low_confidence_streak"] = low_streak
            transitions.append(
                f"{name}: live->pruned (confidence={new_conf:.2f} < "
                f"{PRUNE_CONFIDENCE_FLOOR} for {low_streak} ticks)"
            )
            prune_events.append({
                "source_name": name,
                "reason": "low_confidence",
                "final_confidence": round(new_conf, 4),
                "ticks_observed": tick_count,
                "total_signals": signal_count,
            })
            out.append(src)
            continue

        src["tick_count"] = tick_count
        src["signal_count"] = signal_count
        src["low_confidence_streak"] = low_streak
        out.append(src)

    return out, transitions, prune_events


# ---------------------------------------------------------------------------
# Phase 5: source-pruned audit emitter
# ---------------------------------------------------------------------------

async def _emit_source_pruned_audit(
    task_path: str,
    prune_event: dict[str, Any],
) -> Optional[str]:
    """Write one ``event/steward-source-pruned-<ts>.md`` vault record.

    Mirrors the ``event/steward-action-*.md`` emitter format so the
    dashboard's recent-actions endpoint can pick these up alongside
    state-change audits. Returns the written vault path on success,
    ``None`` if the write failed (logged + swallowed — a stuck audit
    emitter should never block the rest of the tick).
    """
    if not isinstance(prune_event, dict):
        return None
    name = str(prune_event.get("source_name") or "").strip()
    if not name:
        return None
    reason = str(prune_event.get("reason") or "low_confidence").strip()

    slug = _slug_from_task_path(task_path)
    canonical_task_path = f"task/{slug}.md" if slug else (task_path or "task/unknown.md")

    now = datetime.now(timezone.utc)
    ts_iso = now.isoformat(timespec="seconds")
    ts_filename = ts_iso.replace(":", "-").replace("+00-00", "Z")
    audit_name = (
        f"steward-source-pruned-{ts_filename}-"
        f"{_safe_filename_slug(slug or 'task')}-"
        f"{_safe_filename_slug(name)}"
    )

    payload: dict[str, Any] = {
        "type": "steward-source-pruned",
        "timestamp": ts_iso,
        "target": canonical_task_path,
        "source_name": name,
        "reason": reason,
        "final_confidence": float(prune_event.get("final_confidence") or 0.0),
        "ticks_observed": int(prune_event.get("ticks_observed") or 0),
        "total_signals": int(prune_event.get("total_signals") or 0),
    }

    # Render YAML inline — this record is simpler than steward-action
    # so the existing ``_render_audit_yaml`` (which encodes a fixed
    # SCALAR_ORDER) doesn't fit. We emit hand-formatted YAML 1.2 with
    # JSON-encoded scalars for safety.
    lines = []
    for key in (
        "type", "timestamp", "target", "source_name", "reason",
        "final_confidence", "ticks_observed", "total_signals",
    ):
        if key in payload:
            lines.append(f"{key}: {_yaml_scalar(payload[key])}")
    yaml_block = "\n".join(lines)

    narrative = (
        f"Steward pruned signal source `{name}` from `{canonical_task_path}` at "
        f"{ts_iso}. Reason: **{reason}**. "
        f"Final confidence: {payload['final_confidence']:.2f}. "
        f"Observed {payload['ticks_observed']} ticks producing "
        f"{payload['total_signals']} signals.\n\n"
        "The source has been marked `calibration_status: pruned` in the task's "
        "`signal_sources` frontmatter and will no longer contribute signals. "
        "If this prune was a mistake, revert it by editing the task and changing "
        "the source's `calibration_status` back to `live` (or `pending` to restart "
        "the calibration window)."
    )

    content = (
        "---\n"
        f"{yaml_block}\n"
        "---\n"
        "\n"
        f"# Steward source pruned: {name}\n"
        "\n"
        f"{narrative}\n"
    )

    cfg = load_config()
    payload["narrative"] = narrative
    try:
        # Audit-class record → state.db audit table, not the vault (a vault
        # write 422s under the promotion contract). Same routing as the main
        # steward-action audit.
        from src.utils.state_client import StateClient

        async with StateClient(cfg) as sc:
            written_path = await sc.append_audit(
                action_type="steward-source-pruned",
                actor="steward",
                summary=(
                    f"steward-source-pruned: {name} from "
                    f"{canonical_task_path} ({reason})"
                ),
                ts=ts_iso,
                target_path=canonical_task_path,
                target_kind="task",
                payload=payload,
            )
        logger.info(
            "steward.source_pruned: task=%s source=%s reason=%s -> %s",
            canonical_task_path, name, reason, written_path,
        )
        return written_path
    except httpx.HTTPError as exc:
        logger.warning(
            "steward.source_pruned: write failed task=%s source=%s err=%s",
            canonical_task_path, name, exc,
        )
        return None
    # NOTE: intentionally NO finally-block closing a VaultClient here — this
    # function never opens one (it writes the audit via
    # `async with StateClient(cfg) as sc`, which closes itself). A leftover
    # finally that closed an undefined `client` raised NameError on EVERY
    # source-prune: the audit row landed, the activity then failed in the
    # finally, Temporal retried, and a duplicate audit landed each retry — the
    # cause of the steward NameError storm and the runaway steward-source-pruned
    # audit-row count.


def _get_no_signal_streak(fm: dict[str, Any]) -> int:
    """Read the no-signal streak from frontmatter. Defaults to 0 when
    missing or malformed. Capped at a sane upper bound so a corrupt
    counter can't drive cadence past the 24h LAYER_3_MAX_INTERVAL.
    """
    raw = fm.get("steward_no_signal_streak", 0)
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return 0
    if v < 0:
        return 0
    if v > 100:
        return 100
    return v


def _surface_class(fm: dict[str, Any]) -> str:
    """Pull surface_class with a sensible default of 'normal'."""
    sc = fm.get("surface_class")
    if isinstance(sc, str) and sc.strip():
        return sc.strip().lower()
    return "normal"


@activity.defn
async def evaluate_task(task_id: str, task_data: dict[str, Any]) -> dict[str, Any]:
    """Phase 1 evaluator — real signal gathering + shadow LLM evaluation.

    Pipeline:
      1. Resolve the task's signal sources from frontmatter.
      2. Gather signals from every supported source (Phase 1: vault:record only).
      3. No-signal gate: if zero signals AND surface_class != "high",
         skip the LLM entirely and return ``still_active`` at full
         confidence — the cheapest possible outcome. Surface=high tasks
         always evaluate because they ride the briefing.
      4. Run ``evaluate_state`` (single shadow LLM call).
      5. Patch the task's frontmatter with last_steward_check_at,
         last_steward_outcome, next_check_after, calibration updates,
         no-signal-streak counter.
      6. Call ``apply_state_change(mode="shadow")`` to write the audit
         record.

    Returns the decision dict — the workflow forwards it to
    ``record_steward_check`` as before so Phase 0 callers keep working.
    The decision dict is augmented with a ``signals_summary`` key that
    Phase 5 ranking will use to compute relevance scores.
    """
    if not task_id:
        logger.warning("steward.evaluate: empty task_id — skipping")
        return {
            "decision": "still_active",
            "confidence": 1.0,
            "evidence": [],
            "reasoning": "empty task_id",
            "source_contributions": {},
        }

    task_data = task_data or {}
    fm = task_data.get("frontmatter") or {}
    if not isinstance(fm, dict):
        fm = {}
    task_path = task_data.get("path") or f"task/{task_id}.md"
    surface_class = _surface_class(fm)
    state = str(fm.get("state") or "open")
    snooze_until = fm.get("snoozed_until") or fm.get("snooze_until")
    due_at = fm.get("due_at") or fm.get("due")
    last_check = fm.get("last_steward_check_at") or ""
    sources_in = fm.get("signal_sources") or []
    if isinstance(sources_in, str):
        # patch_frontmatter stringifies — round-trip via JSON.
        # Tolerate single-quoted Python repr too (legacy migrate output).
        try:
            sources_in = json.loads(sources_in)
        except json.JSONDecodeError:
            try:
                import ast as _ast
                sources_in = _ast.literal_eval(sources_in)
            except (ValueError, SyntaxError):
                sources_in = []
    if not isinstance(sources_in, list):
        sources_in = []
    is_warm = bool(fm.get("last_steward_outcome"))

    # 1. Bucket sources by gatherer kind (vault:record / gmail: / sure: /
    #    ctrl-api:stream:). Pruned sources skipped cheaply — they failed
    #    calibration in a prior tick (Phase 5 hard-deletes them).
    vault_record_sources: list[dict[str, Any]] = []
    gmail_sources: list[dict[str, Any]] = []
    sure_sources: list[dict[str, Any]] = []
    ctrl_api_stream_sources: list[dict[str, Any]] = []
    for s in sources_in:
        if not isinstance(s, dict):
            continue
        name = str(s.get("name") or "").strip()
        status = str(s.get("calibration_status") or "pending").strip().lower()
        if status == "pruned":
            continue
        if name.startswith("vault:record:") or name == "vault:record":
            vault_record_sources.append(s)
        elif name.startswith("gmail:"):
            gmail_sources.append(s)
        elif name.startswith("sure:"):
            sure_sources.append(s)
        elif name.startswith("ctrl-api:stream:"):
            ctrl_api_stream_sources.append(s)

    signals: list[dict[str, Any]] = []
    snapshots_path = ""

    async def _run_gatherer(
        label: str,
        fn,
        bucket: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Run a gather_* activity defensively — never let one source
        kind starve the others. The function is the bare ``@activity.defn``
        callable; we invoke it directly because we're already inside an
        activity (Temporal has no nested-activity contract here).
        """
        if not bucket:
            return {"signals": [], "snapshots_path": "", "evaluated_sources": []}
        try:
            return await fn(task_path, bucket, last_check or "")
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "steward.evaluate: %s failed task=%s err=%s",
                label, task_id, exc,
            )
            return {"signals": [], "snapshots_path": "", "evaluated_sources": []}

    # Phase 6 (T6.2.3): unified signal-layer gather reads vault/signal/*.md
    # filtered by target_path. That alone is INSUFFICIENT for closure
    # detection: when Sir pays a bill out-of-band (SEPA, in person), the
    # only trace is a Sure transaction or vault edit that no upstream
    # signal_extract pass would observe. So we run BOTH paths now:
    #
    #   1. Unified gather (Phase 6.2)     — vault/signal/*.md targeting this task
    #   2. Legacy per-source gather (this) — actively polls Sure / Gmail / etc.
    #                                        using predicates declared in the
    #                                        task's signal_sources frontmatter
    #
    # Auto-tasks created by signal_extract now ship with synthesized
    # `signal_sources` predicates (see task_creation._synthesize_closure_
    # predicates), so this path actually fires for them. Sir-created
    # tasks with explicit predicates also benefit.
    #
    # Env knobs:
    #   STEWARD_USE_LEGACY_GATHER=true     — exclusive legacy mode
    #                                        (emergency rollback, Phase 6.2 era)
    #   STEWARD_LEGACY_GATHER_ADDITIVE=true (default) — additive: run BOTH
    #   STEWARD_LEGACY_GATHER_ADDITIVE=false           — disable legacy entirely
    import os as _os  # local import — keep evaluate_task's top-level imports tight

    use_legacy = _os.environ.get("STEWARD_USE_LEGACY_GATHER", "").lower() in ("true", "1", "yes")
    additive_legacy = _os.environ.get(
        "STEWARD_LEGACY_GATHER_ADDITIVE", "true"
    ).lower() in ("true", "1", "yes")

    async def _run_legacy_gatherers() -> None:
        """Run the four per-source legacy gatherers, appending to signals."""
        nonlocal snapshots_path
        if vault_record_sources:
            g = await _run_gatherer(
                "gather_signals_vault_record",
                gather_signals_vault_record,
                vault_record_sources,
            )
            signals.extend(g.get("signals") or [])
            snapshots_path = g.get("snapshots_path") or snapshots_path

        if gmail_sources:
            g = await _run_gatherer(
                "gather_signals_gmail",
                gather_signals_gmail,
                gmail_sources,
            )
            signals.extend(g.get("signals") or [])

        if sure_sources:
            g = await _run_gatherer(
                "gather_signals_sure",
                gather_signals_sure,
                sure_sources,
            )
            signals.extend(g.get("signals") or [])

        if ctrl_api_stream_sources:
            g = await _run_gatherer(
                "gather_signals_ctrl_api_stream",
                gather_signals_ctrl_api_stream,
                ctrl_api_stream_sources,
            )
            signals.extend(g.get("signals") or [])

    if use_legacy:
        # === Legacy-only path (emergency rollback) ===
        await _run_legacy_gatherers()
        if not (vault_record_sources or gmail_sources or sure_sources or ctrl_api_stream_sources):
            logger.info(
                "steward.evaluate: task=%s has no recognised signal sources — skipping gather",
                task_id,
            )
    else:
        # === Phase 6 unified path (default) ===
        # Single ctrl-api call reads /vault/signal/*.md filtered by target_path.
        # All sources surface uniformly — gmail, slack, omi, openclaw-chat,
        # vexa, sure, gcal, etc. — because Phase 6.0's signal extractor
        # already classified them. Steward no longer needs source-by-source
        # awareness here.
        from src.activities.signal_gather import gather_signals as _signal_gather
        try:
            # Note: this is the WORKFLOW activity, called via execute_activity
            # in workflow context. Inside evaluate_task we're already in
            # activity context (evaluate_task is itself @activity.defn) so
            # we can call gather_signals directly as a Python function — but
            # gather_signals is also @activity.defn, which means it has
            # special framing for retries/timeouts when called via Temporal.
            # Direct invocation is fine here since we're already inside an
            # activity (Temporal nesting is supported), and we want the
            # exception path to be the same as the legacy gather.
            gather_result = await _signal_gather(
                task_path=task_path,
                since=last_check or None,
                limit=50,
            )
            signals.extend(gather_result.get("signals") or [])
            # snapshots_path stays "" — signal layer doesn't use per-task
            # snapshot files (signal records are themselves the persistent
            # snapshot).
            evaluated_sources = gather_result.get("evaluated_sources") or []
            if not signals and not evaluated_sources:
                # No signals at all means either nothing has happened OR
                # legacy sources still firing through the old streams
                # haven't been consumed yet. Either way, no-signal-gate
                # below handles it correctly.
                logger.info("steward.evaluate: task=%s no signals (unified gather)", task_id)
            else:
                logger.info(
                    "steward.evaluate: task=%s gathered=%d sources=%s (unified)",
                    task_id, len(signals), evaluated_sources,
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "steward.evaluate: gather_signals (unified) failed task=%s err=%s",
                task_id, exc,
            )
            # Fail-open: empty signals → no-signal-gate engages → low-cost tick.

        # Additive legacy path: when the task has Sure/Gmail/etc.
        # predicates in signal_sources, ALSO actively poll those sources.
        # This is the closure-evidence path: bills paid out-of-band leave
        # only a Sure transaction trace; the unified path won't see it
        # because no signal_extract upstream observed it.
        if additive_legacy and (
            vault_record_sources or gmail_sources or sure_sources or ctrl_api_stream_sources
        ):
            try:
                signals_before = len(signals)
                await _run_legacy_gatherers()
                added = len(signals) - signals_before
                if added:
                    logger.info(
                        "steward.evaluate: task=%s legacy-additive gather added=%d "
                        "(predicates: vault=%d gmail=%d sure=%d ctrl=%d)",
                        task_id, added,
                        len(vault_record_sources),
                        len(gmail_sources),
                        len(sure_sources),
                        len(ctrl_api_stream_sources),
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "steward.evaluate: additive legacy gather failed task=%s err=%s",
                    task_id, exc,
                )

    has_signals = len(signals) > 0
    no_signal_streak = _get_no_signal_streak(fm)

    # 2. No-signal gate.
    decision: dict[str, Any]
    rate_guarded = False
    if not has_signals and surface_class != "high":
        decision = {
            "decision": "still_active",
            "confidence": 1.0,
            "evidence": [],
            "reasoning": "no new signals since last check; default to still_active without invoking LLM",
            "source_contributions": {},
            "no_signal_skip": True,
        }
        no_signal_streak += 1
        logger.info(
            "steward.evaluate: task=%s no-signal-gate triggered (streak=%d, surface=%s) — skipped LLM",
            task_id, no_signal_streak, surface_class,
        )
    else:
        # 3. Phase 5 (#841): rate-guard check BEFORE invoking the LLM.
        # The guard tracks per-tenant rolling counters + per-task and
        # per-matter daily caps + provider 429 backoff. When any cap is
        # hit, ``check_and_reserve`` returns False and we land a
        # low-confidence "rate_guarded" decision so Phase 3's confidence
        # threshold gates it out of any auto-action — nothing happens
        # this tick, the next tick will retry once the rolling window
        # clears.
        from src.activities.rate_guard import (  # local import — avoid
            get_rate_guard,                       # touching workflow paths
            parse_retry_after_from_exc,
        )

        parent_matter_path = _resolve_parent_matter(fm) or "matter/inbox.md"
        rate_guard = get_rate_guard()
        rate_decision = await rate_guard.check_and_reserve(
            task_path=task_path,
            matter_path=parent_matter_path,
        )

        if not rate_decision.allowed:
            # Stream the cap-skip for dashboard observability and land
            # a low-confidence decision. We DO NOT bump no_signal_streak
            # here — the signals existed, we just didn't get to evaluate
            # them. Next tick will pick them up via the snapshot diff.
            await rate_guard.record_cap_skip(
                task_path=task_path,
                matter_path=parent_matter_path,
                cap=rate_decision.cap,
            )
            decision = {
                "decision": "still_active",
                "confidence": LLM_FALLBACK_CONFIDENCE,
                "evidence": [],
                "reasoning": (
                    f"rate-guard blocked dispatch: {rate_decision.reason}. "
                    "Signals will be re-evaluated on the next tick."
                ),
                "source_contributions": {},
                "rate_guarded": True,
                "rate_guard_cap": rate_decision.cap,
                "rate_guard_counts": rate_decision.counts,
            }
            rate_guarded = True
            logger.warning(
                "steward.evaluate: task=%s rate-guarded cap=%s reason=%s — skipped LLM",
                task_id, rate_decision.cap, rate_decision.reason,
            )
            # Don't reset / advance no_signal_streak — this tick was a
            # dispatch failure, not a real "no signals" outcome.
        else:
            # 3b. Shadow LLM evaluation. ``surface_class=high`` tasks
            # evaluate even without signals (briefing freshness req).
            try:
                decision = await evaluate_state(
                    task_path,
                    fm,
                    signals,
                    is_warm,
                )
            except Exception as exc:  # noqa: BLE001
                # Detect 429 from the upstream provider (clerk wraps
                # these in RuntimeError). When we see one, hand the
                # Retry-After to the rate-guard so subsequent ticks
                # back off — and land a fallback decision so the
                # current tick advances cursors cleanly.
                retry_after = parse_retry_after_from_exc(exc)
                if retry_after is not None:
                    await rate_guard.record_429(retry_after or 60)
                    logger.warning(
                        "steward.evaluate: task=%s 429 from provider — backoff registered (retry_after=%ds)",
                        task_id, retry_after or 60,
                    )
                else:
                    logger.warning(
                        "steward.evaluate: task=%s evaluate_state raised %s — landing fallback decision",
                        task_id, exc,
                    )
                decision = {
                    "decision": "still_active",
                    "confidence": LLM_FALLBACK_CONFIDENCE,
                    "evidence": [],
                    "reasoning": f"evaluate_state failed: {exc}"[:500],
                    "source_contributions": {},
                    "fallback": True,
                }
            if has_signals:
                no_signal_streak = 0
            else:
                no_signal_streak += 1

    # 4. Calibration: walk every source (not just vault_record_sources)
    # so we don't lose any source dicts the user has dropped in for
    # future Phase 2 source kinds. Phase 5 (#841): pass through the
    # per-source contribution scores from the LLM so the EMA + hysteresis
    # logic can update each source's confidence.
    signal_source_names = {s.get("source", "") for s in signals if isinstance(s, dict)}
    raw_contribs = decision.get("source_contributions") or {}
    if not isinstance(raw_contribs, dict):
        raw_contribs = {}
    # Skip EMA when the LLM didn't actually run (no-signal gate, rate-
    # guard skip). An empty dict here tells _update_calibration to leave
    # confidence values alone — see its docstring.
    contribs_for_ema: dict[str, float] = {}
    if not decision.get("no_signal_skip") and not rate_guarded:
        for k, v in raw_contribs.items():
            contribs_for_ema[str(k)] = _coerce_float(v, 0.0)

    updated_sources, transitions, prune_events = _update_calibration(
        sources_in,
        signal_source_names,
        source_contributions=contribs_for_ema,
    )
    if transitions:
        logger.info(
            "steward.evaluate: task=%s calibration transitions: %s",
            task_id, "; ".join(transitions),
        )

    # 4b. Phase 5: emit one ``event/steward-source-pruned-*.md`` audit
    # record per source pruned this tick. Best-effort — failures are
    # logged inside the emitter and never block the rest of the tick.
    pruned_audit_paths: list[str] = []
    for prune_event in prune_events:
        written = await _emit_source_pruned_audit(task_path, prune_event)
        if written:
            pruned_audit_paths.append(written)

    # 5. Compose signals_summary for the audit record.
    all_evaluated_names = (
        [str(s.get("name") or "") for s in vault_record_sources]
        + [str(s.get("name") or "") for s in gmail_sources]
        + [str(s.get("name") or "") for s in sure_sources]
        + [str(s.get("name") or "") for s in ctrl_api_stream_sources]
    )
    signals_summary: dict[str, Any] = {
        "count": len(signals),
        "sources": sorted(set(signal_source_names)),
        "evaluated_sources": all_evaluated_names,
        "snapshots_path": snapshots_path,
        "no_signal_streak": no_signal_streak,
        "surface_class": surface_class,
        "calibration_transitions": transitions,
        # Phase 5 (#841): expose prune + rate-guard outcomes so the
        # dashboard's recent-actions endpoint and the briefing-cache
        # reader can surface them without a second walk.
        "pruned_sources": prune_events,
        "pruned_audit_paths": pruned_audit_paths,
        "rate_guarded": rate_guarded,
    }

    # 6. Compute next_check_after via the cadence helper.
    now = datetime.now(timezone.utc)
    next_check = _next_check_after(
        state=state,
        surface_class=surface_class,
        has_signals=has_signals,
        no_signal_streak=no_signal_streak,
        snooze_until=str(snooze_until) if snooze_until else None,
        due_at=str(due_at) if due_at else None,
        now=now,
    )
    next_check_iso = next_check.isoformat(timespec="seconds")
    now_iso = now.isoformat(timespec="seconds")

    # 7. Patch task frontmatter — last_steward_check_at, the outcome,
    # next_check_after (overrides the Phase 0 default written by
    # ``record_steward_check``), updated source list, no-signal streak.
    last_outcome_payload = {
        "decision": decision.get("decision"),
        "confidence": decision.get("confidence"),
        "reasoning": decision.get("reasoning"),
        "evidence": decision.get("evidence", []),
        "source_contributions": decision.get("source_contributions", {}),
        "evaluated_at": now_iso,
        "no_signal_skip": bool(decision.get("no_signal_skip", False)),
        "fallback": bool(decision.get("fallback", False)),
    }

    # Phase 2 (#838) uses ctrl-api's json_set body so structured
    # frontmatter (signal_sources list, last_steward_outcome dict)
    # round-trips with native shape. Scalars still go through the CLI
    # `--set` path for the alfred-CLI's schema validation.
    scalar_updates: dict[str, Any] = {
        "last_steward_check_at": now_iso,
        "next_check_after": next_check_iso,
        "steward_no_signal_streak": str(no_signal_streak),
    }
    json_updates: dict[str, Any] = {
        "last_steward_outcome": last_outcome_payload,
        "signal_sources": updated_sources,
    }

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        try:
            await client.patch_frontmatter_structured(
                task_path,
                scalar_updates=scalar_updates,
                json_updates=json_updates,
            )
        except httpx.HTTPError as exc:
            logger.warning(
                "steward.evaluate: patch_frontmatter_structured failed task=%s err=%s — falling back to scalar PATCH",
                task_id, exc,
            )
            # Fallback to scalar-only PATCH so the cursor still advances
            # even if json_set isn't available on this tenant's ctrl-api
            # (e.g. during a partial Phase 2 rollout). Structured fields
            # become repr strings — the Phase 1 read-side fallback in
            # evaluate_task already tolerates that shape.
            try:
                fm_updates = dict(scalar_updates)
                fm_updates["last_steward_outcome"] = json.dumps(
                    last_outcome_payload, ensure_ascii=False, default=str,
                )
                fm_updates["signal_sources"] = json.dumps(
                    updated_sources, ensure_ascii=False, default=str,
                )
                await client.patch_frontmatter(task_path, fm_updates)
            except httpx.HTTPError as exc2:
                logger.warning(
                    "steward.evaluate: scalar fallback PATCH also failed task=%s err=%s",
                    task_id, exc2,
                )
            # Continue to apply_state_change — the audit record is the
            # source of truth in shadow mode.
    finally:
        await client.close()

    # 8. Audit trail (Phase 0.5 emitter, mode=shadow).
    #
    # #378: shadow is HARDCODED here by design — this per-task sweep only
    # ever emits audit rows and deliberately ignores the
    # `state_mutator_mode` setting (the /study toggle does not cover it).
    # See docs/STATE-MUTATION.md §18 before "fixing" this.
    try:
        await apply_state_change(
            task_path,
            decision,
            signals_summary,
            mode="shadow",
        )
    except Exception as exc:  # noqa: BLE001
        # Never let a stuck audit emitter break the workflow — we'll
        # have logged it and the next tick can retry. The decision is
        # still returned to the workflow.
        logger.warning(
            "steward.evaluate: apply_state_change failed task=%s err=%s",
            task_id, exc,
        )

    decision["signals_summary"] = signals_summary
    # Surface the cadence-aware next_check stamp so ``record_steward_check``
    # can honor it instead of clobbering the value with the Phase 0 default
    # (which always wrote ``now + 30 min`` regardless of state). The
    # workflow signature stays unchanged — outcome is just a richer dict
    # now.
    decision["next_check_after"] = next_check_iso
    decision["last_steward_check_at"] = now_iso
    logger.info(
        "steward.evaluate: task=%s decision=%s confidence=%.2f signals=%d streak=%d next=%s",
        task_id,
        decision.get("decision"),
        float(decision.get("confidence") or 0.0),
        len(signals),
        no_signal_streak,
        next_check_iso,
    )
    return decision


# ---------------------------------------------------------------------------
# Activity: record_steward_check
# ---------------------------------------------------------------------------

@activity.defn
async def record_steward_check(task_id: str, outcome: dict[str, Any]) -> None:
    """Stamp ``last_steward_check_at`` + ``next_check_after`` onto the task.

    Phase 0 always rolled the next check to ``now + 30 min``. Phase 1
    (#837) honors the cadence-aware stamps that ``evaluate_task`` already
    surfaces in ``outcome["next_check_after"]`` /
    ``outcome["last_steward_check_at"]``. If those keys are missing
    (no-op evaluator, malformed outcome), we fall back to the Phase 0
    default so a callsite that pre-dates Phase 1 still gets a sane
    cursor advance — this preserves Temporal-history determinism for
    in-flight workflows and keeps the activity signature stable.

    Note that ``evaluate_task`` already writes these same fields plus
    ``last_steward_outcome`` and the calibration-state mirror via
    ``patch_frontmatter`` before returning. This activity now mostly
    serves as the cursor-advance backstop for the legacy code path —
    in steady-state Phase 1 it idempotently rewrites the same values
    ``evaluate_task`` already set, which is harmless.

    Vault writes go through ctrl-api PATCH per the alfred-learn hard
    rule. Frontmatter values are stringified by ``patch_frontmatter``.
    """
    if not task_id:
        logger.warning("steward.record_check: empty task_id — skipping")
        return

    path = f"task/{task_id}.md" if not task_id.endswith(".md") else task_id
    if not path.startswith("task/"):
        path = f"task/{path}"

    decision = ""
    next_check_iso = ""
    last_check_iso = ""
    if isinstance(outcome, dict):
        decision = str(outcome.get("decision") or "")
        nc = outcome.get("next_check_after")
        if isinstance(nc, str) and nc.strip():
            next_check_iso = nc.strip()
        lc = outcome.get("last_steward_check_at")
        if isinstance(lc, str) and lc.strip():
            last_check_iso = lc.strip()

    updates: dict[str, Any] = {
        "last_steward_check_at": last_check_iso or _now_utc_iso(),
        "next_check_after": next_check_iso or _next_check_iso(),
    }

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        await client.patch_frontmatter(path, updates)
        logger.info(
            "steward.record_check: task=%s decision=%s next_check=%s",
            task_id, decision or "noop", updates["next_check_after"],
        )
    except httpx.HTTPError as exc:
        logger.error(
            "steward.record_check: PATCH %s failed: %s", path, exc,
        )
        raise
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Activity: apply_state_change (Phase 0.5 — audit-trail emitter)
# ---------------------------------------------------------------------------

# Window after which an audit record's undo recipe is no longer honored.
# Mirrors the 7-day hard-delete-of-undo policy in the Steward RFC §6.
STEWARD_UNDO_WINDOW = timedelta(days=7)


# ---------------------------------------------------------------------------
# Phase 3 (#839): live-mode cutover knobs
# ---------------------------------------------------------------------------
#
# Three env-controlled knobs let Sir flip between shadow and live without
# a code redeploy:
#
# * ``STEWARD_LIVE_MODE`` — caller-override gate. Even when
#   ``apply_state_change(mode="live")`` is requested the function will
#   downgrade to shadow if this env var is anything other than ``live``
#   or ``live_high_confidence_only``. Default ships as ``shadow`` so a
#   Phase 3 deploy doesn't auto-cut-over.
#
#     - ``shadow`` — always run shadow, ignore caller's mode.
#     - ``live`` — honor caller's mode; live actions fire whenever
#       ``confidence >= STEWARD_CONFIDENCE_THRESHOLD``.
#     - ``live_high_confidence_only`` — honor caller's mode but only fire
#       Plane writes when ``confidence >= STEWARD_HIGH_CONFIDENCE_THRESHOLD``;
#       lower-confidence decisions land as ``pending_confirmation: true``
#       on the vault task without touching Plane.
#
# * ``STEWARD_CONFIDENCE_THRESHOLD`` — gate for live actions in
#   ``live`` mode. Decisions with confidence < this value land as
#   ``pending_confirmation: true`` and skip the Plane write. Default
#   0.6 per RFC #832 §6.
#
# * ``STEWARD_HIGH_CONFIDENCE_THRESHOLD`` — same gate for
#   ``live_high_confidence_only`` mode. Default 0.85.
#
# All env reads happen inside the activity (env reads are not workflow-
# safe). We read them per-invocation so a flip via systemd reload takes
# effect on the next tick without a worker restart.

STEWARD_LIVE_MODE_ENV = "STEWARD_LIVE_MODE"
STEWARD_CONFIDENCE_THRESHOLD_ENV = "STEWARD_CONFIDENCE_THRESHOLD"
STEWARD_HIGH_CONFIDENCE_THRESHOLD_ENV = "STEWARD_HIGH_CONFIDENCE_THRESHOLD"

DEFAULT_STEWARD_CONFIDENCE_THRESHOLD = 0.6
DEFAULT_STEWARD_HIGH_CONFIDENCE_THRESHOLD = 0.85


def _resolve_steward_live_mode() -> str:
    """Return the effective live-mode setting from the environment.

    One of: ``"shadow"``, ``"live"``, ``"live_high_confidence_only"``.
    Anything unrecognised falls back to ``"shadow"`` — when in doubt,
    don't act.
    """
    raw = (os.environ.get(STEWARD_LIVE_MODE_ENV) or "shadow").strip().lower()
    if raw in ("shadow", "live", "live_high_confidence_only"):
        return raw
    logger.warning(
        "steward.apply_state_change: unrecognised %s=%s — defaulting to shadow",
        STEWARD_LIVE_MODE_ENV, raw,
    )
    return "shadow"


def _resolve_confidence_threshold(env_name: str, default: float) -> float:
    raw = (os.environ.get(env_name) or "").strip()
    if not raw:
        return default
    try:
        v = float(raw)
    except ValueError:
        logger.warning(
            "steward.apply_state_change: %s=%s is not a number — using default %.2f",
            env_name, raw, default,
        )
        return default
    if not 0.0 <= v <= 1.0:
        logger.warning(
            "steward.apply_state_change: %s=%.2f out of range — clamping to default %.2f",
            env_name, v, default,
        )
        return default
    return v


# Mapping decision → Plane state group for the auto-transition. Matters
# the per-tenant Plane workspace creates the canonical 5 groups
# (backlog / unstarted / started / completed / cancelled) on every
# project, so every tenant has a state in each group regardless of
# custom workflow naming.
DECISION_TO_PLANE_STATE_GROUP: dict[str, str] = {
    "likely_done": "completed",
    # "stale_archive_candidate" is handled via the archived flag rather
    # than a state transition — Plane has no first-class "archived" state
    # group, just an issue-level archived flag (see ctrl-api
    # `postStewardAction`).
}

# Decisions that imply Plane should also archive the issue. Steward
# uses this for matters/tasks Sir hasn't engaged with in months.
DECISION_TO_PLANE_ARCHIVE: set[str] = {"stale_archive_candidate"}

# Dispatch signal kind emitted on related_to tasks after a live action.
STEWARD_DEPENDENCY_SIGNAL_KIND = "steward:dependency_change"

# Phase B (#890) — matter-context cascade. When a matter's state mutates
# we fan a signal out to every task whose ``parent_matter`` points at
# this matter so the next Steward tick re-evaluates them in light of the
# matter's new context. Kind is parallel to ``steward:dependency_change``
# (related_to peer-task fan-out) but the fan-out target list is computed
# from ``parent_matter`` pointers at call time, not from a static
# ``related_to`` list.
STEWARD_MATTER_CONTEXT_SIGNAL_KIND = "steward:matter_context_changed"


def _slug_from_task_path(task_path: str) -> str:
    """Extract the bare slug from a ``task/<slug>.md`` path.

    Accepts the same shape variants ``record_steward_check`` does so a
    caller can pass ``"foo"``, ``"task/foo"``, or ``"task/foo.md"`` and
    get back ``"foo"`` consistently.
    """
    s = (task_path or "").strip()
    if not s:
        return ""
    if s.endswith(".md"):
        s = s[:-3]
    if s.startswith("task/"):
        s = s[len("task/"):]
    return s


def _slug_from_matter_path(matter_path: str) -> str:
    """Extract the bare slug from a ``matter/<slug>.md`` path.

    Accepts ``"foo"``, ``"matter/foo"``, or ``"matter/foo.md"``.
    """
    s = (matter_path or "").strip()
    if not s:
        return ""
    if s.endswith(".md"):
        s = s[:-3]
    if s.startswith("matter/"):
        s = s[len("matter/"):]
    return s


def _safe_filename_slug(s: str) -> str:
    """Lowercase + hyphenate a slug so it survives as a filename component.

    Vault filenames are constrained by sanitizeFilename in the ctrl-api;
    we narrow further here so steward audit records sit cleanly in
    ``event/`` even when the task slug contains spaces, punctuation, or
    unicode characters.
    """
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9_-]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "task"


# ---------------------------------------------------------------------------
# RFC #884 — task.current_state composer
# ---------------------------------------------------------------------------

# Hard cap on the deterministic one-sentence ``current_state`` string
# stamped onto a task when Steward transitions its state. Matches the
# spec's 200-char limit; sliced AFTER composition so a chatty reasoning
# field doesn't blow out the frontmatter line.
CURRENT_STATE_CHAR_CAP = 200

# Pretty label for each terminal state. Keyed off the value Steward
# writes to ``state`` after a transition. Anything else falls back to
# the raw state string.
_STATE_LABEL: dict[str, str] = {
    "pending": "Pending",
    "in_progress": "In progress",
    "in-progress": "In progress",
    "done": "Done",
    "archived": "Archived",
    "open": "Open",
}


def _first_n_words(text: str, n: int = 12) -> str:
    """Return the first ``n`` whitespace-delimited words of ``text``.

    Newlines collapse to single spaces. Empty input returns an empty
    string so the caller can short-circuit gracefully.
    """
    if not text:
        return ""
    words = text.split()
    if not words:
        return ""
    return " ".join(words[:n])


def _compose_task_current_state(
    *,
    new_state: str,
    decision: dict[str, Any] | None,
    now_iso: str,
) -> str:
    """Compose the one-sentence ``task.current_state`` write.

    Deterministic — no LLM. Format examples (per RFC #884):

      * "In progress — Alfred picked up the Carter sprint deck from your
        inbox at 2026-05-11 09:14."
      * "Done — Example Co invoice settled on 2026-05-11."
      * "Pending — awaiting your nod on the unusual-route Bolt charge."

    We compose from:
      * the new task state (the label),
      * the triggering signal's ``action_proposal.what`` when present
        on the decision evidence,
      * else the first 12 words of ``decision.reasoning``,
      * the current date (YYYY-MM-DD) from ``now_iso``.

    Capped at 200 chars. The function never raises — missing inputs
    fall through to ``"<Label> — state updated on <date>."`` so the
    writeback can always proceed.
    """
    label = _STATE_LABEL.get((new_state or "").strip().lower(), str(new_state or "").strip().title() or "Updated")

    # Try the signal's action_proposal.what first — the cleanest source
    # when the upstream Steward orchestration handed us a structured
    # evidence list.
    what = ""
    if isinstance(decision, dict):
        evidence_list = decision.get("evidence")
        if isinstance(evidence_list, list):
            for item in evidence_list:
                if not isinstance(item, dict):
                    continue
                proposal = item.get("action_proposal")
                if isinstance(proposal, dict):
                    raw = proposal.get("what")
                    if isinstance(raw, str) and raw.strip():
                        what = raw.strip()
                        break

    if not what and isinstance(decision, dict):
        reasoning = decision.get("reasoning")
        if isinstance(reasoning, str) and reasoning.strip():
            what = _first_n_words(reasoning, 12)

    # Date slice: YYYY-MM-DD prefix of the ISO timestamp. Falling back
    # to "today" keeps the sentence well-formed when ``now_iso`` is
    # malformed (defensive — we always pass a parseable value).
    date_part = ""
    if isinstance(now_iso, str) and len(now_iso) >= 10:
        date_part = now_iso[:10]

    if what:
        # Strip trailing punctuation so the composed sentence doesn't
        # read ``today. on 2026-05-11`` when the reasoning already ended
        # with a period.
        what = what.rstrip(" .,;:")
        sentence = f"{label} — {what} on {date_part}." if date_part else f"{label} — {what}."
    elif date_part:
        sentence = f"{label} — state updated on {date_part}."
    else:
        sentence = f"{label} — state updated."

    # Hard cap. Slice at a word boundary when possible to avoid
    # mid-word truncation, falling back to a hard slice + ellipsis when
    # there's no clean break.
    if len(sentence) > CURRENT_STATE_CHAR_CAP:
        cut = sentence[:CURRENT_STATE_CHAR_CAP - 1]
        last_space = cut.rfind(" ")
        if last_space > CURRENT_STATE_CHAR_CAP // 2:
            sentence = cut[:last_space].rstrip(",;-") + "…"
        else:
            sentence = cut.rstrip(",;-") + "…"
    return sentence


def _yaml_scalar(v: Any) -> str:
    """Render ``v`` as a YAML 1.2 scalar suitable for inline use.

    Booleans, nulls, ints, and floats round-trip without quoting; strings
    are double-quoted with the bare minimum escaping (``"`` and ``\\``)
    so the audit record body parses cleanly through the same js-yaml
    loader the ctrl-api routes use.
    """
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v)
    escaped = s.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _render_audit_yaml(payload: dict[str, Any]) -> str:
    """Serialise the audit record's frontmatter via ``json.dumps`` + a
    YAML-compatible top-level wrapper.

    Strict YAML 1.2 is a superset of JSON for the structures we emit
    here (scalars, lists of dicts, nested dicts), so the simplest
    correct serialiser is ``json.dumps(..., indent=2)`` followed by a
    one-line header. We avoid pulling in a heavyweight YAML serialiser
    purely for this code path; pyyaml is available, but its
    ``default_flow_style=False`` output mixes block + flow notation in
    ways that complicate the round-trip through the parseFrontmatter
    contract on the read side. JSON-as-YAML is unambiguous.

    We DO emit a top-level scalar header (``type: steward-action``)
    rather than the JSON object form so MCP / dashboard frontmatter
    queries that look for top-level scalar fields keep working — the
    rest of the keys are serialised below as flow-style mappings.
    """
    # Top-level scalars first, in the canonical order the issue
    # specifies, so a casual ``head`` of the file reads naturally.
    # ``pending_confirmation``, ``partially_applied``, and
    # ``partially_applied_reason`` were added in #839 Phase 3 — kept
    # at the top so the dashboard's frontmatter scan reads them in one
    # pass alongside the other top-level fields.
    SCALAR_ORDER = (
        "type", "timestamp", "target", "decision", "confidence", "mode",
        "prior_state", "pending_confirmation", "partially_applied",
        "partially_applied_reason",
    )
    lines: list[str] = []
    for key in SCALAR_ORDER:
        if key in payload:
            lines.append(f"{key}: {_yaml_scalar(payload[key])}")
    # Then nested / list-shaped fields as JSON (valid YAML 1.2).
    NESTED_ORDER = (
        "evidence", "prior_frontmatter", "plane_action", "undo_recipe",
        "signals_summary",
    )
    for key in NESTED_ORDER:
        if key in payload:
            blob = json.dumps(payload[key], ensure_ascii=False, indent=2, default=str)
            # Re-indent so the YAML is human-friendly (block-quoted JSON
            # values still parse via js-yaml since `{}` and `[]` are
            # valid flow-style YAML).
            lines.append(f"{key}: {blob}")
    return "\n".join(lines)


def _summarize_evidence(evidence: list[Any]) -> str:
    """Build a one-line human-readable summary of an evidence list.

    Used by the narrative paragraph in the audit record body — keep
    this conservative, no Markdown formatting, since the same string
    flows into Plane comments in Phase 3.
    """
    if not evidence:
        return "no signals"
    parts: list[str] = []
    for e in evidence:
        if not isinstance(e, dict):
            parts.append(str(e))
            continue
        src = str(e.get("source") or "").strip()
        ref = str(e.get("ref") or "").strip()
        note = str(e.get("note") or "").strip()
        if src and ref:
            label = f"{src}:{ref}"
        elif src:
            label = src
        elif ref:
            label = ref
        else:
            label = "(unknown signal)"
        if note:
            label = f"{label} — {note}"
        parts.append(label)
    return "; ".join(parts)


async def _read_matter_plane_project_id(
    client: VaultClient, parent_matter: Optional[str]
) -> str:
    """Look up the parent matter's ``plane_project_id``.

    Returns the empty string if the matter is missing, has no
    ``plane_project_id``, or any read error occurs — callers that need
    a Plane action skip the call gracefully when the lookup fails.
    """
    if not parent_matter:
        return ""
    matter_path = _normalize_matter_id(parent_matter)
    if not matter_path:
        return ""
    try:
        rec = await client.read_record(matter_path)
    except httpx.HTTPStatusError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            return ""
        logger.warning(
            "steward.apply_state_change: matter read failed path=%s status=%s",
            matter_path,
            exc.response.status_code if exc.response is not None else "?",
        )
        return ""
    except (httpx.HTTPError, OSError) as exc:
        logger.warning(
            "steward.apply_state_change: matter read failed path=%s err=%s",
            matter_path, exc,
        )
        return ""
    fm = rec.get("frontmatter") or {}
    if not isinstance(fm, dict):
        return ""
    pid = fm.get("plane_project_id") or ""
    return str(pid).strip()


def _normalise_evidence_for_plane(
    evidence: list[Any],
) -> list[dict[str, Any]]:
    """Coerce the evidence list to ctrl-api's expected shape.

    Plane's auto-comment helper expects ``[{source, ref, note?}, ...]``;
    we tolerate string entries (older audit records) by promoting them
    to ``{"note": <str>}``.
    """
    out: list[dict[str, Any]] = []
    for e in evidence or []:
        if isinstance(e, dict):
            entry: dict[str, Any] = {}
            for k in ("source", "ref", "note"):
                v = e.get(k)
                if v is not None:
                    entry[k] = str(v)
            out.append(entry)
        elif isinstance(e, str):
            out.append({"note": e})
    return out


def _emit_steward_dependency_signals(
    cfg, source_task_path: str, related_to: list[Any], decision_label: str,
) -> int:
    """Append ``steward:dependency_change`` records to the steward
    signals JSONL stream — one per related task.

    The signals file at ``$ALFRED_DATA_DIR/streams/steward-signals.jsonl``
    is the same ledger ctrl-api appends ``vault:edit`` records to, and
    the same one ``gather_signals_ctrl_api_stream`` reads via the
    ``ctrl-api:stream:steward-signals`` source. Returns the count of
    records written so the audit trail can record fan-out width.

    Best-effort: if the directory or file isn't writable, log + return 0.
    The next regular Steward tick will pick up the changes from
    ``vault:edit`` signals anyway — this is a latency optimisation.
    """
    if not related_to:
        return 0
    streams_path = os.path.join(cfg.streams_dir, "steward-signals.jsonl")
    try:
        os.makedirs(os.path.dirname(streams_path), exist_ok=True)
    except OSError as exc:
        logger.warning(
            "steward.apply_state_change: cannot create streams dir path=%s err=%s",
            streams_path, exc,
        )
        return 0

    written = 0
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    try:
        with open(streams_path, "a", encoding="utf-8") as f:
            for ref in related_to:
                if not isinstance(ref, str):
                    continue
                ref_clean = ref.strip()
                if not ref_clean:
                    continue
                # Normalise: accept ``foo``, ``task/foo``, ``task/foo.md``.
                if not ref_clean.startswith("task/"):
                    ref_clean = f"task/{ref_clean}"
                if not ref_clean.endswith(".md"):
                    ref_clean = f"{ref_clean}.md"
                record = {
                    "id": f"evt_steward_dep_{int(time.time() * 1_000_000)}_{written}",
                    "ts": now_iso,
                    "kind": STEWARD_DEPENDENCY_SIGNAL_KIND,
                    "ref": f"vault:{ref_clean}",
                    "note": (
                        f"related task changed: {source_task_path} -> {decision_label}"
                    ),
                    "source_task": source_task_path,
                }
                f.write(json.dumps(record) + "\n")
                written += 1
    except OSError as exc:
        logger.warning(
            "steward.apply_state_change: dependency-signal write failed path=%s err=%s",
            streams_path, exc,
        )
        return 0

    if written:
        logger.info(
            "steward.apply_state_change: emitted %d dependency-change signals from %s",
            written, source_task_path,
        )
    return written


async def _emit_matter_context_signals(
    cfg, matter_path: str, decision_label: str, client: "VaultClient",
) -> int:
    """W2 matter-context cascade — append ``steward:matter_context_changed``
    records to the steward-signals JSONL stream, one per child task whose
    ``parent_matter`` points at ``matter_path``.

    Resolves children by listing ``task/*`` records via ctrl-api and
    filtering on ``parent_matter``. Failure to enumerate (list_records
    HTTP error) returns 0 — the next Steward tick will pick up the
    matter's state change anyway via ``vault:edit`` signals.

    Symmetric with ``_emit_steward_dependency_signals`` (related_to
    peer-task fan-out) so downstream consumers (signal_router,
    StewardWorkflow tick) can treat both signal kinds uniformly.
    """
    if not matter_path:
        return 0

    # Enumerate child tasks whose parent_matter points at this matter.
    # Best-effort: any failure (HTTP, OS, missing method on a stub
    # client) downgrades to "no cascade this tick" — the next Steward
    # tick will pick up the matter's state change via vault:edit signals
    # anyway, so this is a latency optimisation, not a correctness lever.
    try:
        task_records = await client.list_records("task", limit=10_000)
    except (httpx.HTTPError, OSError, AttributeError) as exc:
        logger.warning(
            "steward.apply_state_change: matter-cascade list failed matter=%s err=%s",
            matter_path, exc,
        )
        return 0

    child_task_paths: list[str] = []
    for rec in task_records:
        if not isinstance(rec, dict):
            continue
        fm = rec.get("frontmatter") or rec
        if not isinstance(fm, dict):
            fm = {}
        parent = _resolve_parent_matter(fm)
        if not parent:
            continue
        # Normalise both ends to canonical ``matter/<slug>.md``.
        parent_canon = parent if parent.startswith("matter/") else f"matter/{parent}"
        if not parent_canon.endswith(".md"):
            parent_canon = f"{parent_canon}.md"
        if parent_canon != matter_path:
            continue
        path = str(rec.get("path") or fm.get("path") or "").strip()
        if not path:
            slug = str(rec.get("slug") or fm.get("slug") or "").strip()
            if slug:
                path = f"task/{slug}.md"
        if path:
            if not path.startswith("task/"):
                path = f"task/{path.lstrip('/')}"
            if not path.endswith(".md"):
                path = f"{path}.md"
            child_task_paths.append(path)

    if not child_task_paths:
        return 0

    streams_path = os.path.join(cfg.streams_dir, "steward-signals.jsonl")
    try:
        os.makedirs(os.path.dirname(streams_path), exist_ok=True)
    except OSError as exc:
        logger.warning(
            "steward.apply_state_change: matter-cascade cannot create streams dir "
            "path=%s err=%s",
            streams_path, exc,
        )
        return 0

    written = 0
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    try:
        with open(streams_path, "a", encoding="utf-8") as f:
            for child in child_task_paths:
                record = {
                    "id": (
                        f"evt_steward_matter_ctx_"
                        f"{int(time.time() * 1_000_000)}_{written}"
                    ),
                    "ts": now_iso,
                    "kind": STEWARD_MATTER_CONTEXT_SIGNAL_KIND,
                    "ref": f"vault:{child}",
                    "note": (
                        f"parent matter changed: {matter_path} -> {decision_label}"
                    ),
                    "source_matter": matter_path,
                }
                f.write(json.dumps(record) + "\n")
                written += 1
    except OSError as exc:
        logger.warning(
            "steward.apply_state_change: matter-cascade write failed path=%s err=%s",
            streams_path, exc,
        )
        return 0

    if written:
        logger.info(
            "steward.apply_state_change: emitted %d matter-context-changed signals "
            "from %s",
            written, matter_path,
        )
    return written


# ---------------------------------------------------------------------------
# Phase B propose function — Steward decision → universal ProposedMutation
# ---------------------------------------------------------------------------


@propose_fn("steward.propose_state_change")
async def _propose_steward_state_change(
    *,
    target: dict[str, Any],
    observed: ObservedWindow,
    args: dict[str, Any],
) -> ProposedMutation | None:
    """Translate Steward's decision shape into a universal ProposedMutation.

    ``args`` carries the precomputed Steward decision: ``decision``,
    ``confidence``, ``reasoning``, ``effective_mode``, ``target_kind``,
    plus the resolved write intent (``new_lifecycle_state``,
    ``current_state_str``, ``pending_confirmation``, ``last_steward_outcome``,
    ``ts_iso``). Steward computes all of these in
    ``apply_state_change`` before delegating; we don't re-derive them
    inside the propose function so the universal audit and the legacy
    audit see byte-identical decision metadata.

    Returns ``None`` when there are no universal state fields to mutate
    — e.g. shadow mode without a current_state composition, or
    ``still_active`` / ``needs_input`` decisions whose only effect is
    clearing ``last_steward_check_at`` (NOT a state field).
    """
    decision_label = str(args.get("decision") or "noop")
    target_kind = str(args.get("target_kind") or "task")
    effective_mode = str(args.get("effective_mode") or "shadow")
    pending_confirmation = bool(args.get("pending_confirmation", False))
    new_lifecycle_state = args.get("new_lifecycle_state")  # str or None
    current_state_str = args.get("current_state_str")  # str or None
    last_steward_outcome = args.get("last_steward_outcome")  # dict or None
    ts_iso = str(args.get("ts_iso") or "")
    will_act = bool(args.get("will_act_on_plane", False))
    reasoning = str(args.get("reasoning") or "")

    fields: dict[str, Any] = {}

    # Universal state-field set Steward actually mutates per tick:
    # current_state, as_of, pending_confirmation, outcome,
    # last_steward_outcome, status (lifecycle). The legacy lifecycle
    # field ``state`` (and ``last_steward_check_at``) are NOT in the
    # universal contract — they continue to ride the legacy PATCH
    # path. Status mapping surfaces the lifecycle as ``status`` on the
    # universal envelope so downstream consumers (Desk timeline,
    # /decisions feed) see the transition without learning about
    # Steward's idiosyncratic ``state`` field name.
    #
    # Shadow mode emits NO state-field write — Steward's shadow
    # contract is "audit only, no mutation" and the universal v2
    # audit semantics under shadow are identical (ctrl-api skips the
    # frontmatter patch). For shadow ticks we return None so v2's
    # ctrl-api round-trip is skipped entirely; the legacy
    # ``event/steward-action-*.md`` audit lands by itself, which
    # already gives reviewers the proposed-but-not-applied view.
    if effective_mode != "live":
        return None

    if will_act and target_kind == "task":
        if new_lifecycle_state == "done":
            fields["status"] = "closed"
        elif new_lifecycle_state == "archived":
            fields["status"] = "archived"
    if current_state_str:
        fields["current_state"] = current_state_str
    # ``pending_confirmation: True`` IS a state transition (Steward is
    # flagging that Sir's review is needed). ``pending_confirmation:
    # False`` ALONE — i.e. without an accompanying lifecycle or
    # current_state shift — is a no-op stale-flag clear that we don't
    # surface on the universal timeline. The legacy
    # ``patch_frontmatter_structured`` path still clears the flag
    # via direct PATCH for those ticks.
    if pending_confirmation or "status" in fields or "current_state" in fields:
        fields["pending_confirmation"] = pending_confirmation
    if (
        target_kind == "task"
        and isinstance(last_steward_outcome, dict)
        and ("status" in fields or "current_state" in fields or pending_confirmation)
    ):
        fields["last_steward_outcome"] = last_steward_outcome
    # Only stamp ``as_of`` if there's a substantive state-field change
    # to anchor it to. Stamping as_of by itself moves the timeline
    # forward without any state actually changing — confuses readers
    # of the matter detail page who expect every as_of bump to
    # correspond to a real transition.
    if fields and ts_iso:
        fields["as_of"] = ts_iso

    # If there's nothing universal to write, return None so v2 skips
    # the ctrl-api round-trip entirely.
    if not fields:
        return None

    confidence = float(args.get("confidence") or 0.0)
    return ProposedMutation(
        fields=fields,
        reason=reasoning or f"Steward decision: {decision_label}",
        confidence=confidence,
        fan_out=tuple(args.get("fan_out") or ()),
    )


@activity.defn
async def apply_state_change(
    task_path: str,
    decision: dict[str, Any],
    signals_summary: dict[str, Any],
    mode: str = "shadow",
    target_kind: str = "task",
) -> dict[str, Any]:
    """Emit an audit-trail vault record for one Steward decision and,
    in live mode, mutate vault frontmatter + (for tasks only) post a
    Plane comment + transition the Plane issue's state.

    Target kinds
    ------------
    ``target_kind`` switches the activity between two paths:

    * ``"task"`` (default, legacy behavior) — full Plane fan-out plus
      vault frontmatter mutation. Backward compatible: callers that
      omit ``target_kind`` get the exact same behavior as before this
      parameter existed.
    * ``"matter"`` — vault frontmatter mutation only. Matters are not
      Plane projects, so the Plane comment + state-transition block is
      skipped entirely (``plane_action`` and
      ``undo_recipe.plane_revert`` are both ``None``). The
      dependency-signal fan-out across ``related_to`` is also skipped
      for matters in this phase — the matter-context-edit cascade
      (re-evaluate every task whose ``parent_matter`` points at this
      matter) is its own subsystem and is parked as a TODO.

    Despite the legacy parameter name, ``task_path`` carries the
    target's vault path; with ``target_kind='matter'`` it's a matter
    path (e.g. ``"matter/<slug>.md"``).

    Mode resolution
    ---------------
    The ``mode`` argument is the caller's INTENT; the env var
    ``STEWARD_LIVE_MODE`` is the OPERATOR's veto. We compose them:

    * ``mode="shadow"`` — always shadow regardless of env.
    * ``mode="live"`` + env ``shadow`` — downgraded to shadow.
    * ``mode="live"`` + env ``live`` — live, gated on
      ``confidence >= STEWARD_CONFIDENCE_THRESHOLD`` (default 0.6).
      Below the threshold lands as ``pending_confirmation: true`` on the
      vault task without touching Plane.
    * ``mode="live"`` + env ``live_high_confidence_only`` — live, gated
      on ``confidence >= STEWARD_HIGH_CONFIDENCE_THRESHOLD`` (default
      0.85). Below the threshold lands as ``pending_confirmation: true``.

    Live-mode action sequence (high-confidence path)
    -----------------------------------------------
      1. Read prior task frontmatter (state, last_steward_outcome,
         pending_confirmation, plane_issue_id, parent_matter).
      2. Resolve the parent matter's ``plane_project_id`` via vault read.
      3. POST the Plane comment + state transition through ctrl-api's
         ``/api/v1/plane/steward-action`` helper, which returns the
         ``comment_id``, ``prior_state_id``, and ``prior_archived``.
      4. PATCH the task frontmatter with the new state, the
         last_steward_outcome dict, and ``pending_confirmation: false``.
      5. Emit the ``event/steward-action-<ts>.md`` audit record with the
         full ``undo_recipe`` (vault_patch + plane_revert).
      6. For every entry in ``frontmatter.related_to``, append a
         ``steward:dependency_change`` signal to the steward-signals
         stream so the next Steward tick re-evaluates the related task.

    Returns::

        {
          "path":      "event/steward-action-<ts>-<slug>.md",
          "mode":      "shadow" | "live",
          "timestamp": "2026-05-04T12:34:56+00:00",
          "live_action_taken": bool,
          "pending_confirmation": bool,
          "dependency_signals_emitted": int,
        }

    Raises ``httpx.HTTPError`` if the AUDIT-RECORD vault write fails;
    Plane errors after the audit record is on disk are caught and
    surfaced via ``plane_action.partially_applied = true`` per the
    Phase 3 atomicity rule (don't roll back the vault — Plane is the
    lagging leaf, the dashboard surfaces partials for manual review).

    Phase B (#890) — state-mutation contract retrofit
    -------------------------------------------------
    The core state-field write (``current_state``, ``as_of``,
    ``pending_confirmation``, ``last_steward_outcome``, and — when the
    decision implies a lifecycle transition — ``status``) is delegated
    to ``state_mutator.apply_state_change_v2`` with
    ``source="steward.evaluate_task"``. v2 emits the universal
    ``event/state-change-*.md`` audit record AND appends a
    ``state_change`` entry to the target's ``timeline``.

    The legacy ``event/steward-action-*.md`` audit + the legacy
    frontmatter PATCH continue to fire alongside v2. Choice (a) from
    spec §12 Phase B: most-conservative path that preserves the many
    existing consumers of the Steward-specific audit shape
    (``ctrl-api/routes/steward.ts`` undo/confirm/dismiss flow,
    ``calibration_reversal.py``, ``briefing_cache.py``,
    ``migrate_to_stream_event.py``). When Phase G flips
    ``STATE_CHANGE_ENFORCEMENT=reject``, the legacy direct PATCH will
    have to be removed; until then the duplicate writes are intentional
    and harmless.

    v2 errors (network failure, optimistic-concurrency contention,
    unexpected exceptions) are caught and downgraded to a warning —
    the legacy code path always runs so a v2 outage never starves
    Steward of Plane fan-out or audit. ``state_change_audit_partial``
    is stamped onto the legacy audit when v2 fails so reviewers see the
    universal artefact is missing for that tick.

    Matter targets additionally fan out a
    ``steward:matter_context_changed`` signal to every child task with
    ``parent_matter == this_matter`` (W2 cascade — previously a parked
    TODO).
    """
    if mode not in ("shadow", "live"):
        raise ValueError(f"unsupported steward mode: {mode!r}")

    # Effective mode = caller intent ∩ operator veto. The operator can
    # only DOWNGRADE — the env can't escalate a shadow caller to live
    # (defence-in-depth: a stray test invocation passing mode="shadow"
    # never accidentally hits Plane).
    env_mode = _resolve_steward_live_mode()
    if mode == "live" and env_mode == "shadow":
        logger.info(
            "steward.apply_state_change: downgraded caller mode='live' to "
            "'shadow' — STEWARD_LIVE_MODE=shadow",
        )
        effective_mode = "shadow"
    else:
        effective_mode = mode

    raw_decision = decision or {}
    decision_label = str(raw_decision.get("decision") or "noop")
    confidence_raw = raw_decision.get("confidence", 0.0)
    try:
        confidence = float(confidence_raw)
    except (TypeError, ValueError):
        confidence = 0.0
    reasoning = str(raw_decision.get("reasoning") or "")
    source_contributions = raw_decision.get("source_contributions") or {}
    if not isinstance(source_contributions, dict):
        source_contributions = {}
    evidence_raw = raw_decision.get("evidence") or []
    evidence: list[Any] = list(evidence_raw) if isinstance(evidence_raw, list) else []

    # Normalise the target path. We always write the audit record using
    # the canonical ``<kind>/<slug>.md`` form so MCP queries can join
    # back to the source target. The ``canonical_task_path`` variable
    # name is kept (it's referenced everywhere downstream) — for matter
    # targets it carries a ``matter/<slug>.md`` value rather than a
    # task path.
    target_kind_normalized = (target_kind or "task").lower().strip()
    if target_kind_normalized not in ("task", "matter"):
        raise ValueError(
            f"apply_state_change: unsupported target_kind={target_kind!r} "
            f"(expected 'task' or 'matter')"
        )

    if target_kind_normalized == "matter":
        slug = _slug_from_matter_path(task_path)
        if not slug:
            raise ValueError("apply_state_change: matter path is required")
        canonical_task_path = f"matter/{slug}.md"
    else:
        slug = _slug_from_task_path(task_path)
        if not slug:
            raise ValueError("apply_state_change: task_path is required")
        canonical_task_path = f"task/{slug}.md"

    now = datetime.now(timezone.utc)
    ts_iso = now.isoformat(timespec="seconds")
    expires_iso = (now + STEWARD_UNDO_WINDOW).isoformat(timespec="seconds")
    # Filename component: timestamp without colons (filesystem-safe) +
    # the safe-slugified target name. Mirrors the issue spec example.
    ts_filename = ts_iso.replace(":", "-").replace("+00-00", "Z")
    audit_name = f"steward-action-{ts_filename}-{_safe_filename_slug(slug)}"

    # Decide whether live actions can fire AT ALL given the env gate +
    # the caller's confidence. Even in ``effective_mode="live"`` a
    # below-threshold decision lands as ``pending_confirmation: true``
    # on the vault and skips Plane entirely.
    if effective_mode == "live":
        if env_mode == "live_high_confidence_only":
            threshold = _resolve_confidence_threshold(
                STEWARD_HIGH_CONFIDENCE_THRESHOLD_ENV,
                DEFAULT_STEWARD_HIGH_CONFIDENCE_THRESHOLD,
            )
        else:
            threshold = _resolve_confidence_threshold(
                STEWARD_CONFIDENCE_THRESHOLD_ENV,
                DEFAULT_STEWARD_CONFIDENCE_THRESHOLD,
            )
    else:
        threshold = DEFAULT_STEWARD_CONFIDENCE_THRESHOLD  # unused but defined

    high_confidence = effective_mode == "live" and confidence >= threshold
    pending_confirmation = effective_mode == "live" and not high_confidence
    # Decisions that should never trigger a Plane action even if
    # confidence is high. ``still_active`` is by definition a non-action;
    # ``needs_input`` raises a flag for Sir but doesn't mutate Plane.
    DECISION_REQUIRES_PLANE_WRITE = decision_label in (
        "likely_done",
        "stale_archive_candidate",
    )
    will_act_on_plane = high_confidence and DECISION_REQUIRES_PLANE_WRITE

    cfg = load_config()
    client = VaultClient(cfg)
    try:
        # ── 1. Snapshot prior task frontmatter ──────────────────────────
        prior_fm: dict[str, Any] = {}
        task_missing = False
        try:
            existing = await client.read_record(canonical_task_path)
            fm = existing.get("frontmatter") or {}
            if isinstance(fm, dict):
                prior_fm = fm
        except httpx.HTTPStatusError as exc:
            if exc.response is not None and exc.response.status_code == 404:
                task_missing = True
                logger.warning(
                    "steward.apply_state_change: task=%s missing — emitting "
                    "audit record with empty prior_frontmatter",
                    canonical_task_path,
                )
            else:
                raise

        prior_state = ""
        if isinstance(prior_fm.get("state"), str):
            prior_state = prior_fm["state"]
        prior_outcome = prior_fm.get("last_steward_outcome")
        prior_next_check = prior_fm.get("next_check_after")
        prior_pending = bool(prior_fm.get("pending_confirmation", False))
        plane_issue_id = str(prior_fm.get("plane_issue_id") or "").strip()
        parent_matter = _resolve_parent_matter(prior_fm)
        related_to_raw = prior_fm.get("related_to") or []
        related_to: list[str] = (
            [str(x) for x in related_to_raw if isinstance(x, str) and x.strip()]
            if isinstance(related_to_raw, list)
            else []
        )

        # ── 2. Live-mode: do the Plane write FIRST ──────────────────────
        #
        # Order matters for atomicity: if the Plane write fails we want
        # to know it BEFORE patching vault frontmatter, so the vault
        # patch can still record ``last_steward_outcome.partially_applied``
        # and the audit record's ``plane_action`` reflects reality. In
        # the spec's atomicity rule we do NOT roll back the vault —
        # Plane is the lagging leaf — but we DO want the audit record
        # to flag the partial.
        plane_action_payload: Optional[dict[str, Any]] = None
        plane_revert_recipe: Optional[dict[str, Any]] = None
        plane_partial = False
        plane_partial_reason: Optional[str] = None

        # Matter targets are NOT Plane projects — skip the Plane fan-out
        # entirely. ``plane_action_payload`` and ``plane_revert_recipe``
        # remain ``None``, which the audit record + undo recipe handle
        # downstream as "no Plane side-effect".
        if will_act_on_plane and not task_missing and target_kind_normalized == "task":
            if not plane_issue_id:
                plane_partial = True
                plane_partial_reason = "task_has_no_plane_issue_id"
                logger.info(
                    "steward.apply_state_change: skipping Plane write task=%s "
                    "decision=%s reason=no_plane_issue_id",
                    canonical_task_path, decision_label,
                )
            else:
                project_id = await _read_matter_plane_project_id(client, parent_matter)
                if not project_id:
                    plane_partial = True
                    plane_partial_reason = "matter_has_no_plane_project_id"
                    logger.info(
                        "steward.apply_state_change: skipping Plane write "
                        "task=%s decision=%s reason=no_project_id matter=%s",
                        canonical_task_path, decision_label, parent_matter,
                    )
                else:
                    audit_record_path = f"event/{audit_name}.md"
                    try:
                        plane_resp = await client.plane_post_steward_action(
                            project_id=project_id,
                            issue_id=plane_issue_id,
                            decision=decision_label,
                            confidence=confidence,
                            evidence=_normalise_evidence_for_plane(evidence),
                            audit_record_path=audit_record_path,
                        )
                        plane_action_payload = {
                            "type": "comment+transition",
                            "decision": decision_label,
                            "comment_id": plane_resp.get("comment_id"),
                            "transitioned_to_state_id": plane_resp.get(
                                "transitioned_to_state_id"
                            ),
                            "transitioned_to_state_group": plane_resp.get(
                                "transitioned_to_state_group"
                            ),
                            "archived": bool(plane_resp.get("archived", False)),
                            "audit_record_path": audit_record_path,
                            "partially_applied": False,
                        }
                        plane_revert_recipe = {
                            "issue_id": plane_issue_id,
                            "project_id": project_id,
                            "delete_comment_id": plane_resp.get("comment_id"),
                            "restore_state": plane_resp.get("prior_state_id"),
                            "restore_archived": plane_resp.get(
                                "prior_archived", False
                            ),
                        }
                        logger.info(
                            "steward.apply_state_change: plane action posted "
                            "task=%s decision=%s comment=%s state=%s archived=%s",
                            canonical_task_path,
                            decision_label,
                            plane_resp.get("comment_id"),
                            plane_resp.get("transitioned_to_state_id"),
                            plane_resp.get("archived"),
                        )
                    except (httpx.HTTPError, OSError) as exc:
                        plane_partial = True
                        plane_partial_reason = f"plane_post_failed: {exc}"[:300]
                        logger.warning(
                            "steward.apply_state_change: plane action FAILED "
                            "task=%s decision=%s err=%s — vault still patches, "
                            "audit record marks partially_applied",
                            canonical_task_path, decision_label, exc,
                        )

        # ── 3. Build the undo recipe ────────────────────────────────────
        #
        # In shadow mode this is the recipe a Phase 3 cutover WOULD
        # apply (forward-compat). In live mode it's the actual reversal
        # blueprint, including ``plane_revert`` if we posted to Plane.
        undo_set: dict[str, Any] = {
            "state": prior_state if prior_state else "",
            "next_check_after": prior_next_check if prior_next_check else "",
            "last_steward_outcome": prior_outcome
            if prior_outcome is not None
            else "",
            # Restore prior pending_confirmation. For records written
            # with pending_confirmation=true, undo restores the previous
            # bool (not necessarily false) so reverting a "marked pending
            # by mistake" task takes us back to its pre-Steward state.
            "pending_confirmation": prior_pending,
        }
        undo_recipe: dict[str, Any] = {
            "vault_patch": {
                "target": canonical_task_path,
                "set": undo_set,
            },
            "plane_revert": plane_revert_recipe,
            "expires_at": expires_iso,
        }

        # ── 4. Compose the new last_steward_outcome dict (live only) ────
        new_outcome: dict[str, Any] = {
            "decision": decision_label,
            "confidence": round(confidence, 4),
            "reasoning": reasoning,
            "evidence": evidence,
            "source_contributions": source_contributions,
            "evaluated_at": ts_iso,
            "mode": effective_mode,
            "audit_record_path": f"event/{audit_name}.md",
        }
        if plane_partial:
            new_outcome["partially_applied"] = True
            new_outcome["partially_applied_reason"] = plane_partial_reason

        # ── 4b. Resolve the Steward write intent up-front ──────────────
        # We compute the new lifecycle ``state`` and (RFC #884) the
        # one-sentence ``current_state`` BEFORE both v2 and the legacy
        # PATCH so both writers observe identical decision metadata.
        # Matches the existing legacy semantics: pending-confirmation
        # ticks leave the prior current_state alone; only high-confidence
        # transitions ("likely_done" / "stale_archive_candidate") on task
        # targets compose a new ``current_state`` + stamp ``as_of``.
        new_lifecycle_state: str | None = None
        new_current_state: str | None = None
        new_as_of_stamp: str | None = None
        if effective_mode == "live" and not task_missing:
            if not pending_confirmation:
                if decision_label == "likely_done":
                    new_lifecycle_state = "done"
                elif decision_label == "stale_archive_candidate":
                    new_lifecycle_state = "archived"
            if (
                target_kind_normalized == "task"
                and new_lifecycle_state is not None
            ):
                new_current_state = _compose_task_current_state(
                    new_state=new_lifecycle_state,
                    decision=raw_decision,
                    now_iso=ts_iso,
                )
                new_as_of_stamp = ts_iso

        # ── 4c. Universal state-mutator (Phase B) ──────────────────────
        # The "core" state-field write per the universal contract: emit
        # the ``event/state-change-*.md`` audit + ``state_change``
        # timeline entry through ``apply_state_change_v2``. v2 runs
        # alongside the legacy frontmatter PATCH (step 5) — under
        # ``STATE_CHANGE_ENFORCEMENT=warn`` ctrl-api accepts both; under
        # ``=reject`` only the v2 write will land (Phase G work).
        #
        # v2 errors (network, optimistic-concurrency contention,
        # unexpected exceptions) are caught and logged. The legacy code
        # path continues unconditionally so a v2 outage never deprives
        # Steward of Plane fan-out or the legacy audit.
        v2_result = None
        v2_audit_partial = False
        v2_audit_partial_reason: Optional[str] = None
        observed_start_dt = _parse_iso(prior_fm.get("as_of")) or _parse_iso(
            prior_fm.get("last_steward_check_at")
        ) or now
        observed_window = ObservedWindow(
            start=observed_start_dt,
            end=now,
            signal_paths=[],
            decision_paths=[],
            other_refs=[],
        )
        propose_args: dict[str, Any] = {
            "decision": decision_label,
            "confidence": confidence,
            "reasoning": reasoning,
            "effective_mode": effective_mode,
            "target_kind": target_kind_normalized,
            "pending_confirmation": pending_confirmation,
            "new_lifecycle_state": new_lifecycle_state,
            "current_state_str": new_current_state,
            "last_steward_outcome": new_outcome,
            "ts_iso": ts_iso,
            "will_act_on_plane": will_act_on_plane,
        }
        expected_as_of = prior_fm.get("as_of")
        try:
            v2_result = await apply_state_change_v2(
                target_path=canonical_task_path,
                source="steward.evaluate_task",
                observed=observed_window,
                propose_fn_name="steward.propose_state_change",
                propose_fn_args=propose_args,
                mode=effective_mode,
                expected_as_of=expected_as_of if isinstance(expected_as_of, str) else None,
            )
            if v2_result is not None and v2_result.applied:
                logger.info(
                    "steward.apply_state_change: v2 universal audit landed "
                    "target=%s source=steward.evaluate_task audit=%s "
                    "retries=%d",
                    canonical_task_path,
                    v2_result.audit_record_path,
                    v2_result.retried_count,
                )
        except MutatorContentionError as exc:
            v2_audit_partial = True
            v2_audit_partial_reason = f"v2_contention_exhausted: {exc}"[:300]
            logger.warning(
                "steward.apply_state_change: v2 contention exhausted "
                "target=%s err=%s — universal audit missing for this tick; "
                "legacy audit still lands",
                canonical_task_path, exc,
            )
        except httpx.HTTPError as exc:
            v2_audit_partial = True
            v2_audit_partial_reason = f"v2_http_failed: {exc}"[:300]
            logger.warning(
                "steward.apply_state_change: v2 POST failed target=%s err=%s "
                "— universal audit missing for this tick; legacy audit "
                "still lands",
                canonical_task_path, exc,
            )
        except Exception as exc:  # noqa: BLE001 — defensive last-resort
            v2_audit_partial = True
            v2_audit_partial_reason = f"v2_unexpected: {type(exc).__name__}: {exc}"[:300]
            logger.warning(
                "steward.apply_state_change: v2 raised unexpected target=%s "
                "err=%r — universal audit missing for this tick; legacy "
                "audit still lands",
                canonical_task_path, exc,
            )

        # ── 5. Patch the task frontmatter (live mode only) ──────────────
        # Phase B note: under STATE_CHANGE_ENFORCEMENT=warn ctrl-api
        # accepts the legacy PATCH of state fields (state, current_state,
        # as_of, pending_confirmation, last_steward_outcome) alongside
        # the v2 envelope's frontmatter merge. This is deliberate during
        # Phase B → Phase G — keeps the test contract intact and keeps
        # Steward's lifecycle ``state`` field writable (``state`` is not
        # in the universal allowlist; ``status`` is). When Phase G flips
        # enforcement to ``reject`` we'll need to either drop the state-
        # field subset of scalar_updates or remap ``state`` → ``status``.
        vault_patch_applied = False
        if effective_mode == "live" and not task_missing:
            scalar_updates: dict[str, Any] = {
                "last_steward_check_at": ts_iso,
            }
            if pending_confirmation:
                scalar_updates["pending_confirmation"] = True
            else:
                # High-confidence path: clear the flag in case a prior
                # tick set it AND, if the decision implies a state
                # change, write the new state.
                scalar_updates["pending_confirmation"] = False
                if new_lifecycle_state is not None:
                    scalar_updates["state"] = new_lifecycle_state
            # RFC #884: when the patch actually shifts the task's
            # ``state`` field, also stamp a one-sentence
            # ``current_state`` + ``as_of``. Computed in step 4b above.
            if new_current_state is not None and new_as_of_stamp is not None:
                scalar_updates["current_state"] = new_current_state
                scalar_updates["as_of"] = new_as_of_stamp
            json_updates: dict[str, Any] = {
                "last_steward_outcome": new_outcome,
            }
            try:
                await client.patch_frontmatter_structured(
                    canonical_task_path,
                    scalar_updates=scalar_updates,
                    json_updates=json_updates,
                )
                vault_patch_applied = True
            except httpx.HTTPError as exc:
                logger.warning(
                    "steward.apply_state_change: vault patch FAILED task=%s "
                    "err=%s — falling back to scalar PATCH",
                    canonical_task_path, exc,
                )
                try:
                    fallback = dict(scalar_updates)
                    fallback["last_steward_outcome"] = json.dumps(
                        new_outcome, ensure_ascii=False, default=str,
                    )
                    await client.patch_frontmatter(canonical_task_path, fallback)
                    vault_patch_applied = True
                except httpx.HTTPError as exc2:
                    logger.error(
                        "steward.apply_state_change: vault patch fallback "
                        "ALSO FAILED task=%s err=%s — proceeding with audit "
                        "record only",
                        canonical_task_path, exc2,
                    )

        # ── 6. Compose the audit record body ────────────────────────────
        payload: dict[str, Any] = {
            "type": "steward-action",
            "timestamp": ts_iso,
            "target": canonical_task_path,
            "decision": decision_label,
            "confidence": round(confidence, 4),
            "mode": effective_mode,
            "evidence": evidence,
            "prior_state": prior_state,
            "prior_frontmatter": {
                "state": prior_fm.get("state", ""),
                "next_check_after": prior_next_check or "",
                "last_steward_outcome": prior_outcome
                if prior_outcome is not None
                else "",
                "pending_confirmation": prior_pending,
                "plane_issue_id": plane_issue_id or "",
                "parent_matter": parent_matter or "",
            },
            "plane_action": plane_action_payload,
            "undo_recipe": undo_recipe,
            "signals_summary": signals_summary or {},
        }
        if pending_confirmation:
            payload["pending_confirmation"] = True
        if plane_partial:
            payload["partially_applied"] = True
            payload["partially_applied_reason"] = plane_partial_reason
        # Phase B cross-reference: link the legacy audit to v2's
        # universal audit (when v2 wrote one). When v2 failed, surface
        # the partial so reviewers know the universal artefact is
        # missing for this tick.
        if v2_result is not None and v2_result.applied:
            payload["state_change_audit"] = v2_result.audit_record_path
            payload["state_change_timeline_id"] = v2_result.timeline_entry_id
        if v2_audit_partial:
            payload["state_change_audit_partial"] = True
            payload["state_change_audit_partial_reason"] = v2_audit_partial_reason

        yaml_block = _render_audit_yaml(payload)

        narrative = (
            f"Steward evaluated `{canonical_task_path}` at {ts_iso} and "
            f"reached the decision **{decision_label}** with confidence "
            f"{confidence:.2f} (mode={effective_mode}). Evidence: "
            f"{_summarize_evidence(evidence)}."
        )
        if effective_mode == "shadow":
            narrative += (
                "\n\nNo task state was mutated and no Plane action was "
                "taken — this audit record exists purely so the dashboard "
                "and Sir can review what Steward would have done. The "
                "embedded undo_recipe is the patch a live-mode cutover "
                "would apply, retained for forward compatibility."
            )
        elif pending_confirmation:
            narrative += (
                f"\n\nConfidence {confidence:.2f} fell below the live-mode "
                f"threshold ({threshold:.2f}); the task was marked "
                "`pending_confirmation: true` and no Plane action was "
                "taken. Sir can confirm via the dashboard to fire the full "
                "live action, or dismiss to clear the flag."
            )
        else:
            narrative += (
                "\n\nLive-mode action taken: vault frontmatter patched"
                f"{' (partial — see partially_applied)' if plane_partial else ''}"
                f", Plane issue updated"
                f"{' (skipped — see partially_applied_reason)' if plane_partial else ''}."
                "\n\nThe embedded `undo_recipe` reverses both the vault "
                "patch and the Plane comment + state transition. Use the "
                "dashboard's Undo control or `POST /api/v1/steward/undo/"
                f"{audit_name}` to reverse atomically."
            )

        content = (
            "---\n"
            f"{yaml_block}\n"
            "---\n"
            "\n"
            f"# Steward action: {decision_label} on {canonical_task_path}\n"
            "\n"
            f"{narrative}\n"
        )

        # ── 7. Write the audit row to state.db (audit table) ────────────
        # steward-action is audit-class: the promotion contract demotes it
        # from the vault to Store 2's audit table, so a vault write 422s
        # (PROMOTION_CONTRACT_VIOLATION). Route it through StateClient's
        # append_audit (POST /api/v1/state/audit) — the same migration
        # signal-action got (#26). The narrative + full context ride in the
        # `payload` blob; `written_path` becomes the opaque audit-row id
        # (a ULID cross-ref), not a filesystem path. (`content` above is the
        # legacy markdown body, retained only for the narrative text.)
        from src.utils.state_client import StateClient

        payload["narrative"] = narrative
        async with StateClient(cfg) as sc:
            written_path = await sc.append_audit(
                action_type="steward-action",
                actor="steward",
                summary=(
                    f"steward-action: {decision_label} on "
                    f"{canonical_task_path} (conf={confidence:.2f}, "
                    f"mode={effective_mode})"
                ),
                ts=ts_iso,
                target_path=canonical_task_path,
                target_kind=target_kind_normalized,
                mode=effective_mode,
                confidence=round(confidence, 4),
                undo=undo_recipe,
                payload=payload,
            )

        # ── 8. Multi-matter dispatch (live mode only) ───────────────────
        # Fire dependency-change signals on every related task so the
        # next Steward tick re-evaluates them with the just-applied
        # state change in their context. Skipped in shadow mode (we
        # didn't actually change anything).
        #
        # Phase B (W2) — matter-context cascade
        # -------------------------------------
        # Previously a parked TODO: "when a matter's state mutates,
        # re-evaluate every task whose ``parent_matter`` points at this
        # matter." Implemented here via
        # ``_emit_matter_context_signals`` — enumerates child tasks via
        # ctrl-api ``list_records("task")`` and appends one
        # ``steward:matter_context_changed`` record per match to the
        # same ``streams/steward-signals.jsonl`` ledger the related_to
        # cascade writes to. Symmetric with the related_to fan-out so
        # consumers can treat both signal kinds uniformly.
        dep_signals_emitted = 0
        if (
            effective_mode == "live"
            and will_act_on_plane
            and related_to
            and target_kind_normalized == "task"
        ):
            dep_signals_emitted = _emit_steward_dependency_signals(
                cfg,
                source_task_path=canonical_task_path,
                related_to=related_to,
                decision_label=decision_label,
            )
        elif (
            effective_mode == "live"
            and target_kind_normalized == "matter"
            and not task_missing
        ):
            # Matter writes always fan out to child tasks (no
            # will_act_on_plane gate — matters don't have a Plane
            # action; the cascade IS the actionable downstream effect).
            dep_signals_emitted = await _emit_matter_context_signals(
                cfg,
                matter_path=canonical_task_path,
                decision_label=decision_label,
                client=client,
            )

        logger.info(
            "steward.apply_state_change: task=%s decision=%s mode=%s "
            "live_action=%s pending=%s vault_patched=%s plane_partial=%s "
            "dep_signals=%d -> %s",
            canonical_task_path, decision_label, effective_mode,
            will_act_on_plane, pending_confirmation, vault_patch_applied,
            plane_partial, dep_signals_emitted, written_path,
        )

        return {
            "path": written_path,
            "mode": effective_mode,
            "timestamp": ts_iso,
            "live_action_taken": will_act_on_plane and not plane_partial,
            "pending_confirmation": pending_confirmation,
            "vault_patch_applied": vault_patch_applied,
            "plane_action": plane_action_payload,
            "partially_applied": plane_partial,
            "dependency_signals_emitted": dep_signals_emitted,
        }
    finally:
        await client.close()
