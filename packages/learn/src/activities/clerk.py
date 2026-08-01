"""Hermes run bridge — all LLM calls go through the gateway.

NEVER call the Anthropic API directly. The Clerk is a stateless LLM worker
dispatched for creative tasks.

Phase 2 rewrite (#20): ``_call_clerk`` talks Hermes-native instead of
the legacy OpenClaw ``POST /tools/invoke`` envelope (``sessions_spawn`` /
``sessions_history`` / ``sessions_delete``). The double-encoded
``result.content[].text`` envelope parsing and the ``_cleanup_session``
helper are gone — Hermes' SQLite SessionStore makes per-run cleanup
unnecessary (no leaked ``.bak-*`` files).

#46: the bespoke ``POST /v1/runs`` + ``GET /v1/runs/{id}`` poll loop is
retired in favour of Hermes' native synchronous completion endpoint,
``POST /v1/responses`` (the OpenAI Responses API). That handler runs the
agent to completion server-side and returns the final ``output`` in the
HTTP response — request → final-output in a single call, no fixed-
interval polling. ``_call_clerk``'s signature and return shape are
unchanged; this is an internal-mechanism swap.

``_extract_json`` is unchanged: it parses the LLM's *text* output (the
model still emits prose/markdown around JSON), not the transport.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

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

    prompt = f"""You are a classification clerk. Your job: read the file, classify it, return JSON.

STEP 1: Read the file using the pdf tool (for PDFs) or read tool (for text files).
STEP 2: Based on the file content, classify and extract information.
STEP 3: Return ONLY a JSON object. No explanation, no prose, no markdown.
{file_instruction}

Classify as exactly one of: task, triage, event, note, conversation, braindump, noise.

- task: a clearly actionable item — an invoice to pay, a bug to fix, a follow-up to send, a deadline to meet, something specific that requires action
- triage: something that MIGHT need attention but is ambiguous — you're unsure whether to act on it, or it requires human judgment to decide
- event: a calendar event, meeting, or time-bound occurrence
- note: reference material, documentation, knowledge worth keeping
- conversation: a chat or email thread (not actionable)
- braindump: unstructured stream of thought, ideas, or notes
- noise: trivial, automated notifications, or contains no meaningful information (CI build notifications, routine alerts, spam)

Prefer "task" over "triage" when the action is clear. Prefer "noise" over "triage" for automated notifications.

Your ENTIRE response must be valid JSON matching this schema:
{{
  "type": "task|triage|event|note|conversation|braindump|noise",
  "title": "concise descriptive title",
  "entities": [{{"name": "...", "type": "person|org|place"}}],
  "action_items": ["concrete next steps if any"],
  "dates": ["any dates or deadlines mentioned"],
  "tags": ["topical keywords, max 5"],
  "summary": "One sentence summary of what this file contains"
}}

METADATA:
{json.dumps(metadata, indent=2)}

SUMMARY: {summary}

RAW EVENT:
{raw_content}

CRITICAL: Your final message must contain ONLY the JSON object above. No other text."""

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
async def clerk_extract_observation(item: dict[str, Any]) -> dict[str, Any]:
    """Ask the Clerk to extract a structured observation from a chat interaction.

    Handles two types of queue entries:
    - type="routing" (existing): assistant made a routing decision
    - type="instruction|correction|confirmation" (new): user taught a rule,
      corrected a decision, or confirmed good behavior
    """
    item_type = item.get("type", "routing")

    if item_type in ("instruction", "correction", "confirmation"):
        return await _clerk_extract_user_instruction(item)

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


async def _clerk_extract_user_instruction(item: dict[str, Any]) -> dict[str, Any]:
    """Extract a structured observation from a user instruction, correction, or confirmation."""
    item_type = item.get("type", "instruction")
    user_input = item.get("user_input", "")
    assistant_context = item.get("assistant_context", "")

    type_guidance = {
        "instruction": "The user is TEACHING Alfred a new rule or behavior pattern. Extract the RULE: what trigger condition, what action Alfred should take.",
        "correction": "The user is CORRECTING a previous routing decision. Extract: what was done wrong, what should have happened instead.",
        "confirmation": "The user is CONFIRMING that Alfred's previous action was correct. Extract: what pattern was validated, strengthening which routing behavior.",
    }

    prompt = f"""You are a butler's clerk. The master has given direct feedback during a conversation.

