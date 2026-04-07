"""Vault read/write activities — all go through alfred-ctrl API."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Optional

from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient


def slugify(name: str) -> str:
    """Lowercase, replace spaces/underscores with hyphens, strip non-alphanum."""
    s = name.lower()
    s = re.sub(r"[_\s]+", "-", s)
    s = re.sub(r"[^a-z0-9-]", "", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-")


def vault_record_path(
    record_type: str,
    name: str,
    created: Optional[datetime] = None,
) -> str:
    """Build a vault path, optionally date-based: {type}/YYYY/MM/DD/{slug}.md"""
    config = load_config()
    slug = slugify(name)
    if config.use_date_paths:
        dt = created or datetime.now()
        return f"{record_type}/{dt.strftime('%Y/%m/%d')}/{slug}.md"
    return f"{record_type}/{slug}.md"


@activity.defn
async def drop_raw_event_to_inbox(event: dict[str, Any]) -> str:
    """Drop a raw stream event into the vault inbox as markdown.

    Builds a simple markdown file with the full raw content and metadata.
    The curator's 4-stage pipeline (analyze → entity resolution → interlink
    → enrich) handles all classification and structuring.

    No LLM calls — pure Python content extraction.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        stream_type = event.get("stream_type", "unknown")
        received_at = event.get("received_at", event.get("created_at", ""))
        source_ref = event.get("source_ref", event.get("id", ""))
        raw = event.get("raw", {})

        # Extract a subject/summary line for the title
        title = "Untitled"
        raw_text = ""
        metadata_parts: list[str] = []

        if isinstance(raw, dict):
            # Try common title fields
            title = (
                raw.get("subject")
                or raw.get("title")
                or raw.get("name")
                or raw.get("snippet", "")[:80]
                or "Untitled"
            )

            # Extract full body content
            body_parts: list[str] = []
            for key in ("body", "text", "content", "snippet"):
                val = raw.get(key)
                if val and isinstance(val, str):
                    body_parts.append(val)
                    break  # use the richest field available

            # Conversation messages (openclaw sessions, chats)
            for msg in raw.get("messages", []):
                if isinstance(msg, dict):
                    role = msg.get("role", "")
                    content = msg.get("content", "")
                    body_parts.append(f"**{role}**: {content}" if role else str(content))
                elif isinstance(msg, str):
                    body_parts.append(msg)

            raw_text = "\n\n".join(body_parts)

            # Collect metadata fields (everything that isn't the body)
            skip_keys = {"body", "text", "content", "snippet", "messages", "subject", "title", "name"}
            for k, v in raw.items():
                if k not in skip_keys and v:
                    if isinstance(v, (str, int, float, bool)):
                        metadata_parts.append(f"- **{k}**: {v}")
                    elif isinstance(v, list) and len(v) <= 10:
                        metadata_parts.append(f"- **{k}**: {', '.join(str(i) for i in v)}")

        elif isinstance(raw, str):
            raw_text = raw
            title = raw[:80].split("\n")[0] or "Untitled"

        # Build the markdown inbox file
        parts = [f"# {title}", ""]
        parts.append(f"**Source**: {stream_type}")
        if received_at:
            parts.append(f"**Received**: {received_at}")
        if source_ref:
            parts.append(f"**Source ref**: {source_ref}")
        parts.append("")

        parts.append("## Content")
        parts.append("")
        parts.append(raw_text if raw_text else "(no content)")
        parts.append("")

        if metadata_parts:
            parts.append("## Metadata")
            parts.append("")
            parts.extend(metadata_parts)
            parts.append("")

        content = "\n".join(parts)

        # Filename: date-slugified-title.md
        slug = re.sub(r'[^\w\s-]', '', title.lower())
        slug = re.sub(r'[\s]+', '-', slug)[:60]
        today = datetime.now().strftime("%Y-%m-%d")
        filename = f"{today}-{slug}.md"

        path = await client.drop_to_inbox(filename, content)
        return f"inbox/{path}"
    finally:
        await client.close()


