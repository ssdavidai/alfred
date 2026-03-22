"""OpenClaw subagent bridge — all LLM calls go through the gateway.

NEVER call the Anthropic API directly. The Clerk is a stateless LLM worker
dispatched for creative tasks.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config


@activity.defn
async def clerk_classify(event: dict[str, Any], metadata: dict[str, Any]) -> dict[str, Any]:
    """Ask the Clerk to classify a stream event."""
    source = event.get("stream_type", "unknown")
    raw = event.get("raw", {})
    raw_content = json.dumps(raw, indent=2)
    summary = event.get("summary", "")

    # Build file access instructions if a vault path is available
    file_path = raw.get("path", "") or metadata.get("original_path", "")
    file_instruction = ""
    if file_path:
        # OpenClaw mounts vault at workspace/vault — resolve relative paths there
        rel_path = file_path.lstrip("/")
        if rel_path.startswith("vault/"):
            rel_path = rel_path[len("vault/"):]
        # Provide both possible paths so the Clerk can find the file
        file_instruction = f"""
FILE PATH (try in order):
1. vault/{rel_path}
2. {rel_path}
IMPORTANT: Read the file at one of these paths to analyze its full content. Use the read tool for text files, or the pdf tool for PDFs. Do NOT rely solely on the metadata below — the file itself is the primary source of truth."""

    prompt = f"""You are a butler's clerk. Analyze this raw event from the {source} stream.

Classify it as exactly one of: task, event, note, conversation, braindump, noise.

Extract:
- title (concise, descriptive)
- entities (people, organizations, places mentioned)
- action_items (if any — concrete next steps)
- dates (any dates/deadlines mentioned)
- tags (topical keywords, max 5)

If the content is trivial, automated, or contains no meaningful information, classify as "noise".

Return JSON only:
{{
  "type": "task|event|note|conversation|braindump|noise",
  "title": "...",
  "entities": [{{"name": "...", "type": "person|org|place"}}],
  "action_items": ["..."],
  "dates": ["..."],
  "tags": ["..."],
  "summary": "One sentence summary"
}}
{file_instruction}

METADATA:
{json.dumps(metadata, indent=2)}

SUMMARY: {summary}

RAW CONTENT:
{raw_content}"""

    return await _call_clerk(prompt)


@activity.defn
async def clerk_session_boundary(group: dict[str, Any]) -> dict[str, Any]:
    """Ask the Clerk whether an ambiguous time gap is a session boundary."""
    prompt = f"""You are a butler's clerk. Decide whether these records belong to the same session or different sessions.

The time gap between them is between 30 minutes and 2 hours.

RECORDS:
{json.dumps(group.get("records", []), indent=2)}

Consider:
- Topic continuity
- Participant overlap
- Context similarity

Return JSON only:
{{
  "same_session": true|false,
  "reasoning": "Brief explanation"
}}"""

    return await _call_clerk(prompt)


@activity.defn
async def clerk_daily_digest(activity_data: dict[str, Any]) -> dict[str, Any]:
    """Ask the Clerk to produce a daily digest summary."""
    prompt = f"""You are a butler's clerk preparing the end-of-day briefing for your master.

Summarize today's activity into a concise daily digest.

TODAY'S ACTIVITY:
{json.dumps(activity_data, indent=2)}

Return JSON only:
{{
  "title": "Daily Digest — YYYY-MM-DD",
  "summary": "2-3 sentence overview",
  "highlights": ["Key event 1", "Key event 2"],
  "tasks_created": 0,
  "tasks_completed": 0,
  "tasks_open": 0,
  "events_processed": 0,
  "sessions_detected": 0,
  "orphan_records": 0,
  "action_items": ["Pending item 1"],
  "open_tasks_carrying_forward": ["task description 1"],
  "body": "Full markdown digest body",
  "eod_prompt": "Interactive end-of-day message for the user"
}}"""

    return await _call_clerk(prompt)


@activity.defn
async def clerk_extract_observation(item: dict[str, Any]) -> dict[str, Any]:
    """Ask the Clerk to extract a structured observation from a chat interaction."""
    prompt = f"""You are a butler's clerk. Analyze this interaction where the master gave routing guidance.

