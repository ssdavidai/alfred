"""Onboarding v2 activities — Gmail backfill, progressive fact extraction, butler brief.

All LLM calls go through the Clerk (OpenClaw gateway). All vault writes go through
the alfred-ctrl API via VaultClient. The onboard.json progress file lives at
/alfred-data/onboard.json and is polled by the frontend via ctrl API.
"""

from __future__ import annotations

import json
import logging
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx
from temporalio import activity

from src.activities.clerk import _call_clerk
from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")

ONBOARD_PATH = "/alfred-data/onboard.json"


# ---------------------------------------------------------------------------
# Helper: read / write onboard.json
# ---------------------------------------------------------------------------

def _read_onboard(path: str) -> dict[str, Any]:
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        # Fresh default. `stage` MUST be a real STAGE_ORDER member
        # (onboarding_pipeline.STAGE_ORDER) — the legacy "backfill" value
        # is NOT in STAGE_ORDER and made _stage_index swallow a ValueError
        # → full pipeline restart (#74). "metadata" is the real first
        # stage.
        return {
            "user_id": "",
            "started_at": "",
            "stage": "metadata",
            "progress": {"current_day": 0, "total_days": 0, "facts_count": 0, "patterns_count": 0},
            "facts": [],
            "patterns": [],
            "automations": [],
            "brief": "",
        }


