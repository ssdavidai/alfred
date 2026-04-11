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
    )


BATCH_SIZE = 200


@dataclass
class EnrichmentResult:
    records_found: int = 0
    records_enriched: int = 0
    entities_created: int = 0
    batches: int = 0
    error: str | None = None


@workflow.defn(name="HourlyEnrichmentWorkflow")
class HourlyEnrichmentWorkflow:
    @workflow.run
    async def run(self) -> EnrichmentResult:
        result = EnrichmentResult()

        # 1. Fetch pending event records
        pending: list[dict[str, Any]] = await workflow.execute_activity(
            fetch_pending_enrichment_records,
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        result.records_found = len(pending)

        if not pending:
            return result

        # 2. Process in batches of 200
        for i in range(0, len(pending), BATCH_SIZE):
            batch = pending[i : i + BATCH_SIZE]

            # 3. ONE clerk call for the entire batch
            enrichments: list[dict[str, Any]] = await workflow.execute_activity(
                batch_enrich_events,
                args=[batch],
                start_to_close_timeout=timedelta(seconds=180),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )

            if not enrichments:
                continue

            # 4. Apply enrichments to vault records
            applied: int = await workflow.execute_activity(
                apply_enrichments,
                args=[enrichments, [r["path"] for r in batch]],
                start_to_close_timeout=timedelta(seconds=120),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            result.records_enriched += applied

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