@activity.defn
async def write_vault_record(classification: dict[str, Any]) -> str:
    """Legacy: Drop a classified event into the vault inbox.

    Kept for backward compatibility. New code should use drop_raw_event_to_inbox.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        record_type = classification.get("type", "note")
        title = classification.get("title", "Untitled")
        summary = classification.get("summary", "")
        tags = classification.get("tags", [])
        entities = classification.get("entities", [])
        action_items = classification.get("action_items", [])
        source = classification.get("source", "")
        raw_text = classification.get("raw_text", "")

        parts = [f"# {title}", ""]

        if record_type != "note":
            parts.append(f"**Classified as**: {record_type}")
        if tags:
            parts.append(f"**Tags**: {', '.join(tags)}")
        if source:
            parts.append(f"**Source**: {source}")
        parts.append("")

        if summary:
            parts.append(summary)
            parts.append("")

        if raw_text:
            parts.append("## Full content")
            parts.append("")
            parts.append(raw_text)
            parts.append("")

        if entities:
            parts.append("## People and entities mentioned")
            for e in entities:
                parts.append(f"- {e.get('name', '')} ({e.get('type', '')})")
            parts.append("")

        if action_items:
            parts.append("## Action items")
            for item in action_items:
                parts.append(f"- {item}")
            parts.append("")

        content = "\n".join(parts)

        slug = re.sub(r'[^\w\s-]', '', title.lower())
        slug = re.sub(r'[\s]+', '-', slug)[:60]
        today = datetime.now().strftime("%Y-%m-%d")
        filename = f"{today}-{slug}.md"

        path = await client.drop_to_inbox(filename, content)
        return f"inbox/{path}"
    finally:
        await client.close()


@activity.defn
async def write_observation_record(observation: dict[str, Any]) -> str:
    """Write an observation record to the vault (rich schema)."""
    config = load_config()
    client = VaultClient(config)
    try:
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc).isoformat()
        signals = observation.get("signals", {})
        input_type = observation.get("input_type", "other")
        input_source = observation.get("input_source", "unknown")
        input_ref = observation.get("input_ref", "")
        confidence = observation.get("confidence", "human")
        routed_by = observation.get("routed_by", "user")
        reasoning = observation.get("reasoning", "")
        source = observation.get("source", "chat")
        source_session = observation.get("source_session", "")
        created_by = observation.get("created_by", "")
        tags = observation.get("tags", [])
        considered_alternatives = observation.get("considered_alternatives", [])

        # routing_decision: structured dict or legacy string
        rd = observation.get("routing_decision", "")
        if isinstance(rd, dict):
            rd_yaml = f"""routing_decision:
  destination: "{rd.get('destination', '')}"
  process: "{rd.get('process', '')}"
  assigned_to: "{rd.get('assigned_to', '')}" """
        else:
            rd_yaml = f'routing_decision: "{rd}"'

        # Format considered_alternatives
        alts_yaml = ""
        if considered_alternatives:
            alts_lines = "\n".join(f'  - "{alt}"' for alt in considered_alternatives)
            alts_yaml = f"considered_alternatives:\n{alts_lines}"
        else:
            alts_yaml = "considered_alternatives: []"

        content = f"""---
type: observation
created: {now}
status: unprocessed
input_ref: "{input_ref}"
input_type: {input_type}
input_source: {input_source}
{rd_yaml}
reasoning: "{reasoning}"
{alts_yaml}
signals:
  domain_patterns: {signals.get("domain_patterns", [])}
  keyword_patterns: {signals.get("keyword_patterns", [])}
  input_types: {signals.get("input_types", [])}
  attachment_patterns: {signals.get("attachment_patterns", [])}
confidence: {confidence}
routed_by: {routed_by}
source: {source}
source_session: "{source_session}"
created_by: "{created_by}"
tags: {tags}
---
"""

        raw_name = f"observation-{now[:10]}-{input_type}"
        name = vault_record_path("observation", raw_name)
        path = await client.write_record("observation", name, content)
        return path
    finally:
        await client.close()


@activity.defn
async def fetch_unassigned_records() -> list[dict[str, Any]]:
    """Fetch recent vault records not assigned to a session."""
    config = load_config()
    client = VaultClient(config)
    try:
        records = []
        for rtype in ("triage", "event", "note", "conversation"):
            found = await client.list_records(rtype, limit=50)
            for r in found:
                if not r.get("session_id"):
                    records.append(r)
        return records
    finally:
        await client.close()


@activity.defn
async def create_session_record(session: dict[str, Any]) -> str:
    """Create a session record in the vault."""
    config = load_config()
    client = VaultClient(config)
    try:
        records = session.get("records", [])
        start = session.get("start", "")
        end = session.get("end", "")
        record_count = len(records)

        content = f"""---
type: session
name: Session {start[:10]}
status: active
start: {start}
end: {end}
record_count: {record_count}
---