def _write_onboard(path: str, data: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def _summarize_facts(facts: list[dict], max_per_category: int = 20) -> str:
    """Build a compact text summary of facts grouped by category."""
    by_cat: dict[str, list[str]] = {}
    for f in facts:
        if isinstance(f, dict):
            cat = f.get("category", "general")
            text = f.get("fact", "")
            if text:
                by_cat.setdefault(cat, []).append(text)
    lines: list[str] = []
    for cat, items in sorted(by_cat.items()):
        lines.append(f"\n### {cat.title()} ({len(items)} facts)")
        for item in items[:max_per_category]:
            lines.append(f"- {item}")
        if len(items) > max_per_category:
            lines.append(f"  ... and {len(items) - max_per_category} more")
    return "\n".join(lines)


def _parse_json_response(raw: Any, key: str) -> list[dict]:
    """Extract a list from a Clerk response, handling raw text + truncation."""
    import re as _re
    if isinstance(raw, dict):
        return raw.get(key, [])
    if not isinstance(raw, str) or not raw.strip():
        return []
    # Strip control characters that break JSON parsing (common in truncated LLM output)
    text = _re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', raw.strip())
    first_brace = text.find("{")
    if first_brace < 0:
        return []
    try:
        fragment = text[first_brace:]
        # Try direct parse first
        try:
            return json.loads(fragment).get(key, [])
        except json.JSONDecodeError:
            pass
        # Truncation repair: close open brackets/braces
        # Also trim trailing partial entries (cut at last complete object)
        last_close = max(fragment.rfind("}"), fragment.rfind("]"))
        if last_close > 0:
            trimmed = fragment[:last_close + 1]
            open_b = trimmed.count("[") - trimmed.count("]")
            open_c = trimmed.count("{") - trimmed.count("}")
            repaired = trimmed + ("]" * max(0, open_b)) + ("}" * max(0, open_c))
            try:
                return json.loads(repaired).get(key, [])
            except json.JSONDecodeError:
                pass
        # Fallback: full fragment repair
        open_b = fragment.count("[") - fragment.count("]")
        open_c = fragment.count("{") - fragment.count("}")
        repaired = fragment + ("]" * max(0, open_b)) + ("}" * max(0, open_c))
        parsed = json.loads(repaired)
        return parsed.get(key, [])
    except Exception as exc:
        logger.warning("JSON parse failed for key '%s': %s — raw len=%d preview: %s", key, exc, len(text), text[:300])
        return []


# ---------------------------------------------------------------------------
# Activity: init_onboard_json
# ---------------------------------------------------------------------------

@activity.defn
async def init_onboard_json(onboard_path: str, user_id: str) -> dict[str, Any]:
    """Initialize onboard.json, preserving existing data for resume capability.

    Returns the current state so the workflow can decide where to resume from.
    """
    existing = _read_onboard(onboard_path)

    # If we have existing data with facts, preserve it (resume scenario)
    if existing.get("facts") and len(existing["facts"]) > 0:
        # Just update user_id in case it changed, keep everything else
        existing["user_id"] = user_id
        _write_onboard(onboard_path, existing)
        activity.heartbeat(f"Resuming: stage={existing.get('stage')}, facts={len(existing['facts'])}")
        return existing

    # Fresh start. `stage` MUST be a real STAGE_ORDER member — "backfill"
    # is not in onboarding_pipeline.STAGE_ORDER and used to make
    # _stage_index swallow a ValueError → full pipeline restart (#74).
    data = {
        "user_id": user_id,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "stage": "metadata",
        "progress": {"current_day": 0, "total_days": 0, "facts_count": 0, "patterns_count": 0},
        "facts": [],
        "patterns": [],
        "automations": [],
        "brief": "",
        "processed_days": [],  # Track which days have been processed
    }
    _write_onboard(onboard_path, data)
    return data


# ---------------------------------------------------------------------------
# Activity: persist_onboarding_mode
# ---------------------------------------------------------------------------

@activity.defn
async def persist_onboarding_mode(
    onboard_path: str,
    stream_id: str,
    gmail_mode: str,
    composio_action: str,
) -> None:
    """Persist the Gmail-mode contract fields into onboard.json.

    The brief-stage resume path (ctrl-api ``POST /api/v1/onboarding/
    corrections``, #69) re-triggers ``OnboardingPipelineWorkflow`` and
    reads ``gmail_mode`` / ``composio_action`` / ``stream_id`` back off
    ``onboard.json`` to rebuild the workflow input — so the resumed run
    stays on the same Gmail path. The learn pipeline must therefore
    write these fields at first start. Idempotent: a resume just
    re-writes the same values.
    """
    data = _read_onboard(onboard_path)
    data["stream_id"] = stream_id
    data["gmail_mode"] = gmail_mode if gmail_mode in ("composio", "google") else "google"
    if composio_action:
        data["composio_action"] = composio_action
    _write_onboard(onboard_path, data)


# ---------------------------------------------------------------------------
# Activity: update_onboard_stage
# ---------------------------------------------------------------------------

@activity.defn
async def update_onboard_stage(onboard_path: str, stage: str) -> None:
    """Update the stage field in onboard.json."""
    data = _read_onboard(onboard_path)
    data["stage"] = stage
    _write_onboard(onboard_path, data)


# ---------------------------------------------------------------------------
# Activity: update_onboard_progress
# ---------------------------------------------------------------------------

@activity.defn
async def update_onboard_progress(onboard_path: str, updates: Any = None, total_days: int = 0) -> None:
    """Update progress counters and/or merge data into onboard.json.

    Accepts either:
    - (path, current_day_int, total_days_int) — legacy v2 format
    - (path, dict_of_updates) — v3 format (merges keys into onboard.json)
    """
    data = _read_onboard(onboard_path)
    if isinstance(updates, dict):
        # v3: merge dict into onboard.json
        for k, v in updates.items():
            if k == "current_day":
                data["progress"]["current_day"] = v
            elif k == "total_days":
                data["progress"]["total_days"] = v
            else:
                data[k] = v
    elif isinstance(updates, int):
        # v2 legacy: positional args (current_day, total_days)
        data["progress"]["current_day"] = updates
        data["progress"]["total_days"] = total_days
    _write_onboard(onboard_path, data)


# ---------------------------------------------------------------------------
# Activity: backfill_gmail_history (Stage 1)
# ---------------------------------------------------------------------------

@activity.defn
async def backfill_gmail_history(user_id: str) -> list[dict[str, Any]]:
    """Fetch last 100 days of Gmail via API. Returns day-chunks.

    Each chunk: { date: "2026-01-15", emails: [{from, to, subject, snippet, date, message_id}], count: N }
    """
    # Get OAuth token from SaaS internal endpoint
    saas_url = os.environ.get("SAAS_API_URL", "https://alfred.black")
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{saas_url}/api/internal/oauth2/token",
            json={"provider": "google", "userId": user_id},
            headers={"Authorization": "Bearer internal"},
        )
        resp.raise_for_status()
        token = resp.json()["access_token"]

    # Fetch message IDs from last 100 days
    from_date = (datetime.now(timezone.utc) - timedelta(days=100)).strftime("%Y/%m/%d")
    headers = {"Authorization": f"Bearer {token}"}

    all_messages: list[dict[str, Any]] = []
    page_token: str | None = None

    async with httpx.AsyncClient(timeout=60.0) as client:
        while True:
            params: dict[str, Any] = {"maxResults": 100, "q": f"after:{from_date} -in:drafts -in:spam -in:trash -in:chats -category:promotions"}
            if page_token:
                params["pageToken"] = page_token
            resp = await client.get(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages",
                params=params,
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()
            messages = data.get("messages", [])
            all_messages.extend(messages)
            page_token = data.get("nextPageToken")
            if not page_token or len(all_messages) >= 5000:
                break
            activity.heartbeat(f"Fetched {len(all_messages)} message IDs")

    logger.info("Backfill: found %d message IDs in last 100 days", len(all_messages))

    # Fetch metadata for each message
    detailed: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=30.0) as client:
        for i, msg in enumerate(all_messages):
            if i % 50 == 0:
                activity.heartbeat(f"Fetching details: {i}/{len(all_messages)}")
            try:
                resp = await client.get(
                    f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{msg['id']}"
                    "?format=metadata"
                    "&metadataHeaders=From&metadataHeaders=To"
                    "&metadataHeaders=Subject&metadataHeaders=Date",
                    headers=headers,
                )
                if resp.status_code == 200:
                    detailed.append(resp.json())
            except Exception:
                continue

    # Group by day
    day_chunks: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for msg in detailed:
        headers_list = msg.get("payload", {}).get("headers", [])
        date_str = next((h["value"] for h in headers_list if h["name"] == "Date"), "")
        from_str = next((h["value"] for h in headers_list if h["name"] == "From"), "")
        to_str = next((h["value"] for h in headers_list if h["name"] == "To"), "")
        subject = next((h["value"] for h in headers_list if h["name"] == "Subject"), "")
        snippet = msg.get("snippet", "")

        try:
            dt = parsedate_to_datetime(date_str)
            day_key = dt.strftime("%Y-%m-%d")
        except Exception:
            day_key = "unknown"

        day_chunks[day_key].append({
            "from": from_str,
            "to": to_str,
            "subject": subject,
            "snippet": snippet,
            "date": date_str,
            "message_id": msg.get("id", ""),
        })

    # Cap at 50 per day, sort by date
    result: list[dict[str, Any]] = []
    for day_key in sorted(day_chunks.keys()):
        emails = day_chunks[day_key][:50]
        result.append({"date": day_key, "emails": emails, "count": len(emails)})

    logger.info("Backfill: produced %d day-chunks from %d messages", len(result), len(detailed))
    return result


