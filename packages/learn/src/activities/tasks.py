"""Task execution activities — fetch, execute, and complete vault tasks.

Tasks are the execution primitive: atomic units of work with an owner,
tier, skill reference, and lifecycle. AI tasks are executed via OpenClaw
sessions_spawn with full tool access.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.vault_client import VaultClient


@activity.defn
async def fetch_queued_tasks() -> list[dict[str, Any]]:
    """Fetch vault tasks with status=queued.

    Reads each task's full content to get frontmatter fields (owner, tier, etc.)
    then filters to AI-owned tasks only.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        task_stubs = await client.list_records("task", status="queued")
        tasks = []
        for stub in task_stubs:
            path = stub.get("path", "")
            if not path:
                continue
            # Read full record to get all frontmatter fields
            full = await client.read_record(path)
            # API returns {path, frontmatter: {...}, body: "..."}
            fm = full.get("frontmatter", {})
            if not fm:
                # Fallback: try parsing raw content
                content = full.get("content", "")
                if content:
                    fm = _parse_frontmatter(content)
            fm["path"] = path
            fm["body"] = full.get("body", "")
            owner = str(fm.get("owner", "")).lower().strip('"').strip("'")
            if owner in ("alfred", "ai", "learn-clerk"):
                tasks.append(fm)
        return tasks
    finally:
        await client.close()


def _reconstruct_markdown(record: dict[str, Any]) -> str:
    """Reconstruct raw markdown from API response.

    API returns {frontmatter: {...}, body: "..."} or {content: "..."}.
    """
    # Try raw content first
    content = record.get("content", "")
    if content and content.startswith("---"):
        return content

    # Reconstruct from frontmatter + body
    fm = record.get("frontmatter", {})
    body = record.get("body", "")
    if fm:
        import yaml
        fm_str = yaml.dump(fm, default_flow_style=False, allow_unicode=True).strip()
        return f"---\n{fm_str}\n---\n\n{body}"

    return body or content


def _parse_frontmatter(content: str) -> dict[str, Any]:
    """Parse YAML frontmatter from markdown content."""
    import yaml

    if not content.startswith("---"):
        return {}
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}
    try:
        return yaml.safe_load(parts[1]) or {}
    except Exception:
        return {}


def _extract_body(content: str) -> str:
    """Extract body text after frontmatter."""
    if not content.startswith("---"):
        return content
    parts = content.split("---", 2)
    if len(parts) >= 3:
        return parts[2].strip()
    return ""


@activity.defn
async def check_task_prerequisites(task: dict[str, Any]) -> bool:
    """Check if a task is ready to execute.

    Checks:
    - depends_on: all prerequisite tasks must be done
    - run_after: must be past the scheduled time
    - requires_approval: must have approved=true
    """
    # Check run_after
    run_after = task.get("run_after", "")
    if run_after:
        try:
            scheduled = datetime.fromisoformat(run_after)
            if datetime.now(timezone.utc) < scheduled:
                return False
        except (ValueError, TypeError):
            pass

    # Check requires_approval
    req_approval = task.get("requires_approval", False)
    if isinstance(req_approval, str):
        req_approval = req_approval.lower() not in ("false", "no", "0", "")
    if req_approval and not task.get("approved"):
        return False

    # Check depends_on
    depends_on = task.get("depends_on", [])
    if depends_on:
        config = load_config()
        client = VaultClient(config)
        try:
            for dep_path in depends_on:
                dep = await client.read_record(dep_path)
                if dep.get("status") != "done":
                    return False
        finally:
            await client.close()

    return True


@activity.defn
async def update_task_status(task: dict[str, Any], new_status: str) -> None:
    """Update a task's status field in the vault."""
    config = load_config()
    client = VaultClient(config)
    try:
        path = task.get("path", "")
        if not path:
            return

        existing = await client.read_record(path)
        raw = _reconstruct_markdown(existing)
        if not raw:
            return

        from src.activities.vault import _apply_frontmatter_updates
        updated = _apply_frontmatter_updates(raw, {"status": new_status})
        await client.write_record("task", path, updated)
    finally:
        await client.close()


