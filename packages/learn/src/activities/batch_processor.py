"""Domain-clustered batch processor for stream events.

Groups emails by sender domain, processes each domain in a single LLM call
via direct OpenRouter API (bypasses Clerk/OpenClaw session overhead).
Concurrent execution with entity dedup and vault writing.

Used for:
- Onboarding: process 100-day Gmail backfill in ~15 min
- Ongoing: batch new stream events every 30 min
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")

# --- Config ---
MAX_EMAILS_PER_CALL = 100  # cap per LLM call (context window safety)
MAX_CONCURRENT = 5
SMALL_DOMAIN_THRESHOLD = 5  # domains with fewer emails go to mixed batches
MIXED_BATCH_SIZE = 20
ENRICH_MIN_APPEARANCES = 3  # entities in 3+ domains get LLM enrichment
ENRICH_TOP_N = 30

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = "x-ai/grok-4.1-fast"


def _get_api_key() -> str:
    return os.environ.get("OPENROUTER_API_KEY", "")


# ---------------------------------------------------------------------------
# Step 1: Extract email metadata from JSONL events
# ---------------------------------------------------------------------------

def _extract_email_summary(event: dict) -> dict[str, str]:
    """Extract sender domain, subject, from, snippet, body text from a Gmail event."""
    raw = event.get("raw", {})
    payload = raw.get("payload", {})
    headers = {}
    for h in payload.get("headers", []):
        name = h.get("name", "").lower()
        if name in ("from", "to", "subject", "date"):
            headers[name] = h.get("value", "")

    sender = headers.get("from", "")
    domain = sender.split("@")[-1].strip(">").strip() if "@" in sender else "unknown"

    # Extract body text
    def _extract_text(part: dict) -> str:
        if part.get("mimeType", "").startswith("text/plain"):
            data = part.get("body", {}).get("data", "")
            if data:
                try:
                    return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
                except Exception:
                    return ""
        for sub in part.get("parts", []):
            t = _extract_text(sub)
            if t:
                return t
        return ""

    body = _extract_text(payload)
    snippet = raw.get("snippet", "")

    return {
        "domain": domain,
        "from": sender,
        "to": headers.get("to", ""),
        "subject": headers.get("subject", ""),
        "date": headers.get("date", event.get("received_at", "")),
        "body": body[:2000] if body else snippet[:500],
    }


# ---------------------------------------------------------------------------
# Step 2: Group by sender domain
# ---------------------------------------------------------------------------

def _group_by_domain(emails: list[dict]) -> tuple[dict[str, list[dict]], list[list[dict]]]:
    """Group emails by sender domain. Returns (domain_groups, mixed_batches)."""
    by_domain: dict[str, list[dict]] = defaultdict(list)
    for email in emails:
        by_domain[email["domain"]].append(email)

    # Separate big domains from small ones
    domain_groups: dict[str, list[dict]] = {}
    small_pool: list[dict] = []

    for domain, items in sorted(by_domain.items(), key=lambda x: -len(x[1])):
        if len(items) >= SMALL_DOMAIN_THRESHOLD:
            domain_groups[domain] = items
        else:
            small_pool.extend(items)

    # Chunk small pool into mixed batches
    mixed_batches: list[list[dict]] = []
    for i in range(0, len(small_pool), MIXED_BATCH_SIZE):
        mixed_batches.append(small_pool[i:i + MIXED_BATCH_SIZE])

    return domain_groups, mixed_batches


# ---------------------------------------------------------------------------
# Step 3: Build domain-aware prompts
# ---------------------------------------------------------------------------

def _build_domain_prompt(domain: str, emails: list[dict]) -> str:
    """Build an LLM prompt for a batch of emails from one domain."""
    # Cap emails to avoid context window issues
    batch = emails[:MAX_EMAILS_PER_CALL]
    overflow = len(emails) - len(batch)

    email_text = ""
    for i, e in enumerate(batch, 1):
        email_text += f"\n--- Email {i} ---\n"
        email_text += f"From: {e['from']}\n"
        email_text += f"To: {e['to']}\n"
        email_text += f"Subject: {e['subject']}\n"
        email_text += f"Date: {e['date']}\n"
        if e['body']:
            email_text += f"Body:\n{e['body'][:1500]}\n"

    if overflow > 0:
        email_text += f"\n(... and {overflow} more emails from {domain} not shown)\n"

    return f"""You are a vault curator for a personal AI butler. Analyze these {len(batch)} emails from {domain} and extract structured records.