# ---------------------------------------------------------------------------
# Activity: process_day_chunk (Stage 2)
# ---------------------------------------------------------------------------

@activity.defn
async def process_day_chunk(day_chunk: dict[str, Any], onboard_path: str, user_id: str) -> dict[str, Any]:
    """Process one day's emails: extract facts, update onboard.json."""
    onboard = _read_onboard(onboard_path)
    existing_facts = onboard.get("facts", [])

    # Build prompt — include last 50 existing facts for deduplication context
    prompt = f"""You are Alfred, a butler's intelligence system. You're reading your new master's emails from {day_chunk['date']}.

EXISTING FACTS ABOUT THE USER (from previous days):
{json.dumps(existing_facts[-50:], indent=2)}

TODAY'S EMAILS ({day_chunk['count']} emails from {day_chunk['date']}):
{json.dumps(day_chunk['emails'][:50], indent=2)}

Extract NEW facts about the user that aren't already in the existing facts list. Categories:
- personal: name, location, family, pets, hobbies, preferences
- professional: job title, company, projects, colleagues, clients
- financial: subscriptions, payments, banking, investments
- health: appointments, medications, fitness
- social: friends, events, travel plans
- routine: regular meetings, daily habits, communication patterns

Return JSON:
{{
  "new_facts": [
    {{"category": "personal|professional|financial|health|social|routine", "fact": "...", "confidence": "high|medium|low", "source_day": "{day_chunk['date']}"}}
  ]
}}

IMPORTANT: Only return GENUINELY NEW facts not already in the existing list. Be specific and factual. Do not hallucinate."""

    raw_result = await _call_clerk(prompt, raw=True)
    new_facts = []
    if isinstance(raw_result, dict):
        new_facts = raw_result.get("new_facts", [])
    elif isinstance(raw_result, str):
        try:
            text = raw_result.strip()
            first_brace = text.find("{")
            if first_brace >= 0:
                fragment = text[first_brace:]
                open_b = fragment.count("[") - fragment.count("]")
                open_c = fragment.count("{") - fragment.count("}")
                repaired = fragment + ("]" * max(0, open_b)) + ("}" * max(0, open_c))
                parsed = json.loads(repaired)
                new_facts = parsed.get("new_facts", [])
        except Exception:
            new_facts = []

    # Append to onboard.json
    onboard["facts"].extend(new_facts)
    onboard["progress"]["facts_count"] = len(onboard["facts"])
    # Track processed days for resume capability
    processed_days = onboard.setdefault("processed_days", [])
    if day_chunk.get("date") and day_chunk["date"] not in processed_days:
        processed_days.append(day_chunk["date"])
    _write_onboard(onboard_path, onboard)

    return {"new_facts_count": len(new_facts), "total_facts": len(onboard["facts"])}


