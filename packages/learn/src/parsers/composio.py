"""Composio tool execution response parser.

Normalizes Composio action responses (GMAIL_FETCH_EMAILS, NOTION_LIST_PAGES, etc.)
into ParsedEvents. Each item in the response becomes one event with source_ref
derived from the toolkit + item ID.

Composio responses vary by toolkit but generally have:
- A top-level data/response_data dict or list
- Items with id, created_at, title/subject/name fields
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from . import ParsedEvent


def parse(raw: dict) -> list[ParsedEvent]:
    """Parse a Composio tool execution response into ParsedEvents."""
    # Composio wraps results in different structures depending on the action
    data = _extract_data(raw)

    if isinstance(data, list):
        events = []
        for item in data:
            if isinstance(item, dict):
                events.append(_item_to_event(item))
        return events if events else [_single_event(raw)]

    if isinstance(data, dict):
        # Could be a single item or a wrapper with items inside
        items = (
            data.get("messages", [])
            or data.get("results", [])
            or data.get("items", [])
            or data.get("data", [])
            or data.get("emails", [])
            or data.get("pages", [])
            or data.get("records", [])
            or data.get("entries", [])
            or data.get("events", [])
        )
        if isinstance(items, list) and items:
            return [_item_to_event(item) for item in items if isinstance(item, dict)]
        # Single item
        return [_item_to_event(data)]

    # Fallback
    return [_single_event(raw)]


def _extract_data(raw: dict) -> dict | list | None:
    """Extract the actual data from a Composio response wrapper."""
    # Composio SDK may return {data: ..., successfull: true, error: null}
    if "data" in raw:
        d = raw["data"]
        # Sometimes data is {"response_data": ...}
        if isinstance(d, dict) and "response_data" in d:
            return d["response_data"]
        return d
    if "response_data" in raw:
        return raw["response_data"]
    if "result" in raw:
        return raw["result"]
    if "output" in raw:
        return raw["output"]
    return raw


def _item_to_event(item: dict) -> ParsedEvent:
    """Convert a single Composio result item to a ParsedEvent."""
    # Derive source_ref from whatever ID field exists
    item_id = (
        item.get("id")
        or item.get("messageId")
        or item.get("message_id")
        or item.get("threadId")
        or item.get("page_id")
        or item.get("uid")
        or item.get("uuid")
        or ""
    )
    if not item_id:
        item_id = f"composio-{hash(json.dumps(item, sort_keys=True, default=str)) & 0xFFFFFFFF:08x}"

    source_ref = f"composio:{item_id}"

    # Build summary from common fields
    summary = (
        item.get("subject")
        or item.get("title")
        or item.get("name")
        or item.get("summary")
        or item.get("snippet")
        or item.get("description")
        or ""
    )
    if not summary:
        summary = json.dumps(item, default=str)[:120]

    # Enrich summary with sender if available
    sender = item.get("from") or item.get("sender") or item.get("author") or ""
    if sender and summary and not summary.startswith(str(sender)):
        summary = f"{sender}: {summary}"

    # Extract timestamp
    received_at = (
        item.get("date")
        or item.get("created_at")
        or item.get("createdAt")
        or item.get("timestamp")
        or item.get("receivedAt")
        or item.get("internalDate")
        or datetime.now(timezone.utc).isoformat()
    )

    # Try to convert epoch milliseconds to ISO
    if isinstance(received_at, (int, float)):
        try:
            received_at = datetime.fromtimestamp(received_at / 1000, tz=timezone.utc).isoformat()
        except (ValueError, OSError):
            received_at = datetime.now(timezone.utc).isoformat()

    # Classify event type from common patterns
    event_type = _classify_event_type(item)

    return ParsedEvent(
        source_ref=source_ref,
        summary=str(summary)[:500],
        raw=item,
        event_type=event_type,
        received_at=str(received_at),
        metadata={
            k: v
            for k, v in {
                "from": item.get("from") or item.get("sender"),
                "to": item.get("to") or item.get("recipient"),
                "subject": item.get("subject"),
                "labels": item.get("labelIds") or item.get("labels"),
                "thread_id": item.get("threadId") or item.get("thread_id"),
            }.items()
            if v
        },
    )


def _single_event(raw: dict) -> ParsedEvent:
    """Wrap the entire raw response as a single event."""
    return ParsedEvent(
        source_ref=f"composio-raw-{hash(json.dumps(raw, sort_keys=True, default=str)) & 0xFFFFFFFF:08x}",
        summary=json.dumps(raw, default=str)[:200],
        raw=raw,
        event_type="composio-raw",
        received_at=datetime.now(timezone.utc).isoformat(),
        metadata={},
    )


def _classify_event_type(item: dict) -> str:
    """Best-effort event type classification from item content."""
    if "subject" in item or "snippet" in item or "labelIds" in item:
        return "email"
    if "title" in item and ("url" in item or "html_url" in item):
        return "issue" if "issue" in str(item.get("url", "")) else "page"
    if "amount" in item or "currency" in item:
        return "payment"
    if "object" in item and item["object"] == "page":
        return "page"
    return "item"
