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
        return {
            "user_id": "",
            "started_at": "",
            "stage": "backfill",
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


# ---------------------------------------------------------------------------
# Activity: init_onboard_json
# ---------------------------------------------------------------------------

@activity.defn
async def init_onboard_json(onboard_path: str, user_id: str) -> None:
    """Create initial onboard.json with empty state."""
    data = {
        "user_id": user_id,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "stage": "backfill",
        "progress": {"current_day": 0, "total_days": 0, "facts_count": 0, "patterns_count": 0},
        "facts": [],
        "patterns": [],
        "automations": [],
        "brief": "",
    }
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
async def update_onboard_progress(onboard_path: str, current_day: int, total_days: int) -> None:
    """Update progress counters in onboard.json."""
    data = _read_onboard(onboard_path)
    data["progress"]["current_day"] = current_day
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
            params: dict[str, Any] = {"maxResults": 100, "q": f"after:{from_date}"}
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

    result = await _call_clerk(prompt)
    new_facts = result.get("new_facts", [])

    # Append to onboard.json
    onboard["facts"].extend(new_facts)
    onboard["progress"]["facts_count"] = len(onboard["facts"])
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

    prompt = f"""You are Alfred, a butler's intelligence system. You've been reading your new master's emails
for the past 100 days and extracted these facts:

FACTS ({len(facts)} total):
{json.dumps(facts, indent=2)}

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

    result = await _call_clerk(prompt)
    patterns = result.get("patterns", [])

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

    # Generate USER.md content
    user_prompt = f"""You are Alfred, a butler's intelligence system. Based on 100 days of email analysis,
write a comprehensive USER.md profile for your master.

FACTS ({len(facts)} total):
{json.dumps(facts, indent=2)}

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

Return JSON:
{{
  "user_md": "The full USER.md content in markdown"
}}"""

    user_result = await _call_clerk(user_prompt)
    user_md = user_result.get("user_md", "# User Profile\n\nProfile pending.")

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

Return JSON:
{{
  "soul_md": "The full SOUL.md content in markdown"
}}"""

    soul_result = await _call_clerk(soul_prompt)
    soul_md = soul_result.get("soul_md", "# Alfred — Butler Protocol\n\nAwaiting personalization.")

    # Write to vault via ctrl API
    client = VaultClient(config)
    try:
        # Write USER.md via workspace endpoint
        api_key = os.environ.get("AAS_API_KEY", "")
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        async with httpx.AsyncClient(base_url=config.alfred_ctrl_url, timeout=30.0, headers=headers) as http:
            await http.put(
                "/api/v1/admin/workspace/USER.md",
                json={"content": user_md},
            )
            await http.put(
                "/api/v1/admin/workspace/SOUL.md",
                json={"content": soul_md},
            )
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

    result = await _call_clerk(prompt)
    automations = result.get("automations", [])

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

Return JSON:
{{
  "brief": "The full 5-paragraph brief text, with paragraphs separated by double newlines."
}}"""

    result = await _call_clerk(prompt)
    brief_text = result.get("brief", "")

    # Write brief to vault as event record
    client = VaultClient(config)
    try:
        brief_content = f"# First Brief\n\n*Your first morning brief from Alfred.*\n\n{brief_text}"
        brief_path = await client.write_record("event", "First Brief", brief_content)
    finally:
        await client.close()

    # Update onboard.json
    onboard["stage"] = "done"
    onboard["brief"] = brief_text
    _write_onboard(onboard_path, onboard)

    return brief_path
