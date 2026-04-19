"""Zero-LLM vault record creation from stream events.

Creates structured vault event records using pure Python templates.
No LLM calls — all data comes from the parser's extracted metadata.
"""

from __future__ import annotations

import hashlib
import logging
import re
from datetime import datetime, timezone
from typing import Any

from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


@activity.defn
async def create_stream_vault_record(event: dict[str, Any]) -> str:
    """Create a vault event record from a parsed stream event. Zero LLM calls."""
    config = load_config()
    client = VaultClient(config)
    try:
        name, body, tags = _render_event(event)
        content = _build_vault_content(name, event, body, tags)
        slug = _event_slug(event)
        path = await client.write_record("event", slug, content)
        logger.info("stream_vault: created %s from %s", path, event.get("source_ref", "?")[:40])
        return path
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Template dispatcher
# ---------------------------------------------------------------------------

def _render_event(event: dict[str, Any]) -> tuple[str, str, list[str]]:
    """Dispatch to the right template based on event type. Returns (name, body, tags)."""
    raw = event.get("raw", {})
    if not isinstance(raw, dict):
        raw = {}
    metadata = event.get("metadata", {})
    if not isinstance(metadata, dict):
        metadata = {}

    event_type = metadata.get("event_type", event.get("stream_type", ""))
    stream_type = event.get("stream_type", "")

    # Calendar detection: check for start/end fields in raw
    if raw.get("start") and raw.get("end"):
        return _template_calendar(event, raw, metadata)

    if event_type in ("email", "gmail") or stream_type in ("gmail", "email", "agentmail"):
        return _template_email(event, raw, metadata)

    if event_type.startswith("github") or stream_type.startswith("github"):
        return _template_github(event, raw, metadata)

    if "slack" in event_type or "slack" in stream_type:
        return _template_slack(event, raw, metadata)

    if event_type == "page" or "notion" in stream_type:
        return _template_notion(event, raw, metadata)

    if event_type == "payment" or event_type.startswith("polar"):
        return _template_payment(event, raw, metadata)

    if event_type == "sms" or stream_type in ("sms", "sms-inbound"):
        return _template_sms(event, raw, metadata)

    if event_type == "voice-call" or stream_type == "voice-call":
        return _template_voice_call(event, raw, metadata)

    return _template_generic(event, raw, metadata)


# ---------------------------------------------------------------------------
# Per-source templates
# ---------------------------------------------------------------------------

def _template_calendar(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str]]:
    summary = raw.get("summary") or raw.get("title") or "Untitled Event"
    start = raw.get("start", {})
    end = raw.get("end", {})
    start_dt = start.get("dateTime", start.get("date", ""))
    end_dt = end.get("dateTime", end.get("date", ""))
    location = raw.get("location", "")
    organizer = raw.get("organizer", {})
    org_display = organizer.get("displayName") or organizer.get("email", "")
    attendees = [
        a.get("displayName") or a.get("email", "")
        for a in raw.get("attendees", [])
        if a.get("email")
    ]
    description = raw.get("description", "")
    status = raw.get("status", "confirmed")

    parts: list[str] = []
    if start_dt:
        time_str = _format_dt(start_dt)
        if end_dt:
            time_str += f" — {_format_dt(end_dt)}"
        parts.append(time_str)
    if location:
        parts.append(f"**Location**: {location}")
    if org_display:
        parts.append(f"**Organizer**: {org_display}")
    if attendees:
        parts.append(f"**Attendees**: {', '.join(attendees[:10])}")
    if status != "confirmed":
        parts.append(f"**Status**: {status}")
    if description:
        # Strip HTML tags from Google Calendar descriptions
        clean = re.sub(r"<[^>]+>", "", description)[:500]
        parts.append(f"\n{clean}")

    tags = ["calendar"]
    if status == "cancelled":
        tags.append("cancelled")
    if raw.get("conferenceData"):
        tags.append("meeting")

    return summary[:120], "\n".join(parts), tags