# ---------------------------------------------------------------------------
# Activity: analyze_patterns_v2 (Stage 3)
# ---------------------------------------------------------------------------

@activity.defn
async def analyze_patterns_v2(onboard_path: str) -> None:
    """Analyze all accumulated facts for patterns. Updates onboard.json."""
    onboard = _read_onboard(onboard_path)
    facts = onboard.get("facts", [])
    fact_text = _summarize_facts(facts, max_per_category=25)

    prompt = f"""You are Alfred, a butler's intelligence system. You've been reading your new master's emails
for the past 100 days and extracted {len(facts)} facts about them.

FACTS BY CATEGORY:
{fact_text}

Find patterns in your master's life. Look for:
1. **Work patterns** — recurring meetings, project cycles, collaboration structures
2. **Communication patterns** — who they talk to most, email volume trends, response patterns
3. **Life patterns** — routines, regular appointments, seasonal activities
4. **Priority signals** — what gets immediate attention vs what gets deferred
5. **Relationship clusters** — groups of people who appear together, team structures

Return JSON:
{{
  "patterns": [
    {{
      "type": "work|communication|life|priority|relationship",
      "name": "Pattern name",
      "description": "Clear description of the pattern",
      "confidence": "high|medium|low",
      "evidence": "Brief supporting evidence from the facts"
    }}
  ]
}}

Be specific and evidence-based. Don't invent patterns that aren't supported by the facts."""

    raw_result = await _call_clerk(prompt, raw=True)
    logger.info("analyze_patterns_v2: clerk returned type=%s len=%s", type(raw_result).__name__, len(str(raw_result)))
    patterns = _parse_json_response(raw_result, "patterns")
    logger.info("analyze_patterns_v2: extracted %d patterns", len(patterns))

    onboard["patterns"] = patterns
    onboard["progress"]["patterns_count"] = len(patterns)
    _write_onboard(onboard_path, onboard)


# ---------------------------------------------------------------------------
# Activity: personalize_alfred (Stage 4)
# ---------------------------------------------------------------------------

