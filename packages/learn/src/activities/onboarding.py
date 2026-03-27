"""Onboarding activities — entity extraction, pattern analysis, first brief generation.

All LLM calls go through the Clerk (OpenClaw gateway). All vault writes go through
the alfred-ctrl API via VaultClient.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import httpx
from temporalio import activity

from src.activities.clerk import _call_clerk
from src.config import load_config
from src.utils.vault_client import VaultClient


@activity.defn
async def wait_for_gmail_events(
    stream_id: str,
    min_events: int = 10,
    max_wait_seconds: int = 300,
) -> list[dict[str, Any]]:
    """Poll ctrl API for unprocessed Gmail events until we have enough or timeout."""
    config = load_config()
    client = VaultClient(config)
    start = time.monotonic()
    try:
        while (time.monotonic() - start) < max_wait_seconds:
            events = await client.fetch_unprocessed_events(limit=min_events + 10)
            # Filter to the target stream
            stream_events = [
                e for e in events
                if e.get("stream_id") == stream_id or not stream_id
            ]
            if len(stream_events) >= min_events:
                activity.heartbeat(f"Found {len(stream_events)} events")
                return stream_events
            activity.heartbeat(f"Waiting for events: {len(stream_events)}/{min_events}")
            await asyncio.sleep(15)
        # Return whatever we have if timeout
        events = await client.fetch_unprocessed_events(limit=min_events + 10)
        return [e for e in events if e.get("stream_id") == stream_id or not stream_id]
    finally:
        await client.close()


@activity.defn
async def extract_entities_from_emails(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Call Clerk to extract people, organizations, topics, and relationships from emails."""
    # Build a summarized batch of emails for the Clerk
    email_summaries = []
    for evt in events[:20]:  # Cap at 20 for prompt size
        raw = evt.get("raw", {})
        email_summaries.append({
            "from": raw.get("from", evt.get("source", "")),
            "to": raw.get("to", ""),
            "subject": raw.get("subject", evt.get("summary", "")),
            "snippet": raw.get("snippet", raw.get("body", ""))[:500],
            "date": raw.get("date", evt.get("created_at", "")),
        })

    prompt = f"""You are a butler's clerk performing first-time onboarding. Your master has just connected their Gmail.
Below are their recent emails. Extract every person, organization, and topic you can identify.

For each person, note:
- Their name and email address
- Their apparent relationship to the master (colleague, client, friend, family, vendor, etc.)
- How frequently they appear in this batch

For each organization, note:
- The organization name
- Its apparent role (employer, client, vendor, service provider, etc.)

For each topic, note:
- The topic name
- Which emails it appears in
- Whether it seems urgent, routine, or informational

Also identify any relationships between entities (e.g., "Jane works at Acme Corp").

EMAILS:
{json.dumps(email_summaries, indent=2)}

Return JSON only:
{{
  "people": [
    {{
      "name": "Full Name",
      "email": "email@example.com",
      "relationship": "colleague|client|friend|family|vendor|other",
      "frequency": 1,
      "context": "Brief note about this person"
    }}
  ],
  "organizations": [
    {{
      "name": "Org Name",
      "role": "employer|client|vendor|service|other",
      "context": "Brief note"
    }}
  ],
  "topics": [
    {{
      "name": "Topic Name",
      "urgency": "urgent|routine|informational",
      "email_count": 1,
      "context": "Brief note"
    }}
  ],
  "relationships": [
    {{
      "from": "Entity A",
      "to": "Entity B",
      "type": "works_at|manages|collaborates_with|client_of|other",
      "context": "Brief note"
    }}
  ]
}}"""

    return await _call_clerk(prompt)


