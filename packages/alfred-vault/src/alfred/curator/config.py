"""Load config.yaml into typed dataclasses with env-var substitution."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

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
class VaultConfig:
    path: str = ""
    inbox_dir: str = "inbox"
    processed_dir: str = "inbox/processed"
    ignore_dirs: list[str] = field(default_factory=lambda: [".obsidian"])

    @property
    def vault_path(self) -> Path:
        return Path(self.path)

    @property
    def inbox_path(self) -> Path:
        return self.vault_path / self.inbox_dir

    @property
    def processed_path(self) -> Path:
        return self.vault_path / self.processed_dir


@dataclass
class ClaudeBackendConfig:
    command: str = "claude"
    args: list[str] = field(default_factory=lambda: ["-p"])
    timeout: int = 300
    allowed_tools: list[str] = field(default_factory=lambda: ["Bash"])


@dataclass
class ZoBackendConfig:
    url: str = ""
    method: str = "POST"
    headers: dict[str, str] = field(default_factory=dict)
    request_body_template: dict[str, Any] = field(default_factory=dict)
    response_content_path: str = "response.content"
    timeout: int = 300


@dataclass
class OpenClawBackendConfig:
    command: str = "openclaw"
    args: list[str] = field(default_factory=list)
    workspace_mount: str = ""
    timeout: int = 300
    agent_id: str = "vault-curator"


@dataclass
class HermesBackendConfig:
    url: str = ""  # Default: http://hermes-bg:8787 (set via HERMES_BG_URL env)
    timeout: int = 300


@dataclass
class AgentConfig:
    backend: str = "claude"
    claude: ClaudeBackendConfig = field(default_factory=ClaudeBackendConfig)
    zo: ZoBackendConfig = field(default_factory=ZoBackendConfig)
    openclaw: OpenClawBackendConfig = field(default_factory=OpenClawBackendConfig)
    hermes: HermesBackendConfig = field(default_factory=HermesBackendConfig)


@dataclass
class WatcherConfig:
    poll_interval: int = 5
    debounce_seconds: int = 10
    rescan_interval: int = 60
    max_concurrent: int = 4  # number of inbox files to process in parallel


@dataclass
class StateConfig:
    path: str = "./data/state.json"


@dataclass
class LoggingConfig:
    level: str = "INFO"
    file: str = "./data/curator.log"


@dataclass
class CuratorConfig:
    vault: VaultConfig = field(default_factory=VaultConfig)
    agent: AgentConfig = field(default_factory=AgentConfig)
    watcher: WatcherConfig = field(default_factory=WatcherConfig)
    state: StateConfig = field(default_factory=StateConfig)
    logging: LoggingConfig = field(default_factory=LoggingConfig)
    # Skip Stage 4 entity enrichment to reduce token consumption.
    # Entities keep their stub content from Stage 2 (includes description
    # from the manifest). Re-enable by setting to False if richer entity
    # bodies are needed. Ref: ssdavidai/alfred#14
    skip_entity_enrichment: bool = True


# --- Recursive builder ---

_DATACLASS_MAP: dict[str, type] = {
    "vault": VaultConfig,
    "agent": AgentConfig,
    "claude": ClaudeBackendConfig,
    "zo": ZoBackendConfig,
    "openclaw": OpenClawBackendConfig,
    "hermes": HermesBackendConfig,
    "watcher": WatcherConfig,
    "state": StateConfig,
    "logging": LoggingConfig,
}


def _build(cls: type, data: dict[str, Any]) -> Any:
    """Recursively construct a dataclass from a dict."""
    kwargs: dict[str, Any] = {}
    for key, value in data.items():
        if key in _DATACLASS_MAP and isinstance(value, dict):
            kwargs[key] = _build(_DATACLASS_MAP[key], value)
        else:
            kwargs[key] = value
    return cls(**kwargs)


def load_config(path: str | Path = "config.yaml") -> CuratorConfig:
    """Load and parse config.yaml into CuratorConfig."""
    config_path = Path(path)
    with open(config_path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)
    raw = _substitute_env(raw or {})
    return _build(CuratorConfig, raw)


def load_from_unified(raw: dict[str, Any]) -> CuratorConfig:
    """Build CuratorConfig from a pre-loaded unified config dict."""
    raw = _substitute_env(raw)
    tool = raw.get("curator", {})
    vault_raw = dict(raw.get("vault", {}))
    vault_raw["inbox_dir"] = tool.get("inbox_dir", "inbox")
    vault_raw["processed_dir"] = tool.get("processed_dir", "inbox/processed")
    # Strip keys that don't exist in our VaultConfig
    vault_raw.pop("ignore_files", None)
    # Map unified logging.dir -> logging.file
    log_raw = dict(raw.get("logging", {}))
    log_dir = log_raw.pop("dir", "./data")
    if "file" not in log_raw:
        log_raw["file"] = f"{log_dir}/curator.log"
    return _build(CuratorConfig, {
        "vault": vault_raw,
        "agent": raw.get("agent", {}),
        "watcher": tool.get("watcher", {}),
        "state": tool.get("state", {}),
        "logging": log_raw,
    })