@activity.defn
async def assemble_task_context(task: dict[str, Any]) -> str:
    """Assemble execution context for a task.

    Reads the skill file, initiative/project context, and recent
    related observations to build a comprehensive prompt for the AI.
    """
    config = load_config()
    client = VaultClient(config)
    try:
        parts: list[str] = []

        # 1. Task details
        title = task.get("title", task.get("name", "Untitled Task"))
        parts.append(f"# Task: {title}")
        parts.append("")
        body = task.get("body", "")
        if body:
            parts.append(body)
            parts.append("")

        # 2. Skill file (methodology)
        skill_entry = task.get("skill_entry", "")
        if skill_entry:
            try:
                skill = await client.read_record(skill_entry)
                skill_content = _reconstruct_markdown(skill)
                if skill_content:
                    parts.append("## Skill Methodology")
                    parts.append(skill_content)
                    parts.append("")
            except Exception:
                parts.append(f"## Skill: {skill_entry} (not found)")
                parts.append("")

        # 3. Initiative/project context
        initiative = task.get("initiative", "")
        if initiative:
            try:
                init_data = await client.read_record(initiative)
                init_content = _reconstruct_markdown(init_data)
                if init_content:
                    parts.append("## Initiative Context")
                    parts.append(init_content)
                    parts.append("")
            except Exception:
                pass

        # 4. Source event context
        source_event = task.get("source_event", "")
        if source_event:
            parts.append(f"## Source Event: {source_event}")
            parts.append("")

        return "\n".join(parts)
    finally:
        await client.close()


@activity.defn
async def execute_task(task: dict[str, Any], context: str) -> dict[str, Any]:
    """Execute a task via OpenClaw sessions_spawn.

    Spawns a subagent with the assembled context + task instructions.
    Polls sessions_history for the result.
    Returns the execution result including any artifacts.
    """
    config = load_config()
    token = config.gateway_token()
    base = config.openclaw_gateway_url
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    agent_id = task.get("agent_id", config.clerk_agent_id)
    tier = task.get("tier", 2)
    budget = task.get("budget_turns", 25)
    title = task.get("title", task.get("name", "Untitled"))

    prompt = f"""You are executing a task. Follow the skill methodology provided.

{context}

## Instructions
- Execute the task described above
- Follow the skill methodology step by step
- Use tools (read, pdf, exec, web_search) as needed
- Produce your output as a structured result

Your FINAL message must be a JSON object:
{{
  "status": "completed" or "blocked",
  "output": "The main result or artifact content (markdown)",
  "summary": "One sentence summary of what was done",
  "follow_up_tasks": [
    {{"title": "...", "owner": "alfred|human", "reason": "..."}}
  ],
  "blocked_reason": "Only if status is blocked"
}}

CRITICAL: Your final message must contain ONLY the JSON object above."""

    async with httpx.AsyncClient(timeout=30.0) as client:
        spawn_resp = await client.post(
            f"{base}/tools/invoke",
            headers=headers,
            json={
                "tool": "sessions_spawn",
                "args": {
                    "task": prompt,
                    "agentId": agent_id,
                    "mode": "run",
                    "cleanup": "keep",
                    "sandbox": "inherit",
                    "runTimeoutSeconds": 240,
                },
            },
        )
        spawn_resp.raise_for_status()
        spawn_data = spawn_resp.json()

        # Extract session key
        result = spawn_data.get("result", {})
        content_list = result.get("content", [])
        session_key = None
        for item in content_list:
            if isinstance(item, dict) and item.get("type") == "text":
                try:
                    inner = json.loads(item["text"])
                    session_key = inner.get("childSessionKey")
                except (json.JSONDecodeError, KeyError):
                    pass

        if not session_key:
            return {
                "status": "error",
                "summary": f"Failed to spawn subagent: {spawn_data}",
                "output": "",
                "follow_up_tasks": [],
            }

    # Poll for result
    async with httpx.AsyncClient(timeout=15.0) as client:
        for attempt in range(28):
            await asyncio.sleep(10)
            try:
                hist_resp = await client.post(
                    f"{base}/tools/invoke",
                    headers=headers,
                    json={
                        "tool": "sessions_history",
                        "args": {"sessionKey": session_key, "limit": 5},
                    },
                )
                if hist_resp.status_code != 200:
                    continue
                hist_data = hist_resp.json()
            except Exception:
                continue

            # Parse messages
            hist_result = hist_data.get("result", {})
            hist_content = hist_result.get("content", [])
            messages = []
            for item in hist_content:
                if isinstance(item, dict) and item.get("type") == "text":
                    try:
                        parsed = json.loads(item["text"])
                        messages = parsed.get("messages", [])
                    except (json.JSONDecodeError, TypeError):
                        pass

            for msg in messages:
                if msg.get("role") == "assistant":
                    msg_content = msg.get("content", "")
                    text = ""
                    if isinstance(msg_content, list):
                        for part in msg_content:
                            if isinstance(part, dict) and part.get("type") == "text":
                                text = part["text"]
                                break
                    elif isinstance(msg_content, str):
                        text = msg_content

                    if text:
                        return _extract_task_result(text, title)

    return {
        "status": "timeout",
        "summary": f"Task execution timed out after 280s: {title}",
        "output": "",
        "follow_up_tasks": [],
    }