Extract a structured observation of the routing decision.

INTERACTION:
User input: {item.get("user_input", "")}
Alfred response: {item.get("alfred_response", "")}
Source: {item.get("source", "chat")}

Return JSON only:
{{
  "input_type": "email|message|document|voice|webhook|other",
  "input_source": "source system",
  "input_ref": "wikilink to source record if identifiable, e.g. [[task/2026/03/15/example.md]]",
  "routing_decision": {{
    "destination": "wikilink to project/person/process, e.g. [[project/Example Project]]",
    "process": "name of process if applicable",
    "assigned_to": "wikilink to person if applicable, e.g. [[person/name]]"
  }},
  "reasoning": "Why this was routed here",
  "considered_alternatives": ["Alternative destination — reason rejected"],
  "signals": {{
    "domain_patterns": [],
    "keyword_patterns": [],
    "input_types": [],
    "attachment_patterns": []
  }},
  "source": "chat",
  "tags": []
}}"""

    return await _call_clerk(prompt)


@activity.defn
async def clerk_extract_hint_observation(hint: dict[str, Any]) -> dict[str, Any]:
    """Ask the Clerk to extract an observation from a routing hint (legacy compat)."""
    return await clerk_extract_instruction_observation(hint)


@activity.defn
async def clerk_extract_instruction_observation(hint: dict[str, Any]) -> dict[str, Any]:
    """Ask the Clerk to extract an observation from an alfred_instructions field."""
    prompt = f"""You are a butler's clerk. A vault record has an alfred_instructions field that expresses a routing/handling preference.

Extract a structured observation from this instruction.

RECORD:
Name: {hint.get("name", "")}
Type: {hint.get("type", "")}
Path: {hint.get("path", "")}
alfred_instructions: {hint.get("alfred_instructions", hint.get("routing_hint", ""))}

Return JSON only:
{{
  "input_type": "{hint.get('type', 'other')}",
  "input_source": "alfred_instructions",
  "input_ref": "[[{hint.get('path', '')}]]",
  "routing_decision": {{
    "destination": "wikilink to project/person/process",
    "process": "name of process if applicable",
    "assigned_to": "wikilink to person if applicable"
  }},
  "reasoning": "Why this routing was specified",
  "considered_alternatives": [],
  "signals": {{
    "domain_patterns": [],
    "keyword_patterns": [],
    "input_types": [],
    "attachment_patterns": []
  }},
  "source": "alfred_instructions",
  "tags": []
}}"""

    return await _call_clerk(prompt)


@activity.defn
async def clerk_execute_instructions(hint: dict[str, Any]) -> dict[str, Any]:
    """Ask the Clerk to interpret and execute alfred_instructions."""
    prompt = f"""You are a butler's clerk. The master has left instructions on a vault record.

Interpret these instructions and produce an execution plan. The plan should describe
what vault changes need to be made (move records, update fields, create tasks, etc.).

RECORD:
Name: {hint.get("name", "")}
Type: {hint.get("type", "")}
Path: {hint.get("path", "")}
Content: {hint.get("content", "")}
alfred_instructions: {hint.get("alfred_instructions", hint.get("routing_hint", ""))}

Return JSON only:
{{
  "understood": true|false,
  "interpretation": "What the instructions mean",
  "actions": [
    {{
      "type": "move|update|create|assign|notify",
      "target": "vault path or record",
      "details": "what to do"
    }}
  ],
  "requires_confirmation": true|false,
  "reasoning": "Why these actions were chosen"
}}"""

    return await _call_clerk(prompt)


@activity.defn
async def clerk_extract_braindump(content: str, metadata: dict[str, Any]) -> dict[str, Any]:
    """Deep extraction for braindumps — topic splitting + thorough analysis."""
    prompt = f"""You are a butler's clerk. This is a braindump — a long, stream-of-consciousness input.

