"""Configuration — env vars, defaults, vault paths."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Config:
    # Temporal
    temporal_host: str = field(default_factory=lambda: os.environ.get("TEMPORAL_HOST", "temporal:7233"))
    task_queue: str = field(default_factory=lambda: os.environ.get("TASK_QUEUE", "alfred-learn"))

    # OpenClaw gateway
    openclaw_gateway_url: str = field(default_factory=lambda: os.environ.get("OPENCLAW_GATEWAY_URL", "http://openclaw:18789"))
    openclaw_gateway_token_file: str = field(default_factory=lambda: os.environ.get("OPENCLAW_GATEWAY_TOKEN_FILE", "/alfred-data/.gateway-token"))

    # Vault (via alfred-ctrl API)
    vault_path: str = field(default_factory=lambda: os.environ.get("VAULT_PATH", "/vault"))
    alfred_ctrl_url: str = field(default_factory=lambda: os.environ.get("ALFRED_CTRL_URL", "http://host.docker.internal:3100"))

    # Alfred data directory (observation queue, streams JSONL, etc.)
    alfred_data_dir: str = field(default_factory=lambda: os.environ.get("ALFRED_DATA_DIR", "/alfred-data"))

    # Feature flags
    enabled: bool = field(default_factory=lambda: os.environ.get("ALFRED_LEARN_ENABLED", "true").lower() == "true")
    use_date_paths: bool = field(default_factory=lambda: os.environ.get("USE_DATE_PATHS", "true").lower() == "true")

    # Tenant timezone (IANA, e.g. "America/New_York") — used by daily schedules
    tenant_timezone: str = field(default_factory=lambda: os.environ.get("TENANT_TIMEZONE", "UTC"))

    # Clerk agent
    clerk_agent_id: str = field(default_factory=lambda: os.environ.get("CLERK_AGENT_ID", "learn-clerk"))
    clerk_model: str = field(default_factory=lambda: os.environ.get("CLERK_MODEL", "dgx-spark/qwen3.5:35b"))

    # Processing limits
    max_events_per_run: int = 20
    session_same_threshold_minutes: int = 30
    session_different_threshold_minutes: int = 120

    # Media ingestion stream ID
    MEDIA_STREAM_ID: str = "system-media-ingestion"

    # Vault directories
    @property
    def vault_observation_dir(self) -> str:
        return f"{self.vault_path}/observation"

    @property
    def vault_intuition_dir(self) -> str:
        return f"{self.vault_path}/intuition"

    @property
    def vault_instincts_dir(self) -> str:
        return f"{self.vault_path}/intuition/instincts"

    @property
    def vault_reflection_dir(self) -> str:
        return f"{self.vault_path}/reflection"

    @property
    def vault_inbox_dir(self) -> str:
        return f"{self.vault_path}/inbox"

    @property
    def vault_quarantine_dir(self) -> str:
        return f"{self.vault_path}/inbox/_quarantine"

    @property
    def session_state_path(self) -> str:
        return f"{self.alfred_data_dir}/session-state.json"

    @property
    def observation_queue_path(self) -> str:
        return f"{self.alfred_data_dir}/observation-queue.jsonl"

    @property
    def streams_dir(self) -> str:
        return f"{self.alfred_data_dir}/streams"

    def gateway_token(self) -> str:
        try:
            with open(self.openclaw_gateway_token_file) as f:
                return f.read().strip()
        except FileNotFoundError:
            return ""


def load_config() -> Config:
    return Config()
