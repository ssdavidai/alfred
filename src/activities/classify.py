"""Metadata extraction and classification activities."""

from __future__ import annotations

import re
from typing import Any
from datetime import datetime, timezone

from temporalio import activity

from src.activities.clerk import clerk_classify


@activity.defn
async def extract_metadata(event: dict[str, Any]) -> dict[str, Any]:
    """Extract deterministic metadata from a stream event (Python — structural)."""
    raw = event.get("raw", {})
    summary = event.get("summary", "")
    source_ref = event.get("source_ref", "")
    stream_type = event.get("stream_type", "")
    received_at = event.get("received_at", "")

    # Combine all text content for analysis
    text_parts = [summary]
    if isinstance(raw, dict):
        for key in ("subject", "body", "content", "text", "description", "title"):
            if key in raw:
                text_parts.append(str(raw[key]))
        # Messages from conversations
        messages = raw.get("messages", [])
        for msg in messages[:10]:
            if isinstance(msg, dict):
                text_parts.append(str(msg.get("content", "")))
            elif isinstance(msg, str):
                text_parts.append(msg)

    full_text = " ".join(text_parts).lower()

    # Extract email domains
    domains = re.findall(r"@([\w.-]+\.\w+)", full_text)

    # Extract dates mentioned in text
    date_patterns = re.findall(
        r"\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}/\d{2,4}\b",
        full_text,
    )

    # Extract potential file extensions (attachment patterns)
    attachment_patterns = re.findall(r"\*?\.\w{2,5}\b", full_text)

    # Word count
    word_count = len(full_text.split())

    # Detect if this looks like automated content
    automated_signals = [
        "automated", "noreply", "no-reply", "bot", "notification",
        "unsubscribe", "do not reply",
    ]
    is_automated = any(s in full_text for s in automated_signals)

    return {
        "stream_type": stream_type,
        "source_ref": source_ref,
        "received_at": received_at,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "domains": list(set(domains)),
        "dates_mentioned": date_patterns,
        "attachment_patterns": list(set(attachment_patterns)),
        "word_count": word_count,
        "is_automated": is_automated,
        "has_attachments": bool(attachment_patterns),
    }


@activity.defn
async def classify_event(
    event: dict[str, Any],
    metadata: dict[str, Any],
) -> dict[str, Any]:
    """Classify a stream event via the Clerk (LLM — creative)."""
    return await clerk_classify(event, metadata)
