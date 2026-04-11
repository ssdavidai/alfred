"""Workflow: Stream Puller — generic HTTP pull engine for universal streams.

Loads stream config, resolves auth, executes HTTP pull, runs parser,
ingests parsed events, and updates cursor for incremental pulls.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
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
    detail_fetches: int = 0
    cursor_updated: bool = False
    error: str | None = None


@workflow.defn(name="StreamPullerWorkflow")
class StreamPullerWorkflow:
    @workflow.run
    async def run(self, input: PullerInput) -> PullerResult:
        stream_id = input.stream_id
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
            return await self._run_composio(stream_id, config, composio_action, result)

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
                        count: int = await workflow.execute_activity(
                            ingest_events,
                            args=[stream_id, stream_type, parser_name, batch],
                            start_to_close_timeout=timedelta(seconds=60),
                            retry_policy=RetryPolicy(maximum_attempts=2),
                        )
                        result.events_ingested += count
                        result.events_pulled += len(batch)
                        batch = []

                # Flush remaining
                if batch:
                    count = await workflow.execute_activity(
                        ingest_events,
                        args=[stream_id, stream_type, parser_name, batch],
                        start_to_close_timeout=timedelta(seconds=60),
                        retry_policy=RetryPolicy(maximum_attempts=2),
                    )
                    result.events_ingested += count
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
            ingested_count: int = await workflow.execute_activity(
                ingest_events,
                args=[stream_id, config.get("type", "custom"), parser_name, raw_to_ingest],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=RetryPolicy(maximum_attempts=2),
            )
            result.events_ingested += ingested_count
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


    async def _run_composio(
        self,
        stream_id: str,
        config: dict[str, Any],
        action_slug: str,
        result: PullerResult,
    ) -> PullerResult:
        """Execute a Composio action with incremental sync support."""
        cursor_value = config.get("cursor_value", "")
        last_pull_at = config.get("last_pull_at", "")

        # 1. Compute sync arguments (backfill or incremental)
        sync_args: dict[str, Any] = await workflow.execute_activity(
            build_sync_args,
            args=[action_slug, cursor_value, last_pull_at],
            start_to_close_timeout=timedelta(seconds=10),
        )

        # 2. Execute the Composio action
        raw_response: dict[str, Any] = await workflow.execute_activity(
            composio_pull,
            args=[action_slug, sync_args],
            start_to_close_timeout=timedelta(seconds=120),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )

        # 3. Handle sync token reset (e.g. Calendar 410 Gone)
        if _is_sync_reset(raw_response):
            # Re-run as backfill with cleared cursor
            sync_args = await workflow.execute_activity(
                build_sync_args,
                args=[action_slug, "", ""],
                start_to_close_timeout=timedelta(seconds=10),
            )
            raw_response = await workflow.execute_activity(
                composio_pull,
                args=[action_slug, sync_args],
                start_to_close_timeout=timedelta(seconds=120),
                retry_policy=RetryPolicy(maximum_attempts=3),
            )

        # 4. Ingest through the composio parser
        parser_name = config.get("parser", "composio")
        stream_type = config.get("type", "composio")

        ingested_count: int = await workflow.execute_activity(
            ingest_events,
            args=[stream_id, stream_type, parser_name, [raw_response]],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        result.events_ingested = ingested_count
        result.events_pulled = 1

        # 5. Extract cursor from response (for sync mode)
        new_cursor = _extract_sync_cursor(raw_response, action_slug)

        # 6. Update cursor + timestamp
        await workflow.execute_activity(
            update_cursor,
            args=[stream_id, new_cursor],
            start_to_close_timeout=timedelta(seconds=30),
        )
        result.cursor_updated = True
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


def _extract_sync_cursor(response: dict, action_slug: str) -> str:
    """Extract the continuation/sync token from a Composio response."""
    sync_cfg = SYNC_CONFIGS.get(action_slug, {})
    field = sync_cfg.get("cursor_response_field", "")
    if not field:
        return ""
    # Try top level
    val = _extract_cursor(response, field)
    if val:
        return val
    # Try inside Composio data wrapper
    data = response.get("data", {})
    if isinstance(data, dict):
        rd = data.get("response_data", data)
        if isinstance(rd, dict):
            return _extract_cursor(rd, field)
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
