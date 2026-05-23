"""``_call_llm`` learns the OpenAI Responses API's structured-output knobs.

Live failure (Lane II / harden): ``extract_facts_opus`` posted Hermes
``/v1/responses`` with ``{"input": prompt, "max_output_tokens": N}`` and
nothing else. Heavy Hermes injects ~33k tokens of Alfred persona + 6
MCP tool defs on every call, and gpt-5.5 (the heavy-profile model)
returned 62 chars of non-JSON — silent 0 facts.

The fix is model-agnostic: thread the Responses API's ``text.format``
and ``instructions`` through ``_call_llm`` so every Opus stage can ask
for **a JSON object** AND **override the persona for the call**. These
tests pin the request shape.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from src.activities import onboarding_v3 as ob_mod


def _fake_post_capturing(captured: dict):
    """httpx-style AsyncClient ctx mgr that records the .post JSON body."""
    async def _post(url, headers=None, json=None):  # noqa: A002
        captured["url"] = url
        captured["json"] = json
        resp = MagicMock()
        resp.status_code = 200
        resp.json = MagicMock(return_value={"output": ""})
        resp.raise_for_status = MagicMock()
        resp.text = ""
        return resp

    client = MagicMock()
    client.post = AsyncMock(side_effect=_post)
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=client)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


def test_call_llm_threads_response_format_into_text_field() -> None:
    """``response_format={"type":"json_object"}`` lands under ``text.format``."""
    captured: dict = {}
    with patch("src.activities.onboarding_v3.httpx.AsyncClient",
               return_value=_fake_post_capturing(captured)):
        asyncio.run(ob_mod._call_llm(
            "hello", max_tokens=4096,
            response_format={"type": "json_object"},
        ))
    body = captured.get("json") or {}
    assert (body.get("text") or {}).get("format") == {"type": "json_object"}


def test_call_llm_threads_instructions_field() -> None:
    """``instructions="..."`` is a top-level field — persona override."""
    captured: dict = {}
    with patch("src.activities.onboarding_v3.httpx.AsyncClient",
               return_value=_fake_post_capturing(captured)):
        asyncio.run(ob_mod._call_llm(
            "hello", max_tokens=4096,
            instructions="You are a structured data extractor.",
        ))
    body = captured.get("json") or {}
    assert body.get("instructions") == "You are a structured data extractor."


def test_call_llm_threads_both_response_format_and_instructions() -> None:
    """Combination is the actual production shape."""
    captured: dict = {}
    with patch("src.activities.onboarding_v3.httpx.AsyncClient",
               return_value=_fake_post_capturing(captured)):
        asyncio.run(ob_mod._call_llm(
            "hello", max_tokens=4096,
            response_format={"type": "json_object"},
            instructions="Return only JSON.",
        ))
    body = captured.get("json") or {}
    assert body.get("instructions") == "Return only JSON."
    assert (body.get("text") or {}).get("format") == {"type": "json_object"}


def test_call_llm_legacy_shape_unchanged_when_new_params_omitted() -> None:
    """Backwards compat — no ``text``, no ``instructions``, F35 contract holds."""
    captured: dict = {}
    with patch("src.activities.onboarding_v3.httpx.AsyncClient",
               return_value=_fake_post_capturing(captured)):
        asyncio.run(ob_mod._call_llm("hello", max_tokens=4096))
    body = captured.get("json") or {}
    assert "text" not in body
    assert "instructions" not in body
    assert body.get("input") == "hello"
    assert body.get("max_output_tokens") == 4096


def test_call_llm_strict_json_schema_response_format() -> None:
    """A strict json_schema dict is an opaque pass-through to text.format."""
    captured: dict = {}
    strict_schema = {
        "type": "json_schema",
        "name": "facts_envelope",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {"facts": {"type": "array"}},
            "required": ["facts"],
            "additionalProperties": False,
        },
    }
    with patch("src.activities.onboarding_v3.httpx.AsyncClient",
               return_value=_fake_post_capturing(captured)):
        asyncio.run(ob_mod._call_llm(
            "hello", max_tokens=4096, response_format=strict_schema,
        ))
    body = captured.get("json") or {}
    assert (body.get("text") or {}).get("format") == strict_schema
