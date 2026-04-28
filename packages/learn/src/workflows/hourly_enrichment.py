"""Workflow: Hourly Enrichment — single batched LLM call for stream event enrichment.

Collects all vault event records with enrichment_status=pending,
batches them into one clerk call per 200 records, applies enrichments
(entities, tags, related matters, action items).

Schedule: every 1 hour via Temporal.
LLM cost: 1 call per batch (~16K tokens input for 200 events).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.enrichment import (
        apply_enrichments,
        batch_enrich_events,
        ensure_enrichment_entities,
        fetch_pending_enrichment_records,
        pack_enrichment_batches,
    )


# Cap records processed per workflow run. Holding thousands of 20k-char
# bodies in workflow memory triggers Temporal's "workflow didn't yield
# within 2 seconds" deadlock warnings during replay — the state is too
# big to (de)serialize quickly between activations. 1000 records fits
# well under the budget, and a post-rematerialize backlog of 5800
# drains in ~6 hourly runs (~5hr end-to-end).
MAX_PENDING_PER_WORKFLOW_RUN = 1_000


@dataclass
class EnrichmentResult:
    records_found: int = 0
    records_processed: int = 0
    records_enriched: int = 0
    entities_created: int = 0
    tasks_created: int = 0
    batches: int = 0
    error: str | None = None


@workflow.defn(name="HourlyEnrichmentWorkflow")
class HourlyEnrichmentWorkflow:
    @workflow.run
    async def run(self) -> EnrichmentResult:
        result = EnrichmentResult()

        # 1. Fetch pending records across all enrichable types. Each record
        #    carries its full body up to MAX_BODY_CHARS_PER_EVENT (20k chars).
        pending: list[dict[str, Any]] = await workflow.execute_activity(
            fetch_pending_enrichment_records,
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        result.records_found = len(pending)

        if not pending:
            return result

        # 1b. Cap per-run to avoid Temporal workflow-deadlock warnings.
        # Anything over MAX_PENDING_PER_WORKFLOW_RUN gets picked up by
        # the next hourly tick (or a manual schedule trigger).
        if len(pending) > MAX_PENDING_PER_WORKFLOW_RUN:
            workflow.logger.info(
                "HourlyEnrichment: backlog %d exceeds per-run cap %d; "
                "processing first %d, remaining deferred to next run",
                len(pending), MAX_PENDING_PER_WORKFLOW_RUN,
                MAX_PENDING_PER_WORKFLOW_RUN,
            )
            pending = pending[:MAX_PENDING_PER_WORKFLOW_RUN]
        result.records_processed = len(pending)

        # 2. Size-based packing. A batch of 200 short emails is one call;
        #    a batch with two long Omi transcripts may be two calls. Keeps
        #    each prompt under ~25k tokens of input without dropping body.
        batches: list[list[dict[str, Any]]] = pack_enrichment_batches(pending)

        for batch in batches:
            # 3. ONE clerk call per batch
            enrichments: list[dict[str, Any]] = await workflow.execute_activity(
                batch_enrich_events,
                args=[batch],
                # 600s ceiling for one clerk LLM call. Bumped 180→600 because
                # learn-clerk runs `xai/grok-4-1-fast-reasoning` on
                # openclaw-workers (fleet standard), and dense Rapali-class
                # batches (40 events × up to 20K body chars + matter catalog +
                # output of 40 enrichments) regularly exceeded 180s, causing
                # consecutive runs to fail and the pending backlog to balloon.
                # This is a background job — wallclock budget is fine.
                start_to_close_timeout=timedelta(seconds=600),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            if not enrichments:
                continue

            # 4. Apply enrichments to vault records + materialize
            #    action_items into first-class task/ records.
            applied: dict[str, int] = await workflow.execute_activity(
                apply_enrichments,
                args=[enrichments, [r["path"] for r in batch]],
                start_to_close_timeout=timedelta(seconds=120),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            result.records_enriched += applied.get("records_enriched", 0)
            result.tasks_created += applied.get("tasks_created", 0)

            # 5. Create missing entity records
            created: int = await workflow.execute_activity(
                ensure_enrichment_entities,
                args=[enrichments],
                start_to_close_timeout=timedelta(seconds=120),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            result.entities_created += created
            result.batches += 1

        return result
