"""Braindump detection and extraction activities."""

from __future__ import annotations

from typing import Any

from temporalio import activity


@activity.defn
async def detect_braindump(event: dict[str, Any], metadata: dict[str, Any]) -> bool:
    """Detect if content is a braindump (Python heuristic — deterministic).

    Criteria:
    - Word count > 500 (equivalent to ~2 min speech)
    - Single sender/speaker
    - No back-and-forth pattern (no alternating user/assistant)
    """
    raw = event.get("raw", {})
    word_count = metadata.get("word_count", 0)

    if word_count < 500:
        return False

    # Check for single speaker (no alternating messages)
    messages = raw.get("messages", []) if isinstance(raw, dict) else []
    if messages:
        speakers = set()
        for msg in messages:
            if isinstance(msg, dict):
                role = msg.get("role", msg.get("sender", ""))
                if role:
                    speakers.add(role)
        # If more than one distinct speaker role with alternation, not a braindump
        if len(speakers) > 1:
            # Check for back-and-forth pattern
            roles_sequence = []
            for msg in messages:
                if isinstance(msg, dict):
                    role = msg.get("role", msg.get("sender", ""))
                    if role:
                        roles_sequence.append(role)
            # Count alternations
            alternations = sum(
                1 for i in range(1, len(roles_sequence))
                if roles_sequence[i] != roles_sequence[i - 1]
            )
            if alternations >= 3:
                return False

    return True


@activity.defn
async def extract_braindump(
    event: dict[str, Any],
    metadata: dict[str, Any],
    classification: dict[str, Any],
) -> list[dict[str, Any]]:
    """Extract topics from a braindump via Clerk and write vault records."""
    from src.activities.clerk import clerk_extract_braindump
    from src.activities.vault import write_vault_record

    raw = event.get("raw", {})
    content = ""
    if isinstance(raw, dict):
        content = raw.get("content", raw.get("body", raw.get("text", "")))
        messages = raw.get("messages", [])
        if messages and not content:
            parts = []
            for msg in messages:
                if isinstance(msg, dict):
                    parts.append(str(msg.get("content", "")))
                elif isinstance(msg, str):
                    parts.append(msg)
            content = "\n".join(parts)
    if not content:
        content = event.get("summary", "")

    result = await clerk_extract_braindump(content, metadata)
    topics = result.get("topics", [])

    written = []
    for topic in topics:
        # Each topic becomes its own vault record
        record = {
            "type": topic.get("type", "note"),
            "title": topic.get("title", "Untitled Topic"),
            "summary": topic.get("summary", ""),
            "entities": topic.get("entities", []),
            "action_items": topic.get("action_items", []),
            "tags": topic.get("tags", []),
        }
        path = await write_vault_record(record)
        written.append({"path": path, **record})

    return written
