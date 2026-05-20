"""Domain-clustered batch processor for stream events.

Groups emails by sender domain and writes batched markdown files to the
vault inbox. The curator agent picks them up and creates proper vault
records through its 4-stage pipeline (analyze → entity resolution →
interlink → enrich).

No direct LLM calls. No direct vault writes. Just smart batching into inbox.

Preprocessing: strips raw email body to clean readable text — subject,
from, to, date, snippet. Personal domains get first 500 chars of body.
100 emails per inbox file → ~16 files for 1,600 emails.
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
SMALL_DOMAIN_THRESHOLD = 5
MIXED_BATCH_SIZE = 100
EMAILS_PER_FILE = 100

# Domains that are clearly services (not personal conversations)
# Personal domains get more body text included
SERVICE_DOMAIN_SIGNALS = {
    "noreply", "no-reply", "notification", "notifications", "mailer",
    "mail", "email", "newsletter", "updates", "info", "support",
    "billing", "receipts", "alert", "alerts",
}


def _is_service_domain(domain: str, emails: list[dict]) -> bool:
    """Heuristic: is this a service/notification domain vs personal email?"""
    # Check if most senders are noreply-style
    service_senders = sum(
        1 for e in emails
        if any(sig in e.get("from", "").lower().split("@")[0] for sig in SERVICE_DOMAIN_SIGNALS)
    )
    if service_senders > len(emails) * 0.5:
        return True
    # High volume from single domain = likely service
    if len(emails) > 20:
        return True
    return False


# ---------------------------------------------------------------------------
# Email extraction + preprocessing
# ---------------------------------------------------------------------------

def _extract_body_text(payload: dict) -> str:
    """Extract plain text body from Gmail payload, strip signatures and junk."""
    def _extract(part: dict) -> str:
        if part.get("mimeType", "").startswith("text/plain"):
            data = part.get("body", {}).get("data", "")
            if data:
                try:
                    return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
                except Exception:
                    return ""
        for sub in part.get("parts", []):
            t = _extract(sub)
            if t:
                return t
        return ""

    raw = _extract(payload)
    if not raw:
        return ""

    # Strip common junk
    # Remove zero-width spaces and excessive whitespace
    raw = re.sub(r'[\u200b\u200c\u200d\u00a0]+', ' ', raw)
    # Remove quoted reply chains (lines starting with >)
    lines = raw.split("\n")
    clean = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(">"):
            continue
        if stripped.lower().startswith("on ") and stripped.endswith("wrote:"):
            break  # Stop at reply chain
        if stripped == "--":
            break  # Stop at signature
        if stripped.lower().startswith("sent from my"):
            break
        if stripped.lower().startswith("unsubscribe"):
            break
        clean.append(line)

    return "\n".join(clean).strip()


def _extract_email(event: dict) -> dict[str, str]:
    """Extract clean email summary from a Gmail stream event."""
    raw = event.get("raw", {})
    payload = raw.get("payload", {})
    headers = {}
    for h in payload.get("headers", []):
        name = h.get("name", "").lower()
        if name in ("from", "to", "subject", "date"):
            headers[name] = h.get("value", "")

    sender = headers.get("from", "")
    domain = sender.split("@")[-1].strip(">").strip() if "@" in sender else "unknown"
    snippet = raw.get("snippet", "")
    body = _extract_body_text(payload)

    return {
        "domain": domain,
        "from": sender,
        "to": headers.get("to", ""),
        "subject": headers.get("subject", ""),
        "date": headers.get("date", event.get("received_at", "")),
        "snippet": snippet,
        "body": body,
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


def _format_email_line(email: dict, include_body: bool = False) -> str:
    """Format one email as a compact markdown block."""
    lines = [
        f"### {email.get('subject', 'No Subject')}",
        f"From: {email['from']} | To: {email['to']} | Date: {email['date']}",
    ]
    snippet = email.get("snippet", "")
    body = email.get("body", "")

    if include_body and body:
        lines.append("")
        lines.append(body[:500])
    elif snippet:
        lines.append(snippet)

    lines.append("")
    return "\n".join(lines)


def _build_domain_batch(domain: str, emails: list[dict], is_service: bool) -> str:
    """Build inbox file content for a domain batch."""
    lines = [
        f"# {len(emails)} emails from {domain}",
        "",
    ]

    if is_service:
        lines.append(f"*These are {len(emails)} service/notification emails from {domain}. Summarize the user's relationship with this service. Extract any people, actionable items, or important events. Create appropriate vault records.*")
    else:
        lines.append(f"*These are {len(emails)} emails involving {domain}. Process each conversation — extract people, relationships, projects, tasks, and key facts. Create proper vault records with wikilinks.*")

    lines.extend(["", "---", ""])

    for email in emails:
        lines.append(_format_email_line(email, include_body=not is_service))
        lines.append("---")
        lines.append("")

    return "\n".join(lines)


def _build_mixed_batch(emails: list[dict]) -> str:
    """Build inbox file content for a mixed batch."""
    lines = [
        f"# {len(emails)} emails from various senders",
        "",
        f"*Process these {len(emails)} emails individually. Extract people, organizations, projects, tasks, and key facts. Create proper vault records.*",
        "",
        "---",
        "",
    ]

    for email in emails:
        lines.append(_format_email_line(email, include_body=True))
        lines.append("---")
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main activities
# ---------------------------------------------------------------------------

@activity.defn
async def process_stream_batch(stream_id: str, stream_type: str = "gmail") -> dict[str, Any]:
    """Group stream events by sender domain and drop batched files into inbox.

    The curator agent picks them up and creates proper vault records.
    """
    config = load_config()

    streams_dir = os.environ.get("STREAMS_DIR", "/alfred-data/streams")
    jsonl_path = os.path.join(streams_dir, f"{stream_id}.jsonl")

    if not os.path.exists(jsonl_path):
        logger.warning("batch_processor: JSONL not found: %s", jsonl_path)
        return {"emails_processed": 0, "error": "JSONL not found"}

    # Parse all events
    activity.heartbeat("Reading stream events")
    emails: list[dict] = []
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                email = _extract_email(event)
                if email.get("subject") or email.get("snippet"):
                    emails.append(email)
            except Exception:
                continue

    logger.info("batch_processor: parsed %d emails from %s", len(emails), stream_id)
    activity.heartbeat(f"Parsed {len(emails)} emails")

    if not emails:
        return {"emails_processed": 0}

    # Group by domain
    domain_groups, mixed_batches = _group_by_domain(emails)
    logger.info(
        "batch_processor: %d domain groups, %d mixed batches (%d small-domain emails)",
        len(domain_groups), len(mixed_batches),
        sum(len(b) for b in mixed_batches),
    )

    # Write to inbox
    client = VaultClient(config)
    batches_written = 0
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    try:
        for domain, items in domain_groups.items():
            is_service = _is_service_domain(domain, items)

            # Split into chunks of EMAILS_PER_FILE
            for chunk_start in range(0, len(items), EMAILS_PER_FILE):
                chunk = items[chunk_start:chunk_start + EMAILS_PER_FILE]
                chunk_num = chunk_start // EMAILS_PER_FILE + 1
                total_chunks = (len(items) + EMAILS_PER_FILE - 1) // EMAILS_PER_FILE

                content = _build_domain_batch(domain, chunk, is_service)
                suffix = f"-part{chunk_num}" if total_chunks > 1 else ""
                filename = f"{today}-emails-{_slugify(domain)}{suffix}.md"

                await client.drop_to_inbox(filename, content)
                batches_written += 1

            activity.heartbeat(f"Written {batches_written} batches")

        for i, batch in enumerate(mixed_batches):
            content = _build_mixed_batch(batch)
            filename = f"{today}-emails-mixed-{i + 1:03d}.md"
            await client.drop_to_inbox(filename, content)
            batches_written += 1

    finally:
        await client.close()

    logger.info(
        "batch_processor: wrote %d inbox files from %d emails",
        batches_written, len(emails),
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

    # Write one inbox file with ALL facts (curator processes in one shot)
    client = VaultClient(config)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    try:
        lines = [
            f"# Onboarding: {len(facts)} facts from 100 days of email",
            "",
            "*Create vault records for every person, organization, project, and location mentioned. Also create a user profile summary note.*",
            "",
        ]
        for cat, items in sorted(by_cat.items()):
            lines.append(f"## {cat.title()} ({len(items)} facts)")
            lines.append("")
            for item in items:
                lines.append(f"- {item}")
            lines.append("")

        content = "\n".join(lines)
        await client.drop_to_inbox(f"{today}-onboarding-all-facts.md", content)

        # Brief and automations as separate files
        files_written = 1

        brief = onboard.get("brief", "")
        if brief:
            await client.drop_to_inbox(f"{today}-onboarding-first-brief.md", f"# First Brief\n\n{brief}\n")
            files_written += 1

        automations = onboard.get("automations", [])
        if automations:
            auto_lines = ["# Suggested Automations", ""]
            for a in automations:
                if isinstance(a, dict):
                    auto_lines.append(f"## {a.get('name', 'Untitled')}")
                    auto_lines.append(a.get("description", ""))
                    if a.get("trigger"):
                        auto_lines.append(f"**Trigger**: {a['trigger']}")
                    if a.get("action"):
                        auto_lines.append(f"**Action**: {a['action']}")
                    auto_lines.append("")
            await client.drop_to_inbox(f"{today}-onboarding-automations.md", "\n".join(auto_lines))
            files_written += 1

    finally:
        await client.close()

    logger.info("batch_processor: wrote %d inbox files from %d facts", files_written, len(facts))
    return {"facts_processed": len(facts), "files_written": files_written}
