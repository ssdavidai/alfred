"""SignalExtractWorkflow — stream events → signal records (T6.0.5).

Schedule: every 5 minutes (registered in ``scripts/register_schedules.py``
as ``al-signal-extract`` with overlap=SKIP).

Gated at registration time on ``STEWARD_SIGNAL_EXTRACT_ENABLED=true``.
The workflow itself does not re-check the env var — env reads inside
``@workflow.run`` would violate Temporal determinism rules. The
registration-time gate is the single source of truth: a tenant without
the flag never gets the schedule created, so the workflow never runs.

Pipeline per tick:

  1. ``list_unprocessed_stream_events`` — return paths of stream-event
     records whose ``frontmatter.signal_extracted_at`` is null/missing
     AND whose inferred source_type is in the Phase 6 allowlist. Limit
     ``BATCH_LIMIT`` (100) per tick to keep p95 well within the 5-min
     schedule envelope even on a large backlog.
  2. For each event:

     a. ``extract_signal_from_event`` — pre-filter + LLM extraction +
        target resolution. Returns a signal dict, or ``None`` when the
        event is pre-filtered as noise / classified ``effect=none`` /
        the LLM call failed / the record vanished.

     b. If non-None: ``write_signal_record`` persists the proposal as
        ``signal/<ts>-<short_hash>.md``. The slug is deterministic in
        the event path + raw quote, so a Temporal retry that re-runs
        the activity after a partial failure overwrites the same path
        rather than producing a duplicate record.

     c. ``mark_stream_event_processed`` — patch the source event's
        frontmatter with ``signal_extracted_at = now`` so the next tick
        of ``list_unprocessed_stream_events`` skips it. We mark
        processed even when the extractor returned ``None`` (noise) so
        we don't re-LLM the same noise event every 5 minutes — the
        whole point of the pre-filter cache.

  Per-event try/except: a single bad event (transient ctrl-api error,
  LLM hallucination that breaks validation, etc.) increments the error
  counter but doesn't sink the rest of the batch. The 5-min cadence is
  the natural retry boundary; persistent failures show up as a stalled
  ``signal_extracted_at`` cursor on individual events.

Phase 6 hard rules respected:

  * NO env reads inside ``@workflow.run`` — config + flag are pulled
    by the activities themselves via ``load_config()``.
  * NO mocks — every workflow.execute_activity call dispatches to a
    real activity registered in ``src/worker.py``.
  * NO direct vault filesystem — writes flow through ctrl-api via
    ``VaultClient``.
  * NO direct Anthropic — LLM goes through OpenClaw via clerk.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.signals import (
        extract_signal_from_event,
        list_unprocessed_stream_events,
        mark_stream_event_processed,
        write_signal_record,
    )


# Max events processed per tick. Sized so the worst-case run (every
# event hits the LLM at the 60s ceiling) still finishes inside the
# 5-min schedule envelope when activities run in series — but the
# steady-state path drains the backlog much faster because the
# pre-filter rejects ~50%+ of stream events without an LLM call.
BATCH_LIMIT: int = 100


@dataclass
class SignalExtractResult:
    """Per-tick outcome — surfaced in Temporal UI for visibility.

    Counter semantics:
      * ``listed`` — total paths returned by
        ``list_unprocessed_stream_events`` for this tick (pre-batch).
      * ``extracted`` — events the workflow attempted to extract,
        capped at ``BATCH_LIMIT``.
      * ``written`` — signals successfully persisted to the vault.
      * ``noise_filtered`` — events the extractor returned ``None``
        for (pre-filter or ``effect=none`` classification). These are
        marked processed so we don't re-LLM them.
      * ``errors`` — count of per-event exceptions surfaced from the
        try/except. ``error_messages`` carries the first ~10 messages
        for surfacing in Temporal UI.
    """

    started: bool = False
    listed: int = 0
    extracted: int = 0
    written: int = 0
    noise_filtered: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)


@workflow.defn(name="SignalExtractWorkflow")
class SignalExtractWorkflow:
    """Stream events → signal records (Phase 6 T6.0.5).

    Schedule: every 5 minutes via ``al-signal-extract``. Gated on
    ``STEWARD_SIGNAL_EXTRACT_ENABLED`` at registration time only —
    re-reading the env inside ``@workflow.run`` would break Temporal
    determinism.
    """

    @workflow.run
    async def run(self) -> SignalExtractResult:
        workflow.logger.info("signal_extract.start")
        result = SignalExtractResult()
        result.started = True

        retry = RetryPolicy(
            maximum_attempts=3,
            initial_interval=timedelta(seconds=1),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=15),
        )

        # 1. List unprocessed stream events. A transport-level failure
        #    inside the activity returns [] (logged by the activity);
        #    Temporal-level failure surfaces as an exception we record
        #    on the result and bail.
        try:
            paths: list[str] = await workflow.execute_activity(
                list_unprocessed_stream_events,
                args=[None, BATCH_LIMIT, None],
                # 300s — ctrl-api list reads frontmatter for 6500+ events
                # AND the activity does a sidecar bootstrap on first run.
                # Earlier 180s timed out repeatedly, leaving listed=0
                # while the backfill stayed stuck.
                start_to_close_timeout=timedelta(seconds=300),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            result.errors += 1
            result.error_messages.append(
                f"list_unprocessed_stream_events: {exc}"[:500]
            )
            workflow.logger.warning(
                "signal_extract.list_failed err=%s", exc,
            )
            return result

        result.listed = len(paths)
        if not paths:
            workflow.logger.info("signal_extract.no_events")
            return result

        # 2. Extract → write → mark, PER CHUNK, so progress is durable.
        #    Earlier version did all extractions first, then all marks
        #    after — if the workflow timed out or got restarted mid-run,
        #    every LLM call was wasted (no events marked, all re-extracted
        #    next tick). Now each chunk's results are written+marked
        #    before the next chunk dispatches.
        #
        #    EXTRACT_CHUNK_SIZE=16 sits below the learn-clerk agent's
        #    maxChildrenPerAgent=20 cap (4 slots of breathing room for
        #    cross-tick session leakage).
        import asyncio
        # Reduced from 16 to 8 to relieve openclaw subagent-announce
        # contention; 16 parallel children blew past the 120s announce
        # timeout under load.
        EXTRACT_CHUNK_SIZE: int = 8 if workflow.patched("signal_extract_chunk_8") else 16
        # 600s gives the slow tail of grok-4.1-fast responses room to land —
        # observed extracts returning past 300s and being cancelled by the
        # activity timeout, losing the result. clerk's polling is bounded
        # at 580s, so 600s is the right ceiling.
        extract_timeout = (
            timedelta(seconds=600)
            if workflow.patched("signal_extract_timeout_600")
            else timedelta(seconds=300)
        )
        targets = paths[:BATCH_LIMIT]
        for chunk_start in range(0, len(targets), EXTRACT_CHUNK_SIZE):
            chunk = targets[chunk_start:chunk_start + EXTRACT_CHUNK_SIZE]
            chunk_handles = [
                workflow.execute_activity(
                    extract_signal_from_event,
                    args=[path],
                    start_to_close_timeout=extract_timeout,
                    retry_policy=retry,
                )
                for path in chunk
            ]
            chunk_results = await asyncio.gather(
                *chunk_handles, return_exceptions=True
            )

            for path, extracted in zip(chunk, chunk_results):
                result.extracted += 1
                signal_path: str | None = None

                if isinstance(extracted, BaseException):
                    result.errors += 1
                    if len(result.error_messages) < 10:
                        result.error_messages.append(
                            f"extract path={path}: {extracted}"[:500]
                        )
                    workflow.logger.warning(
                        "signal_extract.extract_failed path=%s err=%s",
                        path, extracted,
                    )
                    # Don't mark on extractor failure — next tick retries.
                    continue

                extracted_signal: dict[str, Any] | None = extracted

                if extracted_signal is None:
                    result.noise_filtered += 1
                else:
                    try:
                        signal_path = await workflow.execute_activity(
                            write_signal_record,
                            args=[extracted_signal],
                            start_to_close_timeout=timedelta(seconds=15),
                            retry_policy=retry,
                        )
                    except Exception as exc:  # noqa: BLE001
                        result.errors += 1
                        if len(result.error_messages) < 10:
                            result.error_messages.append(
                                f"write path={path}: {exc}"[:500]
                            )
                        workflow.logger.warning(
                            "signal_extract.write_failed path=%s err=%s",
                            path, exc,
                        )
                        continue

                    if signal_path:
                        result.written += 1

                # Mark processed — even for noise — so we don't re-LLM
                # the same event next tick. Idempotent slug on
                # write_signal_record protects against duplicates if
                # the next chunk's mark fails and we re-extract.
                try:
                    await workflow.execute_activity(
                        mark_stream_event_processed,
                        args=[path, signal_path],
                        start_to_close_timeout=timedelta(seconds=10),
                        retry_policy=retry,
                    )
                except Exception as exc:  # noqa: BLE001
                    result.errors += 1
                    if len(result.error_messages) < 10:
                        result.error_messages.append(
                            f"mark path={path}: {exc}"[:500]
                        )
                    workflow.logger.warning(
                        "signal_extract.mark_failed path=%s err=%s",
                        path, exc,
                    )

        workflow.logger.info(
            "signal_extract.done listed=%d extracted=%d written=%d "
            "noise_filtered=%d errors=%d",
            result.listed,
            result.extracted,
            result.written,
            result.noise_filtered,
            result.errors,
        )
        return result
