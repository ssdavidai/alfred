"""ChorePromotionReflectionWorkflow — weekly scan for promotion-worthy generated templates [S5-2].

Runs once a week (Sunday 3am tenant time, right after nightly_maintenance
finishes). Walks the tenant's /alfred-data/user-chores/ directory,
filters to templates that have proven useful (min_runs + min_success_rate
from S5-1 analytics), asks Opus to draft a PR description for each
promotion candidate, and persists the drafts to disk for S5-3 to consume.

Design contract:
- Never makes more than _MAX_DRAFTS_PER_TICK LLM calls per tick
  (capped inside the workflow, not the activities, so ops can
  monitor the bound)
- Each Opus draft is a separate activity call so failures don't
  cascade — the workflow records per-candidate errors and continues
- Does NOT create GitHub PRs directly. That's S5-3's activity, which
  the workflow optionally calls at the end if the drafts look good
- Returns a structured summary so alerting can trigger on unusual
  activity (e.g. suddenly 5 promotion candidates from one tenant)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.chore_promotion import (
        draft_promotion_proposal,
        identify_promotion_candidates,
        save_promotion_draft,
        scan_user_chores_directory,
    )


# Hard cap on the number of drafts the workflow produces per tick.
# Each draft is one Opus call — 5 drafts ≈ $2-5 per tick depending on
# template size. Well below the per-tenant daily budget even if every
# week hits the cap.
_MAX_DRAFTS_PER_TICK = 5

# Promotion thresholds — the defaults are conservative (20 runs, 95%
# success rate) to avoid flooding the review queue with half-baked
# templates. They're parameterized here rather than in activities so
# a workflow signal could adjust them dynamically later.
_DEFAULT_MIN_RUNS = 20
_DEFAULT_MIN_SUCCESS_RATE = 0.95


@dataclass
class PromotionReflectionInput:
    """Optional parameters for the workflow. Defaults cover the common case."""
    min_runs: int = _DEFAULT_MIN_RUNS
    min_success_rate: float = _DEFAULT_MIN_SUCCESS_RATE


@dataclass
class PromotionReflectionResult:
    scanned: int = 0
    candidates_found: int = 0
    drafts_attempted: int = 0
    drafts_saved: int = 0
    drafts_failed: int = 0
    errors: list[str] = field(default_factory=list)
    saved_paths: list[str] = field(default_factory=list)


@workflow.defn(name="ChorePromotionReflectionWorkflow")
class ChorePromotionReflectionWorkflow:
    @workflow.run
    async def run(
        self, input: PromotionReflectionInput = PromotionReflectionInput()
    ) -> PromotionReflectionResult:
        result = PromotionReflectionResult()

        # Phase 1: scan every generated template in user-chores/ and
        # enrich each with its S5-1 run history statistics.
        try:
            templates = await workflow.execute_activity(
                scan_user_chores_directory,
                start_to_close_timeout=timedelta(minutes=5),
                heartbeat_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as exc:
            workflow.logger.error("ChorePromotionReflection: scan failed: %s", exc)
            result.errors.append(f"scan: {type(exc).__name__}: {exc}")
            return result

        result.scanned = len(templates)
        if not templates:
            workflow.logger.info("ChorePromotionReflection: no generated templates on this tenant")
            return result

        # Phase 2: apply thresholds to find promotion-worthy candidates.
        # Pure Python, no I/O — fast path that rejects most templates
        # before we spend any Opus tokens.
        try:
            candidates = await workflow.execute_activity(
                identify_promotion_candidates,
                args=[templates, input.min_runs, input.min_success_rate],
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
        except Exception as exc:
            workflow.logger.error(
                "ChorePromotionReflection: candidate filter failed: %s", exc
            )
            result.errors.append(f"identify: {type(exc).__name__}: {exc}")
            return result

        result.candidates_found = len(candidates)
        if not candidates:
            workflow.logger.info(
                "ChorePromotionReflection: 0 candidates met thresholds (min_runs=%d, min_success_rate=%.2f)",
                input.min_runs, input.min_success_rate,
            )
            return result

        # Phase 3: draft + save up to _MAX_DRAFTS_PER_TICK proposals.
        # Sort by success_rate descending so the best candidates get
        # drafted first if we hit the cap.
        candidates.sort(
            key=lambda c: c.get("success_rate", 0),
            reverse=True,
        )
        to_draft = candidates[:_MAX_DRAFTS_PER_TICK]
        workflow.logger.info(
            "ChorePromotionReflection: drafting %d of %d candidates",
            len(to_draft), len(candidates),
        )

        for candidate in to_draft:
            result.drafts_attempted += 1
            module_name = candidate.get("module_name", "unknown")

            # Draft the PR description via Opus
            try:
                proposal = await workflow.execute_activity(
                    draft_promotion_proposal,
                    args=[candidate],
                    start_to_close_timeout=timedelta(minutes=15),
                    heartbeat_timeout=timedelta(seconds=60),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as exc:
                workflow.logger.error(
                    "ChorePromotionReflection: draft activity raised for %s: %s",
                    module_name, exc,
                )
                result.drafts_failed += 1
                result.errors.append(
                    f"draft {module_name}: {type(exc).__name__}: {exc}"
                )
                continue

            if not proposal.get("ok"):
                result.drafts_failed += 1
                err = proposal.get("error", "unknown")
                workflow.logger.warning(
                    "ChorePromotionReflection: draft returned ok=False for %s: %s",
                    module_name, err,
                )
                result.errors.append(f"draft {module_name}: {err}")
                continue

            # Persist the successful draft
            try:
                save_result = await workflow.execute_activity(
                    save_promotion_draft,
                    args=[proposal],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
            except Exception as exc:
                workflow.logger.error(
                    "ChorePromotionReflection: save activity raised for %s: %s",
                    module_name, exc,
                )
                result.drafts_failed += 1
                result.errors.append(
                    f"save {module_name}: {type(exc).__name__}: {exc}"
                )
                continue

            if save_result.get("ok"):
                result.drafts_saved += 1
                result.saved_paths.append(save_result.get("path", ""))
            else:
                result.drafts_failed += 1
                result.errors.append(
                    f"save {module_name}: {save_result.get('error', 'unknown')}"
                )

        workflow.logger.info(
            "ChorePromotionReflection complete: scanned=%d candidates=%d drafts_saved=%d drafts_failed=%d",
            result.scanned, result.candidates_found,
            result.drafts_saved, result.drafts_failed,
        )
        return result