## Records
"""
        for r in records:
            content += f"- [[{r.get('path', '')}]]\n"

        name = vault_record_path("session", f"session-{start[:10]}")
        path = await client.write_record("session", name, content)
        return path
    finally:
        await client.close()


@activity.defn
async def assign_records_to_session(
    records: list[dict[str, Any]],
    session_path: str,
) -> None:
    """Update records to assign them to a session."""
    config = load_config()
    client = VaultClient(config)
    try:
        for record in records:
            path = record.get("path", "")
            if not path:
                continue
            existing = await client.read_record(path)
            raw = existing.get("content", "")
            # Add session_id to frontmatter
            if "---" in raw:
                parts = raw.split("---", 2)
                if len(parts) >= 3:
                    updated = f"---{parts[1]}session_id: \"{session_path}\"\n---{parts[2]}"
                    await client.update_record(path, updated)
    finally:
        await client.close()


@activity.defn
async def collect_daily_activity() -> dict[str, Any]:
    """Collect today's vault activity for the daily digest."""
    config = load_config()
    client = VaultClient(config)
    try:
        triages = await client.list_records("triage", limit=50)
        events = await client.list_records("event", limit=50)
        notes = await client.list_records("note", limit=50)
        sessions = await client.list_records("session", limit=20)

        return {
            "triages": triages,
            "events": events,
            "notes": notes,
            "sessions": sessions,
            "triage_count": len(triages),
            "event_count": len(events),
            "note_count": len(notes),
            "session_count": len(sessions),
        }
    finally:
        await client.close()


@activity.defn
async def write_digest_record(digest: dict[str, Any]) -> str:
    """Write the daily digest as an event record."""
    config = load_config()
    client = VaultClient(config)
    try:
        title = digest.get("title", "Daily Digest")
        summary = digest.get("summary", "")
        highlights = digest.get("highlights", [])
        body = digest.get("body", "")

        content = f"""---
type: event
name: {title}
status: active
tags: [digest, daily]
---

# {title}

{summary}

## Highlights
"""
        for h in highlights:
            content += f"- {h}\n"

        if body:
            content += f"\n{body}\n"

        name = vault_record_path("event", title)
        path = await client.write_record("event", name, content)
        return path
    finally:
        await client.close()


@activity.defn
async def ensure_entities_exist(entities: list[dict[str, Any]]) -> None:
    """Ensure person/org records exist for discovered entities."""
    config = load_config()
    client = VaultClient(config)
    try:
        for entity in entities:
            name = entity.get("name", "")
            etype = entity.get("type", "person")
            if not name:
                continue
            # Check if entity already exists
            results = await client.search_records(name, record_type=etype)
            if not results:
                content = f"""---
type: {etype}
name: {name}
status: active
---

# {name}
"""
                await client.write_record(etype, name, content)
    finally:
        await client.close()


@activity.defn
async def write_quarantine_record(event_id: str, errors: list[str]) -> str:
    """Write a quarantine markdown file to the vault via alfred-ctrl API."""
    config = load_config()
    client = VaultClient(config)
    try:
        from datetime import timezone

        now = datetime.now(timezone.utc).isoformat()
        errors_yaml = "\n".join(f'  - "{e}"' for e in errors)

        content = f"""---
type: quarantine
event_id: {event_id}
quarantined_at: {now}
errors:
{errors_yaml}
---

# Quarantined Event

Event ID: {event_id}
Reason: {'; '.join(errors)}
"""
        path = await client.write_record("quarantine", event_id, content)
        return path
    finally:
        await client.close()


@activity.defn
async def fetch_unprocessed_observations() -> list[dict[str, Any]]:
    """Fetch observations with status 'unprocessed'."""
    config = load_config()
    client = VaultClient(config)
    try:
        return await client.list_records("observation", status="unprocessed")
    finally:
        await client.close()


@activity.defn
async def fetch_active_instincts() -> list[dict[str, Any]]:
    """Fetch all active instincts."""
    config = load_config()
    client = VaultClient(config)
    try:
        return await client.list_records("instinct", status="active")
    finally:
        await client.close()


