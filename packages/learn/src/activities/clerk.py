"""Hermes run bridge — all LLM calls go through the gateway.

NEVER call the Anthropic API directly. The Clerk is a stateless LLM worker
dispatched for creative tasks.

Phase 2 rewrite (#20): ``_call_clerk`` now talks Hermes-native
``POST /v1/runs`` + polls ``GET /v1/runs/{id}`` instead of the legacy
OpenClaw ``POST /tools/invoke`` envelope (``sessions_spawn`` /
``sessions_history`` / ``sessions_delete``). The double-encoded
``result.content[].text`` envelope parsing and the ``_cleanup_session``
helper are gone — Hermes' SQLite SessionStore makes per-run cleanup
unnecessary (no leaked ``.bak-*`` files), and a run's output is a
plain JSON field, not a nested re-encoded string.

``_extract_json`` is unchanged: it parses the LLM's *text* output (the
model still emits prose/markdown around JSON), not the transport.
"""

from __future__ import annotations

import json
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
  "rule_summary": "One-sentence summary of the rule the user is teaching (e.g. 'flag Acme Cloud emails as infrastructure')"
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


# Run-state polling cadence. 90 × 10s = 900s ceiling — matched to the
# 900s the workers profile caps a run at. Background executors that
# actually do work (Composio calls + vault reads + multi-step
# reasoning) routinely need 4-10 minutes; the workers gateway is
# asynchronous (no human waiting) so the budget is deliberately
# generous enough that a genuinely-working run is never cut off
# mid-step.
_RUN_POLL_INTERVAL_SECONDS = 10
_RUN_POLL_MAX_ATTEMPTS = 90

# Terminal Hermes run states. Anything else (queued/running/…) means
# keep polling.
_RUN_TERMINAL_OK = {"completed", "succeeded", "success"}
_RUN_TERMINAL_FAIL = {"failed", "errored", "error", "cancelled", "canceled", "stopped"}

_BILLING_ERROR_MARKERS = (
    "insufficient credits",
    "billing error",
    "out of credits",
    "api key has run out",
)


def _run_output_text(run: dict[str, Any]) -> str:
    """Pull the assistant's final text out of a Hermes ``GET /v1/runs/{id}``
    body.

    Hermes is OpenAI-style: the run's result lives in a plain ``output``
    field, not a double-encoded ``result.content[].text`` envelope.
    We accept a few shapes defensively because the gateway has emitted
    each across v0.2.x:

      * ``output`` is a plain string — return it.
      * ``output`` is a list of content parts (``{type:"text", text}``)
        — concatenate the text parts.
      * ``output`` is a dict with a nested ``text`` / ``content`` — unwrap.
      * fall back to ``output_text`` / ``result`` keys.
    """
    out = run.get("output")
    if out is None:
        out = run.get("output_text")
    if out is None:
        out = run.get("result")

    if isinstance(out, str):
        return out
    if isinstance(out, list):
        parts: list[str] = []
        for part in out:
            if isinstance(part, dict):
                if isinstance(part.get("text"), str):
                    parts.append(part["text"])
                elif isinstance(part.get("content"), str):
                    parts.append(part["content"])
            elif isinstance(part, str):
                parts.append(part)
        return "\n".join(p for p in parts if p)
    if isinstance(out, dict):
        if isinstance(out.get("text"), str):
            return out["text"]
        if isinstance(out.get("content"), str):
            return out["content"]
        if isinstance(out.get("content"), list):
            return _run_output_text({"output": out["content"]})
    return ""


async def _call_clerk(
    prompt: str,
    raw: bool = False,
    agent_id: str | None = None,
) -> dict[str, Any] | str:
    """Run a one-shot Hermes job on the workers gateway and return its output.

    Phase 2 (#20): native ``POST /v1/runs`` + poll ``GET /v1/runs/{id}``.
    No ``sessions_spawn`` / ``sessions_history`` / ``sessions_delete``
    envelope; no per-run cleanup (Hermes' SQLite SessionStore handles
    its own lifecycle — see #23).

    The run targets the WORKERS profile gateway. The main gateway
    (:18789) is reserved for Sir's live chat; autonomous traffic
    deliberately never touches it so the human surface stays
    uncongested.

    ``agent_id`` becomes the run's ``session_id``. For the default
    clerk it is ``learn-clerk``; ephemeral executors pass an
    ``exec-<hash>`` id so each delegated task gets its own session
    scope (see ``ephemeral_agent.py``). Per-task tool scoping is
    expressed in the prompt/instructions, not a per-agent allowlist.

    If raw=True, returns the run's text output verbatim; otherwise the
    output is fed through ``_extract_json``.
    """
    import asyncio

    config = load_config()
    token = config.gateway_token()
    base = config.openclaw_workers_gateway_url
    session_id = agent_id or config.clerk_agent_id
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # 1. Create the run.
    async with httpx.AsyncClient(timeout=60.0) as client:
        create_resp = await client.post(
            f"{base}/v1/runs",
            headers=headers,
            json={
                "input": prompt,
                "session_id": session_id,
            },
        )
        create_resp.raise_for_status()
        create_data = create_resp.json()

    run_id = create_data.get("id") or create_data.get("run_id")
    if not run_id:
        raise ValueError(f"Could not get run id from POST /v1/runs: {create_data}")

    # 2. Poll GET /v1/runs/{id} until the run reaches a terminal state.
    async with httpx.AsyncClient(timeout=60.0) as client:
        for _ in range(_RUN_POLL_MAX_ATTEMPTS):
            await asyncio.sleep(_RUN_POLL_INTERVAL_SECONDS)
            try:
                poll_resp = await client.get(
                    f"{base}/v1/runs/{run_id}", headers=headers,
                )
                if poll_resp.status_code != 200:
                    continue
                run = poll_resp.json()
            except Exception:
                continue

            status = str(run.get("status") or "").strip().lower()
            output_text = _run_output_text(run)

            # Fail fast on billing/credit exhaustion rather than burning
            # the whole 900s polling budget.
            if output_text and any(
                m in output_text.lower() for m in _BILLING_ERROR_MARKERS
            ):
                raise RuntimeError(f"Clerk LLM billing error: {output_text[:200]}")

            if status in _RUN_TERMINAL_FAIL:
                err = (
                    run.get("error")
                    or run.get("error_message")
                    or output_text
                    or status
                )
                raise RuntimeError(f"Clerk run {run_id} {status}: {str(err)[:300]}")

            if status in _RUN_TERMINAL_OK:
                if raw:
                    return output_text
                return _extract_json(output_text)

            # Non-terminal (queued/running/…) — keep polling.

    raise TimeoutError(
        f"Clerk run did not complete within "
        f"{_RUN_POLL_INTERVAL_SECONDS * _RUN_POLL_MAX_ATTEMPTS}s: {run_id}"
    )


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
    # than losing the entire enrichment run, return what we got.
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
            return results

    raise ValueError(f"Could not parse JSON from Clerk response: {content[:200]}")
