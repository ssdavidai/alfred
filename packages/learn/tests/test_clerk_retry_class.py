"""Hardening: _call_clerk must discriminate retryable from un-retryable
HTTP failures (FAILURE-MODES Hermes runtime, S2 — clerk.py collapses
401/429/billing/transient into one generic RuntimeError so Temporal
blind-retries un-retryable failures).

Contract:
  * 401 (stale gateway token) → non-retryable ApplicationError
  * 402 / billing-marker body  → non-retryable ApplicationError
  * 429 (rate limit)           → retryable (ApplicationError, not non_retryable)
  * 5xx (transient run failure) → retryable
A non-retryable ApplicationError tells Temporal to stop retrying.
"""
from __future__ import annotations

from typing import Any

import pytest
from temporalio.exceptions import ApplicationError

import src.activities.clerk as clerk


class _FakeResp:
    def __init__(self, status_code: int, body: Any = None, text: str = ""):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.text = text

    def json(self) -> Any:
        return self._body


class _FakeClient:
    def __init__(self, resp: _FakeResp):
        self._resp = resp

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False

    async def post(self, *args: Any, **kwargs: Any) -> _FakeResp:
        return self._resp


def _patch_client(monkeypatch, resp: _FakeResp) -> None:
    monkeypatch.setattr(
        clerk.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp)
    )
    # Make config resolution cheap / deterministic.
    class _Cfg:
        def gateway_token(self) -> str:
            return "tok"

        openclaw_workers_gateway_url = "http://workers"
        clerk_agent_id = "learn-clerk"

    monkeypatch.setattr(clerk, "load_config", lambda: _Cfg())


async def test_401_is_non_retryable(monkeypatch) -> None:
    _patch_client(
        monkeypatch,
        _FakeResp(401, {"error": {"message": "invalid token"}}),
    )
    with pytest.raises(ApplicationError) as ei:
        await clerk._call_clerk("hi")
    assert ei.value.non_retryable is True


async def test_402_is_non_retryable(monkeypatch) -> None:
    _patch_client(
        monkeypatch,
        _FakeResp(402, {"error": {"message": "payment required"}}),
    )
    with pytest.raises(ApplicationError) as ei:
        await clerk._call_clerk("hi")
    assert ei.value.non_retryable is True


async def test_400_billing_marker_is_non_retryable(monkeypatch) -> None:
    _patch_client(
        monkeypatch,
        _FakeResp(400, {"error": {"message": "insufficient credits, top up"}}),
    )
    with pytest.raises(ApplicationError) as ei:
        await clerk._call_clerk("hi")
    assert ei.value.non_retryable is True


async def test_429_is_retryable(monkeypatch) -> None:
    _patch_client(
        monkeypatch,
        _FakeResp(429, {"error": {"message": "rate limited"}}),
    )
    with pytest.raises(ApplicationError) as ei:
        await clerk._call_clerk("hi")
    assert ei.value.non_retryable is False


async def test_500_is_retryable(monkeypatch) -> None:
    _patch_client(
        monkeypatch,
        _FakeResp(503, {"error": {"message": "upstream unavailable"}}),
    )
    with pytest.raises(ApplicationError) as ei:
        await clerk._call_clerk("hi")
    assert ei.value.non_retryable is False