@activity.defn
async def apply_instinct_change(proposal: dict[str, Any]) -> None:
    """Apply a single instinct change proposal (create/update/merge/deprecate)."""
    config = load_config()
    client = VaultClient(config)
    try:
        action = proposal.get("action", "")
        if action == "create":
            instinct = proposal.get("instinct", {})
            name = instinct.get("name", "new-instinct")
            content = _build_instinct_content(instinct)
            await client.write_record("instinct", name, content)

        elif action == "update":
            path = proposal.get("path", "")
            changes = proposal.get("changes", {})
            if path:
                existing = await client.read_record(path)
                raw = existing.get("content", "")
                # Apply field updates to frontmatter
                updated = _apply_frontmatter_updates(raw, changes)
                await client.update_record(path, updated)

        elif action == "merge":
            # Create merged instinct, deprecate sources
            merged = proposal.get("merged_instinct", {})
            name = merged.get("name", "merged-instinct")
            content = _build_instinct_content(merged)
            await client.write_record("instinct", name, content)
            for source_path in proposal.get("source_paths", []):
                existing = await client.read_record(source_path)
                raw = existing.get("content", "")
                updated = _apply_frontmatter_updates(raw, {
                    "status": "deprecated",
                    "deprecation_reason": f"merged into {name}",
                })
                await client.update_record(source_path, updated)

        elif action == "deprecate":
            path = proposal.get("path", "")
            if path:
                existing = await client.read_record(path)
                raw = existing.get("content", "")
                updated = _apply_frontmatter_updates(
                    raw,
                    {"status": "deprecated", "deprecation_reason": proposal.get("reason", "")},
                )
                await client.update_record(path, updated)
    finally:
        await client.close()


@activity.defn
async def mark_observations_processed(observations: list[dict[str, Any]]) -> None:
    """Mark observations as processed."""
    config = load_config()
    client = VaultClient(config)
    try:
        for obs in observations:
            path = obs.get("path", "")
            if not path:
                continue
            existing = await client.read_record(path)
            raw = existing.get("content", "")
            updated = _apply_frontmatter_updates(raw, {"status": "processed"})
            await client.update_record(path, updated)
    finally:
        await client.close()


@activity.defn
async def rebuild_intuition_index() -> None:
    """Rebuild the intuition/index.md from all active instincts."""
    config = load_config()
    client = VaultClient(config)
    try:
        instincts = await client.list_records("instinct", status="active")

        content = """---
type: index
name: Intuition Index
---

# Intuition Index

"""
        for inst in instincts:
            name = inst.get("name", "")
            path = inst.get("path", "")
            obs_count = inst.get("observation_count", 0)
            content += f"- [[{path}]] — {name} ({obs_count} observations)\n"

        await client.write_record("index", "intuition-index", content)
    finally:
        await client.close()


@activity.defn
async def write_reflection_report(
    observations: list[dict[str, Any]],
    proposals: list[dict[str, Any]],
    changes: int,
    reasoning: str = "",
) -> str:
    """Write a nightly reflection report."""
    config = load_config()
    client = VaultClient(config)
    try:
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
        date_str = now.strftime("%Y-%m-%d")

        content = f"""---
type: reflection
name: Reflection {date_str}
created: {now.isoformat()}
status: active
observations_reviewed: {len(observations)}
changes_applied: {changes}
---

# Reflection — {date_str}

Reviewed {len(observations)} observations. Applied {changes} instinct changes.
"""

        if reasoning:
            content += f"""
## Reasoning
{reasoning}
"""

        content += """
## Proposals Applied
"""
        for p in proposals:
            action = p.get("action", "")
            detail = p.get("name", p.get("path", ""))
            content += f"- **{action}**: {detail}\n"

        path = await client.write_record("reflection", f"reflection-{date_str}", content)
        return path
    finally:
        await client.close()


@activity.defn
async def fetch_distiller_learnings() -> list[dict[str, Any]]:
    """Fetch distiller_learnings from completed tasks in the last 24h."""
    config = load_config()
    client = VaultClient(config)
    try:
        tasks = await client.list_records("triage", status="completed", limit=100)
        learnings = []
        for task in tasks:
            dl = task.get("distiller_learnings") or task.get("distiller_signals")
            if dl:
                learnings.append({
                    "task_path": task.get("path", ""),
                    "task_name": task.get("name", ""),
                    "learnings": dl if isinstance(dl, list) else [dl],
                })
        return learnings
    finally:
        await client.close()


@activity.defn
async def fetch_janitor_flags() -> list[dict[str, Any]]:
    """Fetch janitor_note flags from recent vault records."""
    config = load_config()
    client = VaultClient(config)
    try:
        flags = []
        for rtype in ("triage", "event", "note", "conversation"):
            records = await client.list_records(rtype, limit=50)
            for r in records:
                janitor_note = r.get("janitor_note")
                if janitor_note:
                    flags.append({
                        "path": r.get("path", ""),
                        "type": rtype,
                        "name": r.get("name", ""),
                        "janitor_note": janitor_note,
                    })
        return flags
    finally:
        await client.close()