EMAILS FROM {domain}:
{email_text}

Based on ALL these emails, create vault records. Return JSON:
{{
  "records": [
    {{
      "type": "account|person|org|project|task|note|event|decision",
      "name": "descriptive name",
      "description": "2-3 sentence description with context from the emails",
      "tags": ["tag1", "tag2"],
      "relationship": "how this relates to the user (for people: colleague, client, friend, vendor, etc.)",
      "related_entities": ["names of other entities mentioned alongside this one"]
    }}
  ],
  "domain_summary": "One paragraph summarizing the user's relationship with {domain}"
}}

Guidelines:
- For service domains (notifications, newsletters): create ONE account record summarizing usage, plus any people/projects mentioned
- For personal domains: create individual person records with relationship context
- Extract tasks only if there's a clear actionable item with a deadline or follow-up needed
- Don't create noise records — skip trivial automated notifications
- Names should be full proper names (not email addresses)
- Be thorough — extract every person, organization, and project mentioned"""


def _build_mixed_prompt(emails: list[dict]) -> str:
    """Build prompt for a mixed batch of emails from low-frequency senders."""
    email_text = ""
    for i, e in enumerate(emails, 1):
        email_text += f"\n--- Email {i} ({e['domain']}) ---\n"
        email_text += f"From: {e['from']}\n"
        email_text += f"To: {e['to']}\n"
        email_text += f"Subject: {e['subject']}\n"
        email_text += f"Date: {e['date']}\n"
        if e['body']:
            email_text += f"Body:\n{e['body'][:1500]}\n"

    return f"""You are a vault curator for a personal AI butler. Analyze these {len(emails)} emails from various senders and extract structured records.

EMAILS:
{email_text}

Create vault records for each meaningful email. Return JSON:
{{
  "records": [
    {{
      "type": "person|org|project|task|note|event|decision",
      "name": "descriptive name",
      "description": "2-3 sentence description with context",
      "tags": ["tag1", "tag2"],
      "relationship": "relationship to the user",
      "related_entities": ["other entities mentioned"]
    }}
  ]
}}

