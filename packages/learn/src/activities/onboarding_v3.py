"""Onboarding v3 — 4 Opus calls, 5-minute intelligence pipeline.

Replaces the 101-sequential-Clerk-call pipeline with direct OpenRouter
API calls to claude-opus-4-6. Full email corpus as context.

Steps:
1. Fetch metadata + snippets for all emails (30-60s)
2. Extract facts (1 Opus call)
3. Discover patterns (1 Opus call)
4. Write USER.md + SOUL.md + MEMORY.md + TOOLS.md (1 Opus call)
5. Write First Brief — high-EQ butler welcome letter (1 Opus call)
"""

from __future__ import annotations

import json
import logging
import os
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config

logger = logging.getLogger("alfred-learn")

ONBOARD_PATH = "/alfred-data/onboard.json"


async def _call_llm(prompt: str, max_tokens: int = 8192) -> str:
    """Call Sonnet 4.6 via OpenRouter. Returns raw text response."""
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY not set")

    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "anthropic/claude-opus-4-6",
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.4,
                "max_tokens": max_tokens,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("choices", [{}])[0].get("message", {}).get("content", "")


def _read_onboard(path: str) -> dict:
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write_onboard(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


# ---------------------------------------------------------------------------
# Step 1: Fetch email metadata + snippets
# ---------------------------------------------------------------------------

@activity.defn
async def fetch_email_metadata(user_id: str) -> dict[str, Any]:
    """Fetch metadata + snippets for last 100 days of Gmail.

    Returns {emails: [{from, to, subject, date, snippet, domain}], count, days}.
    """
    saas_url = os.environ.get("SAAS_API_URL", "https://alfred.black")
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{saas_url}/api/internal/oauth2/token",
            json={"provider": "google", "userId": user_id},
            headers={"Authorization": "Bearer internal"},
        )
        resp.raise_for_status()
        token = resp.json()["access_token"]

    from_date = (datetime.now(timezone.utc) - timedelta(days=100)).strftime("%Y/%m/%d")
    auth_headers = {"Authorization": f"Bearer {token}"}
    all_ids: list[str] = []
    page_token: str | None = None

    async with httpx.AsyncClient(timeout=60.0) as client:
        while True:
            params: dict[str, Any] = {"maxResults": 100, "q": f"after:{from_date} -in:drafts -in:spam -in:trash -in:chats -category:promotions"}
            if page_token:
                params["pageToken"] = page_token
            resp = await client.get(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages",
                params=params, headers=auth_headers,
            )
            resp.raise_for_status()
            data = resp.json()
            for msg in data.get("messages", []):
                all_ids.append(msg["id"])
            page_token = data.get("nextPageToken")
            if not page_token or len(all_ids) >= 5000:
                break
            activity.heartbeat(f"Fetched {len(all_ids)} message IDs")

    logger.info("onboarding_v3: found %d messages in last 100 days", len(all_ids))

    # Fetch metadata for each (format=metadata gives headers + snippet)
    emails: list[dict] = []
    async with httpx.AsyncClient(timeout=30.0) as client:
        for i, msg_id in enumerate(all_ids):
            if i % 50 == 0:
                activity.heartbeat(f"Fetching metadata: {i}/{len(all_ids)}")
            try:
                resp = await client.get(
                    f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{msg_id}"
                    "?format=metadata"
                    "&metadataHeaders=From&metadataHeaders=To"
                    "&metadataHeaders=Subject&metadataHeaders=Date",
                    headers=auth_headers,
                )
                if resp.status_code != 200:
                    continue
                msg = resp.json()
                headers = {}
                for h in msg.get("payload", {}).get("headers", []):
                    name = h.get("name", "").lower()
                    if name in ("from", "to", "subject", "date"):
                        headers[name] = h.get("value", "")

                sender = headers.get("from", "")
                domain = sender.split("@")[-1].strip(">").strip() if "@" in sender else "unknown"

                emails.append({
                    "from": sender,
                    "to": headers.get("to", ""),
                    "subject": headers.get("subject", ""),
                    "date": headers.get("date", ""),
                    "snippet": msg.get("snippet", ""),
                    "domain": domain,
                })
            except Exception:
                continue

    # Group by domain for summary
    by_domain: dict[str, int] = defaultdict(int)
    for e in emails:
        by_domain[e["domain"]] += 1

    logger.info("onboarding_v3: fetched metadata for %d emails from %d domains", len(emails), len(by_domain))

    # Write emails directly to onboard.json (don't return them — 5000 emails
    # exceeds Temporal's 4MB gRPC payload limit for activity results)
    onboard_path = os.environ.get("ONBOARD_PATH", "/alfred-data/onboard.json")
    onboard = _read_onboard(onboard_path)
    onboard["emails"] = emails
    onboard["top_domains"] = sorted(by_domain.items(), key=lambda x: -x[1])[:30]
    onboard["progress"]["current_day"] = len(emails)
    onboard["progress"]["total_days"] = len(emails)
    _write_onboard(onboard_path, onboard)

    return {
        "count": len(emails),
        "domains": len(by_domain),
    }


