"""Batched enrichment activities for the HourlyEnrichmentWorkflow.

Collects pending vault event records, sends ONE clerk LLM call per batch
to extract entities, tags, related matters, and action items, then
applies the enrichments back to the vault records.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


# Per-event body cap. Long transcripts (Omi 30-min meetings can run
# 30-50k chars) still need to be trimmed somewhere, but 20k chars is
# roughly 5-7k tokens — enough to cover mid-transcript matter mentions
# (Erste/makerspace cases) without blowing a single event's cost.
MAX_BODY_CHARS_PER_EVENT = 20_000

# Size-based batch target. Clerk (fast-tier OpenRouter models) comfortably
# takes 128k tokens of context; we want to leave room for output (entities
# + action_items JSON can run 5-10k tokens for a busy batch). 80k chars of
# input is ~20-25k tokens under the ~3 chars/token rule of thumb for mixed
# content (shorter for ASCII-heavy English, longer for Hungarian/UTF-8).
# Well under any provider cap.
MAX_INPUT_CHARS_PER_BATCH = 80_000


def pack_enrichment_batches(
    records: list[dict[str, Any]],
    max_chars: int = MAX_INPUT_CHARS_PER_BATCH,
) -> list[list[dict[str, Any]]]:
    """Pack records into batches whose total input size is under max_chars.

    - A single record larger than max_chars goes in its own batch (the
      per-event cap in fetch_pending_enrichment_records keeps that from
      blowing up the prompt — MAX_BODY_CHARS_PER_EVENT is well under
      max_chars by design).
    - Within a batch, pack greedily by record order (preserves the
      clerk's per-event index semantics when downstream inspects results).
    """
    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    current_size = 0
    for r in records:
        body = r.get("body") or r.get("body_preview") or ""
        # Rough size estimate: body + name + metadata overhead. Use
        # len(body) + 200-char buffer per record for the prompt framing.
        rec_size = len(body) + 200
        if current and current_size + rec_size > max_chars:
            batches.append(current)
            current = []
            current_size = 0
        current.append(r)
        current_size += rec_size
    if current:
        batches.append(current)
    return batches

# Record types that flow through enrichment. event is the default for
# stream records, conversation is for Omi / voice transcripts, note +
# observation cover curator+distiller output that still wants entity
# and action-item extraction.
ENRICHED_RECORD_TYPES = ("event", "conversation", "note", "observation")


@activity.defn
async def fetch_pending_enrichment_records() -> list[dict[str, Any]]:
    """Fetch vault records of enrichable types with enrichment_status=pending.

    Keeps the full body (up to MAX_BODY_CHARS_PER_EVENT) rather than a
    200-char preview — the batch-enricher prompt used to see only the first
    sentence of each event, which for long Omi transcripts meant ambient
    matter/entity mentions mid-conversation were silently lost.
    """
    config = load_config()
    client = VaultClient(config)
    pending: list[dict[str, Any]] = []
    try:
        for rtype in ENRICHED_RECORD_TYPES:
            try:
                records = await client.list_records(rtype, limit=500)
            except Exception as exc:
                logger.warning("enrichment: list_records(%s) failed: %s", rtype, exc)
                continue
            for record in records:
                fm = record.get("frontmatter", record)
                if fm.get("enrichment_status") != "pending":
                    continue
                body = record.get("body", "") or ""
                pending.append({
                    "path": record.get("path", ""),
                    "name": fm.get("name", record.get("name", "")),
                    "stream_type": fm.get("stream_type", ""),
                    "source_ref": fm.get("source_ref", ""),
                    "record_type": rtype,
                    "created": fm.get("created", ""),
                    "tags": fm.get("tags", []),
                    "body": body[:MAX_BODY_CHARS_PER_EVENT],
                    "body_truncated": len(body) > MAX_BODY_CHARS_PER_EVENT,
                })
        logger.info("enrichment: found %d pending records across %d types",
                    len(pending), len(ENRICHED_RECORD_TYPES))
        return pending
    finally:
        await client.close()


@activity.defn
async def batch_enrich_events(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """ONE clerk LLM call to enrich a batch of records.

    Uses the full per-event body (up to MAX_BODY_CHARS_PER_EVENT, set by
    the fetch activity) rather than a 200-char preview. Callers pack the
    batch to a total-size budget via `pack_enrichment_batches`.
    """
    if not records:
        return []

    from src.activities.clerk import _call_clerk

    # Build the structured events block. We feed the full body available on
    # the record (already capped by fetch_pending_enrichment_records), so a
    # single long Omi transcript gets its mid-transcript content surfaced to
    # the clerk.
    events_lines: list[str] = []
    for i, r in enumerate(records):
        name = r.get("name", "?")
        stream_type = r.get("stream_type", "?")
        created = r.get("created", "")[:16]
        # Prefer full body; fall back to body_preview for backwards compat
        # with any caller still building the old shape.
        body = (r.get("body") or r.get("body_preview") or "").strip()
        trunc_note = " [TRUNCATED]" if r.get("body_truncated") else ""
        events_lines.append(f"[{i}] {name} (source: {stream_type}, {created}){trunc_note}")
        if body:
            events_lines.append(body)
        events_lines.append("")

    events_block = "\n".join(events_lines)

    prompt = f"""You are enriching a batch of {len(records)} stream events for Sir's vault.

For each event below, extract:
1. entities: people and organizations mentioned (name + type: person or org)
2. topic_tags: 2-5 topical keywords beyond the source tags
3. related_matters: if this event relates to a known project/matter, name it (empty list if unsure)
4. action_items: concrete next steps if any (empty list if none)
5. priority: low, normal, or high (based on urgency signals)

Return a JSON array where each element has:
{{"event_index": 0, "entities": [{{"name": "...", "type": "person"}}], "topic_tags": ["..."], "related_matters": ["..."], "action_items": ["..."], "priority": "normal"}}

EVENTS:
{events_block}

Return ONLY the JSON array. No explanation, no markdown fences."""

    activity.heartbeat(f"Calling clerk with {len(records)} events")

    try:
        result = await _call_clerk(prompt)
        # Result should be a parsed JSON dict/list
        if isinstance(result, list):
            return result
        if isinstance(result, dict):
            # Might be wrapped in a key
            for key in ("enrichments", "results", "data"):
                if isinstance(result.get(key), list):
                    return result[key]
            # Single enrichment? Wrap it.
            if "event_index" in result:
                return [result]
        # Try to extract JSON from string
        if isinstance(result, str):
            return _extract_json_array(result)
        logger.warning("enrichment: unexpected clerk result type: %s", type(result))
        return []
    except Exception as exc:
        logger.error("enrichment: clerk call failed: %s", exc)
        return []


@activity.defn
async def apply_enrichments(
    enrichments: list[dict[str, Any]],
    record_paths: list[str],
) -> int:
    """Apply enrichment results to vault records."""
    config = load_config()
    client = VaultClient(config)
    applied = 0
    try:
        for enrichment in enrichments:
            idx = enrichment.get("event_index", -1)
            if not isinstance(idx, int) or idx < 0 or idx >= len(record_paths):
                continue

            path = record_paths[idx]
            if not path:
                continue

            try:
                record = await client.read_record(path)
            except Exception:
                logger.warning("enrichment: could not read %s", path)
                continue

            # Parse existing content
            full_content = record.get("content", record.get("body", ""))
            if not full_content:
                continue

            # Update frontmatter
            entities = enrichment.get("entities", [])
            topic_tags = enrichment.get("topic_tags", [])
            related = enrichment.get("related_matters", [])
            action_items = enrichment.get("action_items", [])
            priority = enrichment.get("priority", "normal")

            # Build entity wikilinks
            entity_links = []
            for e in entities:
                ename = e.get("name", "")
                etype = e.get("type", "person")
                if ename:
                    entity_links.append(f"[[{etype}/{ename}]]")

            # Inject enrichment fields into frontmatter
            now = datetime.now(timezone.utc).isoformat()
            new_content = _inject_frontmatter_fields(full_content, {
                "enrichment_status": "enriched",
                "enriched_at": now,
                "priority": priority,
                "entities": [f"{e.get('type','person')}/{e.get('name','')}" for e in entities if e.get("name")],
                "topic_tags": topic_tags,
                "related_matters": related,
                "action_items": action_items,
            })

            # Append entity section to body if there are entities
            if entity_links:
                entities_section = "\n## Entities\n\n" + "\n".join(f"- {link}" for link in entity_links) + "\n"
                new_content = new_content.rstrip() + "\n" + entities_section

            # Write back
            try:
                # Extract the record name/slug from path for write_record
                await client.write_record("event", path.replace("event/", "").replace(".md", ""), new_content)
                applied += 1
            except Exception as exc:
                logger.warning("enrichment: failed to write %s: %s", path, exc)

        logger.info("enrichment: applied %d/%d enrichments", applied, len(enrichments))
        return applied
    finally:
        await client.close()


@activity.defn
async def ensure_enrichment_entities(enrichments: list[dict[str, Any]]) -> int:
    """Create missing person/org records for entities found during enrichment."""
    config = load_config()
    client = VaultClient(config)
    created = 0
    seen: set[str] = set()

    try:
        for enrichment in enrichments:
            for entity in enrichment.get("entities", []):
                name = entity.get("name", "").strip()
                etype = entity.get("type", "person")
                if not name or etype not in ("person", "org"):
                    continue

                key = f"{etype}:{name.lower()}"
                if key in seen:
                    continue
                seen.add(key)

                # Check if entity exists
                try:
                    results = await client.search_records(name, record_type=etype)
                    if results:
                        continue
                except Exception:
                    continue

                # Create minimal entity record
                content = f"""---
type: {etype}
name: "{name}"
status: active
tags: [auto-discovered]
---

# {name}
"""
                try:
                    await client.write_record(etype, name, content)
                    created += 1
                except Exception as exc:
                    logger.warning("enrichment: failed to create %s/%s: %s", etype, name, exc)

        logger.info("enrichment: created %d entity records", created)
        return created
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _inject_frontmatter_fields(content: str, fields: dict[str, Any]) -> str:
    """Inject key-value pairs into YAML frontmatter of a vault record."""
    # Split frontmatter from body
    match = re.match(r"^---\n(.*?)\n---\n(.*)", content, re.DOTALL)
    if not match:
        return content

    fm_text = match.group(1)
    body = match.group(2)

    # Parse frontmatter lines, update/add fields
    fm_lines = fm_text.split("\n")
    existing_keys = set()
    new_lines: list[str] = []

    for line in fm_lines:
        key_match = re.match(r"^(\w+):", line)
        if key_match:
            key = key_match.group(1)
            existing_keys.add(key)
            if key in fields:
                # Replace this line with updated value
                new_lines.append(_format_fm_line(key, fields[key]))
                continue
        new_lines.append(line)

    # Add fields that weren't in the original frontmatter
    for key, value in fields.items():
        if key not in existing_keys:
            new_lines.append(_format_fm_line(key, value))

    return f"---\n{chr(10).join(new_lines)}\n---\n{body}"


def _format_fm_line(key: str, value: Any) -> str:
    """Format a single YAML frontmatter line."""
    if isinstance(value, list):
        items = ", ".join(str(v) for v in value)
        return f"{key}: [{items}]"
    if isinstance(value, bool):
        return f"{key}: {'true' if value else 'false'}"
    if isinstance(value, str) and (" " in value or ":" in value or '"' in value):
        safe = value.replace('"', '\\"')
        return f'{key}: "{safe}"'
    return f"{key}: {value}"


def _extract_json_array(text: str) -> list[dict[str, Any]]:
    """Try to extract a JSON array from text that might have extra content."""
    # Strip markdown fences
    text = re.sub(r"```json?\s*", "", text)
    text = re.sub(r"```", "", text)
    text = text.strip()

    # Try direct parse
    try:
        result = json.loads(text)
        if isinstance(result, list):
            return result
    except json.JSONDecodeError:
        pass

    # Try to find array boundaries
    start = text.find("[")
    end = text.rfind("]")
    if start >= 0 and end > start:
        try:
            result = json.loads(text[start : end + 1])
            if isinstance(result, list):
                return result
        except json.JSONDecodeError:
            pass

    return []
