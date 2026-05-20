"""Hermes backend — invokes Hermes Agent via HTTP for vault operations.

Instead of spawning an OpenClaw CLI subprocess, this backend sends the
prompt to the Background Hermes agent via an HTTP endpoint. The Hermes
agent has persistent sessions that accumulate skills over time.

Requires: HERMES_BG_URL env var (default: http://hermes-bg:8787)
"""

from __future__ import annotations

import json as _json
import os
from typing import Any

import httpx

from ..config import HermesBackendConfig
from ..utils import get_logger
from . import BackendResult, BaseBackend, build_prompt

log = get_logger(__name__)

# Default URL for the background Hermes agent
DEFAULT_HERMES_URL = "http://hermes-bg:8787"


class HermesBackend(BaseBackend):
    """Send prompts to Background Hermes for processing."""

    def __init__(self, config: HermesBackendConfig, vault_path: str, scope: str):
        self.config = config
        self.vault_path = vault_path
        self.scope = scope
        self.base_url = config.url or os.environ.get("HERMES_BG_URL", DEFAULT_HERMES_URL)
        self.timeout = config.timeout

    async def dispatch(self, prompt: str, context: str = "") -> BackendResult:
        """Send a prompt to the Hermes agent and return the result."""
        full_prompt = build_prompt(prompt, context, self.vault_path, self.scope)

        log.info(
            "hermes.dispatch",
            url=self.base_url,
            prompt_len=len(full_prompt),
            scope=self.scope,
        )

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                # Start a chat session with the background Hermes
                start_resp = await client.post(
                    f"{self.base_url}/api/chat/start",
                    json={
                        "message": full_prompt,
                        "session_id": f"vault-{self.scope}",
                    },
                )
                start_resp.raise_for_status()
                start_data = start_resp.json()
                stream_id = start_data.get("stream_id")

                if not stream_id:
                    return BackendResult(
                        success=False,
                        summary=f"Hermes returned no stream_id: {start_data}",
                    )

                # Poll for the response (SSE stream as HTTP)
                # The hermes-webui API returns SSE events; we collect them
                response_text = ""
                async with client.stream(
                    "GET",
                    f"{self.base_url}/api/chat/stream",
                    params={"stream_id": stream_id},
                    timeout=self.timeout,
                ) as stream:
                    async for line in stream.aiter_lines():
                        if line.startswith("data: "):
                            data_str = line[6:]
                            try:
                                data = _json.loads(data_str)
                                if "token" in data:
                                    response_text += data["token"]
                                elif "text" in data:
                                    response_text += data["text"]
                            except _json.JSONDecodeError:
                                pass
                        elif line.startswith("event: done"):
                            break

                log.info(
                    "hermes.response",
                    response_len=len(response_text),
                    scope=self.scope,
                )

                return BackendResult(
                    success=True,
                    summary=response_text[:200] if response_text else "No response",
                    files_changed=[],  # Hermes handles vault writes via alfred vault CLI
                )

        except httpx.TimeoutException:
            log.error("hermes.timeout", timeout=self.timeout, scope=self.scope)
            return BackendResult(
                success=False,
                summary=f"Hermes timed out after {self.timeout}s",
            )
        except Exception as e:
            log.error("hermes.error", error=str(e), scope=self.scope)
            return BackendResult(
                success=False,
                summary=f"Hermes error: {e}",
            )
