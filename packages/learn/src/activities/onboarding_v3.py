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

import asyncio
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


async def _call_llm(
    prompt: str,
    max_tokens: int = 8192,
    total_timeout: float = 600.0,
    heartbeat_message: str = "waiting on Opus",
) -> str:
    """Call Opus via OpenRouter. Returns raw text response.

    Uses an explicit total timeout (wait_for) because httpx's read timeout
    applies *between bytes*, not total duration — a slow-streaming response
    can hang the activity until Temporal's StartToClose kills it.

    Also heartbeats periodically so the activity stays alive in Temporal and
    heartbeat_timeout can catch true stalls faster than StartToClose.
    """
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY not set")

    # Explicit per-phase timeouts. Note: httpx `read` is between bytes, so
    # we also enforce a total budget below via asyncio.wait_for.
    timeout = httpx.Timeout(connect=30.0, read=120.0, write=60.0, pool=30.0)

    async def _do_call() -> str:
        async with httpx.AsyncClient(timeout=timeout) as client:
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

    async def _heartbeat_loop() -> None:
        start = asyncio.get_event_loop().time()
        while True:
            await asyncio.sleep(15)
            elapsed = int(asyncio.get_event_loop().time() - start)
            try:
                activity.heartbeat(f"{heartbeat_message} ({elapsed}s)")
            except Exception:
                # Not running inside an activity context — ignore.
                return

    hb_task = asyncio.create_task(_heartbeat_loop())
    try:
        return await asyncio.wait_for(_do_call(), timeout=total_timeout)
    finally:
        hb_task.cancel()
        try:
            await hb_task
        except (asyncio.CancelledError, Exception):
            pass


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


def _string_aware_json_object_span(text: str, start: int) -> int | None:
    """Find the closing ``}`` of the JSON object that opens at ``text[start]``.

    Returns the index of the matching closing brace, or ``None`` if no
    balanced object is found before the end of the text. Unlike a naive
    ``{``/``}`` counter, this respects JSON string literals: braces that
    appear inside ``"..."`` strings (e.g. an Opus matter description
    containing ``"uses curly-brace placeholders like {userId}"``) do not
    affect the depth counter, and an escaped quote (``\\"``) does not
    end the string.

    This is the difference between the matter_pack_opus output parsing
    cleanly and silently degrading to ``source: rule_based_parse_error``
    when an Opus-authored description happened to mention literal braces.
    """
    if start >= len(text) or text[start] != "{":
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i
    return None