TYPE: {item_type}
GUIDANCE: {type_guidance.get(item_type, type_guidance["instruction"])}

USER SAID: {user_input}
{f"ALFRED'S PREVIOUS MESSAGE (context): {assistant_context}" if assistant_context else ""}

Extract a structured observation. Return JSON only:
{{
  "input_type": "instruction",
  "input_source": "chat",
  "input_ref": "",
  "routing_decision": {{
    "destination": "the target/action the user described (if applicable)",
    "process": "the process or rule being taught",
    "assigned_to": ""
  }},
  "reasoning": "What the user is teaching Alfred — the rule, correction, or validation",
  "considered_alternatives": [],
  "signals": {{
    "domain_patterns": [],
    "keyword_patterns": [],
    "input_types": ["instruction"],
    "attachment_patterns": []
  }},
  "source": "chat",
  "tags": ["{item_type}"],
  "instruction_type": "{item_type}",
  "rule_summary": "One-sentence summary of the rule the user is teaching (e.g. 'flag Hetzner emails as infrastructure')"
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

Tier promotion ladder (the trust gradient — you are its only writer):
- Every instinct has "tier": "Asking" | "Confirming" | "Acting".
- New instincts ALWAYS start at "Asking" (surface to the human, never act).
- Promote Asking → Confirming only when an instinct has 10+ CONSISTENT
  observations (human agreed with the routing) and no contradicting
  observation in the window.
- Promote Confirming → Acting only at 20+ consistent observations AND
  zero reversals — Acting means autonomous execution; treat it like
  handing over keys.
- DEMOTE one step immediately on any reversal/contradiction observation.
- Propose a tier change via update: {{"changes": {{"tier": "Confirming"}}}}.
  Never skip a rung in either direction.

When creating or updating instincts, use the rich schema:
- input_patterns: {{ sender_domains: [], subject_keywords: [], attachment_types: [], input_types: [] }}
- routing_rule: {{ destination_type: "project|person|process|hold", destination: "[[wikilink]]", destination_resolver: null, process: "", default_assignee: "[[person/name]]" }}
- observations: list of wikilinks to observation records
- execution: OPTIONAL block that enables autonomous task creation when this instinct fires. Include ONLY when the instinct's action goes BEYOND simple routing/filing — i.e., when it should create a task, draft a response, summarize and notify, or take a multi-step action. Do NOT set execution.enabled for pure routing instincts like "file newsletters to digest" or "move to project folder."

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
      "execution": {{
        "enabled": false,
        "task_title_template": "{{title}}",
        "tier": 2,
        "requires_approval": true
      }},
      "confidence_score": 0.0,
      "tier": "Asking",
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
}}

