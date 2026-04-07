"""Tier 2/3 noise detection — pure Python heuristics, no LLM calls.

Tier 2: automated/low-value events that get a one-line stream log entry.
Tier 3: empty/meaningless events that are silently discarded.
"""

from __future__ import annotations

import re
from typing import Any


# --- Tier detection --------------------------------------------------------

def is_tier2(event: dict[str, Any], metadata: dict[str, Any]) -> bool:
    """Return True if the event should get quick-log treatment (no LLM, no inbox).

    Tier 2 signals (any match = Tier 2):
    - is_automated from metadata
    - Gmail category labels (promotions, social, updates)
    - Sender domain matches known automated patterns
    - Word count < 100 AND is_automated
    - Subject line matches transactional patterns
    """
    # 1. Automated flag from metadata
    if metadata.get("is_automated"):
        return True

    raw = event.get("raw", {})
    if not isinstance(raw, dict):
        return False

    # 2. Gmail category labels
    label_ids = raw.get("labelIds", [])
    if isinstance(label_ids, list):
        tier2_labels = {"CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES"}
        if tier2_labels.intersection(set(label_ids)):
            return True

    # 3. Sender domain patterns
    sender = raw.get("from", raw.get("sender", ""))
    if isinstance(sender, str):
        sender_lower = sender.lower()
        automated_domain_keywords = [
            "noreply", "notification", "newsletter", "marketing",
            "digest", "updates", "orders", "shipping", "billing", "alerts",
        ]
        for keyword in automated_domain_keywords:
            if keyword in sender_lower:
                return True

    # 4. Word count < 100 AND is_automated (already covered by #1, but
    #    also check text content for automated signals directly)
    full_text = _extract_full_text(event)
    word_count = len(full_text.split())
    automated_signals = ["noreply", "bot", "notification", "unsubscribe"]
    text_is_automated = any(s in full_text.lower() for s in automated_signals)
    if word_count < 100 and text_is_automated:
        return True

    # 5. Subject line patterns (transactional/CI)
    subject = raw.get("subject", raw.get("title", ""))
    if isinstance(subject, str) and subject:
        tier2_subject_patterns = re.compile(
            r"password reset|verify your email|login attempt|build #|deploy|OTP|verification code",
            re.IGNORECASE,
        )
        if tier2_subject_patterns.search(subject):
            return True

    return False


def is_tier3(event: dict[str, Any]) -> bool:
    """Return True for pure discard — empty or meaningless events.

    Tier 3 signals:
    - Word count < 20 AND no subject/title
    - Raw content is empty or just '{}'
    """
    raw = event.get("raw", {})

    # Empty raw content
    if not raw:
        return True
    if isinstance(raw, str) and raw.strip() in ("", "{}"):
        return True
    if isinstance(raw, dict) and not raw:
        return True

    # Word count < 20 AND no subject/title
    if isinstance(raw, dict):
        has_title = bool(
            raw.get("subject") or raw.get("title") or raw.get("name")
        )
        if not has_title:
            full_text = _extract_full_text(event)
            if len(full_text.split()) < 20:
                return True

    return False


# --- Log line extraction ---------------------------------------------------

def extract_log_line(event: dict[str, Any]) -> str:
    """Extract a one-line summary for the stream log.

    Format varies by stream type:
    - email: {sender_name} ({domain}): {subject} -- {key_facts}
    - omi: {duration}s recording: {first 50 chars or "no speech detected"}
    - notion: {page_title} updated
    - other: {source}: {summary[:80]}
    """
    stream_type = event.get("stream_type", "unknown")
    raw = event.get("raw", {})
    if not isinstance(raw, dict):
        raw = {}

    if stream_type in ("gmail", "email"):
        return _log_line_email(raw)
    elif stream_type == "omi":
        return _log_line_omi(raw)
    elif stream_type == "notion":
        return _log_line_notion(raw)
    else:
        return _log_line_generic(stream_type, raw, event)


def format_log_entry(stream_type: str, log_line: str) -> str:
    """Format a stream log entry as a markdown list item."""
    return f"- {log_line}"


