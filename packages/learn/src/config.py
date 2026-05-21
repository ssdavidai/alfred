"""Configuration — env vars, defaults, vault paths."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Config:
    # Temporal
    temporal_host: str = field(default_factory=lambda: os.environ.get("TEMPORAL_HOST", "temporal:7233"))
    task_queue: str = field(default_factory=lambda: os.environ.get("TASK_QUEUE", "alfred-learn"))

    # Gateways. alfred-black runs ONE Hermes container exposing two
    # profiles, each binding its OpenAI-compatible /v1 API directly on its
    # canonical port (the hermes-shim compat layer was retired in issue #40):
    #
    # * ``openclaw_gateway_url`` → the MAIN profile on :18789. Hosts the
    #   Sir-facing chat, Slack DMs, Plane @alfred mentions.
    # * ``openclaw_workers_gateway_url`` → the WORKERS profile on :18790.
    #   Hosts ``learn-clerk`` + ephemeral execution subagents spawned by
    #   TaskRunner.
    #
    # Both URLs point at the single ``hermes`` service — the profile is
    # selected by port (18789 = main, 18790 = workers). The variable NAMES
    # are deliberately unchanged (Temporal determinism); only the default
    # values moved from the two openclaw containers to the hermes service.
    #
    # Keep these straight: any activity spawning a user-facing Alfred
    # session (notify EOD, Plane triggers, email channel, voice) must use
    # ``openclaw_gateway_url``. Any activity spawning a background
    # clerk/subagent (classification, reflection, task execution) must use
    # ``openclaw_workers_gateway_url``.
    openclaw_gateway_url: str = field(default_factory=lambda: os.environ.get("OPENCLAW_GATEWAY_URL", "http://hermes:18789"))
    openclaw_workers_gateway_url: str = field(default_factory=lambda: os.environ.get("OPENCLAW_WORKERS_GATEWAY_URL", "http://hermes:18790"))
    # ``heavy_gateway_url`` → the HEAVY profile on :18791. Hosts the
    # high-reasoning Opus agent used by the onboarding/chore pipeline
    # (#118). The model lives in the Hermes profile config, not here — the
    # body of a ``/v1/responses`` call deliberately omits ``model``.
    heavy_gateway_url: str = field(default_factory=lambda: os.environ.get("HERMES_HEAVY_GATEWAY_URL", "http://hermes:18791"))
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

    # Clerk agent (model comes from OpenClaw agent config, not env)
    clerk_agent_id: str = field(default_factory=lambda: os.environ.get("CLERK_AGENT_ID", "learn-clerk"))

    # Execution gateway — the workers-profile Hermes /v1 API, used by
    # TaskRunner for ephemeral subagent spawning (#378). Same endpoint as
    # ``openclaw_workers_gateway_url``; the variable name is kept stable.
    execution_gateway_url: str = field(default_factory=lambda: os.environ.get("EXECUTION_GATEWAY_URL", "http://hermes:18790"))
    workers_openclaw_config_path: str = field(default_factory=lambda: os.environ.get("WORKERS_OPENCLAW_CONFIG", "/hermes-state/workers/config.yaml"))

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