Split it into discrete topics. For each topic:
- title
- type: task | idea | decision | observation | question
- summary
- action_items (if any)
- entities mentioned (people, organizations, places)
- related projects/processes (if identifiable)

Return as JSON:
{{
  "topics": [
    {{
      "title": "...",
      "type": "task|idea|decision|observation|question",
      "summary": "...",
      "action_items": ["..."],
      "entities": [{{"name": "...", "type": "person|org|place"}}],
      "related_projects": ["..."],
      "tags": ["..."]
    }}
  ]
}}

METADATA:
{json.dumps(metadata, indent=2)}

BRAINDUMP CONTENT:
{content}"""

    return await _call_clerk(prompt)


@activity.defn
async def clerk_compare_topics(
    session_summary: str,
    new_records: list[dict[str, Any]],
) -> dict[str, Any]:
    """Ask the Clerk if new activity is about the same topic as the current session."""
    prompt = f"""You are a butler's clerk. Compare the current session topic with new activity.

CURRENT SESSION TOPIC:
{session_summary}

NEW RECORDS:
{json.dumps(new_records, indent=2)}

Is this new activity about the same topic as the current session?

Return JSON only:
{{
  "same_topic": true|false,
  "reasoning": "Brief explanation",
  "suggested_topic_summary": "Updated topic summary if same, or new topic summary if different"
}}"""

    return await _call_clerk(prompt)


@activity.defn
async def clerk_match_session_context(session: dict[str, Any]) -> dict[str, Any]:
    """Ask the Clerk to match a closing session to vault projects, people, entities."""
    prompt = f"""You are a butler's clerk. A work session is closing. Match it to relevant vault context.

SESSION:
{json.dumps(session, indent=2)}

Identify:
- The primary project this session relates to (as a wikilink)
- Participants (as wikilinks to person records)
- Entities mentioned (as wikilinks to org/place records)
- A concise session summary
- Tags

Return JSON only:
{{
  "project": "[[project/Project Name]]",
  "participants": ["[[person/name]]"],
  "entities": ["[[org/name]]"],
  "summary": "Brief session summary",
  "tags": ["tag1", "tag2"]
}}"""

    return await _call_clerk(prompt)


@activity.defn
async def clerk_reflect(
    observations: list[dict[str, Any]],
    instincts: list[dict[str, Any]],
    distiller_learnings: list[dict[str, Any]] | None = None,
    janitor_flags: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Ask the Clerk to analyze observations and propose instinct changes."""
    distiller_section = ""
    if distiller_learnings:
        distiller_section = f"""
DISTILLER LEARNINGS (from completed tasks — additional signal data):
{json.dumps(distiller_learnings, indent=2)}
"""

    janitor_section = ""
    if janitor_flags:
        janitor_section = f"""
JANITOR FLAGS (structural issues — lower confidence for flagged records):
{json.dumps(janitor_flags, indent=2)}
"""

    prompt = f"""You are a butler's head clerk, reviewing today's observations to refine the household's instincts.

CURRENT INSTINCTS (learned patterns):
{json.dumps(instincts, indent=2)}

NEW OBSERVATIONS (today's routing decisions):
{json.dumps(observations, indent=2)}
{distiller_section}{janitor_section}
Analyze the observations against existing instincts. For each observation, determine:

1. Does it strengthen an existing instinct? → UPDATE (add signals, increment count)
2. Does it represent a new pattern not covered? → CREATE new instinct
3. Do two instincts now overlap enough to merge? → MERGE
4. Does new evidence contradict an instinct? → DEPRECATE

Rules:
- A new instinct needs at least 3 observations of the same pattern to be created
- Never delete observations — only instincts can be deprecated
- Be conservative: when in doubt, don't create a new instinct yet
- Signal patterns must be specific enough to avoid false positives
- If distiller_learnings are provided, use them to strengthen or refine instincts
- If janitor_flags are present, reduce confidence for affected records

When creating or updating instincts, use the rich schema:
- input_patterns: {{ sender_domains: [], subject_keywords: [], attachment_types: [], input_types: [] }}
- routing_rule: {{ destination_type: "project|person|process|hold", destination: "[[wikilink]]", destination_resolver: null, process: "", default_assignee: "[[person/name]]" }}
- observations: list of wikilinks to observation records

Return JSON only:
{{
  "create": [
    {{
      "name": "...",
      "description": "...",
      "input_patterns": {{
        "sender_domains": [],
        "subject_keywords": [],
        "attachment_types": [],
        "input_types": []
      }},
      "routing_rule": {{
        "destination_type": "project|person|process|hold",
        "destination": "[[...]]",
        "destination_resolver": null,
        "process": "",
        "default_assignee": "[[...]]"
      }},
      "confidence_score": 0.0,
      "observations": ["[[...]]"],
      "tags": []
    }}
  ],
  "update": [
    {{
      "instinct_id": "path",
      "name": "...",
      "changes": {{}}
    }}
  ],
  "merge": [],
  "deprecate": [],
  "reasoning": "Brief explanation of changes"
}}"""

    return await _call_clerk(prompt)