Guidelines:
- Create person records for real people (not automated senders)
- Extract tasks if there's a clear action needed
- Create note records for important reference material
- Skip pure spam/marketing with no personal relevance
- Be thorough with names and relationships"""


# ---------------------------------------------------------------------------
# Step 4: Call OpenRouter directly (concurrent)
# ---------------------------------------------------------------------------

async def _call_openrouter(prompt: str, api_key: str) -> dict:
    """Make a direct OpenRouter API call. Returns parsed JSON or empty dict."""
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            OPENROUTER_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.3,
                "max_tokens": 4096,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")

    # Parse JSON from response
    content = content.strip()
    # Find JSON in response (may have markdown fences)
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*", "", content)
        content = re.sub(r"\s*```$", "", content)

    first_brace = content.find("{")
    if first_brace < 0:
        return {"records": []}

    fragment = content[first_brace:]
    # Repair truncation
    try:
        return json.loads(fragment)
    except json.JSONDecodeError:
        # Try closing open brackets
        open_b = fragment.count("[") - fragment.count("]")
        open_c = fragment.count("{") - fragment.count("}")
        repaired = fragment + ("]" * max(0, open_b)) + ("}" * max(0, open_c))
        try:
            return json.loads(repaired)
        except json.JSONDecodeError:
            logger.warning("batch_processor: JSON parse failed, preview: %s", content[:200])
            return {"records": []}


async def _process_batch(
    label: str,
    prompt: str,
    api_key: str,
    semaphore: asyncio.Semaphore,
) -> tuple[str, dict]:
    """Process one batch with concurrency control. Returns (label, result)."""
    async with semaphore:
        logger.info("batch_processor: processing %s", label)
        try:
            result = await _call_openrouter(prompt, api_key)
            records = result.get("records", [])
            logger.info("batch_processor: %s -> %d records", label, len(records))
            return label, result
        except Exception as exc:
            logger.error("batch_processor: %s failed: %s", label, exc)
            return label, {"records": []}


# ---------------------------------------------------------------------------
# Step 5: Entity dedup + vault writing
# ---------------------------------------------------------------------------

def _slugify(text: str, maxlen: int = 60) -> str:
    if not isinstance(text, str):
        text = str(text)
    s = re.sub(r'[^\w\s-]', '', text.lower())
    s = re.sub(r'[\s]+', '-', s.strip())
    return s[:maxlen]


def _dedup_records(all_results: list[dict]) -> list[dict]:
    """Deduplicate records across all batch results by name."""
    seen: dict[str, dict] = {}  # lowercase name -> best record

    for result in all_results:
        for record in result.get("records", []):
            if not isinstance(record, dict):
                continue
            name = record.get("name", "").strip()
            if not name or len(name) < 2:
                continue
            rtype = record.get("type", "note")

            key = f"{rtype}:{name.lower()}"
            if key not in seen:
                seen[key] = record
            else:
                # Merge: keep longer description, combine tags
                existing = seen[key]
                if len(record.get("description", "")) > len(existing.get("description", "")):
                    existing["description"] = record["description"]
                existing_tags = set(existing.get("tags", []))
                existing_tags.update(record.get("tags", []))
                existing["tags"] = list(existing_tags)[:10]
                # Merge related entities
                existing_related = set(existing.get("related_entities", []))
                existing_related.update(record.get("related_entities", []))
                existing["related_entities"] = list(existing_related)

    return list(seen.values())


async def _write_records_to_vault(records: list[dict], client: VaultClient) -> int:
    """Write deduped records to vault via ctrl API. Returns count written."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    written = 0

    for record in records:
        rtype = record.get("type", "note")
        name = record.get("name", "Untitled")
        desc = record.get("description", "")
        tags = record.get("tags", [])
        relationship = record.get("relationship", "")
        related = record.get("related_entities", [])

        tag_str = ", ".join(tags) if isinstance(tags, list) else str(tags)

        # Build frontmatter
        fm = [
            "---",
            f"type: {rtype}",
            f'name: "{name}"',
            f"status: {'queued' if rtype == 'task' else 'active'}",
            f"tags: [{tag_str}]",
            f"created: {today}",
        ]
        if rtype == "task":
            fm.append("owner: alfred")
            fm.append("priority: normal")
        if relationship:
            fm.append(f"relationship: {relationship}")
        fm.append("---")

        # Build body with wikilinks
        body_parts = [f"\n# {name}\n"]
        if desc:
            body_parts.append(f"{desc}\n")
        if relationship:
            body_parts.append(f"**Relationship**: {relationship}\n")
        if related:
            body_parts.append("\n## Related\n")
            body_parts.append(" ".join(f"[[{r}]]" for r in related if r))
            body_parts.append("")

        content = "\n".join(fm) + "\n" + "\n".join(body_parts) + "\n"

        try:
            await client.write_record(rtype, name, content)
            written += 1
        except Exception as exc:
            logger.warning("batch_processor: failed to write %s/%s: %s", rtype, name, exc)

    return written


# ---------------------------------------------------------------------------
# Step 6: Enrichment for top entities
# ---------------------------------------------------------------------------

