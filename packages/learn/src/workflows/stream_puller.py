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
        http_pull,
        http_pull_detail,
        ingest_events,
        load_stream_config,
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

        if detail_endpoint:
            # Extract IDs from list response
            items = raw_response.get("messages", raw_response.get("items", raw_response.get("data", [])))
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

        # 6. Run parser on response (done in ingest activity, pass parser name)
        parser_name = config.get("parser", "passthrough")

        # Determine what to ingest — detail items if we fetched them, else raw response
        raw_to_ingest = detail_items if detail_items else [raw_response]

        # 7. Ingest parsed events via POST /api/v1/streams/ingest
        ingested_count: int = await workflow.execute_activity(
            ingest_events,
            args=[stream_id, config.get("type", "custom"), parser_name, raw_to_ingest],
            start_to_close_timeout=timedelta(seconds=60),
            retry_policy=RetryPolicy(maximum_attempts=2),
        )
        result.events_ingested = ingested_count
        result.events_pulled = len(raw_to_ingest)

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
