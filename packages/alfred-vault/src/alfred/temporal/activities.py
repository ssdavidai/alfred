"""Temporal activities that use Alfred's pluggable backend system."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from temporalio import activity

from .config import AgentProfile, TemporalRuntime


@dataclass
class SpawnResult:
    success: bool = False
    output: str = ""


@dataclass
class ScriptResult:
    success: bool = False
    output: str = ""
    exit_code: int = -1


class AlfredActivities:
    """Shared-state activity class — instantiated once, bound to the worker."""

    def __init__(self, runtime: TemporalRuntime) -> None:
        self.runtime = runtime

    def _resolve_profile(self, agent: str) -> AgentProfile:
        return self.runtime.temporal.agents.get(agent, AgentProfile())

    def _resolve_backend(self, profile: AgentProfile) -> str:
        return profile.backend or self.runtime.agent_backend

    def _load_skill_text(self, skill_name: str) -> str:
        skill_dir = self.runtime.skills_dir / skill_name
        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            return ""
        text = skill_file.read_text(encoding="utf-8")
        # Inline {{file}} references
        for ref_file in skill_dir.iterdir():
            if ref_file.name == "SKILL.md":
                continue
            placeholder = "{{" + ref_file.name + "}}"
            if placeholder in text:
                text = text.replace(placeholder, ref_file.read_text(encoding="utf-8"))
        return text

    def _build_env(self, profile: AgentProfile) -> dict[str, str]:
        from alfred.vault.mutation_log import create_session_file
        env = {**os.environ, "ALFRED_VAULT_PATH": self.runtime.vault_path}
        if profile.scope:
            env["ALFRED_VAULT_SCOPE"] = profile.scope
        env["ALFRED_VAULT_SESSION"] = create_session_file()
        return env

    @activity.defn
    async def spawn_agent(self, task: str, agent: str = "worker", timeout: int = 300) -> SpawnResult:
        """Invoke an Alfred agent backend with a task prompt."""
        profile = self._resolve_profile(agent)
        backend_name = self._resolve_backend(profile)
        effective_timeout = timeout or profile.timeout

        # Prepend skill text if configured
        full_task = task
        if profile.skill:
            skill_text = self._load_skill_text(profile.skill)
            if skill_text:
                full_task = f"{skill_text}\n\n---\n\n{task}"

        if backend_name == "claude":
            return await self._run_claude(full_task, profile, effective_timeout)
        elif backend_name == "zo":
            return await self._run_zo(full_task, effective_timeout)
        elif backend_name == "openclaw":
            return await self._run_openclaw(full_task, profile, effective_timeout)
        else:
            return SpawnResult(success=False, output=f"Unknown backend: {backend_name}")

    async def _run_claude(self, prompt: str, profile: AgentProfile, timeout: int) -> SpawnResult:
        rt = self.runtime
        cmd = [rt.agent_claude_command, *rt.agent_claude_args]
        if rt.agent_claude_allowed_tools:
            cmd.extend(["--allowedTools", ",".join(rt.agent_claude_allowed_tools)])
        cmd.extend(["-p", "-"])
        env = self._build_env(profile)
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=prompt.encode("utf-8")),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            return SpawnResult(success=False, output="ERROR: timeout")
        except FileNotFoundError:
            return SpawnResult(success=False, output=f"ERROR: command not found: {rt.agent_claude_command}")
        raw = stdout.decode("utf-8", errors="replace")
        if proc.returncode != 0:
            err = stderr.decode("utf-8", errors="replace")
            return SpawnResult(success=False, output=f"Exit code {proc.returncode}: {err[:500]}")
        return SpawnResult(success=True, output=raw.strip())

    async def _run_zo(self, prompt: str, timeout: int) -> SpawnResult:
        import httpx
        rt = self.runtime
        body = self._build_zo_body(rt.agent_zo_request_body_template, prompt)
        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                resp = await client.request(
                    method=rt.agent_zo_method,
                    url=rt.agent_zo_url,
                    headers=rt.agent_zo_headers,
                    json=body,
                )
                resp.raise_for_status()
            except httpx.HTTPError as e:
                return SpawnResult(success=False, output=f"ERROR: {e}")
        try:
            data = resp.json()
        except json.JSONDecodeError:
            data = resp.text
        raw = self._navigate_path(data, rt.agent_zo_response_content_path)
        return SpawnResult(success=True, output=raw.strip())

    async def _run_openclaw(self, prompt: str, profile: AgentProfile, timeout: int) -> SpawnResult:
        import uuid
        rt = self.runtime
        agent_id = profile.agent_id or rt.agent_openclaw_agent_id
        session_id = f"temporal-{uuid.uuid4().hex[:12]}"
        cmd = [rt.agent_openclaw_command, "agent", *rt.agent_openclaw_args,
               "--agent", agent_id, "--session-id", session_id,
               "--message", prompt, "--local", "--json"]
        self._clear_openclaw_sessions(agent_id)
        env = self._build_env(profile)
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            return SpawnResult(success=False, output="ERROR: timeout")
        except FileNotFoundError:
            return SpawnResult(success=False, output=f"ERROR: command not found: {rt.agent_openclaw_command}")
        raw = stdout.decode("utf-8", errors="replace")
        if proc.returncode != 0:
            err = stderr.decode("utf-8", errors="replace")
            return SpawnResult(success=False, output=f"Exit code {proc.returncode}: {err[:500]}")
        return SpawnResult(success=True, output=raw.strip())

    @staticmethod
    def _clear_openclaw_sessions(agent_id: str) -> None:
        sessions_dir = Path.home() / ".openclaw" / "agents" / agent_id / "sessions"
        if not sessions_dir.exists():
            return
        for f in sessions_dir.iterdir():
            try:
                f.unlink(missing_ok=True)
            except Exception:
                pass

    @staticmethod
    def _build_zo_body(template: dict[str, Any], prompt: str) -> dict[str, Any]:
        def _replace(value: Any) -> Any:
            if isinstance(value, str):
                return value.replace("{prompt}", prompt)
            if isinstance(value, dict):
                return {k: _replace(v) for k, v in value.items()}
            if isinstance(value, list):
                return [_replace(v) for v in value]
            return value
        return _replace(template)

    @staticmethod
    def _navigate_path(data: Any, path: str) -> str:
        for key in path.split("."):
            if isinstance(data, dict):
                data = data.get(key, "")
            elif isinstance(data, list) and key.isdigit():
                data = data[int(key)]
            else:
                return str(data)
        return str(data)

    @activity.defn
    async def run_script(self, command: str, timeout: int = 120) -> ScriptResult:
        """Run a shell command and return stdout + exit code."""
        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=self.runtime.vault_path,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            return ScriptResult(success=False, output="ERROR: timeout", exit_code=-1)
        raw = stdout.decode("utf-8", errors="replace")
        return ScriptResult(
            success=proc.returncode == 0,
            output=raw.strip(),
            exit_code=proc.returncode or 0,
        )

    @activity.defn
    async def notify_slack(self, message: str, channel: str = "") -> bool:
        """No-op Slack notification — just logs the message."""
        activity.logger.info("[slack] %s", message)
        return True

    @activity.defn
    async def ping_uptime(self, key: str) -> bool:
        """Ping an uptime/healthcheck endpoint."""
        import httpx
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(key)
                return resp.status_code < 400
        except Exception:
            return False

    @activity.defn
    async def check_day_of_week(self) -> int:
        """Return current day of week (0=Monday, 6=Sunday)."""
        return datetime.now(timezone.utc).weekday()

    @activity.defn
    async def harvest_openclaw_sessions(self) -> dict:
        """Scan OpenClaw main agent sessions and push new messages to inbox."""
        vault_path = Path(self.runtime.vault_path)
        inbox_dir = vault_path / "inbox"
        inbox_dir.mkdir(parents=True, exist_ok=True)

        state_path = Path(self.runtime.log_dir) / "streams" / "openclaw_sessions_state.json"
        state = json.loads(state_path.read_text("utf-8")) if state_path.exists() else {}
        sessions_state: dict[str, Any] = state.get("sessions", {})

        sessions_dir = Path.home() / ".openclaw" / "agents" / "main" / "sessions"
        if not sessions_dir.exists():
            activity.logger.info("No OpenClaw main sessions directory found")
            return {"sessions_scanned": 0, "new_batches": 0, "messages_harvested": 0}

        scanned = 0
        batches = 0
        harvested = 0

        for session_file in sorted(sessions_dir.glob("*.jsonl")):
            if ".deleted." in session_file.name:
                continue
            scanned += 1
            file_key = str(session_file)
            prev = sessions_state.get(file_key, {})
            processed_lines = prev.get("processed_lines", 0)

            try:
                all_lines = session_file.read_text("utf-8").splitlines()
            except OSError:
                continue

            if len(all_lines) <= processed_lines:
                continue

            new_lines = all_lines[processed_lines:]
            messages: list[dict[str, Any]] = []
            for line in new_lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") != "message":
                    continue
                role = entry.get("role", "")
                if role not in ("user", "assistant"):
                    continue
                # Extract text content only
                content = entry.get("content", "")
                if isinstance(content, list):
                    text_parts = []
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text_parts.append(block.get("text", ""))
                        elif isinstance(block, str):
                            text_parts.append(block)
                    content = "\n".join(text_parts)
                if not content:
                    continue
                messages.append({"role": role, "content": content})

            if not messages:
                sessions_state[file_key] = {
                    "processed_lines": len(all_lines),
                    "session_id": session_file.stem,
                    "last_harvested": datetime.now(timezone.utc).isoformat(),
                }
                continue

            # Build markdown transcript
            session_id = session_file.stem
            first_user_msg = next((m["content"][:60] for m in messages if m["role"] == "user"), "chat")
            batch_ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")

            lines_out = []
            for msg in messages:
                label = "User" if msg["role"] == "user" else "Assistant"
                lines_out.append(f"**{label}:**\n{msg['content']}\n")

            frontmatter = (
                f"---\n"
                f"title: 'OpenClaw Chat — {first_user_msg}'\n"
                f"source: openclaw\n"
                f"session_id: {session_id}\n"
                f"agent_id: main\n"
                f"harvested_at: {datetime.now(timezone.utc).isoformat()}\n"
                f"message_count: {len(messages)}\n"
                f"---\n\n"
            )
            body = "\n---\n\n".join(lines_out)
            inbox_file = inbox_dir / f"openclaw-chat-{session_id}-{batch_ts}.md"
            inbox_file.write_text(frontmatter + body, encoding="utf-8")

            harvested += len(messages)
            batches += 1
            sessions_state[file_key] = {
                "processed_lines": len(all_lines),
                "session_id": session_id,
                "last_harvested": datetime.now(timezone.utc).isoformat(),
            }
            activity.logger.info(
                "Harvested %d messages from session %s", len(messages), session_id
            )

        # Save state
        state["sessions"] = sessions_state
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")

        return {"sessions_scanned": scanned, "new_batches": batches, "messages_harvested": harvested}

    @activity.defn
    async def load_json_state(self, path: str) -> dict:
        """Load a JSON file and return its contents as a dict."""
        p = Path(path)
        if not p.exists():
            return {}
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}

    @activity.defn
    async def save_json_state(self, path: str, data: dict) -> bool:
        """Save a dict to a JSON file."""
        try:
            p = Path(path)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(data, indent=2), encoding="utf-8")
            return True
        except OSError:
            return False