@activity.defn
async def analyze_patterns(
    events: list[dict[str, Any]],
    entities: dict[str, Any],
) -> dict[str, Any]:
    """Call Clerk to identify communication patterns, routines, and priorities."""
    # Build timeline data
    timeline = []
    for evt in events[:20]:
        raw = evt.get("raw", {})
        timeline.append({
            "from": raw.get("from", evt.get("source", "")),
            "subject": raw.get("subject", evt.get("summary", "")),
            "date": raw.get("date", evt.get("created_at", "")),
            "labels": raw.get("labels", []),
        })

    prompt = f"""You are a butler's clerk analyzing your new master's communication patterns during onboarding.

Using the email timeline and extracted entities below, identify:

1. **Communication frequency patterns** — Who writes most often? Are there regular check-ins?
2. **Time-of-day patterns** — When does the master receive most email? Any morning vs evening patterns?
3. **Priority signals** — Which senders or topics consistently demand quick responses?
4. **Recurring routines** — Weekly meetings, regular reports, recurring threads?
5. **Attention clusters** — Groups of related emails that form a "workstream"

ENTITIES (already extracted):
{json.dumps(entities, indent=2)}

EMAIL TIMELINE:
{json.dumps(timeline, indent=2)}

Return JSON only:
{{
  "patterns": [
    {{
      "type": "frequency|time_of_day|priority|routine|cluster",
      "name": "Pattern name",
      "description": "What this pattern is",
      "entities_involved": ["Name1", "Name2"],
      "confidence": 0.8,
      "evidence": "Brief supporting evidence"
    }}
  ],
  "suggested_priorities": [
    {{
      "item": "Description of priority item",
      "reason": "Why this should be prioritized",
      "urgency": "high|medium|low"
    }}
  ],
  "routines_detected": [
    {{
      "name": "Routine name",
      "frequency": "daily|weekly|monthly",
      "next_expected": "When this might next occur",
      "participants": ["Name1"]
    }}
  ]
}}"""

    return await _call_clerk(prompt)


@activity.defn
async def generate_first_brief(
    events: list[dict[str, Any]],
    entities: dict[str, Any],
    patterns: dict[str, Any],
) -> str:
    """Call Clerk to write a personalized 5-paragraph morning brief."""
    # Prepare a compact summary of the source data
    email_subjects = []
    for evt in events[:20]:
        raw = evt.get("raw", {})
        email_subjects.append({
            "from": raw.get("from", evt.get("source", "")),
            "subject": raw.get("subject", evt.get("summary", "")),
            "date": raw.get("date", evt.get("created_at", "")),
            "snippet": raw.get("snippet", raw.get("body", ""))[:200],
        })

    prompt = f"""You are Alfred Black, a personal butler's intelligence system. You have just completed onboarding
for a new master. This is the very first brief you will deliver. Make it count.

Write exactly 5 paragraphs:

**Paragraph 1 — Who's Been Reaching Out**
Name the key people from recent emails. Provide context for each — who they are, what they seem to want.
Make the master feel you already understand their world.

**Paragraph 2 — What Needs Attention Today**
Identify anything urgent, any deadlines, any items that look time-sensitive.
Be specific. If nothing is truly urgent, say so honestly.

**Paragraph 3 — Recurring Themes and Patterns**
What patterns did you notice? Regular correspondents, repeated topics, workstreams forming.
Show the master you see the shape of their days.

**Paragraph 4 — Suggested Priorities**
Based on what you've seen, suggest what deserves attention first.
Be practical and direct — a butler advises, not lectures.

**Paragraph 5 — A Personal Note**
Close with something warm and grounding. You are a butler — professional, loyal, observant.
Welcome your master to the service. Keep it brief and genuine.

Tone: Professional butler. Warm but not effusive. Concise. Personal. You are not Sherlock Holmes
deducing secrets — you are a trusted household manager helping someone start their day well.

ENTITIES FOUND:
{json.dumps(entities, indent=2)}

PATTERNS OBSERVED:
{json.dumps(patterns, indent=2)}

RECENT EMAILS:
{json.dumps(email_subjects, indent=2)}

IMPORTANT: Return JSON only:
{{
  "brief": "The full 5-paragraph brief text, with paragraphs separated by double newlines."
}}"""

    result = await _call_clerk(prompt)
    return result.get("brief", "")