def _parse_json_with_key(raw: str, key: str, expect: type = list) -> dict:
    """Parse a JSON object containing a specific key from LLM output.

    Tolerates the variety of envelopes Opus emits — bare JSON, JSON
    wrapped in ``` ```json ``` ``` fences, JSON with leading or trailing
    prose, truncated JSON (max_tokens), and most notably JSON whose
    string values themselves contain literal ``{``/``}`` characters
    (Opus often mentions code snippets, URL templates, etc. in matter
    descriptions). The previous brace-depth tracker counted every
    ``{`` character regardless of string context, so a single
    `"description": "..{placeholder}.."` would push depth out of sync
    and the parser would give up — silently degrading every Opus pack
    to the rule-based fallback (the production symptom Sir saw as
    eight domain-named matters instead of eight Opus-authored ones).

    ``expect`` is the type the value at ``key`` must have for a candidate
    to be accepted (``list`` for facts/patterns/packs; ``str`` for the
    personalize stage's ``user_md`` etc., #BUG-6). The final array-element
    salvage stage only applies when ``expect`` is ``list``.
    """
    if not raw or f'"{key}"' not in raw:
        logger.error("onboarding_v3: no '%s' key found in LLM response (len=%d)", key, len(raw))
        return {}

    # Strip markdown code fences if present. Tolerate both fully-closed
    # ``` ```json ... ``` ``` blocks AND opening-only fences (Opus sometimes
    # forgets the closer when it stops at max_tokens).
    text = raw
    code_block = re.search(r'```(?:json)?\s*\n(.*?)\n```', raw, re.DOTALL)
    if code_block and f'"{key}"' in code_block.group(1):
        text = code_block.group(1).strip()
    else:
        open_fence = re.search(r'```(?:json)?\s*\n', raw)
        if open_fence:
            tail = raw[open_fence.end():]
            if f'"{key}"' in tail:
                text = tail.strip()

    # Try direct parse first — the happy path when Opus returns a clean
    # standalone JSON object.
    try:
        parsed = json.loads(text)
        if isinstance(parsed.get(key), expect):
            return parsed
    except (json.JSONDecodeError, AttributeError):
        pass

    # String-aware object scan. For every ``{`` candidate, look for a
    # matching ``}`` that respects string literals; try to parse what
    # we get out. Returns the first candidate that actually contains
    # ``key`` as a list — protects against false matches in nested
    # objects that share unrelated braces.
    pos = 0
    while True:
        ob = text.find("{", pos)
        if ob == -1:
            break
        cb = _string_aware_json_object_span(text, ob)
        if cb is None:
            break
        candidate = text[ob:cb + 1]
        if f'"{key}"' in candidate:
            try:
                parsed = json.loads(candidate)
                if isinstance(parsed.get(key), expect):
                    return parsed
            except json.JSONDecodeError:
                pass
        pos = ob + 1

    # Brace repair for truncated JSON (may hit max_tokens). Walks
    # the fragment with string-awareness, keeping a LIFO stack of
    # open ``{`` / ``[`` characters, then closes them in the correct
    # order. The previous repair counted open vs close characters
    # globally and appended ``]`` ``s before ``}`` — wrong for any
    # nested object that got truncated mid-string, because the inner
    # ``{`` needs to close BEFORE the surrounding ``[``. This left
    # ``"matters": [{"name": "A"}, {"name": "B"`` unrepairable even
    # though only two closers and one bracket-closer were missing.
    try:
        first = text.find("{")
        if first >= 0:
            fragment = text[first:]
            stack: list[str] = []
            in_string = False
            escape = False
            for ch in fragment:
                if in_string:
                    if escape:
                        escape = False
                        continue
                    if ch == "\\":
                        escape = True
                        continue
                    if ch == '"':
                        in_string = False
                    continue
                if ch == '"':
                    in_string = True
                    continue
                if ch == "{":
                    stack.append("}")
                elif ch == "[":
                    stack.append("]")
                elif ch in ("}", "]"):
                    if stack and stack[-1] == ch:
                        stack.pop()
            tail = ""
            # If we ran off the end mid-string, close the string first.
            if in_string:
                tail += '"'
            # Close any unclosed container in LIFO order.
            while stack:
                tail += stack.pop()
            repaired = fragment + tail
            parsed = json.loads(repaired)
            if isinstance(parsed.get(key), expect):
                logger.info(
                    "onboarding_v3: parsed %s via brace repair (added %r)",
                    key,
                    tail,
                )
                return parsed
    except Exception:
        pass

    # Final salvage: recover complete array elements. When the truncation lands
    # mid-element (e.g. a key with no value yet), brace-repair can't produce
    # valid JSON — but every COMPLETE {...} object before the cutoff is still
    # good. Walk the `key` array, collect each fully-closed object, and drop the
    # partial tail. Better a few hundred real facts than zero. Only meaningful
    # for list-valued keys.
    try:
        kpos = text.find(f'"{key}"') if expect is list else -1
        arr_start = text.find("[", kpos) if kpos >= 0 else -1
        if arr_start >= 0:
            items: list = []
            i = arr_start + 1
            n = len(text)
            while i < n:
                while i < n and text[i] in " \t\r\n,":
                    i += 1
                if i >= n or text[i] == "]":
                    break
                if text[i] != "{":
                    break
                end = _string_aware_json_object_span(text, i)
                if end is None:
                    break  # partial trailing object — stop, keep what we have
                try:
                    items.append(json.loads(text[i:end + 1]))
                except json.JSONDecodeError:
                    break
                i = end + 1
            if items:
                logger.info(
                    "onboarding_v3: salvaged %d complete '%s' element(s) from truncated JSON",
                    len(items), key,
                )
                return {key: items}
    except Exception:
        pass

    logger.error("onboarding_v3: failed to parse '%s' from LLM response (len=%d)", key, len(raw))
    return {}