# ---------------------------------------------------------------------------
# Step 2: Extract facts
# ---------------------------------------------------------------------------

@activity.defn
async def extract_facts_opus(onboard_path: str) -> dict[str, Any]:
    """Send all email metadata to Opus, extract every fact about the user."""
    onboard = _read_onboard(onboard_path)
    emails = onboard.get("emails", [])
    if not emails:
        return {"facts": [], "count": 0}

    # Build email corpus text — compact format
    lines = []
    for e in emails:
        line = f"{e.get('date', '')} | {e.get('from', '')} → {e.get('to', '')} | {e.get('subject', '')} | {e.get('snippet', '')}"
        lines.append(line)

    email_text = "\n".join(lines)

    activity.heartbeat("Sending to Opus for fact extraction")

    prompt = f"""You are Alfred, a personal AI butler. You've been given access to your new master's email history — {len(emails)} emails from the last 100 days. Your task: extract EVERY fact about this person's WHOLE LIFE — not just their work.

EMAIL HISTORY ({len(emails)} emails):
{email_text}

Extract facts in these categories:
- **personal**: name, location, family members, children, partner, pets, health, fitness, diet, hobbies, birthday, age
- **home**: home address clues, deliveries, utilities, home services, renovations, neighborhood
- **health_fitness**: gym memberships, sports, training, medical, supplements, diet services
- **professional**: role, company, clients, projects, skills, tools they use
- **financial**: subscriptions, payments, investments, expenses, banking, insurance
- **social**: key relationships, friends, family contacts, communities, clubs
- **routine**: daily patterns, recurring events, habits, sleep schedule clues, commute
- **interests**: topics they follow, newsletters, hobbies, entertainment, travel preferences
- **travel**: trips planned or taken, airlines, hotels, destinations, visa/passport
- **services**: every service/app/platform they use (from sender domains and content)

Return JSON:
{{
  "facts": [
    {{"category": "personal", "fact": "Full name is ...", "confidence": "high"}},
    {{"category": "health_fitness", "fact": "Trains Muay Thai at ...", "confidence": "medium"}}
  ],
  "key_identity_facts": [
    {{"field": "name", "value": "David Szabo-Stuban", "display": "Full name"}},
    {{"field": "age", "value": "35", "display": "Age"}},
    {{"field": "location", "value": "Törökbálint, Hungary", "display": "Location"}},
    {{"field": "partner", "value": "Eszter", "display": "Partner"}},
    {{"field": "children", "value": "Hanna (6 months)", "display": "Children"}},
    {{"field": "pets", "value": "Madonna", "display": "Pets"}},
    {{"field": "company", "value": "Ugly Code LLC", "display": "Company/Role"}},
    {{"field": "main_project", "value": "Alfred Black", "display": "Main project"}}
  ]
}}

The key_identity_facts are the 8-12 most important facts about who this person IS — the ones where getting them wrong would be embarrassing for a butler. Include: name, age, location, partner, children, pets, company/role, main project, and anything else that defines their identity.

Be EXHAUSTIVE on the facts. This is about the WHOLE person — their family dinners matter as much as their business deals. Extract every person, place, service, habit, preference, and pattern you can find. Hundreds of facts expected from {len(emails)} emails."""

    raw = await _call_llm(prompt, max_tokens=16384)

    # Parse JSON
    facts = []
    try:
        # Find JSON in response
        match = re.search(r'\{[\s\S]*"facts"[\s\S]*\}', raw)
        if match:
            parsed = json.loads(match.group())
            facts = parsed.get("facts", [])
    except json.JSONDecodeError:
        # Try repair
        try:
            first = raw.find("{")
            if first >= 0:
                fragment = raw[first:]
                ob = fragment.count("[") - fragment.count("]")
                oc = fragment.count("{") - fragment.count("}")
                repaired = fragment + ("]" * max(0, ob)) + ("}" * max(0, oc))
                facts = json.loads(repaired).get("facts", [])
        except Exception:
            logger.error("onboarding_v3: failed to parse facts from Opus response")

    # Extract key identity facts from the same response
    key_identity_facts = []
    try:
        if match:
            parsed = json.loads(match.group())
            key_identity_facts = parsed.get("key_identity_facts", [])
    except Exception:
        pass

    logger.info("onboarding_v3: extracted %d facts, %d key identity facts", len(facts), len(key_identity_facts))

    onboard["facts"] = facts
    onboard["key_identity_facts"] = key_identity_facts
    onboard["progress"]["facts_count"] = len(facts)
    _write_onboard(onboard_path, onboard)

    return {"facts": len(facts), "key_identity_facts": len(key_identity_facts)}