def _template_email(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str]]:
    subject = raw.get("subject") or metadata.get("subject") or "(no subject)"
    sender = raw.get("from") or metadata.get("from") or "unknown"
    recipient = raw.get("to") or metadata.get("to") or ""
    snippet = raw.get("snippet", "")
    labels = raw.get("labelIds", metadata.get("labels", []))

    parts: list[str] = [f"**From**: {sender}"]
    if recipient:
        parts.append(f"**To**: {recipient}")
    if snippet:
        parts.append(f"\n{snippet[:300]}")

    tags = ["email"]
    if isinstance(labels, list):
        if "IMPORTANT" in labels:
            tags.append("important")
        if "STARRED" in labels:
            tags.append("starred")

    # Build name from sender + subject
    sender_name = sender.split("<")[0].strip().strip('"') or sender
    name = f"{sender_name}: {subject}"[:120]
    return name, "\n".join(parts), tags


def _template_github(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str]]:
    action = raw.get("action", metadata.get("action", ""))
    repo = raw.get("repo", metadata.get("repo", ""))
    actor = raw.get("actor", metadata.get("actor", ""))

    pr = raw.get("pull_request", {})
    issue = raw.get("issue", {})

    if pr:
        title = pr.get("title", "")
        number = pr.get("number", "")
        name = f"PR #{number}: {title}" if number else title or "Pull Request"
        body = f"**Repo**: {repo}\n**Author**: {actor}\n**Action**: {action}"
        branch = pr.get("head", {}).get("ref", "")
        if branch:
            body += f"\n**Branch**: {branch}"
        return name[:120], body, ["github", "pull-request"]

    if issue:
        title = issue.get("title", "")
        number = issue.get("number", "")
        name = f"Issue #{number}: {title}" if number else title or "Issue"
        body = f"**Repo**: {repo}\n**Author**: {actor}\n**Action**: {action}"
        return name[:120], body, ["github", "issue"]

    # Notification / push / release / etc.
    subject = raw.get("subject", {})
    if isinstance(subject, dict):
        title = subject.get("title", "")
        notif_type = subject.get("type", "")
        name = f"{repo}: {title}" if title else f"{repo}: {notif_type or action}"
    else:
        name = f"{repo}: {action or 'event'}"
    body = f"**Repo**: {repo}\n**Actor**: {actor}"
    if action:
        body += f"\n**Action**: {action}"
    return name[:120], body, ["github"]


def _template_slack(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str]]:
    sender = raw.get("user", raw.get("sender", raw.get("username", "")))
    channel = raw.get("channel", raw.get("channel_name", ""))
    text = raw.get("text", raw.get("message", ""))[:500]

    parts: list[str] = []
    if channel:
        parts.append(f"**Channel**: #{channel}")
    if sender:
        parts.append(f"**From**: {sender}")
    if text:
        parts.append(f"\n{text}")

    name = f"{sender} in #{channel}" if channel else f"Message from {sender}"
    return name[:120], "\n".join(parts), ["slack"]


def _template_notion(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str]]:
    title = (
        raw.get("title")
        or raw.get("name")
        or metadata.get("title")
        or "Untitled Page"
    )
    obj_type = raw.get("object", "page")
    url = raw.get("url", "")

    parts: list[str] = []
    if url:
        parts.append(f"**URL**: {url}")
    if obj_type:
        parts.append(f"**Type**: {obj_type}")

    # Extract properties if available
    props = raw.get("properties", {})
    if isinstance(props, dict):
        for key, val in list(props.items())[:5]:
            if isinstance(val, dict):
                # Try to extract display value
                for vk in ("plain_text", "name", "start", "number"):
                    if val.get(vk):
                        parts.append(f"**{key}**: {val[vk]}")
                        break

    content = metadata.get("content", "")
    if content:
        parts.append(f"\n{content[:500]}")

    return str(title)[:120], "\n".join(parts), ["notion"]


def _template_payment(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str]]:
    amount = raw.get("amount", metadata.get("amount", ""))
    currency = raw.get("currency", metadata.get("currency", ""))
    customer = raw.get("customer_name", raw.get("customer_email", ""))
    product = raw.get("product_name", "")
    event_type = metadata.get("event_type", "payment")

    name = f"{event_type}: {product or customer or 'payment'}"
    parts: list[str] = []
    if amount:
        display_amount = f"{int(amount) / 100:.2f}" if isinstance(amount, int) and amount > 100 else str(amount)
        parts.append(f"**Amount**: {display_amount} {currency}")
    if customer:
        parts.append(f"**Customer**: {customer}")
    if product:
        parts.append(f"**Product**: {product}")

    return name[:120], "\n".join(parts), ["payment"]