def _parse_json_with_facts(raw: str) -> dict:
    """Parse a JSON object containing both "facts" and "key_identity_facts"."""
    return _parse_json_with_key(raw, "facts")


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
    onboard["progress"]["messages_read"] = len(emails)
    _write_onboard(onboard_path, onboard)

    # Live butler narration of the real inbox — one cheap pass through Hermes
    # (workers gateway). Best effort; never blocks or fails the fetch.
    try:
        from src.activities.inbox_narration import generate_inbox_narration

        narration = await generate_inbox_narration(emails)
        if narration:
            onboard["narration"] = narration
            _write_onboard(onboard_path, onboard)
    except Exception as e:  # noqa: BLE001
        logger.warning("fetch_email_metadata: narration skipped: %s", e)

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

    # Cap at 3000 emails to stay within Opus context limits
    if len(emails) > 3000:
        logger.info("onboarding_v3: capping emails from %d to 3000", len(emails))
        emails = emails[:3000]

    # Build email corpus text — compact format
    lines = []
    for e in emails:
        line = f"{e.get('date', '')} | {e.get('from', '')} → {e.get('to', '')} | {e.get('subject', '')} | {e.get('snippet', '')}"
        lines.append(line)

    email_text = "\n".join(lines)

    # Inject behavioral profiler data if available (#283)
    profiler_context = ""
    profile = onboard.get("profile", {})
    if profile:
        summary = profile.get("summary", {})
        profiler_context = f"""

BEHAVIORAL ANALYSIS (pre-computed from email metadata — use as ground truth):
- Inner circle contacts: {', '.join(summary.get('inner_circle', [])[:10])}
- Communication style: {summary.get('communication_style', 'unknown')}
- Work hours estimate: {summary.get('work_hours', 'unknown')}
- Top subscriptions/services: {', '.join(summary.get('top_subscriptions', [])[:10])}
- Key behavioral patterns: {'; '.join(summary.get('key_patterns', [])[:5])}
"""

    activity.heartbeat("Sending to Opus for fact extraction")

    prompt = f"""You are Alfred, a personal AI butler. You've been given access to your new master's email history — {len(emails)} emails from the last 100 days. Your task: extract EVERY fact about this person's WHOLE LIFE — not just their work.
{profiler_context}
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
    {{"field": "name", "value": "Jane Doe", "display": "Full name"}},
    {{"field": "age", "value": "35", "display": "Age"}},
    {{"field": "location", "value": "Anytown", "display": "Location"}},
    {{"field": "partner", "value": "Sam Lee", "display": "Partner"}},
    {{"field": "children", "value": "Robin (6 months)", "display": "Children"}},
    {{"field": "pets", "value": "Biscuit", "display": "Pets"}},
    {{"field": "company", "value": "Example LLC", "display": "Company/Role"}},
    {{"field": "main_project", "value": "Alfred Black", "display": "Main project"}}
  ]
}}

The key_identity_facts are the 8-12 most important facts about who this person IS — the ones where getting them wrong would be embarrassing for a butler. Include: name, age, location, partner, children, pets, company/role, main project, and anything else that defines their identity.

Be EXHAUSTIVE on the facts. This is about the WHOLE person — their family dinners matter as much as their business deals. Extract every person, place, service, habit, preference, and pattern you can find. Hundreds of facts expected from {len(emails)} emails."""

    # The prompt asks for "hundreds of facts, be EXHAUSTIVE" — at 16384 the
    # response truncated mid-array (observed: a 57.7k-char cutoff → unparseable
    # → 0 facts → empty verify screen). Give it real headroom so the full
    # facts + key_identity_facts object lands; the parser salvages anyway if a
    # very large inbox still overruns.
    raw = await _call_llm(prompt, max_tokens=32000)

    # Parse JSON — use brace-depth tracking (not greedy regex)
    parsed = _parse_json_with_facts(raw)
    facts = parsed.get("facts", [])
    key_identity_facts = parsed.get("key_identity_facts", [])

    logger.info("onboarding_v3: extracted %d facts, %d key identity facts", len(facts), len(key_identity_facts))

    onboard["facts"] = facts
    onboard["key_identity_facts"] = key_identity_facts
    onboard["progress"]["facts_count"] = len(facts)
    _write_onboard(onboard_path, onboard)

    # Stage narration — Alfred working out who you are (best-effort, via Hermes).
    try:
        from src.activities.inbox_narration import generate_facts_narration

        lines = await generate_facts_narration(facts, key_identity_facts)
        if lines:
            onboard["narration"] = onboard.get("narration", []) + lines
            _write_onboard(onboard_path, onboard)
    except Exception as e:  # noqa: BLE001
        logger.warning("onboarding_v3: facts narration skipped: %s", e)

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

    # Inject behavioral profiler data if available (#283)
    profiler_context = ""
    profile = onboard.get("profile", {})
    if profile:
        rhythm = profile.get("rhythm", {})
        tiers = profile.get("sender_tiers", {})
        summary = profile.get("summary", {})
        profiler_context = f"""

BEHAVIORAL PROFILER DATA (ML-extracted from email metadata — high confidence):
- Peak work hours: {rhythm.get('peak_hours', [])}
- Work window: {summary.get('work_hours', 'unknown')}
- Weekend activity ratio: {rhythm.get('weekend_activity_ratio', 'unknown')}
- Regularity score: {rhythm.get('regularity_score', 'unknown')} (0=chaotic, 1=clockwork)
- Communication style: {summary.get('communication_style', 'unknown')}
- Sender tiers: inner_circle={len(tiers.get('inner_circle',[]))}, regular={len(tiers.get('regular',[]))}, noise={len(tiers.get('noise',[]))}
- Detected routines: {len(rhythm.get('detected_routines', []))}
- Key patterns: {'; '.join(summary.get('key_patterns', [])[:5])}
"""

    activity.heartbeat("Sending to Opus for pattern discovery")

    prompt = f"""You are Alfred, a personal AI butler. You've extracted {len(facts)} facts from your new master's {len(emails)} emails. Now discover PATTERNS in their life.
{profiler_context}
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

    # Reuse the same robust parser (looks for "patterns" key)
    parsed = _parse_json_with_key(raw, "patterns")
    patterns = parsed.get("patterns", [])

    logger.info("onboarding_v3: discovered %d patterns", len(patterns))

    onboard["patterns"] = patterns
    onboard["progress"]["patterns_count"] = len(patterns)
    _write_onboard(onboard_path, onboard)

    # Stage narration — Alfred noticing the rhythms of your days.
    try:
        from src.activities.inbox_narration import generate_patterns_narration

        lines = await generate_patterns_narration(patterns)
        if lines:
            onboard["narration"] = onboard.get("narration", []) + lines
            _write_onboard(onboard_path, onboard)
    except Exception as e:  # noqa: BLE001
        logger.warning("onboarding_v3: patterns narration skipped: %s", e)

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

Write these five files. Return them in this exact JSON format:

{{
  "user_md": "# User Profile\\n\\n[Rich markdown about who this person is — name, role, company, family, interests, communication style, daily routines. 800-1200 words. Specific and personal.]",

  "soul_md": "# Alfred's Soul\\n\\n[How Alfred should behave with THIS specific person. Tone (formal? casual? technical?), priorities to watch for, boundaries, communication rhythm, personality notes. Make it feel like a real butler who has studied their master. 500-800 words.]",

  "memory_md": "# Memory Index\\n\\n[Key entities Alfred should remember: people (with relationships), organizations, projects, locations, accounts/services. Formatted as wikilinks like [[Person Name]] with brief context. 30-50 entries.]",

  "tools_md": "# Suggested Tools\\n\\n[3-5 specific automations or workflows that would help THIS person based on their patterns. Each with: name, what it does, what triggers it, estimated time saved. Be practical and specific.]",

  "rules_md": "# Standing Rules\\n\\n[8-15 standing house rules Alfred should follow for THIS person, inferred from their life: boundaries, preferences, do's and don'ts, who/what to prioritise or protect, quiet hours, financial caution, tone. Format as a markdown bullet list — exactly ONE clear rule per line starting with '- ', each a single imperative sentence the principal can keep, edit, or delete. Draft sensible defaults, not generic platitudes.]"
}}

Make each file genuinely useful — not generic templates. Reference specific names, projects, and patterns from the data."""

    raw = await _call_llm(prompt, max_tokens=16384)

    # Use the hardened, string-aware parser the facts/patterns/packs stages
    # already rely on instead of the naive brace-counting regex that desynced
    # on literal braces in values and gave up on max_tokens truncation —
    # the facts→0 truncation class that dropped all five files (#BUG-6).
    # ``user_md`` is the anchor key; its value is a string, so expect=str.
    files = _parse_json_with_key(raw, "user_md", expect=str)
    if not files:
        logger.error("onboarding_v3: failed to parse personalization")

    # Write files to vault
    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    # USER.md and SOUL.md are load-bearing — the brief, the butler's bearing,
    # and every downstream stage assume they exist. MEMORY/TOOLS/RULES are
    # valuable but not blocking. Attempt ALL five writes, collect failures,
    # and only abort the stage (so Temporal retries) if a load-bearing write
    # failed. A transient MEMORY/TOOLS/RULES failure must NOT strand the user
    # pre-verification with partial vault state (#BUG-2).
    LOAD_BEARING = {"USER.md", "SOUL.md"}
    written: list[str] = []
    failed: list[str] = []
    load_bearing_failures: list[str] = []
    async with httpx.AsyncClient(base_url=config.alfred_ctrl_url, timeout=30.0, headers=headers) as client:
        for filename, key in [("USER.md", "user_md"), ("SOUL.md", "soul_md"), ("MEMORY.md", "memory_md"), ("TOOLS.md", "tools_md"), ("RULES.md", "rules_md")]:
            content = files.get(key, "")
            if not content:
                continue
            try:
                resp = await client.put(
                    f"/api/v1/admin/workspace/{filename}",
                    json={"content": content},
                )
                ok = resp.is_success
                detail = f"status={resp.status_code} body={resp.text[:300]}"
            except Exception as exc:  # noqa: BLE001 — network/transport error
                ok = False
                detail = f"transport error: {exc}"
            if not ok:
                logger.error("onboarding_v3: %s write failed %s", filename, detail)
                failed.append(filename)
                if filename in LOAD_BEARING:
                    load_bearing_failures.append(
                        f"{filename} write failed {detail}"
                    )
                continue
            written.append(filename)
            logger.info("onboarding_v3: wrote %s (%d chars)", filename, len(content))

    # A load-bearing write failure aborts so Temporal retries the whole stage;
    # the user does not advance to awaiting_verification on half a vault.
    if load_bearing_failures:
        raise RuntimeError(
            "personalize_opus: load-bearing vault write(s) failed: "
            + "; ".join(load_bearing_failures)
        )

    onboard["user_md"] = files.get("user_md", "")
    onboard["soul_md"] = files.get("soul_md", "")
    _write_onboard(onboard_path, onboard)

    # Stage narration — Alfred composing your profile + shaping its own soul.
    try:
        from src.activities.inbox_narration import generate_personalize_narration

        lines = await generate_personalize_narration(
            onboard.get("key_identity_facts", [])
        )
        if lines:
            onboard["narration"] = onboard.get("narration", []) + lines
            _write_onboard(onboard_path, onboard)
    except Exception as e:  # noqa: BLE001
        logger.warning("onboarding_v3: personalize narration skipped: %s", e)

    if failed:
        logger.warning(
            "onboarding_v3: personalize completed with non-blocking write "
            "failures: %s", failed,
        )
    return {"files_written": written, "files_failed": failed}


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

    # #B2: surface a failed vault write. The old `except: pass` swallowed
    # everything AND never checked the status, so a 422 (or transport error)
    # left the brief unpersisted while the activity returned success and the
    # workflow reported `done`. Propagate transport errors; raise on non-2xx
    # so the Temporal stage retries / surfaces the failure.
    async with httpx.AsyncClient(base_url=config.alfred_ctrl_url, timeout=30.0, headers=headers) as client:
        resp = await client.post(
            "/api/v1/vault/records",
            json={
                # `briefing` is a canonical vault type; `event` is
                # demoted by the promotion contract and rejected with
                # a 422 by ctrl-api's assertCanonicalVaultPath (#75).
                "type": "briefing",
                "name": "First Brief",
                "content": f"---\ntype: briefing\nname: First Brief\nstatus: active\ntags: [onboarding, brief]\n---\n\n# First Brief\n\n{brief}\n",
            },
        )
    if resp.status_code < 200 or resp.status_code >= 300:
        raise RuntimeError(
            f"First Brief vault write failed (HTTP {resp.status_code}): "
            f"{getattr(resp, 'text', '')[:300]}"
        )

    return {"brief_length": len(brief)}