# --- Internal helpers ------------------------------------------------------

def _extract_full_text(event: dict[str, Any]) -> str:
    """Pull all text content from an event for word counting."""
    raw = event.get("raw", {})
    parts = [event.get("summary", "")]
    if isinstance(raw, dict):
        for key in ("subject", "body", "content", "text", "snippet", "title"):
            val = raw.get(key)
            if val and isinstance(val, str):
                parts.append(val)
    elif isinstance(raw, str):
        parts.append(raw)
    return " ".join(parts)


def _log_line_email(raw: dict[str, Any]) -> str:
    """Format email log line: sender (domain): subject -- key_facts."""
    sender = raw.get("from", raw.get("sender", "unknown"))
    subject = raw.get("subject", "(no subject)")

    # Parse sender name and domain
    sender_name = sender
    domain = ""
    email_match = re.search(r"<?([^<>\s]+@([^<>\s]+))>?", sender)
    if email_match:
        domain = email_match.group(2)
        # Use the part before the email as the name, or the local part
        name_part = sender[:email_match.start()].strip().strip('"').strip()
        sender_name = name_part if name_part else email_match.group(1).split("@")[0]

    # Extract key facts from body
    body = raw.get("body", raw.get("text", raw.get("snippet", "")))
    key_facts = _extract_key_facts(str(body) if body else "")

    line = f"{sender_name} ({domain}): {subject}" if domain else f"{sender_name}: {subject}"
    if key_facts:
        line += f" -- {key_facts}"
    return line


def _log_line_omi(raw: dict[str, Any]) -> str:
    """Format Omi log line: {duration}s recording: {transcript preview}."""
    duration = raw.get("duration", raw.get("length", "?"))
    transcript = raw.get("transcript", raw.get("text", raw.get("content", "")))
    if transcript and isinstance(transcript, str) and transcript.strip():
        preview = transcript.strip()[:50]
    else:
        preview = "no speech detected"
    return f"{duration}s recording: {preview}"


def _log_line_notion(raw: dict[str, Any]) -> str:
    """Format Notion log line: {page_title} updated."""
    title = raw.get("title", raw.get("name", raw.get("page_title", "Untitled page")))
    return f"{title} updated"


def _log_line_generic(stream_type: str, raw: dict[str, Any], event: dict[str, Any]) -> str:
    """Format generic log line: {source}: {summary[:80]}."""
    summary = (
        event.get("summary", "")
        or raw.get("title", "")
        or raw.get("subject", "")
        or raw.get("snippet", "")
        or raw.get("name", "")
        or "(no summary)"
    )
    return f"{stream_type}: {summary[:80]}"


def _extract_key_facts(text: str) -> str:
    """Extract notable facts from text: amounts, tracking numbers, dates, status words."""
    if not text:
        return ""

    facts: list[str] = []

    # Currency amounts: $22.00, EUR150, 4,200 PLN
    amounts = re.findall(
        r"[\$\u20ac\u00a3]\s?\d[\d,]*\.?\d*|\d[\d,]*\.?\d*\s?(?:USD|EUR|GBP|PLN|CZK|HUF)",
        text,
    )
    facts.extend(amounts[:3])

    # Tracking numbers: #XYZ-123, tracking: ABC
    tracking = re.findall(r"#[A-Z0-9][\w-]{3,}", text)
    tracking += re.findall(r"tracking[:\s]+([A-Z0-9][\w-]{5,})", text, re.IGNORECASE)
    facts.extend(tracking[:2])

    # Dates/times mentioned
    dates = re.findall(
        r"\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}/\d{2,4}\b|\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{2,4}\b",
        text,
        re.IGNORECASE,
    )
    facts.extend(dates[:2])

    # Status words
    status_pattern = re.compile(
        r"\b(shipped|delivered|failed|succeeded|approved|denied)\b",
        re.IGNORECASE,
    )
    statuses = status_pattern.findall(text)
    facts.extend(s.lower() for s in statuses[:2])

    return ", ".join(facts) if facts else ""
