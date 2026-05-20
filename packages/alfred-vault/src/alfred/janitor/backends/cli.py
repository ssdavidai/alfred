"""Claude Code backend — runs claude -p with vault access via alfred vault CLI."""

from __future__ import annotations

import asyncio
import os

from ..config import ClaudeBackendConfig
from ..utils import get_logger
from . import BackendResult, BaseBackend, build_sweep_prompt

log = get_logger(__name__)


class ClaudeBackend(BaseBackend):
    def __init__(self, config: ClaudeBackendConfig, env_overrides: dict[str, str] | None = None) -> None:
        self.config = config
        self.env_overrides = env_overrides or {}

    async def process(
        self,
        skill_text: str,
        issue_report: str,
        affected_records: str,
        vault_path: str,
    ) -> BackendResult:
        prompt = build_sweep_prompt(skill_text, issue_report, affected_records, vault_path)

        cmd = [self.config.command, *self.config.args]

        # Restrict to Bash-only (agent uses alfred vault commands)
        if self.config.allowed_tools:
            cmd.extend(["--allowedTools", ",".join(self.config.allowed_tools)])

        # Prompt via stdin to avoid ARG_MAX limits on large inputs
        cmd.append("-p")
        cmd.append("-")

        # Build environment with vault env vars
        env = {**os.environ, **self.env_overrides}

        log.info(
            "claude.dispatching",
            command=self.config.command,
            vault=vault_path,
            timeout=self.config.timeout,
        )

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
                timeout=self.config.timeout,
            )
        except asyncio.TimeoutError:
            log.error("claude.timeout", timeout=self.config.timeout)
            return BackendResult(success=False, summary="ERROR: timeout")
        except FileNotFoundError:
            log.error("claude.command_not_found", command=self.config.command)
            return BackendResult(
                success=False,
                summary=f"ERROR: command not found: {self.config.command}",
            )

        raw = stdout.decode("utf-8", errors="replace")
        err = stderr.decode("utf-8", errors="replace")

        if proc.returncode != 0:
            log.warning("claude.nonzero_exit", code=proc.returncode, stderr=err[:500])
            return BackendResult(
                success=False,
                summary=f"Exit code {proc.returncode}: {err[:500]}",
            )

        log.info("claude.completed", summary_length=len(raw))
        return BackendResult(success=True, summary=raw.strip())