execution field rules:
- enabled: true ONLY if the instinct should CREATE AN EXECUTION TASK when it fires (e.g. "create an urgent errand with payment details", "draft a reply and notify the user", "summarize the weekly report and write to vault"). Set false for pure routing.
- tier: 2 (default — user-triggered context), 3 (event-driven, for well-established patterns only)
- requires_approval: ALWAYS true for newly created instincts. The trust gradient will auto-relax this as observation_count grows.
- task_title_template: use {{title}} as default; can include variables like {{source}} or {{domain}}"""

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


# Overall completion budget for a single clerk call. ``POST /v1/responses``
# blocks for the full agent run, so this is the httpx read timeout —
# the direct successor of the old 90 × 10s = 900s poll ceiling. Background
# executors that actually do work (Composio calls + vault reads + multi-
# step reasoning) routinely need 4-10 minutes; the workers gateway is
# asynchronous (no human waiting) so the budget is deliberately generous
# enough that a genuinely-working run is never cut off mid-step. The
# enclosing Temporal activity timeout/heartbeat is the outer bound.
_CLERK_COMPLETION_BUDGET_SECONDS = 900.0

# F35 — priced-ceiling cap. Hermes' ``POST /v1/responses`` otherwise asks
# the model for its full output window (65536 on the heavy/clerk models),
# and OpenRouter prices the request against that ceiling — so a call 402s
# ("requested up to 65536 tokens, can only afford 31301") even when the
# actual reply is short. Forwarding a bounded ``max_output_tokens`` shrinks
# the priced ceiling below the affordable budget. 31000 sits just under the
# observed ~31301 affordable line; clerk replies are JSON envelopes that
# never need anywhere near that. Correct regardless of the credit wall.
_MAX_OUTPUT_TOKENS_CAP = 31000

# Temporal envelope for any activity whose body blocks on ``_call_clerk``.
# The activity ``start_to_close_timeout`` MUST sit above the HTTP completion
# budget, otherwise Temporal kills the activity mid-call (the billable clerk
# run keeps going server-side) and then retries → double spend
# (FAILURE-MODES Hermes runtime, S2: media_ingestion.py:110 vs clerk.py:530).
# A 60s margin covers connect + JSON parse + dispatch overhead on top of the
# 900s budget. The heartbeat is the inner liveness signal: a genuinely-
# progressing run heartbeats every ``CLERK_ACTIVITY_HEARTBEAT_SECONDS`` so a
# stalled/dead run is detected and reaped well before the full envelope,
# while a working long run is never cut off. Workflows that schedule clerk-
# backed activities import these so there is ONE source of truth.
CLERK_ACTIVITY_TIMEOUT_SECONDS = _CLERK_COMPLETION_BUDGET_SECONDS + 60.0
CLERK_ACTIVITY_HEARTBEAT_SECONDS = 60.0

# How often ``_call_clerk`` pings ``activity.heartbeat`` while the blocking
# HTTP call is in flight. Must be < ``CLERK_ACTIVITY_HEARTBEAT_SECONDS`` so
# at least one heartbeat lands inside every Temporal heartbeat window.
_CLERK_HEARTBEAT_INTERVAL_SECONDS = CLERK_ACTIVITY_HEARTBEAT_SECONDS / 2.0

_BILLING_ERROR_MARKERS = (
    "insufficient credits",
    "billing error",
    "out of credits",
    "api key has run out",
)

# openai-codex (ChatGPT Pro) usage-cap 429. Distinct from a transient
# rate-limit 429: retrying the usage-cap variant only re-pins the cap, so
# the route_decision / signal-extract paths must treat it as non-retryable
# and let the rate-guard's reset-aware backoff hold them off.
_USAGE_CAP_ERROR_MARKERS = (
    "usage_limit_reached",
    "the usage limit has been reached",
)


def _content_parts_text(content: Any) -> str:
    """Concatenate the text of an OpenAI-style ``content`` parts list.

    A Responses ``message`` item's ``content`` is a list of parts such as
    ``{"type": "output_text", "text": "..."}``. We accept a few shapes
    defensively because the gateway has emitted variants across versions:
    a plain string, a list of part dicts (``text`` or ``content`` keys),
    or a bare list of strings.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict):
                if isinstance(part.get("text"), str):
                    parts.append(part["text"])
                elif isinstance(part.get("content"), str):
                    parts.append(part["content"])
            elif isinstance(part, str):
                parts.append(part)
        return "\n".join(p for p in parts if p)
    if isinstance(content, dict):
        if isinstance(content.get("text"), str):
            return content["text"]
        if isinstance(content.get("content"), str):
            return content["content"]
        if isinstance(content.get("content"), list):
            return _content_parts_text(content["content"])
    return ""


def _response_output_text(response: dict[str, Any]) -> str:
    """Pull the assistant's final text out of a Hermes ``POST /v1/responses``
    body.

    The canonical shape (Hermes ``_extract_output_items``) is::

        {"output": [ ...function_call / function_call_output items...,
                     {"type": "message", "role": "assistant",
                      "content": [{"type": "output_text", "text": "..."}]} ]}

    The final ``message`` item carries the assistant's reply. We walk the
    ``output`` list and take the last assistant ``message``. A few
    fallbacks are kept defensively: a top-level ``output_text`` string, or
    ``output`` itself being a plain string / parts list (older or mocked
    transports).
    """
    out = response.get("output")

    if isinstance(out, list):
        message_text = ""
        for item in out:
            if isinstance(item, dict) and item.get("type") == "message":
                text = _content_parts_text(item.get("content"))
                if text:
                    message_text = text
        if message_text:
            return message_text
        # No ``message`` item — fall back to concatenating any text parts.
        return _content_parts_text(out)

    if isinstance(out, str):
        return out
    if isinstance(out, dict):
        return _content_parts_text(out)

    fallback = response.get("output_text")
    if isinstance(fallback, str):
        return fallback
    return ""