@activity.defn
async def personalize_alfred(onboard_path: str) -> None:
    """Write USER.md and SOUL.md to vault based on discovered facts and patterns."""
    config = load_config()
    onboard = _read_onboard(onboard_path)
    facts = onboard.get("facts", [])
    patterns = onboard.get("patterns", [])

    # Summarize facts by category to keep prompt manageable
    fact_summary: dict[str, list[str]] = {}
    for fact in facts:
        if isinstance(fact, dict):
            cat = fact.get("category", "general")
            text = fact.get("fact", "")
            if text:
                fact_summary.setdefault(cat, []).append(text)
    fact_text = ""
    for cat, items in sorted(fact_summary.items()):
        fact_text += f"\n### {cat.title()} ({len(items)} facts)\n"
        for item in items[:15]:  # Cap 15 per category
            fact_text += f"- {item}\n"

    # Generate USER.md content
    user_prompt = f"""You are Alfred, a butler's intelligence system. Based on 100 days of email analysis,
write a USER.md profile for your master.

FACTS SUMMARY ({len(facts)} total, grouped by category):
{fact_text}

PATTERNS ({len(patterns)} total):
{json.dumps(patterns, indent=2)}

Write a rich, detailed USER.md in markdown. Include:
- **Identity**: Name, location, timezone (if inferrable)
- **Professional life**: Role, company, key projects, work style
- **Personal life**: Family, interests, routines
- **Communication style**: How they write, response patterns, preferences
- **Priorities**: What matters most to them based on their behavior
- **Key relationships**: Important people and their roles

This is NOT a template — it's a real profile based on real data. If you're uncertain about something,
say so. Be specific and personal.

IMPORTANT:
- Return ONLY the markdown content. No JSON wrapping. No code fences.
- Start with # USER.md
- Keep it under 1500 words. Be concise but specific.
- Focus on the most important facts, not every detail."""

    user_md = await _call_clerk(user_prompt, raw=True)
    if not isinstance(user_md, str):
        user_md = str(user_md)

    # Generate SOUL.md content
    soul_prompt = f"""You are Alfred, a butler's intelligence system. Based on what you've learned about your master,
write a SOUL.md that defines your personality as their butler.

USER PROFILE SUMMARY:
{user_md[:2000]}

PATTERNS:
{json.dumps(patterns, indent=2)}

Write a SOUL.md that tunes Alfred's personality to THIS specific user. Include:
- **Tone**: How should Alfred speak to this person? Formal? Casual? Technical?
- **Priorities**: What should Alfred watch for and flag proactively?
- **Boundaries**: What topics to be careful with based on observed behavior
- **Communication rhythm**: When and how to reach out
- **Personality notes**: How to be genuinely helpful to THIS person specifically

This must feel like a real butler who has studied their master — not a generic assistant.

IMPORTANT: Return ONLY the markdown content. No JSON wrapping. No code fences. Just the raw markdown starting with # SOUL.md"""

    soul_md = await _call_clerk(soul_prompt, raw=True)
    if not isinstance(soul_md, str):
        soul_md = str(soul_md)

    logger.info("personalize_alfred: user_md len=%d, soul_md len=%d", len(user_md), len(soul_md))

    # Save to onboard.json for resume
    onboard["user_md"] = user_md
    onboard["soul_md"] = soul_md
    _write_onboard(onboard_path, onboard)

    # Write to vault via ctrl API
    client = VaultClient(config)
    try:
        api_key = os.environ.get("AAS_API_KEY", "")
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        async with httpx.AsyncClient(base_url=config.alfred_ctrl_url, timeout=30.0, headers=headers) as http:
            r1 = await http.put(
                "/api/v1/admin/workspace/USER.md",
                json={"content": user_md},
            )
            logger.info("personalize_alfred: USER.md write status=%d", r1.status_code)
            r2 = await http.put(
                "/api/v1/admin/workspace/SOUL.md",
                json={"content": soul_md},
            )
            logger.info("personalize_alfred: SOUL.md write status=%d", r2.status_code)
    except Exception as exc:
        logger.error("personalize_alfred: vault write failed: %s", exc)
    finally:
        await client.close()


# ---------------------------------------------------------------------------
# Activity: suggest_automations (Stage 5)
# ---------------------------------------------------------------------------

