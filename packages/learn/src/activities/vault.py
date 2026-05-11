"""Vault read/write activities — all go through alfred-ctrl API."""

from __future__ import annotations

import json
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
async def fetch_stream_log(date_str: str = "") -> str:
    """Fetch today's stream log content. Returns empty string if no log exists."""
    config = load_config()
    client = VaultClient(config)
    try:
        if not date_str:
            date_str = datetime.now().strftime("%Y-%m-%d")
        log_path = f"memory/stream-log-{date_str}.md"
        try:
            record = await client.read_record(log_path)
            return record.get("content", "")
        except Exception:
            return ""
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

        # F.2 fix: include a microsecond timestamp + input_ref hash so
        # multiple observations on the same day with the same input_type
        # don't collide on disk. Without this, the seeder writes 50
        # entries and only the last one survives because they all map
        # to the same filename.
        import hashlib as _hashlib
        ref_hash = _hashlib.sha256(
            (input_ref or input_source or now).encode("utf-8")
        ).hexdigest()[:8]
        # now is ISO with microseconds: 2026-04-09T03:14:15.123456+00:00
        # Use the time part down to microseconds for uniqueness within a tick
        ts_compact = now.replace(":", "").replace(".", "").replace("-", "").replace("+", "_")[:20]
        raw_name = f"observation-{ts_compact}-{input_type}-{ref_hash}"
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


# ---------------------------------------------------------------------------
# RFC #884 — Living Brief data layer
# ---------------------------------------------------------------------------

# Narrative staleness threshold. When a matter's ``as_of`` is older
# than this (or missing), the composer falls back to walking the
# matter's recent events inline — keeps the brief usable while the
# nightly narrative layer is still warming.
_NARRATIVE_STALENESS = 36 * 60 * 60  # 36 hours, in seconds

# Cap on how many event records the inline fallback walks per stale
# matter. Anything past this gets dropped — a chatty matter would
# otherwise blow out the daily-digest prompt budget.
_FALLBACK_EVENT_LIMIT = 20


def _parse_iso_utc(ts: Any) -> Optional[datetime]:
    """Parse an ISO-8601 string to a UTC-aware datetime; ``None`` on fail."""
    from datetime import timezone as _tz
    if ts is None:
        return None
    if isinstance(ts, datetime):
        return ts if ts.tzinfo else ts.replace(tzinfo=_tz.utc)
    if not isinstance(ts, str):
        return None
    s = ts.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_tz.utc)
    return dt


def _first_sentence(text: str, cap: int = 240) -> str:
    """Return the first sentence-ish slice of ``text`` (period / ellipsis)."""
    if not text:
        return ""
    s = text.strip()
    # Find the first period that isn't an abbreviation. Heuristic: take
    # everything up to the first ". " or "! " / "? ".
    for marker in (". ", "! ", "? "):
        idx = s.find(marker)
        if idx > 20:  # ignore tiny prefixes like "Dr."
            s = s[: idx + 1]
            break
    if len(s) > cap:
        s = s[: cap - 1].rstrip() + "…"
    return s