async def _enrich_top_entities(
    records: list[dict],
    all_results: list[dict],
    api_key: str,
    client: VaultClient,
) -> int:
    """Enrich the most-referenced entities with LLM-generated descriptions."""
    # Count entity appearances across results
    appearances: dict[str, int] = defaultdict(int)
    for result in all_results:
        names_in_result = set()
        for record in result.get("records", []):
            n = record.get("name", "").strip().lower()
            if n:
                names_in_result.add(n)
            for r in record.get("related_entities", []):
                if r:
                    names_in_result.add(r.strip().lower())
        for n in names_in_result:
            appearances[n] += 1

    # Find records that appear frequently but have short descriptions
    to_enrich = []
    for record in records:
        name = record.get("name", "").strip()
        if not name:
            continue
        count = appearances.get(name.lower(), 0)
        desc_len = len(record.get("description", ""))
        rtype = record.get("type", "")
        if count >= ENRICH_MIN_APPEARANCES and desc_len < 100 and rtype in ("person", "org", "project"):
            to_enrich.append((record, count))

    to_enrich.sort(key=lambda x: -x[1])
    to_enrich = to_enrich[:ENRICH_TOP_N]

    if not to_enrich:
        return 0

    # Batch enrich — send all names in one call
    entity_list = "\n".join(
        f"- {r['name']} ({r.get('type', '?')}, appears in {c} contexts, current desc: \"{r.get('description', '')}\")"
        for r, c in to_enrich
    )

    prompt = f"""Write enriched 2-3 sentence descriptions for each of these entities. They appear in someone's email history.

{entity_list}

Return JSON:
{{
  "enrichments": [
    {{"name": "entity name", "description": "enriched 2-3 sentence description"}}
  ]
}}

Be specific — reference what you know about each entity from the context provided."""

    try:
        result = await _call_openrouter(prompt, api_key)
        enrichments = result.get("enrichments", [])
        enriched = 0
        for e in enrichments:
            if not isinstance(e, dict):
                continue
            name = e.get("name", "")
            desc = e.get("description", "")
            if not name or not desc:
                continue
            # Find matching record and update in vault
            slug = _slugify(name)
            for record in records:
                if record.get("name", "").lower() == name.lower():
                    rtype = record.get("type", "note")
                    try:
                        path = f"{rtype}/{name}.md"
                        existing = await client.read_record(path)
                        old_body = existing.get("body", "")
                        if len(desc) > len(old_body):
                            # Update with enriched description
                            fm = existing.get("frontmatter", {})
                            new_content = "---\n"
                            for k, v in fm.items():
                                new_content += f"{k}: {v}\n"
                            new_content += "---\n\n"
                            new_content += f"# {name}\n\n{desc}\n"
                            await client.update_record(path, new_content)
                            enriched += 1
                    except Exception:
                        pass
                    break
        return enriched
    except Exception as exc:
        logger.error("batch_processor: enrichment failed: %s", exc)
        return 0


# ---------------------------------------------------------------------------
# Main activity: process_stream_batch
# ---------------------------------------------------------------------------