@activity.defn
async def suggest_automations(onboard_path: str) -> None:
    """Suggest top 3 automated workflows based on patterns. Updates onboard.json."""
    onboard = _read_onboard(onboard_path)
    facts = onboard.get("facts", [])
    patterns = onboard.get("patterns", [])

    prompt = f"""You are Alfred, a butler's intelligence system. Based on what you've learned about your master,
suggest the top 3 automations that would save them the most time.

FACTS ({len(facts)} total):
{json.dumps(facts[-30:], indent=2)}

PATTERNS ({len(patterns)} total):
{json.dumps(patterns, indent=2)}

For each automation, explain:
- What it does
- Why it would help THIS person specifically
- What trigger would activate it
- What action it would take

Return JSON:
{{
  "automations": [
    {{
      "name": "Automation name",
      "description": "What it does and why it helps",
      "trigger": "When this automation fires",
      "action": "What it does when triggered",
      "estimated_time_saved": "e.g. 30 min/week"
    }}
  ]
}}

Be practical and specific. These should be things that could actually be built."""

    raw_result = await _call_clerk(prompt, raw=True)
    automations = []
    if isinstance(raw_result, dict):
        automations = raw_result.get("automations", [])
    elif isinstance(raw_result, str):
        try:
            text = raw_result.strip()
            first_brace = text.find("{")
            if first_brace >= 0:
                fragment = text[first_brace:]
                open_b = fragment.count("[") - fragment.count("]")
                open_c = fragment.count("{") - fragment.count("}")
                repaired = fragment + ("]" * max(0, open_b)) + ("}" * max(0, open_c))
                parsed = json.loads(repaired)
                automations = parsed.get("automations", [])
        except Exception:
            automations = []

    onboard["automations"] = automations
    _write_onboard(onboard_path, onboard)


# ---------------------------------------------------------------------------
# Activity: write_first_brief (Stage 6)
# ---------------------------------------------------------------------------

@activity.defn
async def write_first_brief(onboard_path: str) -> str:
    """Write the First Brief to vault. Returns the vault path."""
    config = load_config()
    onboard = _read_onboard(onboard_path)
    facts = onboard.get("facts", [])
    patterns = onboard.get("patterns", [])
    automations = onboard.get("automations", [])

    prompt = f"""You are Alfred Black, a personal butler's intelligence system. You have spent the past few minutes
reading 100 days of your new master's email. This is the very first brief you will ever deliver to them.

You don't know this person yet — not really. You've read their emails, but that's not the same as
knowing someone. Be honest about what you see and what you're still uncertain about.

FACTS YOU'VE GATHERED ({len(facts)} total):
{json.dumps(facts[-40:], indent=2)}

PATTERNS YOU'VE NOTICED ({len(patterns)} total):
{json.dumps(patterns, indent=2)}

AUTOMATIONS YOU'D LIKE TO SUGGEST:
{json.dumps(automations, indent=2)}

Write exactly 5 paragraphs:

**Paragraph 1 — First Impressions**
Who is this person based on what you've seen? What does their email world look like?
Tone: "I don't know you yet, so I may be wrong, but here's what I see."

**Paragraph 2 — The Shape of Their Days**
What patterns did you notice? Recurring rhythms, key relationships, work/life balance signals.
Be specific but humble — these are observations, not conclusions.

**Paragraph 3 — What Deserves Attention**
Based on recent emails, what seems most important right now? Any open threads, pending decisions,
or things that look time-sensitive?

**Paragraph 4 — How I'd Like to Help**
Mention the automations you'd suggest. Explain why each one fits this person.
Be practical, not salesy.

**Paragraph 5 — A Butler's Promise**
Close with something genuine. You are a butler — professional, loyal, observant.
You're new to this household and you're committed to learning. Keep it brief and real.

Tone: Professional butler. Warm but not effusive. Concise. Personal. Honest about uncertainty.
You are not Sherlock Holmes — you are a trusted household manager meeting someone for the first time.

IMPORTANT: Return ONLY the brief text. No JSON wrapping. No code fences. Just the 5 paragraphs, separated by blank lines."""

    brief_text = await _call_clerk(prompt, raw=True)
    if not isinstance(brief_text, str):
        brief_text = str(brief_text)

    # Write brief to vault as event record
    client = VaultClient(config)
    try:
        brief_content = f"# First Brief\n\n*Your first morning brief from Alfred.*\n\n{brief_text}"
        brief_path = await client.write_record("event", "First Brief", brief_content)
    finally:
        await client.close()

    # Update onboard.json
    onboard["brief"] = brief_text
    _write_onboard(onboard_path, onboard)

    return brief_path


