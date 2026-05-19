"""Input metadata extraction for judgment scoring."""

from __future__ import annotations

import re
from typing import Any

from temporalio import activity


@activity.defn
def extract_input_metadata(input_event: dict[str, Any]) -> dict[str, Any]:
    """Extract metadata from an input for instinct matching.

    This is a deterministic Python operation — no LLM involved.
    """
    raw = input_event.get("raw", {})
    classification = input_event.get("classification", {})

    # Combine all available text
    text_parts: list[str] = []
    for field in ("summary", "title", "subject", "body", "content", "description"):
        val = input_event.get(field) or raw.get(field) or classification.get(field)
        if val and isinstance(val, str):
            text_parts.append(val)

    # Include messages from conversations
    if isinstance(raw, dict):
        messages = raw.get("messages", [])
        for msg in messages[:10]:
            if isinstance(msg, dict):
                text_parts.append(str(msg.get("content", "")))
            elif isinstance(msg, str):
                text_parts.append(msg)

    full_text = " ".join(text_parts).lower()

    # Extract domains from email addresses
    domains = list(set(re.findall(r"@([\w.-]+\.\w+)", full_text)))

    # Extract keywords (top terms by simple frequency, excluding stopwords)
    stopwords = {
        "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "will", "would", "could",
        "should", "may", "might", "shall", "can", "to", "of", "in", "for",
        "on", "with", "at", "by", "from", "as", "into", "through", "during",
        "before", "after", "and", "but", "or", "nor", "not", "so", "yet",
        "both", "either", "neither", "each", "every", "all", "any", "few",
        "more", "most", "other", "some", "such", "no", "only", "own", "same",
        "than", "too", "very", "just", "about", "this", "that", "these",
        "those", "it", "its", "i", "me", "my", "we", "our", "you", "your",
        "he", "him", "his", "she", "her", "they", "them", "their", "what",
        "which", "who", "whom", "when", "where", "why", "how",
    }
    words = re.findall(r"\b[a-z]{3,}\b", full_text)
    freq: dict[str, int] = {}
    for w in words:
        if w not in stopwords:
            freq[w] = freq.get(w, 0) + 1
    keywords = sorted(freq, key=freq.get, reverse=True)[:15]

    # Input type
    input_type = (
        input_event.get("stream_type")
        or classification.get("type")
        or raw.get("type")
        or "other"
    )

    # Attachment patterns
    attachment_patterns = list(set(re.findall(r"\*?\.\w{2,5}\b", full_text)))

    # Tags
    tags = classification.get("tags", []) or input_event.get("tags", [])

    return {
        "domains": domains,
        "keywords": keywords,
        "input_type": input_type,
        "attachment_patterns": attachment_patterns,
        "tags": tags if isinstance(tags, list) else [],
        "full_text": full_text,
    }
