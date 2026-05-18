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
        # Phase 1 — multi-signal extractor. Selected via
        # workflow.patched("signal_extract_multi_signal_v1") so
        # in-flight workflows replaying old history keep calling the
        # single-signal extractor (one signal or None) while new runs
        # use the multi-signal extractor (list[dict]).
        extract_signals_from_event,
        list_unprocessed_stream_events,
        mark_stream_event_processed,
        write_signal_record,
    )
    from src.activities.signal_observations import (
        extract_observation_from_signal,
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
    # Phase 1 — populated only on the patched (multi-signal) branch.
    # ``signals_per_event`` is the count of signal records written per
    # extracted stream event (0 = noise/filtered; ≥2 = multi-signal).
    # We track it as a list so the Temporal UI surfaces the
    # distribution without dragging extra activity calls.
    multi_signal_branch: bool = False
    multi_signal_max: int = 0
    multi_signal_events_with_multiple: int = 0


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
        # Bumped 100 → 200 (workflow.patched) to double per-tick throughput.
        effective_limit = 200 if workflow.patched("signal_extract_batch_200") else BATCH_LIMIT
        try:
            paths: list[str] = await workflow.execute_activity(
                list_unprocessed_stream_events,
                args=[None, effective_limit, None],
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

        # Defensive cap (activity should already return ≤ effective_limit).
        paths = paths[:effective_limit]
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
        # Restored to 16: the original `chunk_8` patch was a stop-gap
        # while the gateway was saturated by orphan subagent state. With
        # the v5.6 dispatcher fix in place + cold-restart hygiene, 16
        # concurrent stays comfortably under the 20-cap because Skip
        # overlap means at most one tick is active at a time.
        EXTRACT_CHUNK_SIZE: int = (
            16
            if workflow.patched("signal_extract_chunk_16_v2")
            else (8 if workflow.patched("signal_extract_chunk_8") else 16)
        )
        # 600s gives the slow tail of grok-4.1-fast responses room to land —
        # observed extracts returning past 300s and being cancelled by the
        # activity timeout, losing the result. clerk's polling is bounded
        # at 580s, so 600s is the right ceiling.
        extract_timeout = (
            timedelta(seconds=600)
            if workflow.patched("signal_extract_timeout_600")
            else timedelta(seconds=300)
        )
        # Phase 1 — multi-signal extraction gate. The new
        # ``extract_signals_from_event`` activity returns ``list[dict]``
        # so one stream event can produce 0..N signal records. Old
        # in-flight runs replaying pre-patch history keep the legacy
        # single-signal codepath; new runs go through the multi path.
        use_multi_signal = workflow.patched(
            "signal_extract_multi_signal_v1"
        )
        if use_multi_signal:
            result.multi_signal_branch = True

        targets = paths[:BATCH_LIMIT]
        for chunk_start in range(0, len(targets), EXTRACT_CHUNK_SIZE):
            chunk = targets[chunk_start:chunk_start + EXTRACT_CHUNK_SIZE]
            chunk_handles = [
                workflow.execute_activity(
                    (
                        extract_signals_from_event
                        if use_multi_signal
                        else extract_signal_from_event
                    ),
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

                # Normalise both branches to a list[dict] of signals
                # for the inner loop. Legacy branch returns dict|None;
                # multi branch returns list[dict].
                if use_multi_signal:
                    extracted_list: list[dict[str, Any]] = (
                        extracted if isinstance(extracted, list) else []
                    )
                else:
                    extracted_list = (
                        [extracted] if isinstance(extracted, dict) else []
                    )

                if not extracted_list:
                    result.noise_filtered += 1

                if use_multi_signal and len(extracted_list) >= 2:
                    result.multi_signal_events_with_multiple += 1
                if use_multi_signal and len(extracted_list) > result.multi_signal_max:
                    result.multi_signal_max = len(extracted_list)

                written_paths_for_event: list[str] = []
                write_failed_for_event = False
                for sig_idx, extracted_signal in enumerate(extracted_list):
                    try:
                        sig_path = await workflow.execute_activity(
                            write_signal_record,
                            args=[extracted_signal],
                            start_to_close_timeout=timedelta(seconds=15),
                            retry_policy=retry,
                        )
                    except Exception as exc:  # noqa: BLE001
                        result.errors += 1
                        if len(result.error_messages) < 10:
                            result.error_messages.append(
                                f"write path={path}#{sig_idx}: {exc}"[:500]
                            )
                        workflow.logger.warning(
                            "signal_extract.write_failed path=%s "
                            "entry=%d err=%s",
                            path, sig_idx, exc,
                        )
                        write_failed_for_event = True
                        continue

                    if sig_path:
                        result.written += 1
                        written_paths_for_event.append(sig_path)

                if write_failed_for_event and not written_paths_for_event:
                    # Every write on this event failed — don't mark
                    # the event processed; next tick retries.
                    continue

                # ``signal_path`` (singular) is preserved as the FIRST
                # written path so mark_stream_event_processed and the
                # observation extractor still consume a single value
                # — both consumers are per-signal, but the sidecar
                # column only carries one. The observation loop below
                # iterates every written path.
                signal_path = (
                    written_paths_for_event[0]
                    if written_paths_for_event
                    else None
                )

                # OBS-2: every signal that survives the noise filter
                # becomes a passive observation. Phase 1 — iterate
                # every written path, so multi-signal events produce
                # one observation per signal. Failure is non-fatal.
                #
                # WARNING — DETERMINISM CONTRACT: this branch was
                # extended in the Phase 1 multi-signal refactor (see
                # CLAUDE.md). Any further logic added here MUST be
                # wrapped in workflow.patched("<name>") so history
                # replay of pre-patch runs deterministically skips
                # the new code path.
                for obs_path in written_paths_for_event:
                    try:
                        await workflow.execute_activity(
                            extract_observation_from_signal,
                            args=[obs_path],
                            start_to_close_timeout=timedelta(seconds=30),
                            retry_policy=retry,
                        )
                    except Exception as exc:  # noqa: BLE001
                        workflow.logger.warning(
                            "signal_extract.obs_failed path=%s err=%s",
                            obs_path, exc,
                        )

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
            "noise_filtered=%d errors=%d multi=%s multi_max=%d "
            "multi_events_with_multiple=%d",
            result.listed,
            result.extracted,
            result.written,
            result.noise_filtered,
            result.errors,
            result.multi_signal_branch,
            result.multi_signal_max,
            result.multi_signal_events_with_multiple,
        )
        return result
