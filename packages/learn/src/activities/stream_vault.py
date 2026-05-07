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
from src.utils.entity_promotion import (
    initial_status_for_auto_discovery,
    is_provisional_entity_type,
    merge_mentioned_streams,
    next_status,
)
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


@activity.defn
async def create_stream_vault_record(event: dict[str, Any]) -> str:
    """Create a vault record from a parsed stream event. Zero LLM calls.

    Phase 6.6 unifies all stream-event records under
    ``vault/stream_event/<source_type>-<slug>.md``. The legacy split
    (``event/`` for most templates, ``conversation/`` for OMI / voice
    / openclaw-chat) was load-bearing only for the surveyor's old
    ENTITY_RECORD_TYPES gate; that gate now treats stream_event as
    non-entity uniformly. The ``source_type`` frontmatter field
    disambiguates the origin so the signal extractor can route /
    pre-filter without inspecting filename heuristics.

    Record_type passed to ``write_record`` is always ``stream_event``.
    The per-template ``record_type`` return (still kept on the legacy
    return tuple for ``_build_vault_content`` to stamp the
    frontmatter ``type:`` field) is now collapsed to ``stream_event``
    in the same step. ``_build_vault_content`` also stamps a
    ``source_type:`` field so the signal extractor's normalizer can
    classify in O(1) without inspecting tags / filename.

    Steward audit records (``steward-action-*``, ``signal-action-*``,
    ``auto-task-created-*``, etc.) keep using ``record_type="event"``
    via different code paths (see ``steward.apply_state_change``,
    ``signal_actions._emit_signal_action_audit``,
    ``task_creation._emit_audit``); this activity is only the entry
    for genuine STREAM events.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        name, body, tags, _legacy_record_type = _render_event(event)
        source_type = _resolve_source_type(event, _legacy_record_type)
        content = _build_vault_content(
            name, event, body, tags, "stream_event", source_type=source_type,
        )
        slug = _stream_event_slug(event, source_type)
        path = await client.write_record("stream_event", slug, content)
        logger.info(
            "stream_vault: created %s from %s (source_type=%s)",
            path,
            event.get("source_ref", "?")[:40],
            source_type,
        )
        return path
    finally:
        await client.close()


def _resolve_source_type(event: dict[str, Any], legacy_record_type: str) -> str:
    """Pick the canonical Phase 6 source_type for ``event``.

    Inspection order:
      1. ``stream_type`` on the event payload — canonical and
         already normalised by the upstream pull layer.
      2. ``source_id`` / ``source_ref`` heuristics — match the
         system-openclaw-* / agent: prefixes the openclaw chat
         emitter writes.
      3. ``metadata.event_type`` — pre-canonicalised stream_type
         for older sources.
      4. Legacy ``record_type`` from the template dispatch (only
         "conversation" buys "omi" as a default).

    The output is always one of the Phase 6 PRE_FILTER_ALLOWLIST
    values OR "generic" for events that pre-date Phase 6 and don't
    match a known source.
    """
    stream_type = str(event.get("stream_type") or "").strip().lower()
    metadata = event.get("metadata") or {}
    if not isinstance(metadata, dict):
        metadata = {}
    raw = event.get("raw") or {}
    if not isinstance(raw, dict):
        raw = {}
    event_type = str(metadata.get("event_type") or "").strip().lower()

    # Direct stream_type matches.
    if stream_type in ("gmail", "email", "agentmail"):
        return "gmail"
    if stream_type.startswith("slack"):
        return "slack"
    if stream_type in ("omi-audio", "voice-call"):
        return "omi"
    if stream_type in ("vexa-transcript", "vexa-meeting", "vexa"):
        return "vexa"
    if stream_type in ("calendar", "google-calendar", "google_calendar", "scheduled"):
        return "gcal"
    if stream_type in ("plane-issue", "plane_issue", "plane-comment", "plane-event", "plane"):
        return "plane"
    if stream_type in ("vault-edit", "vault-record-edit", "vault_edit"):
        return "vault_edit"
    if stream_type.startswith("sure"):
        return "sure"

    # OpenClaw chat: stream_type=conversation with a system-openclaw
    # source id, OR an agent: source_ref. Mirrors the dispatch in
    # _render_event.
    if stream_type == "conversation" and (
        str(event.get("stream_id", "")).startswith("system-openclaw-")
        or str(event.get("source_ref", "")).startswith("agent:")
    ):
        return "openclaw-chat"

    # Calendar inferred from raw start/end fields.
    if raw.get("start") and raw.get("end"):
        return "gcal"

    # Email via metadata.event_type.
    if event_type in ("email", "gmail"):
        return "gmail"

    # Slack via metadata.event_type.
    if "slack" in event_type:
        return "slack"

    # Voice call always lands as omi.
    if event_type == "voice-call":
        return "omi"

    # Legacy "conversation" record_type → omi default.
    if legacy_record_type == "conversation":
        return "omi"

    return "generic"


def _stream_event_slug(event: dict[str, Any], source_type: str) -> str:
    """Return ``<source_type>-<deterministic-slug>`` for a new stream event.

    Re-uses ``_event_slug`` (sha256(source_ref) + date) for the unique
    portion and adds the source_type prefix so a quick ls of
    ``stream_event/`` is human-scannable. The prefix is ALSO what
    distinguishes a freshly-minted stream_event from a migrator-output
    record (the migrator names them the same way), so the migrator's
    idempotent re-run can detect already-migrated records by content
    hash without a separate marker file.
    """
    base = _event_slug(event)
    if base.lower().startswith(f"{source_type.lower()}-"):
        return base
    return f"{source_type}-{base}"


# ---------------------------------------------------------------------------
# Template dispatcher
# ---------------------------------------------------------------------------

def _render_event(event: dict[str, Any]) -> tuple[str, str, list[str], str]:
    """Dispatch to the right template. Returns (name, body, tags, record_type)."""
    raw = event.get("raw", {})
    if not isinstance(raw, dict):
        raw = {}
    metadata = event.get("metadata", {})
    if not isinstance(metadata, dict):
        metadata = {}

    event_type = metadata.get("event_type", event.get("stream_type", ""))
    stream_type = event.get("stream_type", "")

    # Omi audio — full transcripts. Check first so it doesn't fall through
    # to the generic path and lose the body past 500 chars.
    if stream_type == "omi-audio" or event_type == "omi-audio":
        return _template_omi(event, raw, metadata)

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

    # OpenClaw chat sessions arrive with stream_type="conversation" and
    # source_id="system-openclaw-sessions". Other conversation streams
    # (omi-audio, voice-call) get matched above by their dedicated
    # stream_type, so this branch is exclusively openclaw chat sessions.
    # Critical for Phase 6 signal extraction — the LLM needs full
    # turn-by-turn body, not just the bare summary _template_generic
    # produces (which loses every Sir-said-X assertion).
    if stream_type == "conversation" and (
        str(event.get("stream_id", "")).startswith("system-openclaw-")
        or str(event.get("source_ref", "")).startswith("agent:")
    ):
        return _template_openclaw_chat(event, raw, metadata)

    return _template_generic(event, raw, metadata)


# ---------------------------------------------------------------------------
# Per-source templates
# ---------------------------------------------------------------------------

def _template_calendar(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str], str]:
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

    return summary[:120], "\n".join(parts), tags, "event"


def _template_email(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str], str]:
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
    return name, "\n".join(parts), tags, "event"


def _template_github(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str], str]:
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
        return name[:120], body, ["github", "pull-request"], "event"

    if issue:
        title = issue.get("title", "")
        number = issue.get("number", "")
        name = f"Issue #{number}: {title}" if number else title or "Issue"
        body = f"**Repo**: {repo}\n**Author**: {actor}\n**Action**: {action}"
        return name[:120], body, ["github", "issue"], "event"

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
    return name[:120], body, ["github"], "event"


def _template_slack(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str], str]:
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
    return name[:120], "\n".join(parts), ["slack"], "event"


def _template_notion(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str], str]:
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

    return str(title)[:120], "\n".join(parts), ["notion"], "event"


def _template_payment(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str], str]:
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

    return name[:120], "\n".join(parts), ["payment"], "event"


def _template_sms(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str], str]:
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
    return name[:120], "\n".join(parts), tags, "event"


def _template_voice_call(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str], str]:
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
    return name[:120], "\n".join(parts), tags, "conversation"


def _template_openclaw_chat(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str], str]:
    """OpenClaw chat session — render full turn-by-turn body.

    Source: ``system-openclaw-sessions`` stream. Each event represents
    one closed/idle session. ``raw.messages`` is the canonical list of
    ``{role, content, at}`` dicts (NOTE: ``raw.turns`` is just a count,
    NOT the array — caught at T6.1.2 implementation, would have been
    silently empty if we'd trusted the spec field name).

    The body must preserve every assertion verbatim — Phase 6 signal
    extraction reads it for "Sir said X" corrections. Bare summary
    (which is what ``_template_generic`` was producing) loses
    everything past the first user turn.

    Channel inference from ``source_ref``:
      ``agent:main:dashboard:...`` → dashboard
      ``agent:main:slack:...``     → slack (note: this is openclaw routing
                                    Sir-via-slack-DM through the same agent;
                                    distinct from the composio-slack-list
                                    stream which captures non-DM channels)
      ``agent:main:telegram:...``  → telegram
      ``agent:main:cli:...``       → cli
      ``agent:main:mcp:...``       → mcp
    """
    source_ref = str(event.get("source_ref") or "")
    session_key = raw.get("session_key") or ""
    messages = raw.get("messages") or []

    # Channel from source_ref — second segment after "agent:main:".
    channel = "openclaw-unknown"
    if source_ref.startswith("agent:main:"):
        rest = source_ref[len("agent:main:"):]
        # Take everything up to the next colon — that's the channel.
        ch = rest.split(":", 1)[0]
        if ch:
            channel = ch

    # Build summary line (matches existing "Chat session — N turns: <first>" shape).
    first_user_msg = next(
        (str(m.get("content") or "").strip() for m in messages if isinstance(m, dict) and m.get("role") == "user"),
        "",
    )
    turn_count = len(messages) if isinstance(messages, list) else int(raw.get("turns") or 0)
    name_summary = first_user_msg[:80] if first_user_msg else f"({turn_count} turns)"
    name = f"Chat session — {turn_count} turns: {name_summary}"[:120]

    # Body: turn-by-turn, full content (no truncation per turn — Phase
    # 6 needs to see every assertion). Cap individual turns at 4000
    # chars to defend against accidental large dumps; that's still
    # plenty for any real exchange.
    parts: list[str] = []
    parts.append(f"**Channel**: {channel}")
    parts.append(f"**Session**: {session_key}")
    parts.append(f"**Turns**: {turn_count}")
    parts.append("")
    parts.append("## Turns")
    parts.append("")
    for m in (messages if isinstance(messages, list) else []):
        if not isinstance(m, dict):
            continue
        role_raw = str(m.get("role") or "?").lower()
        # Normalize: human-readable label, but keep the raw role in
        # the heading for accurate machine parsing later.
        if role_raw == "user":
            label = "Sir"
        elif role_raw == "assistant":
            label = "Alfred"
        elif role_raw == "system":
            label = "System"
        elif role_raw == "tool":
            label = "Tool"
        else:
            label = role_raw.capitalize()
        when = str(m.get("at") or "")
        ts_suffix = f" ({when})" if when else ""
        content = str(m.get("content") or "").strip()
        if not content:
            continue
        if len(content) > 4000:
            content = content[:4000] + "…"
        parts.append(f"### {label}{ts_suffix}")
        parts.append("")
        parts.append(content)
        parts.append("")

    body = "\n".join(parts)
    tags = ["openclaw-chat", channel]
    # record_type: "conversation" — matches OMI/voice-call convention.
    # Phase 6.6 unifies all conversation/event records into stream_event/.
    return name, body, tags, "conversation"


def _template_generic(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str], str]:
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
    return name, body, [stream_type], "event"


def _template_omi(
    event: dict[str, Any], raw: dict, metadata: dict,
) -> tuple[str, str, list[str], str]:
    """Omi audio transcript → conversation record with FULL body preserved.

    The Omi ingest activity packs the date, time range, language, and part
    number into `raw.text` as a prefix, followed by the full transcript.
    We keep the whole thing so downstream enrichment can see mid-transcript
    content (e.g. ambient "Erste" / "makerspace" mentions that never appear
    in the first sentence).

    Metadata fields like `conversation_id`, `languages`, `duration_seconds`,
    `segment_count`, `part`, `total_parts` are propagated into frontmatter
    via `_build_vault_content` (which reads the top-level `metadata` field
    on the event payload).
    """
    # Pull the full transcript — no 500-char truncation like generic.
    body = raw.get("text", "") or ""
    if not body:
        # Fall back to any other text-ish field
        for key in ("body", "content", "summary"):
            val = raw.get(key) or event.get(key)
            if val and isinstance(val, str):
                body = val
                break

    date = raw.get("date") or metadata.get("date") or ""
    time_range = raw.get("time_range") or metadata.get("time_range") or ""
    languages = raw.get("languages") or metadata.get("languages") or []
    part = raw.get("part") or metadata.get("part") or 1
    total_parts = raw.get("total_parts") or metadata.get("total_parts") or 1

    lang_str = (
        "/".join(str(l) for l in languages) if isinstance(languages, list) and languages
        else ""
    )
    part_suffix = f" pt {part}/{total_parts}" if total_parts and int(total_parts) > 1 else ""
    name_parts = ["Omi conversation"]
    if date:
        name_parts.append(date)
    if time_range:
        name_parts.append(time_range)
    if lang_str:
        name_parts.append(f"({lang_str})")
    name = " — ".join(name_parts)[:120] + part_suffix

    tags = ["omi-audio"]
    if lang_str:
        for l in (languages if isinstance(languages, list) else [lang_str]):
            if l and isinstance(l, str):
                tags.append(f"lang/{l}")

    # Record type: conversation (multi-speaker dialogue captured in full),
    # so surveyor's ENTITY_RECORD_TYPES still sees it as a non-entity
    # record that links to matters/persons/orgs/projects.
    return name, body, tags, "conversation"


# ---------------------------------------------------------------------------
# Vault record builder
# ---------------------------------------------------------------------------

def _build_vault_content(
    name: str,
    event: dict[str, Any],
    body: str,
    tags: list[str],
    record_type: str = "event",
    *,
    source_type: str | None = None,
) -> str:
    received_at = event.get("received_at", datetime.now(timezone.utc).isoformat())
    stream_id = event.get("stream_id", "")
    source_ref = event.get("source_ref", "")
    stream_type = event.get("stream_type", "unknown")
    tag_str = ", ".join(tags) if tags else ""

    safe_name = name.replace('"', '\\"')

    # Extra frontmatter for rich streams (Omi etc.) — surface useful metadata
    # without hardcoding into every template.
    extra_fm_lines: list[str] = []
    metadata = event.get("metadata") or {}
    raw = event.get("raw") or {}
    if stream_type == "omi-audio":
        # Pull from either metadata or raw, whichever has the field.
        def _get(key: str, default: Any = "") -> Any:
            return metadata.get(key) if metadata.get(key) is not None else raw.get(key, default)
        conv_id = _get("conversation_id")
        duration = _get("duration_seconds")
        segments = _get("segments") or _get("segment_count")
        word_count = _get("word_count")
        langs = _get("languages") or []
        part = _get("part")
        total_parts = _get("total_parts")
        if conv_id: extra_fm_lines.append(f'conversation_id: "{conv_id}"')
        if isinstance(langs, list) and langs:
            langs_yaml = ", ".join(f'"{l}"' for l in langs if l)
            extra_fm_lines.append(f"languages: [{langs_yaml}]")
        if duration: extra_fm_lines.append(f"duration_seconds: {duration}")
        if segments: extra_fm_lines.append(f"segments: {segments}")
        if word_count: extra_fm_lines.append(f"word_count: {word_count}")
        if part and total_parts and int(total_parts) > 1:
            extra_fm_lines.append(f"part: {part}")
            extra_fm_lines.append(f"total_parts: {total_parts}")
        # Ambient-capture forward-defense (#650): Omi pendant captures
        # whatever it hears — conferences, restaurants, family dinners,
        # other people's phone calls. Without speaker diarization (today
        # Whisper doesn't do it by default), we cannot tell which segments
        # are Sir's voice vs ambient. Default to the conservative posture:
        # treat every Omi conversation as "things Sir was AROUND" rather
        # than "things Sir SAID/OWNS". Downstream enrichment + Alfred's
        # answering layer should require explicit possession evidence
        # before asserting Sir owns/uses/drives any entity mentioned here.
        #
        # When diarization is wired (segments[].speaker_id == owner), this
        # block can be relaxed — but only for that specific case. Lack of
        # diarization stays ambient.
        segments_list = _get("segments_list") or raw.get("segments")
        owner_id = _get("owner_id") or metadata.get("owner_speaker_id")
        attribution = _compute_omi_speaker_attribution(segments_list, owner_id)
        extra_fm_lines.append(f"speaker_attribution: {attribution}")
        extra_fm_lines.append(
            f"possession_evidence: {'true' if attribution == 'owner' else 'false'}"
        )

    extra_fm = ("\n" + "\n".join(extra_fm_lines)) if extra_fm_lines else ""

    # Phase 6.6: stamp source_type as a top-level frontmatter scalar
    # so the signal extractor's normalizer can classify in O(1)
    # without scanning tags or filename. We always emit the field
    # (even when caller didn't pass source_type — the legacy
    # non-stream callers still get a placeholder so the schema is
    # uniform across all event/stream_event records).
    source_type_value = source_type or "generic"
    src_type_line = f"source_type: {source_type_value}"

    return f"""---
type: {record_type}
created: {received_at}
status: active
name: "{safe_name}"
source: "{stream_id}"
source_ref: "{source_ref}"
stream_type: {stream_type}
{src_type_line}
tags: [{tag_str}]
enrichment_status: pending
signal_extracted_at: null{extra_fm}
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


def _compute_omi_speaker_attribution(
    segments: Any, owner_id: Any,
) -> str:
    """Return ``owner`` only if diarization proves Sir was the speaker (#650).

    Conservative default — anything we can't prove is Sir's voice gets
    tagged ``ambient``:

    - No segments OR no diarization data → ``ambient``
    - No known owner speaker id → ``ambient`` (we can't compare)
    - Any segment has ``speaker_id != owner_id`` → ``ambient`` (mixed audio)
    - All segments speaker_id match owner_id → ``owner`` (proven Sir)

    Today's Omi pipeline doesn't emit ``speaker_id`` per segment (Whisper
    doesn't diarize by default), so this returns ``ambient`` for every
    real conversation. The branch exists so that the moment diarization
    lands, the same template starts gating correctly without rewrite.
    """
    if not isinstance(segments, list) or not segments:
        return "ambient"
    if not owner_id:
        return "ambient"
    has_any_speaker_field = False
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        if "speaker_id" not in seg:
            continue
        has_any_speaker_field = True
        if seg.get("speaker_id") != owner_id:
            return "ambient"
    if not has_any_speaker_field:
        return "ambient"
    return "owner"


def apply_two_strike_promotion(
    record_type: str,
    existing_frontmatter: dict[str, Any] | None,
    new_stream_id: str,
) -> dict[str, Any]:
    """Compute the frontmatter delta for a stream-driven entity touch (#651).

    This is the public surface the downstream entity-creation paths
    (``activities/vault.py:ensure_entities_exist`` and
    ``activities/enrichment.py:_create_discovered_entities``) should call
    to start auto-discoveries as ``provisional`` and promote them only
    once a *second distinct* stream corroborates them.

    No code path in this PR invokes it yet — wiring those callers is a
    follow-up because they live under ``activities/`` which #650/#651
    explicitly told us to leave alone. But the helper is here, tested,
    and ready so the downstream PR is a small surgical change.

    Args:
        record_type: ``org``, ``person``, ``location``, etc.
        existing_frontmatter: The current YAML frontmatter (or None for
            a brand-new record).
        new_stream_id: The stream id introducing the mention right now.

    Returns:
        A frontmatter delta dict with the keys that should be set/updated
        on the entity record. Empty dict if the type is non-provisional
        or if nothing changed (existing already-active record, no new
        stream id).
    """
    if not is_provisional_entity_type(record_type):
        return {}

    existing = existing_frontmatter or {}
    current_status = existing.get("status")
    existing_streams = existing.get("mentioned_by_streams") or []

    if current_status is None:
        # Brand-new auto-discovery from a single stream.
        merged, _ = merge_mentioned_streams(existing_streams, new_stream_id)
        return {
            "status": initial_status_for_auto_discovery(record_type),
            "mentioned_by_streams": merged,
        }

    merged, added = merge_mentioned_streams(existing_streams, new_stream_id)
    delta: dict[str, Any] = {}
    if added:
        delta["mentioned_by_streams"] = merged
    promoted_status = next_status(current_status, merged)
    if promoted_status != current_status:
        delta["status"] = promoted_status
    return delta


def _format_dt(dt_str: str) -> str:
    """Format an ISO datetime string for display."""
    if not dt_str:
        return ""
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        return dt_str[:16]
