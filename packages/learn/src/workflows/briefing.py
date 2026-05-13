"""BriefingWorkflow — morning + evening composer (#893, spec §8.1).

The two chore slots (``daily-morning-briefing`` and
``daily-evening-digest``) invoke the same workflow with a ``slot``
parameter. The workflow:

  1. Reads the most-recent prior briefing for the slot (for the window
     anchor + the audit chain pointer).
  2. Enumerates every active matter.
  3. Phase 1 — visits each matter, running read+propose+apply through
     ``state_mutator.apply_state_change_v2``. The propose function
     (``briefing.propose_matter_update``) is clerk-driven: NO_CHANGE
     skips the round-trip; a JSON narrative produces a state-change
     audit + timeline entry on the matter.
  4. Phase 2 — re-reads every matter (post-mutation) and asks the clerk
     to compose the brief body from the freshly-written current_state
     paragraphs. Writes the snapshot to ``briefing/<YYYY-MM-DD>-<slot>.md``.
  5. ``record_chore_run`` appends a run-log line.

The two phases are explicitly decoupled per spec §8.3 — the brief body
must reflect *current* state, even if a matter mutated during Phase 1.
The composer's read happens AFTER the mutation pass.

This is a NEW workflow — there is no pre-deploy history to keep
deterministic. Future modifications to ``BriefingWorkflow.run`` MUST
gate any new ``execute_activity`` calls behind ``workflow.patched(...)``
per ``packages/learn/CLAUDE.md`` — replay safety applies from this
commit forward.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta, timezone
from typing import Literal

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.briefing import (
        briefing_visit_matter,
        compose_and_write_briefing,
        get_prior_briefing,
        list_active_matters_for_briefing,
    )
    from src.workflows.chores._base import record_chore_run


# Heartbeat every N matters so a long briefing run doesn't trip Temporal's
# default workflow-task timeout on a tenant with many active matters.
HEARTBEAT_EVERY = 5

# Fallback window when there is no prior briefing for this slot — first
# run on a fresh tenant, or after the briefing chain was reset.
DEFAULT_FALLBACK_WINDOW_HOURS = 24


@dataclass
class BriefingResult:
    """Compact run summary surfaced to Temporal history + tests."""

    slot: str = "morning"
    matters_scanned: int = 0
    matters_mutated: int = 0
    matters_no_change: int = 0
    matters_errored: int = 0
    brief_record_path: str = ""
    error_messages: list[str] = field(default_factory=list)


@workflow.defn(name="BriefingWorkflow")
class BriefingWorkflow:
    """Per-tenant morning+evening briefing composer."""

    @workflow.run
    async def run(self, slot: Literal["morning", "evening"]) -> BriefingResult:
        slot_norm = (slot or "morning").strip().lower()
        if slot_norm not in ("morning", "evening"):
            slot_norm = "morning"

        result = BriefingResult(slot=slot_norm)
        workflow.logger.info("briefing.run: start slot=%s", slot_norm)

        retry = RetryPolicy(
            maximum_attempts=3,
            initial_interval=timedelta(seconds=2),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=30),
        )

        # 1. Window anchor — prior briefing for the same slot, if any.
        try:
            prior = await workflow.execute_activity(
                get_prior_briefing,
                args=[slot_norm],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            workflow.logger.warning(
                "briefing.run: get_prior_briefing failed: %s — using fallback window",
                exc,
            )
            prior = None

        window_end = workflow.now().astimezone(timezone.utc)
        prior_composed = None
        prior_path: str | None = None
        if isinstance(prior, dict):
            prior_path = prior.get("path") or None
            composed_at = prior.get("composed_at")
            if isinstance(composed_at, str) and composed_at.strip():
                # Best-effort ISO parse for the window start. If the
                # prior is unparseable we fall back to the default
                # lookback so the briefing still has a sane window.
                from datetime import datetime
                s = composed_at.strip().replace("Z", "+00:00")
                try:
                    prior_composed = datetime.fromisoformat(s)
                    if prior_composed.tzinfo is None:
                        prior_composed = prior_composed.replace(tzinfo=timezone.utc)
                except ValueError:
                    prior_composed = None

        if prior_composed is not None:
            window_start = prior_composed
        else:
            window_start = window_end - timedelta(hours=DEFAULT_FALLBACK_WINDOW_HOURS)

        window_start_iso = window_start.isoformat(timespec="seconds")
        if window_start_iso.endswith("+00:00"):
            window_start_iso = window_start_iso[:-6] + "Z"
        window_end_iso = window_end.isoformat(timespec="seconds")
        if window_end_iso.endswith("+00:00"):
            window_end_iso = window_end_iso[:-6] + "Z"

        workflow.logger.info(
            "briefing.run: slot=%s window=%s → %s prior=%s",
            slot_norm, window_start_iso, window_end_iso, prior_path,
        )

        # 2. Enumerate active matters.
        try:
            matter_paths: list[str] = await workflow.execute_activity(
                list_active_matters_for_briefing,
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            result.matters_errored += 1
            result.error_messages.append(f"list_active_matters: {exc}"[:500])
            workflow.logger.error("briefing.run: list failed: %s", exc)
            return result

        result.matters_scanned = len(matter_paths)
        workflow.logger.info(
            "briefing.run: visiting %d active matters", len(matter_paths),
        )

        # 3. Phase 1 — per-matter read+propose+apply through v2.
        visit_results: list[dict] = []
        for idx, matter_path in enumerate(matter_paths):
            if idx and idx % HEARTBEAT_EVERY == 0:
                workflow.logger.info(
                    "briefing.run: progress %d/%d", idx, len(matter_paths),
                )

            try:
                outcome = await workflow.execute_activity(
                    briefing_visit_matter,
                    args=[
                        matter_path,
                        slot_norm,
                        window_start_iso,
                        window_end_iso,
                        prior_path,
                    ],
                    start_to_close_timeout=timedelta(minutes=10),
                    retry_policy=retry,
                )
            except Exception as exc:  # noqa: BLE001
                result.matters_errored += 1
                result.error_messages.append(
                    f"{matter_path}: visit dispatch failed: {exc}"[:500]
                )
                workflow.logger.warning(
                    "briefing.run: visit dispatch failed matter=%s err=%s",
                    matter_path, exc,
                )
                # Still record a "no-op" entry so the composer's join
                # set covers every matter the briefing intended to visit.
                visit_results.append({
                    "matter_path": matter_path,
                    "applied": False,
                    "state_changed": False,
                    "audit_record_path": None,
                    "new_as_of": None,
                    "retried_count": 0,
                    "error_message": f"dispatch_failed: {exc}"[:300],
                })
                continue

            entry = outcome if isinstance(outcome, dict) else {}
            visit_results.append(entry)

            err = entry.get("error_message") if isinstance(entry, dict) else None
            if err:
                result.matters_errored += 1
                result.error_messages.append(f"{matter_path}: {err}"[:500])
            elif entry.get("state_changed"):
                result.matters_mutated += 1
            else:
                result.matters_no_change += 1

        # 4. Phase 2 — compose the brief body from post-mutation state +
        # write the snapshot. compose_and_write_briefing re-reads each
        # matter internally; the workflow does NOT pass pre-mutation
        # snapshots here so the two-phase decoupling is preserved.
        try:
            brief_path: str = await workflow.execute_activity(
                compose_and_write_briefing,
                args=[
                    slot_norm,
                    window_start_iso,
                    window_end_iso,
                    visit_results,
                    prior_path,
                ],
                start_to_close_timeout=timedelta(minutes=10),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            result.matters_errored += 1
            result.error_messages.append(
                f"compose_and_write_briefing failed: {exc}"[:500]
            )
            workflow.logger.error(
                "briefing.run: compose failed slot=%s err=%s", slot_norm, exc,
            )
            return result

        result.brief_record_path = brief_path

        # 5. Run-log entry. Best-effort — record_chore_run already
        # swallows failures so a vault hiccup here doesn't mask a
        # successful briefing.
        chore_slug = f"daily-{slot_norm}-briefing"
        try:
            await workflow.execute_activity(
                record_chore_run,
                args=[
                    chore_slug,
                    (
                        f"composed {brief_path} — "
                        f"matters={result.matters_scanned} "
                        f"mutated={result.matters_mutated} "
                        f"no_change={result.matters_no_change} "
                        f"errored={result.matters_errored}"
                    ),
                ],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as exc:  # noqa: BLE001
            workflow.logger.warning(
                "briefing.run: record_chore_run failed (non-fatal): %s", exc,
            )

        workflow.logger.info(
            "briefing.run: done slot=%s path=%s scanned=%d mutated=%d "
            "no_change=%d errors=%d",
            slot_norm,
            result.brief_record_path,
            result.matters_scanned,
            result.matters_mutated,
            result.matters_no_change,
            result.matters_errored,
        )
        return result