# ---------------------------------------------------------------------------
# Step 3: Discover patterns
# ---------------------------------------------------------------------------

@activity.defn
async def discover_patterns_opus(onboard_path: str) -> dict[str, Any]:
    """Analyze facts + email metadata to discover behavioral patterns."""
    onboard = _read_onboard(onboard_path)
    facts = onboard.get("facts", [])
    emails = onboard.get("emails", [])
    top_domains = onboard.get("top_domains", [])

    # Summarize facts by category
    by_cat: dict[str, list[str]] = defaultdict(list)
    for f in facts:
        if isinstance(f, dict):
            by_cat[f.get("category", "general")].append(f.get("fact", ""))

    fact_summary = ""
    for cat, items in sorted(by_cat.items()):
        fact_summary += f"\n### {cat.title()} ({len(items)} facts)\n"
        for item in items[:25]:
            fact_summary += f"- {item}\n"

    domain_summary = "\n".join(f"- {d}: {c} emails" for d, c in top_domains[:20])

    activity.heartbeat("Sending to Opus for pattern discovery")

    prompt = f"""You are Alfred, a personal AI butler. You've extracted {len(facts)} facts from your new master's {len(emails)} emails. Now discover PATTERNS in their life.

FACTS SUMMARY:
{fact_summary}

TOP EMAIL DOMAINS:
{domain_summary}

Find patterns in these areas:
1. **Work patterns** — recurring meetings, project cycles, collaboration structures, work rhythm
2. **Communication patterns** — who they talk to most, response patterns, communication style
3. **Life patterns** — routines, regular appointments, seasonal activities, health/fitness
4. **Priority signals** — what gets immediate attention vs deferred, where they spend money
5. **Relationship clusters** — groups of people who appear together, team structures
6. **Growth areas** — skills being developed, new interests, evolving priorities
7. **Pain points** — recurring frustrations, things that break, areas needing help

Return JSON:
{{
  "patterns": [
    {{
      "type": "work|communication|life|priority|relationship|growth|pain",
      "name": "Pattern name",
      "description": "2-3 sentence description with evidence",
      "confidence": "high|medium|low",
      "butler_relevance": "How Alfred could help with this pattern"
    }}
  ]
}}

Be insightful. Look for non-obvious connections. A great butler notices what the master doesn't."""

    raw = await _call_llm(prompt, max_tokens=8192)

    patterns = []
    try:
        match = re.search(r'\{[\s\S]*"patterns"[\s\S]*\}', raw)
        if match:
            patterns = json.loads(match.group()).get("patterns", [])
    except Exception:
        try:
            first = raw.find("{")
            if first >= 0:
                fragment = raw[first:]
                ob = fragment.count("[") - fragment.count("]")
                oc = fragment.count("{") - fragment.count("}")
                repaired = fragment + ("]" * max(0, ob)) + ("}" * max(0, oc))
                patterns = json.loads(repaired).get("patterns", [])
        except Exception:
            logger.error("onboarding_v3: failed to parse patterns")

    logger.info("onboarding_v3: discovered %d patterns", len(patterns))

    onboard["patterns"] = patterns
    onboard["progress"]["patterns_count"] = len(patterns)
    _write_onboard(onboard_path, onboard)

    return {"patterns": len(patterns)}