# ---------------------------------------------------------------------------
# Step 5.5 (NEW): Write First Brief + Chore Opportunities in one Opus call
#
# This is the Step 2 activity from the bespoke chore generation plan. It
# replaces write_brief_opus in the onboarding pipeline (PR S2-2) but is
# defined alongside the old activity so rollbacks are trivial. The key
# architectural change: the welcome brief and the list of chore opportunities
# are generated in the same Opus call, so every promise in the letter maps
# to a concrete structured opportunity by construction.
#
# Downstream activities (assign_initial_chores) read the opportunity list
# from onboard.json["opportunities"] and either match each opportunity to
# an existing template (Step 3) or generate a new template (Step 4).
# ---------------------------------------------------------------------------

# Internal retry budget for JSON parse failures on the brief+opportunities call.
_BRIEF_AND_OPPORTUNITIES_MAX_ATTEMPTS = 3


def _build_brief_and_opportunities_prompt(
    user_md: str,
    soul_md: str,
    fact_highlights: str,
    pattern_highlights: str,
    corrections_text: str,
    retry_feedback: str = "",
) -> str:
    """Build the Opus prompt that generates brief + opportunities together.

    `retry_feedback` is appended on retries to tell Opus exactly what was
    wrong with its previous response (e.g. "not valid JSON", "missing 'brief'
    key", specific validation errors). Empty on the first attempt.
    """
    retry_block = ""
    if retry_feedback:
        retry_block = (
            "\n\n**IMPORTANT: previous attempt failed** — " + retry_feedback +
            "\nYou MUST return strictly valid JSON matching the schema below. "
            "No extra text, no preamble, no markdown fences.\n"
        )

    return f"""You are Alfred, a personal AI butler, writing your First Brief — the very first letter to your new master.
{corrections_text}
You've spent time quietly observing their email life — not just their work, but their LIFE — and have formed an impression of the whole person. You will deliver TWO things in this single response:

1. A **First Brief** letter to the master (beautiful butler-quality prose)
2. A structured list of **Chore Opportunities** — specific recurring things Alfred should do for this master, derived from what you learned.

Every promise you make in the letter MUST correspond to a specific opportunity in the list. If you say "I'll watch your subscriptions" in the letter, there must be a `watch-subscriptions` opportunity below. If you say "I'll remember birthdays" in the letter, there must be a `remember-birthdays` opportunity. The letter and the list are one coherent proposal.

USER PROFILE:
{user_md[:3000]}

BUTLER'S SOUL:
{soul_md[:2000]}

KEY FACTS (top 100):
{fact_highlights}

PATTERNS DISCOVERED:
{pattern_highlights}

Return your response as valid JSON matching this exact schema:

{{
  "brief": "Sir, ...[5-7 paragraphs of butler-quality prose]... At your disposal.",
  "opportunities": [
    {{
      "id": "watch-subscriptions",
      "name": "Watch subscriptions",
      "description": "Reviews recurring charges weekly and surfaces failed payments, price hikes, and suspicious new subscriptions.",
      "goal": "Catch failed charges, unexpected price increases, and zombie subscriptions before they cost the master money.",
      "trigger": {{"kind": "cron", "hint": "weekly on Friday"}},
      "data_sources": ["event", "matter"],
      "frequency_hint": "weekly",
      "notify_when": "when confidence of anomaly > 0.7",
      "tags": ["financial", "auto-generated"]
    }},
    {{
      "id": "weekly-acme-digest",
      "name": "Weekly Acme Consulting digest",
      "description": "Summarizes Acme Consulting-matter activity each Sunday so the master has a clear picture going into Monday.",
      "goal": "Prevent the master from walking into Monday without context on the Acme Consulting project.",
      "trigger": {{"kind": "cron", "hint": "Sunday 6pm"}},
      "data_sources": ["event", "matter/acme"],
      "frequency_hint": "weekly",
      "notify_when": "if >=3 events occurred this week",
      "tags": ["digest", "acme"]
    }}
  ]
}}

## Rules for the brief

- **About the whole person** — not a business report. Notice their family, health, hobbies, life outside work. A great butler knows the person, not just the professional.
- **High EQ** — what drives them beyond money and career? What tensions do you sense between different parts of their life?
- **Practically useful** — mention 3-5 things across their WHOLE life where you can help (not just work). Each thing must correspond to an opportunity in the list.
- **Honest about uncertainty** — admit what you cannot see, ask gently to learn more.
- **Butler-quality prose** — elegant, understated, warm, with personality. Not corporate. Not AI-sounding.
- **Peculiar observations** — what did you find interesting, surprising, or endearing? Notice the HUMAN details.
- **Length**: 5-7 paragraphs. No headers, no bullet points, no markdown formatting — just prose.
- **Start** with "Sir," or "Ma'am," (infer from the data).
- **End** with "At your disposal."

## Rules for opportunities

- 3-8 opportunities. Each one must be specific to THIS master, not generic.
- Each opportunity's `name` must appear verbatim (or nearly so) in the brief.
- `id` is a lowercase slug with hyphens only, 1-64 chars, starting and ending with alphanumeric.
- `trigger.kind` must be "cron", "event", or "on-demand".
- `data_sources` should name real vault record types (event, matter, task, note, etc.) or stream names (gmail, calendar, github).
- `frequency_hint` should be "hourly", "daily", "weekly", "biweekly", "monthly", "quarterly", "on-demand", or "continuous".
- Be specific about `notify_when` — this is the decision gate that prevents false-positive notifications. Bias toward silence.
- At minimum, include ONE opportunity corresponding to each concrete promise in the brief. Do not promise things in the letter you cannot back with a chore opportunity.

{retry_block}
Return ONLY the JSON object. No markdown, no preamble, no explanation."""