def _template_sms(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str]]:
    """Phone SMS — both inbound (unauthorised → here) and outbound logging."""
    from_num = raw.get("from") or metadata.get("from", "")
    to_num = raw.get("to") or metadata.get("to", "")
    body = (raw.get("body") or raw.get("message") or "").strip()
    direction = raw.get("direction") or metadata.get("direction") or "inbound"

    parts: list[str] = []
    parts.append(f"**Direction**: {direction}")
    if from_num:
        parts.append(f"**From**: {from_num}")
    if to_num:
        parts.append(f"**To**: {to_num}")
    if body:
        parts.append(f"\n{body[:1000]}")

    tags = ["sms", direction]

    if direction == "outbound":
        name = f"SMS to {to_num or 'unknown'}"
    else:
        name = f"SMS from {from_num or 'unknown'}"
    return name[:120], "\n".join(parts), tags


def _template_voice_call(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str]]:
    """Voice call transcript — posted by the Voice Bridge after hangup."""
    from_num = raw.get("from") or metadata.get("from", "")
    to_num = raw.get("to") or metadata.get("to", "")
    started = raw.get("started_at", "")
    ended = raw.get("ended_at", "")
    duration = raw.get("duration_seconds", 0)
    direction = raw.get("direction") or "inbound"
    summary = (
        event.get("summary")
        or raw.get("summary")
        or f"Call from {from_num or 'unknown'}"
    )
    transcript = raw.get("transcript", [])

    parts: list[str] = []
    parts.append(f"**Direction**: {direction}")
    if from_num:
        parts.append(f"**From**: {from_num}")
    if to_num:
        parts.append(f"**To**: {to_num}")
    if duration:
        try:
            mins, secs = divmod(int(duration), 60)
            parts.append(f"**Duration**: {mins} min {secs} sec")
        except (TypeError, ValueError):
            pass
    if started:
        parts.append(f"**Started**: {_format_dt(started)}")
    if summary:
        parts.append(f"\n**Summary**: {summary}")

    if isinstance(transcript, list) and transcript:
        parts.append("\n## Transcript\n")
        for turn in transcript[:200]:
            if not isinstance(turn, dict):
                continue
            role = turn.get("role", "?")
            text = (turn.get("text") or turn.get("content") or "").strip()
            if not text:
                continue
            label = "Sir" if role == "user" else "Alfred"
            parts.append(f"**{label}**: {text[:500]}")

    tags = ["voice-call", direction]
    name = f"Call: {from_num or 'unknown'}" if direction == "inbound" else f"Call to {to_num or 'unknown'}"
    return name[:120], "\n".join(parts), tags


def _template_generic(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str]]:
    name = (
        event.get("summary", "")
        or raw.get("title", "")
        or raw.get("subject", "")
        or raw.get("name", "")
        or "Stream event"
    )[:120]

    body = event.get("summary", "")
    for key in ("body", "text", "content", "description", "snippet"):
        val = raw.get(key)
        if val and isinstance(val, str):
            body = val[:500]
            break

    stream_type = event.get("stream_type", "unknown")
    return name, body, [stream_type]


# ---------------------------------------------------------------------------
# Vault record builder
# ---------------------------------------------------------------------------

def _build_vault_content(
    name: str,
    event: dict[str, Any],
    body: str,
    tags: list[str],
) -> str:
    received_at = event.get("received_at", datetime.now(timezone.utc).isoformat())
    stream_id = event.get("stream_id", "")
    source_ref = event.get("source_ref", "")
    stream_type = event.get("stream_type", "unknown")
    tag_str = ", ".join(tags) if tags else ""

    safe_name = name.replace('"', '\\"')

    return f"""---
type: event
created: {received_at}
status: active
name: "{safe_name}"
source: "{stream_id}"
source_ref: "{source_ref}"
stream_type: {stream_type}
tags: [{tag_str}]
enrichment_status: pending
---

# {name}

{body}
"""


def _event_slug(event: dict[str, Any]) -> str:
    """Generate a deterministic slug from source_ref + date for dedup."""
    source_ref = event.get("source_ref", event.get("id", ""))
    received_at = event.get("received_at", "")

    # Extract date
    date_str = received_at[:10] if received_at else datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Hash source_ref for uniqueness
    ref_hash = hashlib.sha256(source_ref.encode()).hexdigest()[:12]

    return f"{date_str}-{ref_hash}"


def _format_dt(dt_str: str) -> str:
    """Format an ISO datetime string for display."""
    if not dt_str:
        return ""
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        return dt_str[:16]