# ---------------------------------------------------------------------------
# Step 4: Write USER.md + SOUL.md + MEMORY.md + TOOLS.md
# ---------------------------------------------------------------------------

@activity.defn
async def personalize_opus(onboard_path: str) -> dict[str, Any]:
    """Generate personalization files from facts + patterns."""
    onboard = _read_onboard(onboard_path)
    facts = onboard.get("facts", [])
    patterns = onboard.get("patterns", [])

    fact_text = "\n".join(
        f"- [{f.get('category', '?')}] {f.get('fact', '')}"
        for f in facts[:200] if isinstance(f, dict)
    )
    pattern_text = "\n".join(
        f"- [{p.get('type', '?')}] {p.get('name', '')}: {p.get('description', '')}"
        for p in patterns if isinstance(p, dict)
    )

    activity.heartbeat("Sending to Opus for personalization")

    prompt = f"""You are configuring Alfred, a personal AI butler, for a new master. Based on the facts and patterns below, write four configuration files.

FACTS ({len(facts)} total):
{fact_text}

PATTERNS ({len(patterns)} total):
{pattern_text}

Write these four files. Return them in this exact JSON format:

{{
  "user_md": "# User Profile\\n\\n[Rich markdown about who this person is — name, role, company, family, interests, communication style, daily routines. 800-1200 words. Specific and personal.]",

  "soul_md": "# Alfred's Soul\\n\\n[How Alfred should behave with THIS specific person. Tone (formal? casual? technical?), priorities to watch for, boundaries, communication rhythm, personality notes. Make it feel like a real butler who has studied their master. 500-800 words.]",

  "memory_md": "# Memory Index\\n\\n[Key entities Alfred should remember: people (with relationships), organizations, projects, locations, accounts/services. Formatted as wikilinks like [[Person Name]] with brief context. 30-50 entries.]",

  "tools_md": "# Suggested Tools\\n\\n[3-5 specific automations or workflows that would help THIS person based on their patterns. Each with: name, what it does, what triggers it, estimated time saved. Be practical and specific.]"
}}

Make each file genuinely useful — not generic templates. Reference specific names, projects, and patterns from the data."""

    raw = await _call_llm(prompt, max_tokens=16384)

    files = {}
    try:
        match = re.search(r'\{[\s\S]*"user_md"[\s\S]*\}', raw)
        if match:
            files = json.loads(match.group())
    except Exception:
        try:
            first = raw.find("{")
            if first >= 0:
                fragment = raw[first:]
                ob = fragment.count("[") - fragment.count("]")
                oc = fragment.count("{") - fragment.count("}")
                repaired = fragment + ("]" * max(0, ob)) + ("}" * max(0, oc))
                files = json.loads(repaired)
        except Exception:
            logger.error("onboarding_v3: failed to parse personalization")

    # Write files to vault
    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    written = []
    async with httpx.AsyncClient(base_url=config.alfred_ctrl_url, timeout=30.0, headers=headers) as client:
        for filename, key in [("USER.md", "user_md"), ("SOUL.md", "soul_md"), ("MEMORY.md", "memory_md"), ("TOOLS.md", "tools_md")]:
            content = files.get(key, "")
            if content:
                try:
                    await client.put(
                        f"/api/v1/admin/workspace/{filename}",
                        json={"content": content},
                    )
                    written.append(filename)
                    logger.info("onboarding_v3: wrote %s (%d chars)", filename, len(content))
                except Exception as exc:
                    logger.error("onboarding_v3: failed to write %s: %s", filename, exc)

    onboard["user_md"] = files.get("user_md", "")
    onboard["soul_md"] = files.get("soul_md", "")
    _write_onboard(onboard_path, onboard)

    return {"files_written": written}


# ---------------------------------------------------------------------------
# Step 5: Write First Brief
# ---------------------------------------------------------------------------