@activity.defn
async def write_brief_and_opportunities_opus(onboard_path: str) -> dict[str, Any]:
    """Generate the First Brief AND a structured chore opportunity list in one call.

    Companion to write_brief_opus, intended to replace it in the onboarding
    pipeline (see PR S2-2). Uses the same context assembly (user_md, soul_md,
    facts, patterns, corrections) but a prompt that asks Opus to return a JSON
    envelope with two keys: "brief" (prose) and "opportunities" (list).

    On JSON parse failure: retries up to 3 times total with amended prompts.
    On repeated failure: falls back to writing just the brief (empty
    opportunities list) so onboarding still completes.

    Writes:
      - vault/event/First Brief.md       (same as write_brief_opus)
      - onboard.json["brief"]            (same as write_brief_opus)
      - onboard.json["opportunities"]    (NEW — list of validated opportunity dicts)

    Returns: {brief_length: int, opportunities_count: int, attempts: int, fallback: bool}
    """
    # Local import so importing onboarding_v3 doesn't pull the schema in every
    # test — the activity module is already large and we keep coupling explicit.
    from src.activities.chore_opportunity_schema import (
        ChoreOpportunity,
        ChoreOpportunityValidationError,
    )

    onboard = _read_onboard(onboard_path)
    facts = onboard.get("facts", [])
    patterns = onboard.get("patterns", [])
    user_md = onboard.get("user_md", "")
    soul_md = onboard.get("soul_md", "")

    fact_highlights = "\n".join(
        f"- {f.get('fact', '')}"
        for f in facts[:100]
        if isinstance(f, dict) and f.get("confidence") == "high"
    )
    pattern_highlights = "\n".join(
        f"- {p.get('name', '')}: {p.get('description', '')}"
        for p in patterns
        if isinstance(p, dict)
    )

    corrections = onboard.get("fact_corrections", {})
    corrections_text = ""
    if corrections:
        corrections_text = "\n\nIMPORTANT CORRECTIONS FROM THE USER (these override anything else):\n"
        for cfield, cvalue in corrections.items():
            corrections_text += f"- {cfield}: {cvalue}\n"
        corrections_text += "\nUse these corrected values. Do NOT use the original values for these fields.\n"

    brief_text = ""
    opportunities: list[dict[str, Any]] = []
    attempts = 0
    last_error = ""

    while attempts < _BRIEF_AND_OPPORTUNITIES_MAX_ATTEMPTS:
        attempts += 1
        activity.heartbeat(f"Sending to Opus for brief+opportunities (attempt {attempts})")

        prompt = _build_brief_and_opportunities_prompt(
            user_md=user_md,
            soul_md=soul_md,
            fact_highlights=fact_highlights,
            pattern_highlights=pattern_highlights,
            corrections_text=corrections_text,
            retry_feedback=last_error,
        )

        try:
            raw = await _call_llm(prompt, max_tokens=8192)
        except Exception as exc:
            logger.error("onboarding_v3: _call_llm failed on attempt %d: %s", attempts, exc)
            last_error = f"LLM call raised {type(exc).__name__}: {exc}"
            continue

        # Robust parse: _parse_json_with_key handles code fences, truncation,
        # brace-depth scanning. Note the helper requires the keyed value to be
        # a LIST (it was designed for "facts"/"patterns" extraction), so we
        # key on "opportunities" which maps to a list. The returned dict will
        # also contain "brief" as a string which we pull out separately.
        parsed = _parse_json_with_key(raw, "opportunities")
        if not parsed:
            logger.error(
                "onboarding_v3: brief+opportunities parse failed (attempt %d), raw[:200]=%r",
                attempts, raw[:200]
            )
            last_error = "response was not valid JSON matching the schema {brief, opportunities}"
            continue

        brief_candidate = parsed.get("brief")
        opps_raw = parsed.get("opportunities")

        if not isinstance(brief_candidate, str) or not brief_candidate.strip():
            last_error = "response had no 'brief' string field"
            continue
        if not isinstance(opps_raw, list):
            last_error = "response 'opportunities' was not a list"
            continue

        # Validate each opportunity. Drop bad ones but keep good ones — we'd
        # rather ship a partially-populated list than reject the whole response.
        validated: list[dict[str, Any]] = []
        rejected_count = 0
        for raw_opp in opps_raw:
            try:
                opp = ChoreOpportunity.from_dict(raw_opp)
            except ChoreOpportunityValidationError as exc:
                rejected_count += 1
                logger.warning(
                    "onboarding_v3: dropping invalid opportunity on attempt %d: %s",
                    attempts, exc,
                )
                continue
            validated.append(opp.to_dict())

        if not validated:
            last_error = (
                f"all {len(opps_raw)} opportunities failed schema validation "
                f"(example: {last_error or 'see prior logs'})"
            )
            continue

        brief_text = brief_candidate.strip()
        if brief_text.startswith("```"):
            brief_text = re.sub(r"^```\w*\s*", "", brief_text)
            brief_text = re.sub(r"\s*```$", "", brief_text)
        brief_text = brief_text.strip()

        opportunities = validated
        logger.info(
            "onboarding_v3: parsed brief (%d chars) and %d opportunities (%d rejected)",
            len(brief_text), len(opportunities), rejected_count,
        )
        break  # success, exit retry loop

    fallback = False
    if not brief_text:
        # All retries exhausted — fall back to the old write_brief_opus logic
        # so onboarding doesn't block. Empty opportunities list.
        logger.error(
            "onboarding_v3: brief+opportunities failed after %d attempts; falling back to write_brief_opus",
            attempts,
        )
        fallback = True
        fallback_result = await write_brief_opus(onboard_path)
        return {
            "brief_length": fallback_result.get("brief_length", 0),
            "opportunities_count": 0,
            "attempts": attempts,
            "fallback": True,
        }

    onboard["brief"] = brief_text
    onboard["opportunities"] = opportunities
    _write_onboard(onboard_path, onboard)

    # Write the brief to vault (same path as write_brief_opus for dashboard compat)
    config = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    # #B2: surface a failed brief write (see write_brief_opus). The old
    # `except: …warning` made a never-persisted brief look like success.
    async with httpx.AsyncClient(base_url=config.alfred_ctrl_url, timeout=30.0, headers=headers) as client:
        resp = await client.post(
            "/api/v1/vault/records",
            json={
                # `briefing` is a canonical vault type; `event` is
                # demoted by the promotion contract and rejected with
                # a 422 by ctrl-api's assertCanonicalVaultPath (#75).
                "type": "briefing",
                "name": "First Brief",
                "content": (
                    f"---\ntype: briefing\nname: First Brief\nstatus: active\n"
                    f"tags: [onboarding, brief]\n---\n\n"
                    f"# First Brief\n\n{brief_text}\n"
                ),
            },
        )
    if resp.status_code < 200 or resp.status_code >= 300:
        raise RuntimeError(
            f"First Brief vault write failed (HTTP {resp.status_code}): "
            f"{getattr(resp, 'text', '')[:300]}"
        )

    return {
        "brief_length": len(brief_text),
        "opportunities_count": len(opportunities),
        "attempts": attempts,
        "fallback": fallback,
    }