@activity.defn
async def clerk_process_media(
    file_type: str,
    file_path: str,
    context: dict[str, Any],
) -> dict[str, Any]:
    """Ask the Clerk to process a media file (transcribe, OCR, describe)."""
    prompt = f"""You are a butler's clerk. Process this media file.

FILE TYPE: {file_type}
FILE PATH: {file_path}
CONTEXT (surrounding messages):
{json.dumps(context, indent=2)}

Based on the file type:
- If audio → transcribe and summarize
- If PDF/document → extract text and classify
- If image → describe and extract any text (OCR)

Return JSON only:
{{
  "content_type": "transcript|document_text|image_description",
  "extracted_text": "Full extracted/transcribed text",
  "summary": "Brief summary of the content",
  "entities": [{{"name": "...", "type": "person|org|place"}}],
  "action_items": ["..."],
  "tags": ["..."]
}}"""

    return await _call_clerk(prompt)


async def _call_clerk(prompt: str) -> dict[str, Any]:
    """Call the LLM directly via OpenAI-compatible API.

    Uses CLERK_BASE_URL (Ollama/vLLM) or falls back to OpenClaw chat completions.
    """
    config = load_config()
    base_url = os.environ.get("CLERK_BASE_URL", "")

    if base_url:
        url = f"{base_url.rstrip('/')}/v1/chat/completions"
        headers: dict[str, str] = {}
    else:
        url = f"{config.openclaw_gateway_url}/v1/chat/completions"
        headers = {"Authorization": f"Bearer {config.gateway_token()}"}

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            url,
            headers=headers,
            json={
                "model": config.clerk_model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
            },
        )
        resp.raise_for_status()
        data = resp.json()

    content = ""
    choices = data.get("choices", [])
    if choices:
        content = choices[0].get("message", {}).get("content", "")

    return _extract_json(content)


def _extract_json(content: str) -> dict[str, Any]:
    """Extract JSON from LLM response text."""
    if not isinstance(content, str) or not content.strip():
        raise ValueError("Empty clerk response")

    content = content.strip()
    # Try direct JSON parse
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass
    # Strip markdown code fences
    if "```" in content:
        import re
        match = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", content)
        if match:
            try:
                return json.loads(match.group(1).strip())
            except json.JSONDecodeError:
                pass
    # Find first JSON object
    first_brace = content.find("{")
    last_brace = content.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        try:
            return json.loads(content[first_brace:last_brace + 1])
        except json.JSONDecodeError:
            pass
    raise ValueError(f"Could not parse JSON from Clerk response: {content[:200]}")
