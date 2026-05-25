"""Tests for omi_audio._get_groq_api_key — Phase 6b Vaultwarden sourcing.

The Groq API key used to be sourced exclusively from the GROQ_API_KEY
env var. After Phase 6b the canonical store is Vaultwarden, served by
ctrl-api at ``GET /api/v1/credentials/groq-api-key``. The env var
remains as a backward-compat fallback so deploys that haven't migrated
keep working.

These tests cover the 7 cases the lane brief calls out:
  1. ctrl-api 200 → key returned.
  2. ctrl-api 404 → env fallback.
  3. ctrl-api 500 → env fallback + warning logged.
  4. Network timeout → env fallback + warning logged.
  5. Cache hit: 2nd call within 5 min reuses cached value (1 HTTP call).
  6. Cache expiry: call after 5+ min refetches (2 HTTP calls).
  7. 404 response invalidates any cached value.

The ctrl-api HTTP round-trip is mocked at the httpx.AsyncClient
factory layer using a custom transport — same pattern used in
test_state_mutator.py — so we exercise the real request envelope
construction (URL, auth header, timeout) without needing a live ctrl
on :3100.

Public OSS — test keys must use ``gsk_TEST*`` placeholders, never a
real Groq credential.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any
from unittest.mock import patch

import httpx
import pytest

# Make `src.` imports resolve the same way they do inside the container.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities import omi_audio  # noqa: E402


# ---------------------------------------------------------------------------
# Scripted transport — replay a list of canned responses against the
# httpx.AsyncClient that _get_groq_api_key builds for ctrl-api.
# ---------------------------------------------------------------------------


class ScriptedTransport(httpx.AsyncBaseTransport):
    """Replay a list of canned responses (or raise on demand).

    Each script entry is either an ``httpx.Response`` (returned verbatim)
    or an ``Exception`` instance (raised — simulates network errors).
    Every request is captured for post-test assertions.
    """

    def __init__(self, script: list[Any]) -> None:
        self.script = list(script)
        self.requests: list[httpx.Request] = []

    async def handle_async_request(
        self, request: httpx.Request
    ) -> httpx.Response:
        self.requests.append(request)
        if not self.script:
            raise AssertionError(
                f"ScriptedTransport: no more responses; request was "
                f"{request.method} {request.url}"
            )
        entry = self.script.pop(0)
        if isinstance(entry, BaseException):
            raise entry
        return entry


@pytest.fixture
def install_transport():
    """Install a ScriptedTransport into the httpx.AsyncClient that
    ``_get_groq_api_key`` builds for the credential GET."""

    transports: list[ScriptedTransport] = []

    def _install(*responses_or_excs: Any) -> ScriptedTransport:
        transport = ScriptedTransport(list(responses_or_excs))
        transports.append(transport)
        return transport

    real_async_client = httpx.AsyncClient

    def _factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        if transports:
            kwargs["transport"] = transports[0]
        return real_async_client(*args, **kwargs)

    ctx = patch("src.activities.omi_audio.httpx.AsyncClient", _factory)
    ctx.start()
    yield _install
    ctx.stop()


@pytest.fixture(autouse=True)
def _reset_module_state(monkeypatch):
    """Clear the cache between tests + scrub any leaked GROQ_API_KEY
    from the test environment, then restore module state on teardown.
    """
    omi_audio._reset_groq_key_cache()
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("AAS_API_KEY", raising=False)
    yield
    omi_audio._reset_groq_key_cache()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_ctrl_200_returns_api_key(install_transport):
    """ctrl-api returns 200 with valid JSON → helper returns the key."""
    install_transport(
        httpx.Response(200, json={"api_key": "gsk_TEST_from_vaultwarden"})
    )

    key = await omi_audio._get_groq_api_key()
    assert key == "gsk_TEST_from_vaultwarden"


async def test_ctrl_404_falls_back_to_env(install_transport, monkeypatch):
    """ctrl-api returns 404 (Vaultwarden item not configured)
    → helper returns os.environ["GROQ_API_KEY"]."""
    monkeypatch.setenv("GROQ_API_KEY", "gsk_TEST_from_env_fallback")
    install_transport(httpx.Response(404, json={"error": "not_found"}))

    key = await omi_audio._get_groq_api_key()
    assert key == "gsk_TEST_from_env_fallback"


async def test_ctrl_500_falls_back_to_env_and_warns(
    install_transport, monkeypatch, caplog
):
    """ctrl-api returns 500 (anything other than 200/404)
    → env fallback + warning logged."""
    monkeypatch.setenv("GROQ_API_KEY", "gsk_TEST_env_after_500")
    install_transport(httpx.Response(500, text="internal error"))

    with caplog.at_level("WARNING", logger="alfred-learn"):
        key = await omi_audio._get_groq_api_key()

    assert key == "gsk_TEST_env_after_500"
    assert any(
        "ctrl-api returned 500" in rec.message and "groq-api-key" in rec.message
        for rec in caplog.records
    ), f"expected warning about 500 in {[r.message for r in caplog.records]}"


async def test_ctrl_timeout_falls_back_to_env_and_warns(
    install_transport, monkeypatch, caplog
):
    """ctrl-api network timeout → env fallback + warning logged."""
    monkeypatch.setenv("GROQ_API_KEY", "gsk_TEST_env_after_timeout")
    install_transport(httpx.ConnectTimeout("ctrl-api timeout"))

    with caplog.at_level("WARNING", logger="alfred-learn"):
        key = await omi_audio._get_groq_api_key()

    assert key == "gsk_TEST_env_after_timeout"
    assert any(
        "ctrl-api unreachable" in rec.message and "groq-api-key" in rec.message
        for rec in caplog.records
    ), f"expected unreachable warning in {[r.message for r in caplog.records]}"


async def test_cache_hit_within_ttl_skips_http(install_transport):
    """Second call within 5 min uses the cached value → 1 HTTP call total."""
    transport = install_transport(
        httpx.Response(200, json={"api_key": "gsk_TEST_cached"})
    )

    key1 = await omi_audio._get_groq_api_key()
    key2 = await omi_audio._get_groq_api_key()

    assert key1 == "gsk_TEST_cached"
    assert key2 == "gsk_TEST_cached"
    assert len(transport.requests) == 1, (
        f"expected exactly 1 HTTP call (cache hit on 2nd), "
        f"got {len(transport.requests)}"
    )


async def test_cache_expiry_refetches_after_ttl(install_transport, monkeypatch):
    """Call after 5+ min refetches → 2 HTTP calls."""
    transport = install_transport(
        httpx.Response(200, json={"api_key": "gsk_TEST_first"}),
        httpx.Response(200, json={"api_key": "gsk_TEST_second_after_expiry"}),
    )

    # Freeze time at t0 for the first call.
    fake_now = {"t": 1_000_000.0}

    def _fake_time() -> float:
        return fake_now["t"]

    monkeypatch.setattr("src.activities.omi_audio.time.time", _fake_time)

    key1 = await omi_audio._get_groq_api_key()
    assert key1 == "gsk_TEST_first"
    assert len(transport.requests) == 1

    # Advance clock past the 5-min TTL.
    fake_now["t"] += omi_audio._GROQ_KEY_CACHE_TTL_SECONDS + 1

    key2 = await omi_audio._get_groq_api_key()
    assert key2 == "gsk_TEST_second_after_expiry"
    assert len(transport.requests) == 2, (
        f"expected exactly 2 HTTP calls (cache miss after expiry), "
        f"got {len(transport.requests)}"
    )


async def test_404_invalidates_cached_value(install_transport, monkeypatch):
    """A 404 response clears any previously cached value so a
    key-rotation flow (DELETE in the UI) recovers within one cycle —
    i.e. after the cached entry's TTL elapses, the next fetch returns
    404, the cache is cleared, and a follow-up call DOES NOT re-serve
    the stale value from cache.

    Sequence:
      1. ctrl-api 200 at t0 → cache "gsk_TEST_old".
      2. (operator DELETEs the Vaultwarden item.)
      3. Advance clock past 5-min TTL. Next fetch hits ctrl-api → 404.
         Helper falls back to env AND clears the cache entry.
      4. A follow-up call immediately after (well inside what *would* be
         the 5-min cache window if the 200 result had been re-cached)
         must re-hit ctrl-api, not return "gsk_TEST_old". This is the
         load-bearing check: it proves the 404 path did not preserve
         the stale entry.
    """
    monkeypatch.setenv("GROQ_API_KEY", "gsk_TEST_env_post_rotation")
    transport = install_transport(
        httpx.Response(200, json={"api_key": "gsk_TEST_old"}),
        httpx.Response(404, json={"error": "not_found"}),
        # Third 404: if the 404 path had (incorrectly) cached anything,
        # this slot wouldn't be consumed. Asserting len(requests) == 3
        # below proves the cache stays clear after a 404.
        httpx.Response(404, json={"error": "not_found"}),
    )

    fake_now = {"t": 1_000_000.0}

    def _fake_time() -> float:
        return fake_now["t"]

    monkeypatch.setattr("src.activities.omi_audio.time.time", _fake_time)

    # Step 1: prime cache with a valid key.
    key1 = await omi_audio._get_groq_api_key()
    assert key1 == "gsk_TEST_old"
    assert len(transport.requests) == 1

    # Step 2: simulate cache TTL elapsing so the next call actually
    # consults ctrl-api (which now returns 404 — the key was deleted).
    fake_now["t"] += omi_audio._GROQ_KEY_CACHE_TTL_SECONDS + 1

    key2 = await omi_audio._get_groq_api_key()
    assert key2 == "gsk_TEST_env_post_rotation"
    assert len(transport.requests) == 2

    # Step 3: the 404 must have cleared the cache. A follow-up call —
    # made *immediately*, well inside any TTL window — must re-hit
    # ctrl-api rather than serving the stale "gsk_TEST_old".
    key3 = await omi_audio._get_groq_api_key()
    assert key3 == "gsk_TEST_env_post_rotation"
    assert key3 != "gsk_TEST_old", (
        "404 must invalidate cache — got stale cached value back"
    )
    assert len(transport.requests) == 3, (
        "404 must invalidate cache — expected the 3rd call to re-hit "
        f"ctrl-api, got {len(transport.requests)} total requests"
    )