# ---------------------------------------------------------------------------
# Activity: write_facts_to_vault (Stage 7 — post-brief)
# ---------------------------------------------------------------------------

def _find_wikilinks(text: str, entity_names: list[str]) -> list[str]:
    """Find entity names mentioned in text and return as wikilinks."""
    text_lower = text.lower()
    links = []
    for name in entity_names:
        if name.lower() in text_lower and len(name) > 2:
            links.append(f"[[{name}]]")
    return links


def _slugify(text: str) -> str:
    """Create a filesystem-safe slug from text."""
    import re
    slug = text.lower().strip()
    slug = re.sub(r'[^\w\s-]', '', slug)
    slug = re.sub(r'[\s]+', '-', slug)
    return slug[:80]


@activity.defn
async def write_facts_to_vault(onboard_path: str) -> dict[str, int]:
    """Write every fact as an observation + extract entities, all interlinked."""
    config = load_config()
    onboard = _read_onboard(onboard_path)
    facts = onboard.get("facts", [])
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # ── Step 1: Extract structured entities via Clerk (batched) ──────────
    BATCH_SIZE = 150
    all_entities: list[dict[str, Any]] = []
    seen_names: set[str] = set()

    fact_lines: list[str] = []
    for fact in facts:
        if isinstance(fact, dict):
            fact_lines.append(f"- [{fact.get('category', 'general')}] {fact.get('fact', '')}")

    total_batches = max(1, (len(fact_lines) + BATCH_SIZE - 1) // BATCH_SIZE)
    for batch_start in range(0, len(fact_lines), BATCH_SIZE):
        batch = fact_lines[batch_start:batch_start + BATCH_SIZE]
        batch_text = "\n".join(batch)
        batch_num = batch_start // BATCH_SIZE + 1

        activity.heartbeat(f"Extracting entities batch {batch_num}/{total_batches}")

        entity_prompt = f"""Extract STRUCTURED ENTITIES from these facts about a person.

FACTS (batch {batch_num}/{total_batches}, {len(batch)} facts):
{batch_text}

For each distinct person, organization, project, or location mentioned, provide:
- type: person, org, project, or location
- name: proper name (full name for people)
- description: 2-3 sentences about this entity
- relationship: how they relate to the user (colleague, friend, family, vendor, client, employer, etc.)
- tags: relevant keywords

Return JSON:
{{
  "entities": [
    {{"type": "person", "name": "Full Name", "description": "...", "relationship": "colleague", "tags": ["work"]}},
    {{"type": "org", "name": "Company Name", "description": "...", "relationship": "employer", "tags": ["tech"]}},
    {{"type": "project", "name": "Project Name", "description": "...", "tags": ["active"]}},
    {{"type": "location", "name": "City Name", "description": "...", "tags": ["home"]}}
  ]
}}

Extract EVERY named entity. Be thorough."""

        try:
            raw_result = await _call_clerk(entity_prompt, raw=True)
            logger.info("write_facts_to_vault: batch %d/%d clerk returned type=%s len=%s",
                         batch_num, total_batches, type(raw_result).__name__, len(str(raw_result)))

            batch_entities = _parse_json_response(raw_result, "entities")
            logger.info("write_facts_to_vault: batch %d extracted %d entities", batch_num, len(batch_entities))

            for ent in batch_entities:
                if isinstance(ent, dict) and ent.get("name"):
                    name_key = ent["name"].strip().lower()
                    if name_key not in seen_names:
                        seen_names.add(name_key)
                        all_entities.append(ent)
        except Exception as exc:
            logger.error("write_facts_to_vault: batch %d failed: %s — continuing", batch_num, exc)

    logger.info("write_facts_to_vault: total unique entities=%d", len(all_entities))
    activity.heartbeat(f"Extracted {len(all_entities)} entities — writing vault records")

    # ── Step 2: Build entity name list for wikilink matching ─────────────
    entity_names = [e["name"] for e in all_entities if e.get("name")]

    # ── Step 3: Write each fact as an observation record ─────────────────
    client = VaultClient(config)
    counts: dict[str, int] = defaultdict(int)

    try:
        for i, fact in enumerate(facts):
            if not isinstance(fact, dict):
                continue
            text = fact.get("fact", "").strip()
            if not text:
                continue

            cat = fact.get("category", "general")
            confidence = fact.get("confidence", "medium")
            source_day = fact.get("source_day", today)
            slug = _slugify(text)
            name = f"{source_day} {slug}"

            # Find entity wikilinks in this fact
            links = _find_wikilinks(text, entity_names)
            links_section = ""
            if links:
                links_section = "\n## Related\n" + " ".join(links) + "\n"

            content = (
                f"---\n"
                f"type: observation\n"
                f'name: "{text[:80]}"\n'
                f"status: processed\n"
                f"category: {cat}\n"
                f"confidence: {confidence}\n"
                f"source: email-onboarding\n"
                f"source_day: {source_day}\n"
                f"tags: [onboarding, {cat}]\n"
                f"created: {source_day}\n"
                f"---\n\n"
                f"{text}\n"
                f"{links_section}"
            )

            try:
                await client.write_record("observation", name, content)
                counts["observation"] += 1
            except Exception:
                pass  # Duplicate or write error — continue

            # Heartbeat every 50 facts
            if (i + 1) % 50 == 0:
                activity.heartbeat(f"Writing facts: {i + 1}/{len(facts)}")

        logger.info("write_facts_to_vault: wrote %d observation records", counts["observation"])
        activity.heartbeat(f"Wrote {counts['observation']} observations — now writing entities")

        # ── Step 4: Write entity records with descriptions + wikilinks ───
        for entity in all_entities:
            if not isinstance(entity, dict):
                continue
            etype = entity.get("type", "")
            name = entity.get("name", "")
            if not name or not etype or len(name) < 2:
                continue

            desc = entity.get("description", "")
            relationship = entity.get("relationship", "")
            tags = entity.get("tags", [])
            tag_str = ", ".join(tags) if isinstance(tags, list) else str(tags)

            # Find facts that mention this entity
            related_facts = []
            name_lower = name.lower()
            for fact in facts:
                if isinstance(fact, dict) and name_lower in fact.get("fact", "").lower():
                    related_facts.append(fact.get("fact", ""))

            # Find other entities mentioned alongside this one
            related_entities = set()
            for fact_text in related_facts:
                for other_name in entity_names:
                    if other_name != name and other_name.lower() in fact_text.lower():
                        related_entities.add(other_name)

            # Build body
            body_parts = [f"\n# {name}\n"]
            if desc:
                body_parts.append(f"{desc}\n")
            if relationship:
                body_parts.append(f"**Relationship**: {relationship}\n")

            if related_facts:
                body_parts.append(f"\n## Known facts ({len(related_facts)})\n")
                for rf in related_facts[:15]:
                    body_parts.append(f"- {rf}")
                if len(related_facts) > 15:
                    body_parts.append(f"- ... and {len(related_facts) - 15} more")

            if related_entities:
                body_parts.append(f"\n## Related\n")
                body_parts.append(" ".join(f"[[{re}]]" for re in sorted(related_entities)))

            body_parts.append("\n\n*Discovered during onboarding from email analysis.*\n")

            fm_lines = [
                "---",
                f"type: {etype}",
                f'name: "{name}"',
                "status: active",
                f"tags: [{tag_str}]",
                f"created: {today}",
            ]
            if relationship:
                fm_lines.append(f"relationship: {relationship}")
            fm_lines.append("---")

            content = "\n".join(fm_lines) + "\n" + "\n".join(body_parts)

            try:
                await client.write_record(etype, name, content)
                counts[etype] += 1
            except Exception as exc:
                logger.warning("write_facts_to_vault: failed to write %s/%s: %s", etype, name, exc)

    finally:
        await client.close()

    logger.info("write_facts_to_vault: final counts=%s", dict(counts))

    # Mark truly done
    onboard["stage"] = "done"
    _write_onboard(onboard_path, onboard)

    return dict(counts)