async def _heartbeat_until_cancelled() -> None:
    """Ping Temporal at a fixed interval until cancelled.

    Runs concurrently with the blocking ``POST /v1/responses`` so a
    genuinely-progressing clerk run keeps the enclosing activity alive
    against its ``heartbeat_timeout``. ``activity.heartbeat`` raises if
    there is no activity context (unit tests, direct calls); we swallow
    that so ``_call_clerk`` stays usable outside a worker.
    """
    while True:
        try:
            activity.heartbeat()
        except Exception:
            # No activity context (test / direct call) — nothing to ping.
            return
        await asyncio.sleep(_CLERK_HEARTBEAT_INTERVAL_SECONDS)


async def _call_clerk(
    prompt: str,
    raw: bool = False,
    agent_id: str | None = None,
) -> dict[str, Any] | str:
    """Run a one-shot Hermes job on the workers gateway and return its output.

    #46: native synchronous ``POST /v1/responses`` (the OpenAI Responses
    API). Hermes runs the agent to completion server-side and returns the
    final ``output`` in the HTTP response — request → final-output in a
    single call. There is no ``POST /v1/runs`` + ``GET /v1/runs/{id}``
    poll loop, no ``sessions_spawn`` / ``sessions_history`` /
    ``sessions_delete`` envelope, and no per-run cleanup (Hermes' SQLite
    SessionStore handles its own lifecycle — see #23).

    The request targets the WORKERS profile gateway. The main gateway
    (:18789) is reserved for Sir's live chat; autonomous traffic
    deliberately never touches it so the human surface stays
    uncongested.

    ``agent_id`` scopes the call via the ``X-Hermes-Session-Key`` header
    — Hermes' stable per-channel identifier. For the default clerk it is
    ``learn-clerk``; ephemeral executors pass an ``exec-<hash>`` id so
    each delegated task gets its own session scope (see
    ``ephemeral_agent.py``). Per-task tool scoping is expressed in the
    prompt/instructions, not a per-agent allowlist.

    The whole call is bounded by ``_CLERK_COMPLETION_BUDGET_SECONDS`` (the
    direct successor of the old 900s poll ceiling); the enclosing Temporal
    activity timeout/heartbeat is the outer bound.

    If raw=True, returns the run's text output verbatim; otherwise the
    output is fed through ``_extract_json``.
    """
    config = load_config()
    token = config.gateway_token()
    base = config.openclaw_workers_gateway_url
    session_key = agent_id or config.clerk_agent_id
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        # Stable per-channel scope; the Responses API has no body
        # ``session_id`` field — see Hermes ``_handle_responses``.
        "X-Hermes-Session-Key": session_key,
    }

    # POST /v1/responses blocks until the agent run completes, so the read
    # timeout IS the completion budget. ``stream`` is omitted (defaults
    # false) — the non-streaming branch returns the final response JSON.
    timeout = httpx.Timeout(_CLERK_COMPLETION_BUDGET_SECONDS, connect=30.0)
    # Heartbeat while the call is in flight so the enclosing activity's
    # heartbeat_timeout reaps only a truly stalled run, never a working
    # long one (FAILURE-MODES Hermes runtime, S2).
    heartbeat_task = asyncio.ensure_future(_heartbeat_until_cancelled())
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{base}/v1/responses",
                headers=headers,
                # F35: cap the priced output ceiling (see _MAX_OUTPUT_TOKENS_CAP).
                json={"input": prompt, "max_output_tokens": _MAX_OUTPUT_TOKENS_CAP},
            )
    except httpx.TimeoutException as exc:
        raise TimeoutError(
            f"Clerk run did not complete within "
            f"{int(_CLERK_COMPLETION_BUDGET_SECONDS)}s"
        ) from exc
    finally:
        heartbeat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await heartbeat_task

    # Hermes returns 4xx/5xx with an ``error`` envelope when the request or
    # the agent run itself fails. Discriminate retryable from un-retryable
    # so Temporal stops blind-retrying failures that retries can never fix
    # (FAILURE-MODES Hermes runtime, S2 — clerk.py collapsed everything into
    # one generic RuntimeError):
    #   * 401 (stale gateway token), 402/403 (auth/payment), or any status
    #     carrying a billing/credit-exhaustion marker → NON-retryable. A
    #     retry just burns the same dead token / empty wallet.
    #   * 429 (rate limit) and 5xx (transient run failure) → retryable, so
    #     Temporal's backoff can ride out the blip.
    if resp.status_code >= 400:
        detail = ""
        try:
            err_body = resp.json()
            if isinstance(err_body, dict):
                err = err_body.get("error")
                detail = err.get("message") if isinstance(err, dict) else str(err or err_body)
        except Exception:
            detail = resp.text
        detail = str(detail)
        detail_lower = detail.lower()
        is_billing = any(m in detail_lower for m in _BILLING_ERROR_MARKERS)
        # openai-codex (ChatGPT Pro) usage-cap 429. A plain transient 429
        # stays retryable (Temporal rides the blip), but the Pro usage-cap
        # variant carries ``usage_limit_reached`` — retrying just re-pins
        # the exhausted cap, so it must be non-retryable. The rate-guard's
        # parse_retry_after_from_exc reads ``resets_in_seconds`` off the
        # same payload to schedule the real backoff.
        is_usage_cap = any(
            m in detail_lower for m in _USAGE_CAP_ERROR_MARKERS
        )
        non_retryable = (
            resp.status_code in (401, 402, 403) or is_billing or is_usage_cap
        )
        raise ApplicationError(
            f"Clerk run failed (HTTP {resp.status_code}): {detail[:300]}",
            type="ClerkBillingError" if (resp.status_code == 402 or is_billing)
            else "ClerkUsageCapError" if is_usage_cap
            else "ClerkAuthError" if resp.status_code in (401, 403)
            else "ClerkRunError",
            non_retryable=non_retryable,
        )

    response = resp.json()
    output_text = _response_output_text(response)

    # Fail fast on billing/credit exhaustion. A failed agent run comes back
    # as HTTP 200 with the failure text in ``output`` (Hermes folds the
    # agent's ``error`` into the final message), so this check stays.
    if output_text and any(
        m in output_text.lower() for m in _BILLING_ERROR_MARKERS
    ):
        raise RuntimeError(f"Clerk LLM billing error: {output_text[:200]}")

    if raw:
        return output_text
    return _extract_json(output_text)


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
    # Try fixing unescaped newlines in string values (common LLM issue)
    try:
        import re
        fixed = re.sub(r'(?<=": ")(.*?)(?="[,}\]])', lambda m: m.group(0).replace('\n', '\\n').replace('\r', '\\r'), content, flags=re.DOTALL)
        return json.loads(fixed)
    except (json.JSONDecodeError, Exception):
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

    # Attempt to repair truncated JSON (close open brackets/braces)
    if first_brace != -1:
        fragment = content[first_brace:]
        open_braces = fragment.count("{") - fragment.count("}")
        open_brackets = fragment.count("[") - fragment.count("]")
        repaired = fragment + ("]" * max(0, open_brackets)) + ("}" * max(0, open_braces))
        try:
            return json.loads(repaired)
        except json.JSONDecodeError:
            pass

    # Last-resort: if content looks like a JSON array (starts with `[`),
    # salvage every complete object up to the truncation point. Used when
    # the clerk's response hit its output token budget mid-batch — rather
    # than losing the entire enrichment run, return what we got. The
    # salvaged objects are returned WRAPPED as ``{"results": [...]}`` —
    # never a bare list — so this function honours its ``-> dict`` contract
    # and single-object callers (``classification.get(...)`` in
    # media_ingestion) don't hit AttributeError. The one array-consumer
    # (enrichment._call_clerk caller) already unwraps a ``results`` key.
    first_bracket = content.find("[")
    if first_bracket != -1:
        results: list = []
        depth = 0
        in_string = False
        escape = False
        obj_start: int | None = None
        for i in range(first_bracket, len(content)):
            ch = content[i]
            if escape:
                escape = False
                continue
            if ch == "\\":
                escape = True
                continue
            if ch == '"':
                in_string = not in_string
                continue
            if in_string:
                continue
            if ch == "{":
                if depth == 0:
                    obj_start = i
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0 and obj_start is not None:
                    try:
                        results.append(json.loads(content[obj_start : i + 1]))
                    except json.JSONDecodeError:
                        pass
                    obj_start = None
            elif ch == "]" and depth == 0:
                break
        if results:
            return {"results": results}

    raise ValueError(f"Could not parse JSON from Clerk response: {content[:200]}")
