"""Load temporal config from unified config.yaml into typed dataclasses."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ENV_RE = re.compile(r"\$\{(\w+)\}")


def _substitute_env(value: Any) -> Any:
    """Recursively replace ${VAR} placeholders with environment variables."""
    if isinstance(value, str):
        def _replace(m: re.Match) -> str:
            return os.environ.get(m.group(1), m.group(0))
        return ENV_RE.sub(_replace, value)
    if isinstance(value, dict):
        return {k: _substitute_env(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_substitute_env(v) for v in value]
    return value


# --- Dataclasses ---

@dataclass
class AgentProfile:
    """Per-agent overrides for backend, skill, scope, and timeout."""
    backend: str | None = None
    skill: str | None = None
    scope: str | None = None
    timeout: int = 300
    agent_id: str | None = None


@dataclass
class TemporalConfig:
    address: str = "127.0.0.1:7233"
    namespace: str = "default"
    task_queue: str = "alfred-workflows"
    workflow_dirs: list[str] = field(default_factory=list)
    agents: dict[str, AgentProfile] = field(default_factory=lambda: {"worker": AgentProfile()})


@dataclass
class TemporalRuntime:
    temporal: TemporalConfig
    agent_backend: str
    agent_claude_command: str
    agent_claude_args: list[str]
    agent_claude_timeout: int
    agent_claude_allowed_tools: list[str]
    agent_zo_url: str
    agent_zo_method: str
    agent_zo_headers: dict[str, str]
    agent_zo_request_body_template: dict[str, Any]
    agent_zo_response_content_path: str
    agent_zo_timeout: int
    agent_openclaw_command: str
    agent_openclaw_args: list[str]
    agent_openclaw_workspace_mount: str
    agent_openclaw_timeout: int
    agent_openclaw_agent_id: str
    vault_path: str
    skills_dir: Path
    log_dir: str


# --- Builder ---

def _build_agent_profiles(raw: dict[str, Any]) -> dict[str, AgentProfile]:
    """Build agent profiles from raw config dict."""
    profiles: dict[str, AgentProfile] = {}
    for name, data in raw.items():
        if isinstance(data, dict):
            profiles[name] = AgentProfile(**{k: v for k, v in data.items() if k in AgentProfile.__dataclass_fields__})
        else:
            profiles[name] = AgentProfile()
    if "worker" not in profiles:
        profiles["worker"] = AgentProfile()
    return profiles


def _build_temporal_config(raw: dict[str, Any]) -> TemporalConfig:
    """Build TemporalConfig from the temporal section of config."""
    agents_raw = raw.pop("agents", {})
    agents = _build_agent_profiles(agents_raw) if agents_raw else {"worker": AgentProfile()}
    simple = {k: v for k, v in raw.items() if k in TemporalConfig.__dataclass_fields__ and k != "agents"}
    return TemporalConfig(agents=agents, **simple)


def load_from_unified(raw: dict[str, Any], skills_dir: Path) -> TemporalRuntime:
    """Build TemporalRuntime from a pre-loaded unified config dict."""
    raw = _substitute_env(raw)

    temporal_raw = dict(raw.get("temporal", {}))
    temporal_cfg = _build_temporal_config(temporal_raw)

    agent_raw = raw.get("agent", {})
    vault_raw = raw.get("vault", {})
    log_raw = raw.get("logging", {})

    claude_raw = agent_raw.get("claude", {})
    zo_raw = agent_raw.get("zo", {})
    oc_raw = agent_raw.get("openclaw", {})

    return TemporalRuntime(
        temporal=temporal_cfg,
        agent_backend=agent_raw.get("backend", "claude"),
        agent_claude_command=claude_raw.get("command", "claude"),
        agent_claude_args=claude_raw.get("args", ["-p"]),
        agent_claude_timeout=claude_raw.get("timeout", 600),
        agent_claude_allowed_tools=claude_raw.get("allowed_tools", ["Bash"]),
        agent_zo_url=zo_raw.get("url", ""),
        agent_zo_method=zo_raw.get("method", "POST"),
        agent_zo_headers=zo_raw.get("headers", {}),
        agent_zo_request_body_template=zo_raw.get("request_body_template", {}),
        agent_zo_response_content_path=zo_raw.get("response_content_path", "response.content"),
        agent_zo_timeout=zo_raw.get("timeout", 600),
        agent_openclaw_command=oc_raw.get("command", "openclaw"),
        agent_openclaw_args=oc_raw.get("args", []),
        agent_openclaw_workspace_mount=oc_raw.get("workspace_mount", ""),
        agent_openclaw_timeout=oc_raw.get("timeout", 600),
        agent_openclaw_agent_id=oc_raw.get("agent_id", "vault-worker"),
        vault_path=str(Path(vault_raw.get("path", "./vault")).resolve()),
        skills_dir=skills_dir,
        log_dir=log_raw.get("dir", "./data"),
    )
