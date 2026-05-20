"""Zo Computer HTTP backend — sends prompt to Zo's API."""

from __future__ import annotations

import json
from typing import Any

import httpx

from ..config import ZoBackendConfig
from ..utils import get_logger
from . import BackendResult, BaseBackend, build_sweep_prompt

log = get_logger(__name__)


def _navigate_path(data: Any, path: str) -> str:
    """Navigate a dot-separated path into a nested dict/list."""
    for key in path.split("."):
        if isinstance(data, dict):
            data = data.get(key, "")
        elif isinstance(data, list) and key.isdigit():
            data = data[int(key)]
        else:
            return str(data)
    return str(data)


def _build_request_body(template: dict[str, Any], prompt: str) -> dict[str, Any]:
    """Replace {prompt} placeholders in the request body template."""
    def _replace(value: Any) -> Any:
        if isinstance(value, str):
            return value.replace("{prompt}", prompt)
        if isinstance(value, dict):
            return {k: _replace(v) for k, v in value.items()}
        if isinstance(value, list):
            return [_replace(v) for v in value]
        return value
    return _replace(template)


class ZoBackend(BaseBackend):
    def __init__(self, config: ZoBackendConfig) -> None:
        self.config = config

    async def process(
        self,
        skill_text: str,
        issue_report: str,
        affected_records: str,
        vault_path: str,
    ) -> BackendResult:
        prompt = build_sweep_prompt(skill_text, issue_report, affected_records, vault_path)
        body = _build_request_body(self.config.request_body_template, prompt)

        log.info("zo.dispatching", url=self.config.url, method=self.config.method)

        async with httpx.AsyncClient(timeout=self.config.timeout) as client:
            try:
                resp = await client.request(
                    method=self.config.method,
                    url=self.config.url,
                    headers=self.config.headers,
                    json=body,
                )
                resp.raise_for_status()
            except httpx.HTTPError as e:
                log.error("zo.request_failed", error=str(e))
                return BackendResult(success=False, summary=f"ERROR: {e}")

        try:
            response_data = resp.json()
        except json.JSONDecodeError:
            response_data = resp.text

        raw = _navigate_path(response_data, self.config.response_content_path)
        log.info("zo.completed", summary_length=len(raw))

        return BackendResult(success=True, summary=raw.strip())
