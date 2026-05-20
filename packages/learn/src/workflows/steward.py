"""Steward — the perception-and-action loop (#835 Phase 0 → #52 sweep).

Originally each matter (``matter/*.md`` in the vault) got its own
Temporal Schedule named ``al-steward-<matter-slug>`` firing every 30
minutes. Issue #52 collapsed that per-matter fan-out into a single
``StewardSweepWorkflow`` on one ``al-steward-sweep`` schedule: per the
SPIKE-cron-migration §1 verdict, the per-matter *schedule* carried no
state the per-task ``next_check_after`` / ``last_steward_check_at``
cursors don't already carry, so hundreds of schedules + a stateful
registrar collapse cleanly to one schedule that internally loops the
matters whose cursors have elapsed.

Two workflow types live here:

* ``StewardSweepWorkflow`` — the scheduled entity (``al-steward-sweep``,
  30-min interval, overlap SKIP). Each run lists the matters with due
  work and runs the per-matter evaluation for each.

* ``StewardWorkflow`` — the *original* per-matter workflow. It is no
  longer scheduled (the per-matter ``al-steward-*`` schedules are
  deleted on boot) but the class is **kept registered** as a harmless
  tombstone: it is still callable ad-hoc (e.g. an operator running one
  matter from the Temporal UI) and registering it costs nothing. Both
  workflows drive the *same* per-matter loop via the shared
  ``_run_steward_for_matter`` helper — there is exactly one copy of the
  perception logic.

Yield budget
------------
All vault I/O lives in activities. A sweep run holds at most a list of
matter ids (hundreds of short strings) plus, per matter, a list of
task descriptors — never thousands of records resident at once.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.steward import (
        evaluate_task,
        list_due_steward_matters,
        load_matter_tasks,
        record_steward_check,
        update_matter_cadence,
    )


# Heartbeat every N tasks so a long-running matter (e.g. inbox after a
# fleet-wide migration) doesn't time out silently.
HEARTBEAT_EVERY = 10

# Max matters processed per sweep tick. Sized so the worst-case run
# (every matter has due tasks that all hit the LLM) still drains within
# the sweep's execution envelope; a fleet with more due matters drains
# across consecutive 30-min ticks rather than wedging one run. Mirrors
# the BATCH_LIMIT discipline in SignalExtractWorkflow. The cap is also
# applied inside ``list_due_steward_matters`` (sorted-slug order → no
# starvation); the workflow-side slice is a defensive belt-and-braces.
SWEEP_MATTER_BATCH_LIMIT = 200


@dataclass
class StewardResult:
    """Compact run summary — emitted to Temporal history + returned to
    the caller (mostly tests; the sweep aggregates these)."""
    matter_id: str = ""
    evaluated: int = 0
    skipped: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)
    # Phase 2 (#838) — matter-aggregate cadence backoff bookkeeping. See
    # ``update_matter_cadence`` in src/activities/steward.py.
    matter_no_signal_streak: int = 0
    matter_cadence_seconds: int = 0
    matter_cadence_transitioned: bool = False
    signals_total: int = 0


@dataclass
class StewardSweepResult:
    """Per-sweep-run outcome — surfaced in Temporal UI for visibility.

    Counter semantics:
      * ``matters_due`` — matters ``list_due_steward_matters`` returned
        for this tick (already capped at ``SWEEP_MATTER_BATCH_LIMIT``).
      * ``matters_processed`` — matters the sweep actually ran the
        per-matter loop for.
      * ``tasks_evaluated`` / ``tasks_skipped`` — summed across every
        processed matter.
      * ``errors`` — count of per-matter / per-task exceptions surfaced
        from the inner try/excepts. ``error_messages`` carries the first
        ~20 messages.
      * ``signals_total`` — signals observed across the whole sweep.
    """
    started: bool = False
    matters_due: int = 0
    matters_processed: int = 0
    tasks_evaluated: int = 0
    tasks_skipped: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)
    signals_total: int = 0


def _next_check_due(value: Any, now: datetime) -> bool:
    """Return True iff ``value`` is empty or refers to a moment <= now.

    Frontmatter timestamps round-trip as strings. We accept ISO-8601
    with or without a ``Z`` suffix; anything we can't parse is treated
    as "due now" so a malformed cursor doesn't pin a task forever.
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
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt <= now
    except ValueError:
        return True


def _is_terminal_state(fm: dict[str, Any]) -> bool:
    """Tasks in ``done`` or ``archived`` state never get re-evaluated.

    Steward owns state transitions; once a task lands in a terminal
    state it stays there until a human (or a future signal source)
    explicitly reopens it. Phase 0 doesn't write transitions, but we
    still respect existing ones that the migration script lifted from
    the legacy ``status`` field.
    """
    state = fm.get("state")
    if isinstance(state, str):
        return state.strip().lower() in ("done", "archived")
    return False


