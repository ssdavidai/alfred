"""Gmail API response parser.

Handles both messages.list (list of IDs) and messages.get (full message).
Extracts: from, to, subject, date, snippet as summary, message ID as source_ref.
"""

from __future__ import annotations

from datetime import datetime, timezone

from . import ParsedEvent


def parse(raw: dict) -> list[ParsedEvent]:
    """Parse Gmail API response into ParsedEvents."""
    # messages.get response — single full message
    if "payload" in raw or "snippet" in raw:
        return [_parse_message(raw)]

    # messages.list response — list of message stubs {id, threadId}
    if "messages" in raw and isinstance(raw["messages"], list):
        return [_parse_message_stub(msg) for msg in raw["messages"]]

    # Single message stub (from detail fetch)
    if "id" in raw and "threadId" in raw and "payload" not in raw and "snippet" not in raw:
        return [_parse_message_stub(raw)]

    # Fallback: treat as single item
    return [_parse_message(raw)]


def _parse_message(msg: dict) -> ParsedEvent:
    """Parse a full Gmail message (messages.get response)."""
    message_id = msg.get("id", "")
    snippet = msg.get("snippet", "")

    # Extract headers
    headers = {}
    payload = msg.get("payload", {})
    for header in payload.get("headers", []):
        name = header.get("name", "").lower()
        if name in ("from", "to", "subject", "date"):
            headers[name] = header.get("value", "")

    subject = headers.get("subject", "")
    sender = headers.get("from", "")
    recipient = headers.get("to", "")
    date_str = headers.get("date", "")

    summary = f"{subject}" if subject else snippet[:120]
    if sender:
        summary = f"{sender}: {summary}"

    received_at = date_str if date_str else datetime.now(timezone.utc).isoformat()

    return ParsedEvent(
        source_ref=f"gmail:{message_id}",
        summary=summary,
        raw=msg,
        event_type="email",
        received_at=received_at,
        metadata={
            "from": sender,
            "to": recipient,
            "subject": subject,
            "date": date_str,
            "thread_id": msg.get("threadId", ""),
            "label_ids": msg.get("labelIds", []),
        },
    )


def _parse_message_stub(msg: dict) -> ParsedEvent:
    """Parse a Gmail message stub (from messages.list — just id + threadId)."""
    message_id = msg.get("id", "")
    thread_id = msg.get("threadId", "")

    return ParsedEvent(
        source_ref=f"gmail:{message_id}",
        summary=f"Gmail message {message_id}",
        raw=msg,
        event_type="email-stub",
        received_at=datetime.now(timezone.utc).isoformat(),
        metadata={
            "thread_id": thread_id,
            "needs_detail_fetch": True,
        },
    )
