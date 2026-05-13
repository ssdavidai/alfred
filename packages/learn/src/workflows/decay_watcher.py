"""DecayWatcherWorkflow — six-hourly sweep that stamps freshness bands
on pending needs_attention cards and auto-flips the deeply stale.

The actual decay curve + auto-flip thresholds live in
``src.utils.decay``; the side effects (read needs_attention, PATCH
decay_band / decay_score / status) live in
``src.activities.decay_watcher``. This workflow exists only to make
that activity run on a Temporal schedule with sensible timeouts +
retry. No clerk calls inside the workflow itself — keep replay
deterministic.

SM-D-W8 — STATE-MUTATOR V2 RETROFIT
-----------------------------------

Under the universal state-mutation contract (#892 Phase D) the
DecayWatcher also adjusts matter ``surface_class`` based on
activity-decay bands. The new branch is gated by
``workflow.patched("decay_watcher_state_mutator_v1")`` so in-flight
workflows started before this gate replay deterministically through
the legacy single-activity path (per ``packages/learn/CLAUDE.md``
replay rules).

The legacy ``watch_decay`` (needs_attention freshness) is unchanged
and runs on both branches — out-of-scope of the contract.
"""
from __future__ import annotations

from datetime import timedelta, timezone

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.decay_watcher import (
        adjust_matter_surface_class_v2,
        list_active_matters_for_decay,
        watch_decay,
    )


# SM-D-W8 — patched-gate name. Must match across this file and any
# history-replay safety review. Adding the matter-pass activity calls
# inside ``DecayWatcherWorkflow.run`` is a non-additive change to the
# workflow history; the patched gate keeps pre-deploy histories on
# the legacy single-activity path.
DECAY_WATCHER_STATE_MUTATOR_PATCH = "decay_watcher_state_mutator_v1"

# Heartbeat cadence for the matter pass. Identical shape to
# nightly_narrative's HEARTBEAT_EVERY so reviewers see a familiar
# pattern. Adjust if the tenant matter population grows past low
# hundreds and a six-hourly sweep starts running long.
HEARTBEAT_EVERY = 10


_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=10),
    maximum_interval=timedelta(minutes=2),
    maximum_attempts=3,
)


@workflow.defn
class DecayWatcherWorkflow:
    @workflow.run
    async def run(self) -> dict:
        # Legacy pass — needs_attention freshness bands + auto-flip.
        # Runs unconditionally on both branches (the needs_attention
        # record type is explicitly out of scope for the contract; the
        # legacy activity is the canonical writer there).
        result = await workflow.execute_activity(
            watch_decay,
            start_to_close_timeout=timedelta(minutes=10),
            retry_policy=_RETRY,
        )
        outcome: dict = result if isinstance(result, dict) else {}

        # SM-D-W8 — matter surface_class pass. Gated on the patched
        # marker so in-flight workflow histories replay through the
        # legacy single-activity branch deterministically.
        if not workflow.patched(DECAY_WATCHER_STATE_MUTATOR_PATCH):
            return outcome

        try:
            matter_paths: list[str] = await workflow.execute_activity(
                list_active_matters_for_decay,
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=_RETRY,
            )
        except Exception as exc:  # noqa: BLE001 — surface but don't fail the legacy result
            workflow.logger.warning(
                "decay_watcher: list_active_matters failed: %s", exc,
            )
            outcome["surface_class_pass"] = {
                "skipped_reason": f"list_failed: {exc}"[:200],
            }
            return outcome

        # Stamp the observed-window end with workflow.now() so the
        # propose function's reasoning window closes deterministically
        # across retries (replay-safe).
        as_of_iso = (
            workflow.now()
            .astimezone(timezone.utc)
            .isoformat(timespec="seconds")
        )

        mutated = 0
        no_change = 0
        errored = 0
        per_band: dict[str, int] = {"high": 0, "normal": 0, "low": 0}
        errors: list[str] = []

        workflow.logger.info(
            "decay_watcher: surface_class pass — %d active matters",
            len(matter_paths),
        )

        for idx, matter_path in enumerate(matter_paths):
            if idx and idx % HEARTBEAT_EVERY == 0:
                workflow.logger.info(
                    "decay_watcher: surface_class pass progress %d/%d "
                    "(mutated=%d no_change=%d errors=%d)",
                    idx, len(matter_paths), mutated, no_change, errored,
                )
            try:
                per_matter = await workflow.execute_activity(
                    adjust_matter_surface_class_v2,
                    args=[matter_path, as_of_iso],
                    start_to_close_timeout=timedelta(minutes=2),
                    retry_policy=_RETRY,
                )
            except Exception as exc:  # noqa: BLE001 — per-matter isolation
                errored += 1
                errors.append(f"{matter_path}: dispatch_failed: {exc}"[:300])
                workflow.logger.warning(
                    "decay_watcher: surface_class dispatch failed matter=%s err=%s",
                    matter_path, exc,
                )
                continue

            status = per_matter.get("status") if isinstance(per_matter, dict) else None
            if status == "mutated":
                mutated += 1
                band = per_matter.get("new_surface_class")
                if isinstance(band, str) and band in per_band:
                    per_band[band] += 1
            elif status == "no_change":
                no_change += 1
            else:
                errored += 1
                err = (
                    per_matter.get("error_message")
                    if isinstance(per_matter, dict)
                    else "unknown_status"
                )
                errors.append(f"{matter_path}: {err}"[:300])

        workflow.logger.info(
            "decay_watcher: surface_class pass done "
            "scanned=%d mutated=%d no_change=%d errors=%d bands=%s",
            len(matter_paths), mutated, no_change, errored, per_band,
        )

        outcome["surface_class_pass"] = {
            "scanned": len(matter_paths),
            "mutated": mutated,
            "no_change": no_change,
            "errored": errored,
            "bands_set": per_band,
            "error_messages": errors[:10],
        }
        return outcome
