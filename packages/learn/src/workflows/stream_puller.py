"""Workflow: Stream Puller — generic HTTP pull engine for universal streams.

Loads stream config, resolves auth, executes HTTP pull, runs parser,
ingests parsed events, and updates cursor for incremental pulls.

Originally each stream got its own Temporal Schedule — id
``al-stream-pull-composio-<streamId.slice(0,20)>``, created/deleted by
ctrl-api as streams were enabled/disabled (the same per-entity
dynamic-registrar anti-pattern as the per-matter Steward schedules).
Issue #53 collapsed that per-stream fan-out into a single
``StreamSweepWorkflow`` on one ``al-stream-sweep`` schedule (2-min
interval, overlap SKIP): per the SPIKE-cron-migration §2 verdict, the
per-stream *schedule* carried no state the persisted
``schedule_interval_seconds`` / ``last_pull_at`` fields don't already
carry, so N per-stream schedules + a ctrl-api registrar collapse
cleanly to one schedule that internally loops the streams whose
interval has elapsed.

Two workflow types live here:

* ``StreamSweepWorkflow`` — the scheduled entity (``al-stream-sweep``,
  2-min interval, overlap SKIP). Each run lists enabled streams that
  are due and runs the per-stream pull body for each.

* ``StreamPullerWorkflow`` — the *original* per-stream workflow. It is
  no longer scheduled (the per-stream ``al-stream-pull-*`` schedules
  are deleted on boot) but the class is **kept registered** as a
  harmless tombstone: it is still callable ad-hoc (e.g. an operator
  re-running one stream from the Temporal UI) and registering it costs
  nothing. Both workflows drive the *same* per-stream pull via the
  shared ``_run_stream_pull`` helper — there is exactly one copy of the
  pull logic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from src.activities.pull import (
        SYNC_CONFIGS,
        build_sync_args,
        composio_pull,
        http_pull,
        http_pull_detail,
        ingest_events,
        list_due_streams,
        load_stream_config,
        notion_fetch_blocks,
        resolve_auth_header,
        update_cursor,
    )


@dataclass
class PullerInput:
    stream_id: str


@dataclass
class PullerResult:
    stream_id: str = ""
    events_pulled: int = 0
    events_ingested: int = 0
    events_rejected: int = 0
    detail_fetches: int = 0
    cursor_updated: bool = False
    error: str | None = None


@dataclass
class StreamSweepResult:
    """Per-sweep-run outcome — surfaced in Temporal UI for visibility.

    Counter semantics:
      * ``streams_due`` — streams ``list_due_streams`` returned for this
        tick (already capped at ``SWEEP_STREAM_BATCH_LIMIT``).
      * ``streams_processed`` — streams the sweep actually ran the pull
        body for.
      * ``events_pulled`` / ``events_ingested`` / ``events_rejected`` —
        summed across every processed stream.
      * ``errors`` — count of per-stream pull exceptions surfaced from
        the inner try/except. ``error_messages`` carries the first ~20.
    """
    started: bool = False
    streams_due: int = 0
    streams_processed: int = 0
    events_pulled: int = 0
    events_ingested: int = 0
    events_rejected: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)


# Max streams processed per sweep tick. Streams are far fewer than
# matters (typically <20/tenant per SPIKE-cron-migration §2) so this cap
# is mostly a defensive ceiling — a fleet with an unexpectedly large
# stream count drains across consecutive 2-min ticks rather than wedging
# one run. Mirrors the BATCH_LIMIT discipline in StewardSweepWorkflow /
# SignalExtractWorkflow. The cap is also applied inside
# ``list_due_streams`` (sorted-id order → deterministic, no starvation);
# the workflow-side slice is a defensive belt-and-braces.
SWEEP_STREAM_BATCH_LIMIT = 100


async def _run_stream_pull(stream_id: str) -> PullerResult:
    """Run one stream's pull-parse-ingest-cursor loop.

    This is the single copy of the per-stream pull logic — both
    ``StreamPullerWorkflow`` (per-stream, tombstone) and
    ``StreamSweepWorkflow`` (the scheduled sweep) call it. It performs
    only deterministic in-memory logic + ``workflow.execute_activity``
    calls, so it is replay-safe to call from inside ``@workflow.run``.
    It deliberately reuses the existing pull activities verbatim — no
    pull logic is reimplemented here.
    """
    result = PullerResult(stream_id=stream_id)

    # 1. Load stream config from ctrl API
    config: dict[str, Any] = await workflow.execute_activity(
        load_stream_config,
        args=[stream_id],
        start_to_close_timeout=timedelta(seconds=30),
        retry_policy=RetryPolicy(maximum_attempts=3),
    )

    if not config.get("enabled", False):
        result.error = "stream_disabled"
        return result

    # ----- Composio-backed stream: call Composio action instead of HTTP -----
    composio_action = config.get("composio_action", "")
    if composio_action:
        return await _run_composio_pull(stream_id, config, composio_action, result)

    pull_endpoint = config.get("pull_endpoint", "")
    if not pull_endpoint:
        result.error = "no_pull_endpoint"
        return result

    # 2. Resolve auth header
    auth_config = config.get("auth_config", {})
    auth_config["auth_type"] = config.get("auth_type", "none")
    headers: dict[str, str] = await workflow.execute_activity(
        resolve_auth_header,
        args=[auth_config],
        start_to_close_timeout=timedelta(seconds=30),
        retry_policy=RetryPolicy(maximum_attempts=2),
    )

    # Merge static pull_headers from config
    static_headers = config.get("pull_headers", {})
    if isinstance(static_headers, dict):
        headers = {**static_headers, **headers}

    # 3. Build params (inject cursor if configured)
    params = dict(config.get("pull_params", {}) or {})
    cursor_param = config.get("cursor_param", "")
    cursor_value = config.get("cursor_value", "")
    if cursor_param and cursor_value:
        params[cursor_param] = cursor_value

    # 4. Execute generic HTTP pull
    pull_method = config.get("pull_method", "GET")
    raw_response: dict[str, Any] = await workflow.execute_activity(
        http_pull,
        args=[pull_endpoint, pull_method, headers, params],
        start_to_close_timeout=timedelta(seconds=60),
        retry_policy=RetryPolicy(maximum_attempts=3),
    )

    # 5. If config has detail_endpoint, fetch each item individually
    detail_endpoint = config.get("detail_endpoint", "")
    detail_id_field = config.get("detail_id_field", "id")
    detail_items: list[dict[str, Any]] = []
    parser_name = config.get("parser", "passthrough")

    if detail_endpoint:
        # Extract IDs from list response — support multiple response shapes
        items = raw_response.get("messages",
                    raw_response.get("results",
                        raw_response.get("items",
                            raw_response.get("data", []))))
        if isinstance(items, list) and items:
            ids = [item.get(detail_id_field, "") for item in items if item.get(detail_id_field)]
            if ids:
                detail_items = await workflow.execute_activity(
                    http_pull_detail,
                    args=[detail_endpoint, ids, headers],
                    start_to_close_timeout=timedelta(seconds=120),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                result.detail_fetches = len(detail_items)

    # 5b. Notion-specific: fetch blocks per page and ingest incrementally
    #     to avoid exceeding Temporal's 4MB gRPC message limit.
    if parser_name == "notion":
        items = raw_response.get("results", [])
        if isinstance(items, list) and items:
            stream_type = config.get("type", "custom")
            batch: list[dict[str, Any]] = []
            BATCH_SIZE = 3

            for item in items:
                page_id = item.get("id", "")
                if item.get("object") == "page" and page_id:
                    blocks: list[dict[str, Any]] = await workflow.execute_activity(
                        notion_fetch_blocks,
                        args=[page_id, headers],
                        start_to_close_timeout=timedelta(seconds=60),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                    batch.append({**item, "_blocks": blocks})
                    result.detail_fetches += 1
                else:
                    batch.append(item)

                # Ingest in small batches to keep payloads under 4MB
                if len(batch) >= BATCH_SIZE:
                    counts: dict[str, int] = await workflow.execute_activity(
                        ingest_events,
                        args=[stream_id, stream_type, parser_name, batch],
                        start_to_close_timeout=timedelta(seconds=60),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                    result.events_ingested += counts.get("ingested", 0)
                    result.events_rejected += counts.get("rejected", 0)
                    result.events_pulled += len(batch)
                    batch = []

            # Flush remaining
            if batch:
                counts = await workflow.execute_activity(
                    ingest_events,
                    args=[stream_id, stream_type, parser_name, batch],
                    start_to_close_timeout=timedelta(seconds=60),
                    retry_policy=RetryPolicy(maximum_attempts=2),
                )
                result.events_ingested += counts.get("ingested", 0)
                result.events_rejected += counts.get("rejected", 0)
                result.events_pulled += len(batch)

            # Skip the generic ingest below — already handled
            detail_items = []

    # 6. Run parser on response (done in ingest activity, pass parser name)

    # Determine what to ingest — detail items if we fetched them, else raw response
    # Notion ingests incrementally in step 5b, so skip the bulk ingest.
    already_ingested = parser_name == "notion" and result.events_pulled > 0
    if not already_ingested:
        raw_to_ingest = detail_items if detail_items else [raw_response]

        # 7. Ingest parsed events via POST /api/v1/streams/ingest
        ingest_counts: dict[str, int] = await workflow.execute_activity(
            ingest_events,
            args=[stream_id, config.get("type", "custom"), parser_name, raw_to_ingest],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        result.events_ingested += ingest_counts.get("ingested", 0)
        result.events_rejected += ingest_counts.get("rejected", 0)
        result.events_pulled += len(raw_to_ingest)

    # 8. Update cursor if configured
    cursor_field = config.get("cursor_field", "")
    if cursor_field:
        new_cursor = _extract_cursor(raw_response, cursor_field)
        if new_cursor:
            await workflow.execute_activity(
                update_cursor,
                args=[stream_id, new_cursor],
                start_to_close_timeout=timedelta(seconds=30),
            )
            result.cursor_updated = True

    return result


async def _run_composio_pull(
    stream_id: str,
    config: dict[str, Any],
    action_slug: str,
    result: PullerResult,
) -> PullerResult:
    """Execute a Composio action with incremental sync support.

    Shared per-stream Composio body — called by ``_run_stream_pull``
    when a stream config carries a ``composio_action``. Replay-safe:
    only deterministic logic + ``workflow.execute_activity`` calls.
    """
    cursor_value = config.get("cursor_value", "")
    last_pull_at = config.get("last_pull_at", "")

    # 1. Compute sync arguments (backfill or incremental).
    sync_args: dict[str, Any] = await workflow.execute_activity(
        build_sync_args,
        args=[action_slug, cursor_value, last_pull_at],
        start_to_close_timeout=timedelta(seconds=10),
    )

    # Merge per-stream composio_args on top of computed sync_args. Lets a
    # stream config pin per-tenant overrides (e.g. a specific userId or
    # calendarId) without fighting the incremental-filter template.
    stream_args = config.get("composio_args") or {}
    if isinstance(stream_args, dict):
        merged_args = {**sync_args, **stream_args}
    else:
        merged_args = sync_args

    # 2. Execute the Composio action. Pass stream context so the activity can
    #    self-ingest an oversized (fresh-inbox backfill) response instead of
    #    returning a >4MB batch that Temporal would reject (#180).
    parser_name = config.get("parser", "composio")
    stream_type = config.get("type", "composio")
    raw_response: dict[str, Any] = await workflow.execute_activity(
        composio_pull,
        args=[action_slug, merged_args, None, stream_id, stream_type, parser_name],
        start_to_close_timeout=timedelta(seconds=120),
        retry_policy=RetryPolicy(maximum_attempts=3),
    )

    # 3. Handle sync token reset (e.g. Calendar 410 Gone).
    if _is_sync_reset(raw_response):
        # Re-run as backfill with cleared cursor.
        sync_args = await workflow.execute_activity(
            build_sync_args,
            args=[action_slug, "", ""],
            start_to_close_timeout=timedelta(seconds=10),
        )
        if isinstance(stream_args, dict):
            merged_args = {**sync_args, **stream_args}
        else:
            merged_args = sync_args
        raw_response = await workflow.execute_activity(
            composio_pull,
            args=[action_slug, merged_args, None, stream_id, stream_type, parser_name],
            start_to_close_timeout=timedelta(seconds=120),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )

    # 4. Determine pull status BEFORE ingest so we record it even if the
    #    ingest step silently drops everything.
    pull_status = _classify_composio_response(raw_response)

    # 5. Ingest through the composio parser only if the response carries
    #    real data. An error envelope with no `data` would just produce
    #    an empty ingest anyway.
    #    #180: if composio_pull already self-ingested an oversized batch it
    #    returns an `_ingested` summary instead of the data — adopt those
    #    counts and skip the (now redundant, and itself >4MB) ingest call.
    pre_ingested = raw_response.get("_ingested") if isinstance(raw_response, dict) else None
    if isinstance(pre_ingested, dict):
        result.events_ingested = pre_ingested.get("ingested", 0)
        result.events_rejected = pre_ingested.get("rejected", 0)
    elif pull_status == "ok":
        counts: dict[str, int] = await workflow.execute_activity(
            ingest_events,
            args=[stream_id, stream_type, parser_name, [raw_response]],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        result.events_ingested = counts.get("ingested", 0)
        result.events_rejected = counts.get("rejected", 0)
    result.events_pulled = 1

    # 6. Extract cursor from response (for sync mode).
    new_cursor = _extract_sync_cursor(raw_response, action_slug)

    # 7. Update cursor + timestamp with the REAL status, so downstream
    #    monitoring can detect 413s and other upstream failures.
    await workflow.execute_activity(
        update_cursor,
        args=[stream_id, new_cursor, pull_status],
        start_to_close_timeout=timedelta(seconds=30),
    )
    result.cursor_updated = True
    return result


@workflow.defn(name="StreamPullerWorkflow")
class StreamPullerWorkflow:
    """Per-stream pull tick — TOMBSTONE (no longer scheduled, #53).

    Issue #53 retired the per-stream ``al-stream-pull-*`` schedules in
    favour of ``StreamSweepWorkflow``. This class is kept registered
    (the cost is zero) so it stays callable ad-hoc — e.g. an operator
    re-running one stream from the Temporal UI — and so any historical
    per-stream run can still be described. It delegates to the shared
    ``_run_stream_pull`` helper, the exact same body the sweep runs.
    """

    @workflow.run
    async def run(self, input: PullerInput) -> PullerResult:
        return await _run_stream_pull(input.stream_id)


@workflow.defn(name="StreamSweepWorkflow")
class StreamSweepWorkflow:
    """One sweep over every enabled stream that is due for a pull (#53).

    Schedule: ``al-stream-sweep``, 2-min interval, overlap SKIP — one
    schedule for the whole fleet of streams, replacing the former
    per-stream ``al-stream-pull-*`` fan-out that ctrl-api created and
    deleted as streams were enabled/disabled.

    Each run:
      1. ``list_due_streams`` — one ctrl-api ``GET /api/v1/streams``
         scan that returns the ids of enabled streams whose
         ``schedule_interval_seconds`` has elapsed since their
         ``last_pull_at`` (a never-pulled stream is always due),
         capped at ``SWEEP_STREAM_BATCH_LIMIT``.
      2. For each due stream, runs the per-stream pull via the shared
         ``_run_stream_pull`` helper — reusing the existing pull
         activities verbatim. ``_run_stream_pull`` re-loads the stream
         config and re-checks ``enabled`` itself, so a stream disabled
         between the list call and the pull is a safe no-op.

    A per-stream try/except keeps one bad stream from sinking the rest
    of the sweep; the 2-min cadence is the natural retry boundary.

    Replay-safety: the due-ness decision lives entirely inside
    ``list_due_streams`` (an activity) — the workflow never reads a
    wall clock, so a replay reuses the exact list recorded in history.
    The per-stream cursor discipline in ``update_cursor`` (cursor /
    ``last_pull_at`` advanced only after a pull) means a dropped sweep
    run simply re-pulls the same window next tick.
    """

    @workflow.run
    async def run(self) -> StreamSweepResult:
        workflow.logger.info("stream.sweep.start")
        result = StreamSweepResult()
        result.started = True

        retry = RetryPolicy(
            maximum_attempts=3,
            initial_interval=timedelta(seconds=2),
            backoff_coefficient=2.0,
            maximum_interval=timedelta(seconds=30),
        )

        # 1. Enumerate enabled streams that are due. A transport-level
        #    failure inside the activity propagates; the RetryPolicy
        #    covers a transient ctrl-api blip, and a hard failure bails
        #    the run (the next 2-min tick re-lists from scratch).
        try:
            due_streams: list[str] = await workflow.execute_activity(
                list_due_streams,
                args=[SWEEP_STREAM_BATCH_LIMIT],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=retry,
            )
        except Exception as exc:  # noqa: BLE001
            result.errors += 1
            result.error_messages.append(
                f"list_due_streams: {exc}"[:500]
            )
            workflow.logger.error(
                "stream.sweep: list_due_streams failed: %s", exc,
            )
            return result

        # Defensive belt-and-braces cap (the activity already sorts +
        # caps; this guards against a future activity-side regression).
        due_streams = (due_streams or [])[:SWEEP_STREAM_BATCH_LIMIT]
        result.streams_due = len(due_streams)

        # 2. Per-stream loop. Each stream runs the existing per-stream
        #    pull body; a per-stream exception is recorded and the
        #    sweep continues.
        for stream_id in due_streams:
            try:
                pull_result = await _run_stream_pull(stream_id)
            except Exception as exc:  # noqa: BLE001
                result.errors += 1
                if len(result.error_messages) < 20:
                    result.error_messages.append(
                        f"stream {stream_id}: {exc}"[:500]
                    )
                workflow.logger.warning(
                    "stream.sweep: stream=%s failed: %s", stream_id, exc,
                )
                continue

            result.streams_processed += 1
            result.events_pulled += pull_result.events_pulled
            result.events_ingested += pull_result.events_ingested
            result.events_rejected += pull_result.events_rejected
            if pull_result.error and pull_result.error != "stream_disabled":
                # A non-fatal per-stream error (e.g. no_pull_endpoint) —
                # surface it but don't count it as a sweep exception.
                if len(result.error_messages) < 20:
                    result.error_messages.append(
                        f"stream {stream_id}: {pull_result.error}"[:500]
                    )

        workflow.logger.info(
            "stream.sweep: due=%d processed=%d pulled=%d ingested=%d "
            "rejected=%d errors=%d",
            result.streams_due, result.streams_processed,
            result.events_pulled, result.events_ingested,
            result.events_rejected, result.errors,
        )
        return result


def _is_sync_reset(response: dict) -> bool:
    """Detect if the API signals a full sync is required (e.g. Calendar 410 Gone)."""
    for container in [response, response.get("data", {}),
                      (response.get("data", {}) or {}).get("response_data", {})]:
        if not isinstance(container, dict):
            continue
        error = str(container.get("error", ""))
        if "410" in error or "fullsyncrequired" in error.lower() or "sync token" in error.lower():
            return True
    return False


def _classify_composio_response(response: dict) -> str:
    """Classify a Composio response for last_pull_status.

    Returns one of:
      - "ok"                : real data came back
      - "payload_too_large" : Composio 413 (needs smaller batch / tighter filter)
      - "tool_not_found"    : Composio 404 (deprecated action — #476 handles)
      - "error"             : any other upstream failure

    Composio wraps HTTP errors inside a {error: "..."} envelope rather than
    raising — so a 200 response can still be a failure. Previously every pull
    stamped "ok" regardless (#474).
    """
    if not isinstance(response, dict):
        return "error"
    # Nested containers where the error might land:
    containers = [response, response.get("data") or {}]
    if isinstance(response.get("data"), dict):
        containers.append(response["data"].get("response_data") or {})
    for c in containers:
        if not isinstance(c, dict):
            continue
        err = c.get("error")
        if not err:
            continue
        err_str = str(err)
        if "413" in err_str or "payload" in err_str.lower():
            return "payload_too_large"
        if "404" in err_str or "not found" in err_str.lower():
            return "tool_not_found"
        return "error"
    return "ok"


def _extract_sync_cursor(response: dict, action_slug: str) -> str:
    """Extract the continuation/sync token from a Composio response.

    Composio wraps responses differently per action — try multiple nesting
    levels: top-level, data.{field}, data.response_data.{field}.
    """
    sync_cfg = SYNC_CONFIGS.get(action_slug, {})
    field = sync_cfg.get("cursor_response_field", "")
    if not field:
        return ""
    # Try at each nesting level
    for container in [
        response,
        response.get("data", {}),
        (response.get("data", {}) or {}).get("response_data", {}),
    ]:
        if isinstance(container, dict):
            val = _extract_cursor(container, field)
            if val:
                return val
    return ""


def _extract_cursor(response: dict, cursor_field: str) -> str:
    """Extract cursor value from response using dot-notation field path."""
    parts = cursor_field.split(".")
    current: Any = response
    for part in parts:
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list) and current:
            # For lists, take last item (most recent)
            current = current[-1].get(part) if isinstance(current[-1], dict) else None
        else:
            return ""
    return str(current) if current is not None else ""