def _build_instinct_content(instinct: dict[str, Any]) -> str:
    """Build markdown content for an instinct record (rich schema)."""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    name = instinct.get("name", "Unnamed Instinct")
    description = instinct.get("description", "")
    obs_count = len(instinct.get("observations", [])) or instinct.get("observation_count", 0)
    threshold = instinct.get("discretion_threshold", 0.95)
    weights = instinct.get("matching_weights", {
        "domain": 0.30, "keywords": 0.30,
        "input_type": 0.15, "attachment": 0.15, "tags": 0.10,
    })
    confidence_score = instinct.get("confidence_score", 0.0)
    observations = instinct.get("observations", instinct.get("based_on", []))
    tags = instinct.get("tags", [])

    # Rich schema: input_patterns
    input_patterns = instinct.get("input_patterns", {})
    if not input_patterns:
        signals = instinct.get("signals", {})
        input_patterns = {
            "sender_domains": signals.get("domain_patterns", []),
            "subject_keywords": signals.get("keyword_patterns", []),
            "attachment_types": signals.get("attachment_patterns", []),
            "input_types": signals.get("input_types", []),
        }

    # Rich schema: routing_rule
    routing_rule = instinct.get("routing_rule", {})
    if not routing_rule:
        destination = instinct.get("routing_destination", "")
        routing_rule = {
            "destination_type": "project",
            "destination": destination,
            "destination_resolver": None,
            "process": "",
            "default_assignee": "",
        }

    obs_lines = ""
    if observations:
        obs_entries = []
        for ref in observations:
            if ref.startswith("[["):
                obs_entries.append(f'  - "{ref}"')
            else:
                obs_entries.append(f'  - "[[{ref}]]"')
        obs_lines = "\n".join(obs_entries)
    else:
        obs_lines = "  []"

    resolver = routing_rule.get("destination_resolver")
    resolver_yaml = "null" if resolver is None else f'"{resolver}"'

    return f"""---
type: instinct
name: {name}
status: active
description: "{description}"
input_patterns:
  sender_domains: {input_patterns.get("sender_domains", [])}
  subject_keywords: {input_patterns.get("subject_keywords", [])}
  attachment_types: {input_patterns.get("attachment_types", [])}
  input_types: {input_patterns.get("input_types", [])}
routing_rule:
  destination_type: {routing_rule.get("destination_type", "project")}
  destination: "{routing_rule.get("destination", "")}"
  destination_resolver: {resolver_yaml}
  process: "{routing_rule.get("process", "")}"
  default_assignee: "{routing_rule.get("default_assignee", "")}"
confidence_score: {confidence_score}
observation_count: {obs_count}
observations:
{obs_lines}
last_reflection: {now}
matching_weights:
  domain: {weights.get("domain", 0.30)}
  keywords: {weights.get("keywords", 0.30)}
  input_type: {weights.get("input_type", 0.15)}
  attachment: {weights.get("attachment", 0.15)}
  tags: {weights.get("tags", 0.10)}
discretion_threshold: {threshold}
created: {now}
updated: {now}
tags: {tags}
---

## Routing Logic
{instinct.get("routing_logic", "Route matching inputs to " + routing_rule.get("destination", ""))}

## Exceptions
{instinct.get("exceptions", "None defined yet.")}
"""


def _apply_frontmatter_updates(raw: str, updates: dict[str, Any]) -> str:
    """Update frontmatter fields in a raw markdown string."""
    if "---" not in raw:
        return raw
    parts = raw.split("---", 2)
    if len(parts) < 3:
        return raw
    fm_lines = parts[1].strip().split("\n")
    updated_keys: set[str] = set()
    new_lines: list[str] = []
    for line in fm_lines:
        key = line.split(":")[0].strip() if ":" in line else ""
        if key in updates:
            val = updates[key]
            new_lines.append(f"{key}: {val}")
            updated_keys.add(key)
        else:
            new_lines.append(line)
    # Add any missing keys
    for key, val in updates.items():
        if key not in updated_keys:
            new_lines.append(f"{key}: {val}")
    return f"---\n{chr(10).join(new_lines)}\n---{parts[2]}"
