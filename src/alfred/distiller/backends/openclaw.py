"""OpenClaw backend — invokes OpenClaw CLI with workspace access to the vault."""

from __future__ import annotations

import asyncio
import os
import shutil
import time
import uuid
from pathlib import Path

from ..config import OpenClawBackendConfig
from ..utils import get_logger
from . import BackendResult, BaseBackend

log = get_logger(__name__)


def _clear_agent_sessions(agent_id: str) -> None:
    """Archive existing session files for an agent to avoid lock contention.

    We *archive* rather than delete because the per-call token-usage records
    written into these session jsonls (input/output/cacheRead/cacheWrite/cost)
    are the only audit trail for these stateless one-shot agents — wiping them
    eliminates fleet-wide cost observability. Files are moved into
    ``<sessions_dir>/_archive/<run-stamp>/`` instead of unlinked. Operators can
    prune ``_archive/`` manually for now; a future change can add a retention
    policy.
    """
    sessions_dir = Path.home() / ".openclaw" / "agents" / agent_id / "sessions"
    if not sessions_dir.exists():
        return
    run_stamp = f"{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"
    archive_root = sessions_dir / "_archive" / run_stamp
    for f in sessions_dir.iterdir():
        # Don't recurse into the archive directory itself.
        if f.name == "_archive":
            continue
        try:
            archive_root.mkdir(parents=True, exist_ok=True)
            shutil.move(str(f), str(archive_root / f.name))
        except Exception:
            # Match prior contract: a failed move must never block a new run.
            pass


def _sync_workspace_claude_md(agent_id: str, vault_path: str) -> None:
    """Copy the vault's CLAUDE.md into the agent's workspace."""
    workspace = Path.home() / ".openclaw" / "agents" / agent_id / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    src = Path(vault_path) / "CLAUDE.md"
    dst = workspace / "CLAUDE.md"
    if src.exists():
        shutil.copy2(src, dst)


class OpenClawBackend(BaseBackend):
    def __init__(self, config: OpenClawBackendConfig, env_overrides: dict[str, str] | None = None) -> None:
        self.config = config
        self.env_overrides = env_overrides or {}

    async def process(
        self,
        prompt: str,
        vault_path: str,
    ) -> BackendResult:
        session_id = f"distiller-{uuid.uuid4().hex[:12]}"

        cmd = [self.config.command, "agent", *self.config.args,
               "--agent", self.config.agent_id,
               "--session-id", session_id,
               "--message", prompt, "--local", "--json"]

        log.info(
            "openclaw.dispatching",
            command=self.config.command,
            agent_id=self.config.agent_id,
            session_id=session_id,
            timeout=self.config.timeout,
        )

        _clear_agent_sessions(self.config.agent_id)
        _sync_workspace_claude_md(self.config.agent_id, vault_path)

        try:
            env = {**os.environ, **self.env_overrides}
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(),
                timeout=self.config.timeout,
            )
        except asyncio.TimeoutError:
            log.error("openclaw.timeout", timeout=self.config.timeout)
            return BackendResult(success=False, summary="ERROR: timeout")
        except FileNotFoundError:
            log.error("openclaw.command_not_found", command=self.config.command)
            return BackendResult(
                success=False,
                summary=f"ERROR: command not found: {self.config.command}",
            )

        raw = stdout.decode("utf-8", errors="replace")
        err = stderr.decode("utf-8", errors="replace")

        if proc.returncode != 0:
            log.warning(
                "openclaw.nonzero_exit", code=proc.returncode, stderr=err[:500]
            )
            return BackendResult(
                success=False,
                summary=f"Exit code {proc.returncode}: {err[:500]}",
            )

        log.info("openclaw.completed", summary_length=len(raw))
        return BackendResult(success=True, summary=raw.strip())