@activity.defn
async def write_brief_opus(onboard_path: str) -> dict[str, Any]:
    """Generate the high-EQ butler welcome letter."""
    onboard = _read_onboard(onboard_path)
    facts = onboard.get("facts", [])
    patterns = onboard.get("patterns", [])
    user_md = onboard.get("user_md", "")
    soul_md = onboard.get("soul_md", "")

    fact_highlights = "\n".join(
        f"- {f.get('fact', '')}" for f in facts[:100] if isinstance(f, dict) and f.get("confidence") == "high"
    )
    pattern_highlights = "\n".join(
        f"- {p.get('name', '')}: {p.get('description', '')}"
        for p in patterns if isinstance(p, dict)
    )

    # Check for user corrections from the fact verification card
    corrections = onboard.get("fact_corrections", {})
    corrections_text = ""
    if corrections:
        corrections_text = "\n\nIMPORTANT CORRECTIONS FROM THE USER (these override anything else):\n"
        for field, value in corrections.items():
            corrections_text += f"- {field}: {value}\n"
        corrections_text += "\nUse these corrected values. Do NOT use the original values for these fields.\n"

    activity.heartbeat("Sending to Opus for First Brief")

    prompt = f"""You are Alfred, a personal AI butler, writing your First Brief — the very first letter to your new master. You've spent time quietly observing their email life — not just their work, but their LIFE — and have formed an impression of the whole person.
{corrections_text}

USER PROFILE:
{user_md[:3000]}

BUTLER'S SOUL:
{soul_md[:2000]}

KEY FACTS (top 100):
{fact_highlights}

PATTERNS DISCOVERED:
{pattern_highlights}

Write a First Brief that is:

1. **About the whole person** — not a business report. You are a butler to a HUMAN, not to an entrepreneur. Notice their family, their health, their hobbies, what they do when they're NOT working. What sports do they follow? What do they eat? Where do they travel? What brings them joy outside of work? Work is part of life but it's not the whole picture. A great butler knows the person, not just the professional.

2. **High EQ** — notice what's remarkable about this person as a human being. What are they like? What drives them beyond money and career? What might they not see about themselves? What tensions do you sense between different parts of their life?

3. **Practically useful** — mention 3-4 things across their WHOLE life (not just work) where you noticed you could help. Maybe it's managing subscriptions, tracking deliveries, remembering birthdays, organizing travel, health routines, family logistics — not just business tasks.

4. **Honest about uncertainty** — you've only seen emails. You know nothing about their inner life, their dreams, their fears. Say what you're curious about. A good butler admits what they cannot see and asks (gently) to learn more.

5. **Butler-quality prose** — elegant, understated, with genuine warmth and personality. Not corporate. Not AI-sounding. Think Jeeves meeting Wooster for the first time — observant, respectful, with a hint of dry wit and real affection for the person they're about to serve.

6. **Peculiar observations** — what did you find interesting, surprising, or endearing? A butler who only reports facts is a secretary. A butler who notices the HUMAN details — that's Alfred.

Length: 5-7 paragraphs. No headers, no bullet points, no markdown formatting — just beautiful prose.

Start with "Sir," or "Ma'am," (infer from the data). End with "At your disposal."

Return ONLY the brief text. No JSON wrapping."""

    brief = await _call_llm(prompt, max_tokens=4096)

    # Clean up any markdown fences
    brief = brief.strip()
    if brief.startswith("```"):
        brief = re.sub(r'^```\w*\s*', '', brief)
        brief = re.sub(r'\s*```$', '', brief)

    logger.info("onboarding_v3: brief generated (%d chars)", len(brief))

    onboard["brief"] = brief
    _write_onboard(onboard_path, onboard)

    # Also write to vault
    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    async with httpx.AsyncClient(base_url=config.alfred_ctrl_url, timeout=30.0, headers=headers) as client:
        try:
            await client.post(
                "/api/v1/vault/records",
                json={
                    "type": "event",
                    "name": "First Brief",
                    "content": f"---\ntype: event\nname: First Brief\nstatus: active\ntags: [onboarding, brief]\n---\n\n# First Brief\n\n{brief}\n",
                },
            )
        except Exception:
            pass

    return {"brief_length": len(brief)}
