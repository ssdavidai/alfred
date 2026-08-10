"""F35 — the clerk/brief LLM request must cap ``max_output_tokens``.

Live symptom: every Hermes ``POST /v1/responses`` asked for the model's
full output ceiling (65536), and the gateway prices the request against
that ceiling, so calls 402'd ("requested up to 65536 tokens, can only
afford 31301") even when the actual response was small.

Both learn-side LLM entry points (``clerk._call_clerk`` on the workers
gateway and ``onboarding_v3._call_llm`` on the heavy gateway) now forward
a bounded ``max_output_tokens`` in the request body. This shrinks the
priced ceiling below the affordable budget — correct regardless of the
402 wall.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from src.activities import clerk as clerk_mod
from src.activities import onboarding_v3 as ob_mod


def _fake_post_capturing(captured: dict):
    """Return an httpx-style AsyncClient context manager whose .post
    records the JSON body it was called with, and returns a 200 response
    with an empty Responses-API output.
    """
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


def test_clerk_request_caps_max_output_tokens():
    captured: dict = {}
    with patch("src.activities.clerk.httpx.AsyncClient",
               return_value=_fake_post_capturing(captured)):
        asyncio.run(clerk_mod._call_clerk("hello", raw=True))
    body = captured.get("json") or {}
    assert "max_output_tokens" in body, "clerk must cap the priced ceiling"
    assert isinstance(body["max_output_tokens"], int)
    # Must sit below the ~31k affordable budget so the request never
    # 402s on the priced ceiling alone.
    assert 0 < body["max_output_tokens"] <= 31000


def test_call_llm_forwards_bounded_max_output_tokens():
    captured: dict = {}
    with patch("src.activities.onboarding_v3.httpx.AsyncClient",
               return_value=_fake_post_capturing(captured)):
        asyncio.run(ob_mod._call_llm("hello", max_tokens=4096))
    body = captured.get("json") or {}
    assert body.get("max_output_tokens") == 4096


def test_call_llm_clamps_oversized_request():
    """A caller asking above the affordable ceiling is clamped down."""
    captured: dict = {}
    with patch("src.activities.onboarding_v3.httpx.AsyncClient",
               return_value=_fake_post_capturing(captured)):
        asyncio.run(ob_mod._call_llm("hello", max_tokens=100000))
    body = captured.get("json") or {}
    assert 0 < body.get("max_output_tokens") <= 31000