@activity.defn
async def write_task_artifacts(task: dict[str, Any], result: dict[str, Any]) -> str:
    """Write task execution output as a vault artifact."""
    config = load_config()
    client = VaultClient(config)
    try:
        title = task.get("title", task.get("name", "Task Output"))
        output = result.get("output", "")
        summary = result.get("summary", "")

        from src.activities.vault import vault_record_path

        content = f"""---
type: note
name: "{title} — Output"
status: active
source_task: "{task.get('path', '')}"
tags: [task-output]
---

# {title} — Output

{summary}

{output}
"""
        name = vault_record_path("note", f"{title}-output")
        path = await client.write_record("note", name, content)
        return path
    finally:
        await client.close()


@activity.defn
async def complete_task(task: dict[str, Any], result: dict[str, Any]) -> None:
    """Mark a task as done and record the outcome."""
    config = load_config()
    client = VaultClient(config)
    try:
        path = task.get("path", "")
        if not path:
            return

        existing = await client.read_record(path)
        raw = _reconstruct_markdown(existing)
        if not raw:
            return

        from src.activities.vault import _apply_frontmatter_updates

        now = datetime.now(timezone.utc).isoformat()
        status = "done" if result.get("status") == "completed" else "blocked"
        updates = {
            "status": status,
            "completed_at": now,
        }
        if result.get("blocked_reason"):
            updates["blocked_by"] = result["blocked_reason"]

        updated = _apply_frontmatter_updates(raw, updates)

        # Append outcome to body
        summary = result.get("summary", "No summary")
        outcome = f"\n\n---\n**Outcome ({now[:10]}):** {summary}\n"
        updated += outcome

        await client.write_record("task", path, updated)
    finally:
        await client.close()


@activity.defn
async def propagate_task_completion(
    task: dict[str, Any], result: dict[str, Any]
) -> list[str]:
    """Create follow-up tasks from task execution results.

    Returns list of created task paths.
    """
    follow_ups = result.get("follow_up_tasks", [])
    if not follow_ups:
        return []

    config = load_config()
    client = VaultClient(config)
    created_paths: list[str] = []
    try:
        from src.activities.vault import vault_record_path, slugify

        now = datetime.now(timezone.utc)
        for fu in follow_ups:
            title = fu.get("title", "Follow-up")
            owner = fu.get("owner", "human")
            reason = fu.get("reason", "")

            content = f"""---
type: task
status: queued
title: "{title}"
owner: "{owner}"
tier: 2
source_task: "{task.get('path', '')}"
created: "{now.isoformat()}"
created_by: propagation
priority: medium
tags: [follow-up]
---

# {title}

{reason}

Created by propagation from: [[{task.get('path', '')}]]
"""
            name = vault_record_path("task", slugify(title), now)
            path = await client.write_record("task", name, content)
            created_paths.append(path)

        return created_paths
    finally:
        await client.close()


def _extract_task_result(text: str, task_title: str) -> dict[str, Any]:
    """Extract structured result from task execution output."""
    # Try direct JSON parse
    try:
        result = json.loads(text)
        if isinstance(result, dict) and "status" in result:
            return result
    except json.JSONDecodeError:
        pass

    # Try stripping markdown fences
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.split("\n")
        lines = lines[1:]  # remove opening fence
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        stripped = "\n".join(lines)
        try:
            result = json.loads(stripped)
            if isinstance(result, dict):
                return result
        except json.JSONDecodeError:
            pass

    # Try finding JSON in text
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            result = json.loads(text[start : end + 1])
            if isinstance(result, dict):
                return result
        except json.JSONDecodeError:
            pass

    # Fallback: treat the whole text as the output
    return {
        "status": "completed",
        "output": text,
        "summary": f"Completed: {task_title}",
        "follow_up_tasks": [],
    }
