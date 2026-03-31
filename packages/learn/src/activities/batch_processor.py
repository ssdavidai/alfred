"""Domain-clustered batch processor for stream events.

Groups emails by sender domain and writes batched markdown files to the
vault inbox. The curator agent picks them up and creates proper vault
records through its 4-stage pipeline (analyze → entity resolution →
interlink → enrich).

No direct LLM calls. No direct vault writes. Just smart batching into inbox.

Used for:
- Onboarding: batch 100-day Gmail backfill into ~70-120 inbox files
- Ongoing: batch new stream events periodically
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")

# --- Config ---
SMALL_DOMAIN_THRESHOLD = 5  # domains with fewer emails go to mixed batches
MIXED_BATCH_SIZE = 20
MAX_EMAILS_PER_BATCH = 20  # cap per inbox file to keep curator prompts manageable


# ---------------------------------------------------------------------------
# Email metadata extraction
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
# Domain grouping
# ---------------------------------------------------------------------------

def _group_by_domain(emails: list[dict]) -> tuple[dict[str, list[dict]], list[list[dict]]]:
    """Group emails by sender domain. Returns (domain_groups, mixed_batches)."""
    by_domain: dict[str, list[dict]] = defaultdict(list)
    for email in emails:
        by_domain[email["domain"]].append(email)

    domain_groups: dict[str, list[dict]] = {}
    small_pool: list[dict] = []

    for domain, items in sorted(by_domain.items(), key=lambda x: -len(x[1])):
        if len(items) >= SMALL_DOMAIN_THRESHOLD:
            domain_groups[domain] = items
        else:
            small_pool.extend(items)

    mixed_batches: list[list[dict]] = []
    for i in range(0, len(small_pool), MIXED_BATCH_SIZE):
        mixed_batches.append(small_pool[i:i + MIXED_BATCH_SIZE])

    return domain_groups, mixed_batches


# ---------------------------------------------------------------------------
# Build inbox markdown files
# ---------------------------------------------------------------------------

def _slugify(text: str, maxlen: int = 60) -> str:
    if not isinstance(text, str):
        text = str(text)
    s = re.sub(r'[^\w\s-]', '', text.lower())
    s = re.sub(r'[\s]+', '-', s.strip())
    return s[:maxlen]


def _build_domain_batch_content(domain: str, emails: list[dict]) -> str:
    """Build a markdown inbox file for a batch of emails from one domain."""
    lines = [
        f"# Emails from {domain} ({len(emails)} messages)",
        "",
        f"*Process these {len(emails)} emails from {domain}. Create proper vault records: extract people, organizations, projects, tasks, and key facts. Link related entities with wikilinks.*",
        "",
        "---",
        "",
    ]

    for i, e in enumerate(emails, 1):
        lines.append(f"## Email {i}: {e.get('subject', 'No Subject')}")
        lines.append("")
        lines.append(f"**From**: {e['from']}")
        lines.append(f"**To**: {e['to']}")
        lines.append(f"**Date**: {e['date']}")
        lines.append("")
        if e['body']:
            lines.append(e['body'][:1500])
        lines.append("")
        lines.append("---")
        lines.append("")

    return "\n".join(lines)


def _build_mixed_batch_content(emails: list[dict]) -> str:
    """Build a markdown inbox file for a mixed batch of emails."""
    lines = [
        f"# Mixed emails ({len(emails)} messages from various senders)",
        "",
        f"*Process these {len(emails)} emails individually. Create proper vault records for each: extract people, organizations, projects, tasks, and key facts.*",
        "",
        "---",
        "",
    ]

    for i, e in enumerate(emails, 1):
        lines.append(f"## Email {i}: {e.get('subject', 'No Subject')} ({e['domain']})")
        lines.append("")
        lines.append(f"**From**: {e['from']}")
        lines.append(f"**To**: {e['to']}")
        lines.append(f"**Date**: {e['date']}")
        lines.append("")
        if e['body']:
            lines.append(e['body'][:1500])
        lines.append("")
        lines.append("---")
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main activity: process_stream_batch
# ---------------------------------------------------------------------------

@activity.defn
async def process_stream_batch(stream_id: str, stream_type: str = "gmail") -> dict[str, Any]:
    """Group stream events by sender domain and drop batched files into inbox.

    The curator agent picks them up and creates proper vault records
    through its 4-stage pipeline.

    Returns {emails_processed, domains, batches_written}.
    """
    config = load_config()

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

    # Write batched inbox files
    client = VaultClient(config)
    batches_written = 0
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    try:
        # Domain batches — split large domains into chunks of MAX_EMAILS_PER_BATCH
        for domain, items in domain_groups.items():
            for chunk_start in range(0, len(items), MAX_EMAILS_PER_BATCH):
                chunk = items[chunk_start:chunk_start + MAX_EMAILS_PER_BATCH]
                chunk_num = chunk_start // MAX_EMAILS_PER_BATCH + 1
                total_chunks = (len(items) + MAX_EMAILS_PER_BATCH - 1) // MAX_EMAILS_PER_BATCH

                content = _build_domain_batch_content(domain, chunk)
                suffix = f"-part{chunk_num}" if total_chunks > 1 else ""
                filename = f"{today}-emails-{_slugify(domain)}{suffix}.md"

                await client.drop_to_inbox(filename, content)
                batches_written += 1

            activity.heartbeat(f"Written {batches_written} batches")

        # Mixed batches
        for i, batch in enumerate(mixed_batches):
            content = _build_mixed_batch_content(batch)
            filename = f"{today}-emails-mixed-{i + 1:03d}.md"
            await client.drop_to_inbox(filename, content)
            batches_written += 1

    finally:
        await client.close()

    logger.info(
        "batch_processor: wrote %d inbox files from %d emails (%d domains + %d mixed)",
        batches_written, len(emails), len(domain_groups), len(mixed_batches),
    )

    return {
        "emails_processed": len(emails),
        "domains": len(domain_groups),
        "mixed_batches": len(mixed_batches),
        "batches_written": batches_written,
    }


@activity.defn
async def process_onboarding_facts(onboard_path: str) -> dict[str, Any]:
    """Write onboarding facts to inbox for curator processing."""
    config = load_config()

    onboard = json.loads(open(onboard_path).read())
    facts = onboard.get("facts", [])
    if not facts:
        return {"facts_processed": 0}

    # Group facts by category
    by_cat: dict[str, list[str]] = defaultdict(list)
    for f in facts:
        if isinstance(f, dict):
            cat = f.get("category", "general")
            text = f.get("fact", "")
            day = f.get("source_day", "")
            if text:
                by_cat[cat].append(f"[{day}] {text}")

    # Write one inbox file per category
    client = VaultClient(config)
    files_written = 0
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    try:
        for cat, items in sorted(by_cat.items()):
            lines = [
                f"# Onboarding Facts — {cat.title()}",
                "",
                f"*{len(items)} facts about the user extracted from 100 days of email. Create proper vault records: people, organizations, projects, locations, and any actionable items.*",
                "",
            ]
            for item in items:
                lines.append(f"- {item}")
            lines.append("")

            content = "\n".join(lines)
            filename = f"{today}-onboarding-facts-{_slugify(cat)}.md"
            await client.drop_to_inbox(filename, content)
            files_written += 1

        # Also write the brief and automations
        brief = onboard.get("brief", "")
        if brief:
            await client.drop_to_inbox(
                f"{today}-onboarding-first-brief.md",
                f"# First Brief\n\n{brief}\n",
            )
            files_written += 1

        automations = onboard.get("automations", [])
        if automations:
            lines = ["# Suggested Automations", ""]
            for a in automations:
                if isinstance(a, dict):
                    lines.append(f"## {a.get('name', 'Untitled')}")
                    lines.append(a.get("description", ""))
                    if a.get("trigger"):
                        lines.append(f"**Trigger**: {a['trigger']}")
                    if a.get("action"):
                        lines.append(f"**Action**: {a['action']}")
                    lines.append("")
            await client.drop_to_inbox(
                f"{today}-onboarding-automations.md",
                "\n".join(lines),
            )
            files_written += 1

    finally:
        await client.close()

    logger.info("batch_processor: wrote %d inbox files from %d facts", files_written, len(facts))
    return {"facts_processed": len(facts), "files_written": files_written}
