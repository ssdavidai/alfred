"""Stream event read/mark activities.

STORE-P4-1: these activities now read from the date-partitioned JSONL
log at /vault/_raw/<date>.jsonl via the consumer-aware ctrl-api endpoint
and record processed events to the stream_event_processed table in
state.db. The change is purely inside the activity bodies — workflow
signatures, activity names, and the workflow.execute_activity call sites
in EventProcessorWorkflow are unchanged, so Temporal replay stays safe.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient


# Stable consumer key. Anything reading the JSONL log via this activity
# share the offset bookkeeping in stream_consumer_offset; future consumers
# (e.g. a separate analytics tail) MUST pick a different name to avoid
# stealing each other's progress.
_EVENT_PROCESSOR_CONSUMER = "event_processor"


def _adapt_jsonl_entry(entry: dict[str, Any]) -> dict[str, Any]:
    """Translate a StreamLogEntry into the legacy event shape the
    EventProcessor workflow expects.

    The workflow body branches on ``event.get("stream_type")`` and reads
    ``event.get("id")`` / ``event.get("raw")``. The new JSONL log carries
    ``source_type`` and ``payload`` instead. We compute back-compat aliases
    so the workflow code stays unchanged (replay-safe).
    """
    if "stream_type" in entry and "raw" in entry:
        return entry
    out = dict(entry)
    if "source_type" in out and "stream_type" not in out:
        out["stream_type"] = out["source_type"]
    if "payload" in out and "raw" not in out:
        out["raw"] = out["payload"]
    if "source_id" in out and "source_ref" not in out:
        out["source_ref"] = out["source_id"]
    return out


@activity.defn
async def fetch_unprocessed_events() -> list[dict[str, Any]]:
    """Fetch unprocessed stream events (max per run from config).

    STORE-P4-1: reads via ``GET /api/v1/streams/events?consumer=event_processor``,
    which advances the per-consumer offset in state.db so a restart resumes
    where it left off. Entries are adapted to the legacy event shape so
    the workflow signature and replay history stay unchanged.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        rows = await client.fetch_unprocessed_events(
            limit=config.max_events_per_run,
            consumer=_EVENT_PROCESSOR_CONSUMER,
        )
        return [_adapt_jsonl_entry(r) for r in rows]
    finally:
        await client.close()


@activity.defn
async def mark_event_processed(
    event_id: str,
    vault_path: str,
    classification: str,
) -> None:
    """Mark a stream event as processed.

    STORE-P4-1: derives the partition date from the event id's
    surrounding received_at if available via heuristics — but in practice
    the workflow only has the id at hand, so we let the server fall back
    to today UTC. The compactor cross-checks the JSONL anyway.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        await client.mark_event_processed(
            event_id,
            vault_path,
            classification,
            consumer=_EVENT_PROCESSOR_CONSUMER,
        )
    finally:
        await client.close()


@activity.defn
async def quarantine_event(event: dict[str, Any], errors: list[str]) -> None:
    """Quarantine a stream event that failed validation."""
    config = load_config()
    client = VaultClient(config)
    try:
        event_id = event.get("id", "")
        await client.quarantine_event(event_id, errors)
    finally:
        await client.close()