async def _run_steward_for_matter(matter_id: str) -> StewardResult:
    """Run one matter's Steward perception-and-action loop.

    This is the single copy of the per-matter logic — both
    ``StewardWorkflow`` (per-matter, tombstone) and
    ``StewardSweepWorkflow`` (the scheduled sweep) call it. It performs
    only deterministic in-memory logic + ``workflow.execute_activity``
    calls, so it is replay-safe to call from inside ``@workflow.run``.
    It deliberately reuses the existing Steward activities verbatim —
    no perception logic is reimplemented here.

    Steps:
      1. ``load_matter_tasks`` — list the matter's tasks.
      2. per-task loop — skip terminal / not-yet-due tasks; for each due
         task, ``evaluate_task`` then ``record_steward_check``.
      3. ``update_matter_cadence`` — matter-aggregate backoff (#838).
    """
    result = StewardResult(matter_id=matter_id)
    workflow.logger.info("steward.tick.start matter=%s", matter_id)

    if not matter_id:
        workflow.logger.warning(
            "steward.tick: empty matter_id — nothing to do"
        )
        return result

    retry = RetryPolicy(
        maximum_attempts=3,
        initial_interval=timedelta(seconds=2),
        backoff_coefficient=2.0,
        maximum_interval=timedelta(seconds=30),
    )

    # 1. Load the matter's tasks. List endpoint walks the whole vault
    #    but the response is cheap (preview=0).
    try:
        tasks: list[dict[str, Any]] = await workflow.execute_activity(
            load_matter_tasks,
            args=[matter_id],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=retry,
        )
    except Exception as exc:  # noqa: BLE001
        result.errors += 1
        result.error_messages.append(f"load_matter_tasks: {exc}"[:500])
        workflow.logger.error(
            "steward.tick: load_matter_tasks(matter=%s) failed: %s",
            matter_id, exc,
        )
        return result

    # 2. Per-task loop. Skip terminal-state tasks and tasks whose
    #    next_check_after is still in the future. Everything else gets
    #    the evaluation + the cursor stamp.
    had_any_signal = False
    signals_total = 0
    now = workflow.now()
    for idx, task in enumerate(tasks):
        if idx % HEARTBEAT_EVERY == 0 and idx > 0:
            workflow.logger.info(
                "steward.tick: matter=%s progress %d/%d",
                matter_id, idx, len(tasks),
            )

        fm: dict[str, Any] = task.get("frontmatter") or {}
        task_id = str(task.get("id") or "")
        if not task_id:
            # Defensive — load_matter_tasks never returns these, but the
            # loop tolerates them so a malformed entry can't crash the
            # whole tick.
            result.skipped += 1
            continue

        if _is_terminal_state(fm):
            result.skipped += 1
            continue

        if not _next_check_due(fm.get("next_check_after"), now):
            result.skipped += 1
            continue

        # 3. Evaluate. Phase 1 promoted this from a no-op to a real LLM
        #    call; Phase 2 widens the timeout (gated on
        #    workflow.patched() to preserve replay determinism for
        #    workflows started under Phase 1).
        if workflow.patched("steward-phase2-eval-timeout"):
            eval_timeout = timedelta(seconds=120)
        else:
            eval_timeout = timedelta(seconds=30)
        try:
            outcome = await workflow.execute_activity(
                evaluate_task,
                args=[task_id, task],
                start_to_close_timeout=eval_timeout,
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            result.errors += 1
            result.error_messages.append(
                f"evaluate {task_id}: {exc}"[:500]
            )
            workflow.logger.warning(
                "steward.tick: evaluate_task(task=%s) failed: %s",
                task_id, exc,
            )
            # Do NOT advance the cursor on a failed evaluation.
            # Next tick retries.
            continue

        # 4. Stamp last_steward_check_at + next_check_after.
        try:
            await workflow.execute_activity(
                record_steward_check,
                args=[task_id, outcome],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            result.errors += 1
            result.error_messages.append(
                f"record_check {task_id}: {exc}"[:500]
            )
            workflow.logger.warning(
                "steward.tick: record_steward_check(task=%s) failed: %s",
                task_id, exc,
            )
            # Counts as evaluated (the no-op succeeded) but we surface
            # the cursor-write failure so david-side observability shows
            # it.
            result.evaluated += 1
            continue

        # Phase 2 (#838) — collect matter-aggregate signal stats from the
        # per-task outcome so the matter-cadence backoff after the loop
        # has accurate input.
        sig_summary = outcome.get("signals_summary") if isinstance(outcome, dict) else None
        if isinstance(sig_summary, dict):
            count = sig_summary.get("count")
            if isinstance(count, int) and count > 0:
                had_any_signal = True
                signals_total += count

        result.evaluated += 1

    # 5. Matter-aggregate cadence backoff (#838 Phase 2). Gated on
    #    workflow.patched() so workflows started under Phase 1 (no
    #    cadence activity in history) replay deterministically.
    if workflow.patched("steward-phase2-matter-cadence"):
        try:
            cadence_outcome = await workflow.execute_activity(
                update_matter_cadence,
                args=[matter_id, had_any_signal],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            # Non-fatal: cadence state is observability-only in Phase 2
            # (Phase 5 wires the actual schedule update).
            workflow.logger.warning(
                "steward.tick: update_matter_cadence(matter=%s) failed: %s",
                matter_id, exc,
            )
        else:
            if isinstance(cadence_outcome, dict):
                result.matter_no_signal_streak = int(
                    cadence_outcome.get("no_signal_streak") or 0,
                )
                result.matter_cadence_seconds = int(
                    cadence_outcome.get("cadence_seconds") or 0,
                )
                result.matter_cadence_transitioned = bool(
                    cadence_outcome.get("transitioned"),
                )
    result.signals_total = signals_total

    workflow.logger.info(
        "steward.tick: matter=%s evaluated=%d skipped=%d errors=%d signals=%d streak=%d cadence=%ds",
        matter_id, result.evaluated, result.skipped, result.errors,
        result.signals_total, result.matter_no_signal_streak,
        result.matter_cadence_seconds,
    )
    return result


@workflow.defn(name="StewardWorkflow")
class StewardWorkflow:
    """Per-matter Steward tick — TOMBSTONE (no longer scheduled, #52).

    Issue #52 retired the per-matter ``al-steward-<slug>`` schedules in
    favour of ``StewardSweepWorkflow``. This class is kept registered
    (the cost is zero) so it stays callable ad-hoc — e.g. an operator
    re-running one matter from the Temporal UI — and so any historical
    per-matter run can still be described. It delegates to the shared
    ``_run_steward_for_matter`` helper, the exact same loop the sweep
    runs.
    """

    @workflow.run
    async def run(self, matter_id: str) -> StewardResult:
        return await _run_steward_for_matter(matter_id)


@workflow.defn(name="StewardSweepWorkflow")
class StewardSweepWorkflow:
    """One sweep over every matter with due Steward work (#52).

    Schedule: ``al-steward-sweep``, 30-min interval, overlap SKIP — one
    schedule for the whole fleet of matters, replacing the former
    per-matter ``al-steward-*`` fan-out.

    Each run:
      1. ``list_due_steward_matters`` — one ctrl-api task-list scan that
         returns matters with >=1 task whose ``next_check_after`` has
         elapsed, capped at ``SWEEP_MATTER_BATCH_LIMIT``.
      2. For each due matter, runs the per-matter loop via the shared
         ``_run_steward_for_matter`` helper — reusing the existing
         Steward activities verbatim. The per-matter loop's own per-task
         ``next_check_after`` gate means a matter with no actually-due
         task this tick is a cheap no-op (it should not appear in the
         due list, but the per-task gate is the authoritative second
         check).

    A per-matter try/except keeps one bad matter from sinking the rest
    of the sweep; the 30-min cadence is the natural retry boundary.
    """

    @workflow.run
    async def run(self) -> StewardSweepResult:
        workflow.logger.info("steward.sweep.start")
        result = StewardSweepResult()
        result.started = True

        retry = RetryPolicy(
            maximum_attempts=3,
            initial_interval=timedelta(seconds=2),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=30),
        )

        # 1. Enumerate matters with due work. A transport-level failure
        #    inside the activity propagates; the RetryPolicy covers a
        #    transient ctrl-api blip, and a hard failure bails the run
        #    (the next 30-min tick re-lists from scratch).
        try:
            due_matters: list[str] = await workflow.execute_activity(
                list_due_steward_matters,
                args=[SWEEP_MATTER_BATCH_LIMIT],
                start_to_close_timeout=timedelta(seconds=120),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            result.errors += 1
            result.error_messages.append(
                f"list_due_steward_matters: {exc}"[:500]
            )
            workflow.logger.error(
                "steward.sweep: list_due_steward_matters failed: %s", exc,
            )
            return result

        # Defensive belt-and-braces cap (the activity already sorts +
        # caps; this guards against a future activity-side regression).
        due_matters = (due_matters or [])[:SWEEP_MATTER_BATCH_LIMIT]
        result.matters_due = len(due_matters)

        # 2. Per-matter loop. Each matter runs the existing per-matter
        #    Steward logic; a per-matter exception is recorded and the
        #    sweep continues.
        for matter_id in due_matters:
            try:
                matter_result = await _run_steward_for_matter(matter_id)
            except Exception as exc:  # noqa: BLE001
                result.errors += 1
                if len(result.error_messages) < 20:
                    result.error_messages.append(
                        f"matter {matter_id}: {exc}"[:500]
                    )
                workflow.logger.warning(
                    "steward.sweep: matter=%s failed: %s", matter_id, exc,
                )
                continue

            result.matters_processed += 1
            result.tasks_evaluated += matter_result.evaluated
            result.tasks_skipped += matter_result.skipped
            result.errors += matter_result.errors
            result.signals_total += matter_result.signals_total
            for msg in matter_result.error_messages:
                if len(result.error_messages) < 20:
                    result.error_messages.append(msg)

        workflow.logger.info(
            "steward.sweep: due=%d processed=%d evaluated=%d skipped=%d "
            "errors=%d signals=%d",
            result.matters_due, result.matters_processed,
            result.tasks_evaluated, result.tasks_skipped,
            result.errors, result.signals_total,
        )
        return result