@activity.defn
async def process_stream_batch(stream_id: str, stream_type: str = "gmail") -> dict[str, Any]:
    """Process all events in a stream JSONL using domain-clustered batching.

    Groups emails by sender domain, processes each domain in a single LLM
    call via direct OpenRouter API (no Clerk/OpenClaw overhead), deduplicates
    entities, writes vault records, and enriches top entities.

    Returns {emails_processed, domains, batches, records_created, records_enriched}.
    """
    config = load_config()
    api_key = _get_api_key()
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY not set")

    # Read all events from JSONL
    streams_dir = os.environ.get("STREAMS_DIR", "/alfred-data/streams")
    jsonl_path = os.path.join(streams_dir, f"{stream_id}.jsonl")

    if not os.path.exists(jsonl_path):
        logger.warning("batch_processor: JSONL not found: %s", jsonl_path)
        return {"emails_processed": 0, "error": "JSONL not found"}

    # Parse all events and extract email summaries
    activity.heartbeat("Reading stream events")
    emails: list[dict] = []
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                summary = _extract_email_summary(event)
                if summary.get("subject") or summary.get("body"):
                    emails.append(summary)
            except Exception:
                continue

    logger.info("batch_processor: parsed %d emails from %s", len(emails), stream_id)
    activity.heartbeat(f"Parsed {len(emails)} emails")

    if not emails:
        return {"emails_processed": 0}

    # Group by domain
    domain_groups, mixed_batches = _group_by_domain(emails)
    logger.info(
        "batch_processor: %d domain groups, %d mixed batches",
        len(domain_groups), len(mixed_batches),
    )

    # Build all prompts
    tasks: list[tuple[str, str]] = []
    for domain, items in domain_groups.items():
        prompt = _build_domain_prompt(domain, items)
        tasks.append((f"domain:{domain}({len(items)})", prompt))
    for i, batch in enumerate(mixed_batches):
        prompt = _build_mixed_prompt(batch)
        tasks.append((f"mixed:{i+1}({len(batch)})", prompt))

    activity.heartbeat(f"Processing {len(tasks)} batches")

    # Execute concurrently
    semaphore = asyncio.Semaphore(MAX_CONCURRENT)
    coros = [_process_batch(label, prompt, api_key, semaphore) for label, prompt in tasks]
    results_raw = await asyncio.gather(*coros)

    all_results = [r for _, r in results_raw]
    total_records_raw = sum(len(r.get("records", [])) for r in all_results)
    logger.info("batch_processor: %d raw records from %d batches", total_records_raw, len(tasks))
    activity.heartbeat(f"Extracted {total_records_raw} raw records, deduplicating")

    # Dedup
    deduped = _dedup_records(all_results)
    logger.info("batch_processor: %d unique records after dedup", len(deduped))

    # Write to vault
    activity.heartbeat(f"Writing {len(deduped)} records to vault")
    client = VaultClient(config)
    try:
        written = await _write_records_to_vault(deduped, client)
        logger.info("batch_processor: wrote %d records to vault", written)

        # Enrich top entities
        activity.heartbeat("Enriching top entities")
        enriched = await _enrich_top_entities(deduped, all_results, api_key, client)
        logger.info("batch_processor: enriched %d entities", enriched)
    finally:
        await client.close()

    return {
        "emails_processed": len(emails),
        "domains": len(domain_groups),
        "mixed_batches": len(mixed_batches),
        "total_batches": len(tasks),
        "raw_records": total_records_raw,
        "deduped_records": len(deduped),
        "records_written": written,
        "records_enriched": enriched,
    }


@activity.defn
async def process_onboarding_facts(onboard_path: str) -> dict[str, Any]:
    """Process onboarding facts as a single batch. Creates person/org/project records."""
    config = load_config()
    api_key = _get_api_key()
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY not set")

    onboard = json.loads(open(onboard_path).read())
    facts = onboard.get("facts", [])
    if not facts:
        return {"facts_processed": 0}

    # Group facts by category for a structured prompt
    by_cat: dict[str, list[str]] = defaultdict(list)
    for f in facts:
        if isinstance(f, dict):
            cat = f.get("category", "general")
            text = f.get("fact", "")
            if text:
                by_cat[cat].append(text)

    fact_text = ""
    for cat, items in sorted(by_cat.items()):
        fact_text += f"\n### {cat.title()} ({len(items)} facts)\n"
        for item in items[:30]:
            fact_text += f"- {item}\n"
        if len(items) > 30:
            fact_text += f"  ... and {len(items) - 30} more\n"

    prompt = f"""You are a vault curator for a personal AI butler. These are {len(facts)} facts extracted from 100 days of email for a new user.

{fact_text}

Create structured vault records for every person, organization, project, and location mentioned. Also create a USER summary note.

Return JSON:
{{
  "records": [
    {{"type": "person", "name": "Full Name", "description": "2-3 sentences", "relationship": "colleague/friend/family/vendor", "tags": ["tag"], "related_entities": ["Other Name"]}},
    {{"type": "org", "name": "Company", "description": "...", "relationship": "employer/client/vendor", "tags": [...]}},
    {{"type": "project", "name": "Project Name", "description": "...", "tags": [...]}},
    {{"type": "note", "name": "User Profile Summary", "description": "comprehensive summary of who this person is based on all facts", "tags": ["profile"]}}
  ]
}}

Extract EVERY named entity. Be thorough."""

    activity.heartbeat("Processing onboarding facts")
    result = await _call_openrouter(prompt, api_key)
    records = result.get("records", [])
    logger.info("batch_processor: extracted %d records from %d facts", len(records), len(facts))

    client = VaultClient(config)
    try:
        written = await _write_records_to_vault(records, client)
    finally:
        await client.close()

    return {"facts_processed": len(facts), "records_written": written}