@activity.defn
async def collect_living_brief_data() -> dict[str, Any]:
    """Assemble the four daily-brief sections from the narrative layer.

    RFC #884 reshapes the daily digest into a thin composer that reads
    pre-written matter narratives instead of re-walking events. The
    sections returned here mirror the brief's structure:

      * ``the_day``        — one bullet per active matter (current_state
                              first sentence, with stale-as_of fallback
                              to a recent-event walk for that matter
                              only).
      * ``awaiting_you``   — needs_attention/*.md cards with
                              ``status == "pending"``.
      * ``drafts``         — tasks pending approval (state == "pending"
                              and pending_confirmation true OR signal
                              cards still awaiting Sir's nod).
      * ``quiet_notes``    — unchanged: observations from the intuition
                              layer surface here for the clerk to weave
                              in lightly.

    Each entry carries enough metadata for the clerk to compose a brief
    without re-fetching anything. The clerk still applies Alfred's
    voice — this activity is pure data.
    """
    from datetime import timezone as _tz

    config = load_config()
    client = VaultClient(config)
    try:
        # 1. Active matters → "The Day"
        matters_raw = await client.list_records("matter", limit=5000)
        now = datetime.now(_tz.utc)
        the_day: list[dict[str, Any]] = []

        for rec in matters_raw:
            if not isinstance(rec, dict):
                continue
            fm = rec.get("frontmatter") or {}
            if not isinstance(fm, dict):
                fm = {}
            state = str(fm.get("state") or "").strip().lower()
            if state == "done":
                continue
            path = str(rec.get("path") or "").strip()
            if not path.startswith("matter/") or not path.endswith(".md"):
                continue

            current_state = str(fm.get("current_state") or "").strip()
            as_of_raw = fm.get("as_of")
            as_of_dt = _parse_iso_utc(as_of_raw)
            stale = (
                as_of_dt is None
                or (now - as_of_dt).total_seconds() > _NARRATIVE_STALENESS
            )

            entry: dict[str, Any] = {
                "path": path,
                "name": str(fm.get("name") or path.removeprefix("matter/").removesuffix(".md")),
                "as_of": str(as_of_raw or "").strip(),
                "narrative_stale": stale,
            }

            if current_state and not stale:
                entry["source"] = "narrative"
                entry["excerpt"] = _first_sentence(current_state)
            else:
                # Fallback: walk recent events for this matter. We pull
                # events whose ``parent_matter`` or ``related_matters``
                # link to this path. The list endpoint can't filter by
                # frontmatter so we slice the prefix and filter in
                # Python; capped at _FALLBACK_EVENT_LIMIT per matter to
                # keep the prompt budget sane.
                entry["source"] = "fallback_events"
                entry["excerpt"] = current_state or ""
                try:
                    all_events = await client.list_records("event", limit=200)
                except Exception:
                    all_events = []
                matter_events: list[dict[str, Any]] = []
                for ev in all_events:
                    if not isinstance(ev, dict):
                        continue
                    efm = ev.get("frontmatter") or {}
                    if not isinstance(efm, dict):
                        continue
                    parent = str(efm.get("parent_matter") or efm.get("matter") or "").strip()
                    related = efm.get("related_matters")
                    matched = parent == path
                    if not matched and isinstance(related, list):
                        for r in related:
                            if isinstance(r, str) and r.strip() == path:
                                matched = True
                                break
                    if not matched:
                        continue
                    matter_events.append({
                        "path": str(ev.get("path") or ""),
                        "name": str(efm.get("name") or "")[:120],
                        "summary": str(efm.get("summary") or "")[:240],
                        "created": str(ev.get("created") or efm.get("created") or ""),
                    })
                # Newest first by string compare on ISO timestamps —
                # malformed entries sort to the end harmlessly.
                matter_events.sort(key=lambda e: e["created"], reverse=True)
                entry["fallback_events"] = matter_events[:_FALLBACK_EVENT_LIMIT]

            the_day.append(entry)

        # Keep ``The Day`` short — clerk consumes up to ~30 matters
        # before the prompt becomes unwieldy. Sort by stale-first so
        # matters with no narrative still get attention.
        the_day.sort(key=lambda e: (not e.get("narrative_stale"), e["path"]))

        # 2. Awaiting You — needs_attention/*.md with status=pending
        awaiting: list[dict[str, Any]] = []
        try:
            needs_attention = await client.list_records("needs_attention", limit=200)
        except Exception:
            needs_attention = []
        for rec in needs_attention:
            if not isinstance(rec, dict):
                continue
            fm = rec.get("frontmatter") or {}
            if not isinstance(fm, dict):
                continue
            status = str(fm.get("status") or "").strip().lower()
            if status != "pending":
                continue
            awaiting.append({
                "path": str(rec.get("path") or ""),
                "name": str(fm.get("name") or fm.get("summary") or "")[:160],
                "reason": str(fm.get("reason") or fm.get("reasoning") or "")[:240],
                "created": str(rec.get("created") or fm.get("created") or ""),
            })

        # 3. Drafts I am Holding — tasks marked pending_confirmation
        drafts: list[dict[str, Any]] = []
        try:
            task_records = await client.list_records("task", limit=2000)
        except Exception:
            task_records = []
        for rec in task_records:
            if not isinstance(rec, dict):
                continue
            fm = rec.get("frontmatter") or {}
            if not isinstance(fm, dict):
                continue
            pending = fm.get("pending_confirmation")
            if not (pending is True or str(pending).strip().lower() == "true"):
                continue
            drafts.append({
                "path": str(rec.get("path") or ""),
                "name": str(fm.get("name") or fm.get("title") or "")[:160],
                "current_state": str(fm.get("current_state") or "")[:240],
                "parent_matter": str(fm.get("parent_matter") or fm.get("matter") or ""),
            })

        # 4. Quiet Notes — observations the intuition layer surfaced
        # since the last brief. Kept unchanged from the prior behaviour
        # except for the size cap so the prompt stays compact.
        try:
            observations = await client.list_records("observation", limit=20)
        except Exception:
            observations = []
        quiet_notes: list[dict[str, Any]] = []
        for rec in observations[:10]:
            if not isinstance(rec, dict):
                continue
            fm = rec.get("frontmatter") or {}
            if not isinstance(fm, dict):
                continue
            quiet_notes.append({
                "path": str(rec.get("path") or ""),
                "reasoning": str(fm.get("reasoning") or "")[:240],
                "input_type": str(fm.get("input_type") or ""),
            })

        return {
            "the_day": the_day,
            "awaiting_you": awaiting,
            "drafts": drafts,
            "quiet_notes": quiet_notes,
            "matter_count": len(the_day),
            "awaiting_count": len(awaiting),
            "draft_count": len(drafts),
            "quiet_note_count": len(quiet_notes),
            "narrative_stale_count": sum(1 for e in the_day if e.get("narrative_stale")),
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


def _build_execution_yaml(instinct: dict[str, Any]) -> str:
    """Build the execution block YAML for an instinct, if present.

    Returns a multi-line string ending with a newline (ready to be
    interpolated into the frontmatter template), or an empty string
    if the instinct has no execution block.
    """
    execution = instinct.get("execution")
    if not execution or not isinstance(execution, dict):
        return ""
    return (
        f'execution: \'{json.dumps(execution, separators=(",", ":"))}\'\n'
    )


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
{_build_execution_yaml(instinct)}created: {now}
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