@activity.defn
async def write_onboarding_results(
    entities: dict[str, Any],
    patterns: dict[str, Any],
    brief: str,
) -> str:
    """Write extracted entities, patterns, and brief to vault. Returns the brief's vault path."""
    config = load_config()
    client = VaultClient(config)
    try:
        # 1. Write person records for each extracted person
        for person in entities.get("people", []):
            name = person.get("name", "Unknown")
            content = _build_person_record(person)
            try:
                await client.write_record("person", name, content)
            except httpx.HTTPStatusError:
                # Person may already exist — not fatal
                pass

        # 2. Write org records for each extracted organization
        for org in entities.get("organizations", []):
            name = org.get("name", "Unknown")
            content = _build_org_record(org)
            try:
                await client.write_record("organization", name, content)
            except httpx.HTTPStatusError:
                pass

        # 3. Write patterns as a vault note
        patterns_content = _build_patterns_note(patterns)
        await client.write_record("note", "Onboarding — Communication Patterns", patterns_content)

        # 4. Write the first brief as an event record
        brief_content = _build_brief_record(brief)
        brief_path = await client.write_record("event", "First Brief", brief_content)

        return brief_path
    finally:
        await client.close()


def _build_person_record(person: dict[str, Any]) -> str:
    """Build markdown content for a person vault record."""
    lines = []
    lines.append(f"# {person.get('name', 'Unknown')}\n")
    if person.get("email"):
        lines.append(f"**Email:** {person['email']}")
    if person.get("relationship"):
        lines.append(f"**Relationship:** {person['relationship']}")
    if person.get("context"):
        lines.append(f"\n{person['context']}")
    lines.append("\n\n*Discovered during onboarding.*")
    return "\n".join(lines)


def _build_org_record(org: dict[str, Any]) -> str:
    """Build markdown content for an organization vault record."""
    lines = []
    lines.append(f"# {org.get('name', 'Unknown')}\n")
    if org.get("role"):
        lines.append(f"**Role:** {org['role']}")
    if org.get("context"):
        lines.append(f"\n{org['context']}")
    lines.append("\n\n*Discovered during onboarding.*")
    return "\n".join(lines)


def _build_patterns_note(patterns: dict[str, Any]) -> str:
    """Build markdown content for the patterns note."""
    lines = ["# Onboarding — Communication Patterns\n"]
    lines.append("*Automatically detected during onboarding analysis.*\n")

    if patterns.get("patterns"):
        lines.append("## Patterns\n")
        for p in patterns["patterns"]:
            lines.append(f"### {p.get('name', 'Unnamed')}")
            lines.append(f"**Type:** {p.get('type', 'unknown')} | **Confidence:** {p.get('confidence', 'N/A')}")
            lines.append(f"{p.get('description', '')}\n")

    if patterns.get("suggested_priorities"):
        lines.append("## Suggested Priorities\n")
        for sp in patterns["suggested_priorities"]:
            urgency = sp.get("urgency", "medium")
            lines.append(f"- **[{urgency.upper()}]** {sp.get('item', '')} — {sp.get('reason', '')}")
        lines.append("")

    if patterns.get("routines_detected"):
        lines.append("## Detected Routines\n")
        for r in patterns["routines_detected"]:
            lines.append(f"- **{r.get('name', '')}** ({r.get('frequency', 'unknown')})")
        lines.append("")

    return "\n".join(lines)


def _build_brief_record(brief: str) -> str:
    """Build markdown content for the first brief event record."""
    lines = ["# First Brief\n"]
    lines.append("*Your first morning brief from Alfred.*\n")
    lines.append(brief)
    return "\n".join(lines)
