"""Phase C — Composio sidecar default-args injection.

These tests pin the wire contract for the in-process defaults TTL cache
and the merge behaviour:

  • derive_toolkit_from_action splits on the first underscore
    (GOOGLECALENDAR_EVENTS_LIST → googlecalendar).
  • fetch_user_defaults short-circuits when toolkit or user_id is empty.
  • A cached default arg (e.g. calendarId) gets merged INTO the arguments
    that reach execute_action — under the LLM-supplied args (so the LLM
    can override a non-primary calendar explicitly).
  • The defaults are looked up at most once per (toolkit, user_id) per
    TTL window (cache property — independent of how many requests come
    in inside that window).
  • A failure inside fetch_user_defaults does NOT block execute_action;
    the call still goes through with only the LLM-supplied args.
"""
from __future__ import annotations

import importlib
import sys
from unittest.mock import patch, AsyncMock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def app_module():
    """Reimport composio_server with a fresh in-process state."""
    if "src.composio_server" in sys.modules:
        del sys.modules["src.composio_server"]
    return importlib.import_module("src.composio_server")


def test_derive_toolkit_from_action(app_module):
    derive = app_module.derive_toolkit_from_action
    assert derive("GOOGLECALENDAR_EVENTS_LIST") == "googlecalendar"
    assert derive("GMAIL_FETCH_EMAILS") == "gmail"
    assert derive("NOTION_CREATE_PAGE") == "notion"
    # No underscore — single token toolkit slug.
    assert derive("HEALTH") == "health"
    # Empty / falsy.
    assert derive("") == ""


def test_fetch_user_defaults_short_circuits_on_missing_inputs(app_module):
    """Calling without a toolkit or without a user_id returns {} cheaply."""
    import asyncio

    async def run():
        a = await app_module.fetch_user_defaults("", "alfred-x")
        b = await app_module.fetch_user_defaults("googlecalendar", "")
        return a, b

    a, b = asyncio.run(run())
    assert a == {}
    assert b == {}


def test_execute_merges_cached_defaults_under_llm_args(app_module):
    """The cached defaults are merged BELOW the LLM-supplied arguments.

    Wire shape: defaults={"calendarId": "primary-xyz"}, LLM passes
    {"timeMin": "..."}. The merge must end up as
    {"calendarId": "primary-xyz", "timeMin": "..."} — i.e. defaults first,
    LLM args last (so an explicit calendarId in the LLM args wins).
    """
    app_module._invalidate_defaults_cache()
    captured: dict = {}

    def fake_execute(action_slug, arguments, user_id=None, connected_account_id=None):
        captured["action_slug"] = action_slug
        captured["arguments"] = arguments
        captured["user_id"] = user_id
        captured["connected_account_id"] = connected_account_id
        return {"data": {"items": []}}

    async def fake_fetch(toolkit, user_id):
        if toolkit == "googlecalendar" and user_id == "alfred-home-1":
            return {"calendarId": "primary-cal-xyz"}
        return {}

    with patch.object(app_module, "execute_action", side_effect=fake_execute), \
         patch.object(app_module, "fetch_user_defaults", new=AsyncMock(side_effect=fake_fetch)):
        client = TestClient(app_module.app)
        resp = client.post(
            "/composio/execute",
            json={
                "action": "GOOGLECALENDAR_EVENTS_LIST",
                "arguments": {"timeMin": "2026-05-31T00:00:00Z"},
                "user_id": "alfred-home-1",
                "connected_account_id": "ca_abc123",
            },
        )

    assert resp.status_code == 200
    assert captured["action_slug"] == "GOOGLECALENDAR_EVENTS_LIST"
    assert captured["arguments"] == {
        "calendarId": "primary-cal-xyz",
        "timeMin": "2026-05-31T00:00:00Z",
    }


def test_llm_explicit_arg_wins_over_cached_default(app_module):
    """When the LLM passes calendarId explicitly, the cached default is overridden."""
    app_module._invalidate_defaults_cache()
    captured: dict = {}

    def fake_execute(action_slug, arguments, user_id=None, connected_account_id=None):
        captured["arguments"] = arguments
        return {"ok": True}

    async def fake_fetch(toolkit, user_id):
        return {"calendarId": "primary-cal-xyz"}

    with patch.object(app_module, "execute_action", side_effect=fake_execute), \
         patch.object(app_module, "fetch_user_defaults", new=AsyncMock(side_effect=fake_fetch)):
        client = TestClient(app_module.app)
        resp = client.post(
            "/composio/execute",
            json={
                "action": "GOOGLECALENDAR_EVENTS_LIST",
                "arguments": {"calendarId": "side-calendar@group", "timeMin": "x"},
                "user_id": "alfred-home-1",
                "connected_account_id": "ca_x",
            },
        )

    assert resp.status_code == 200
    assert captured["arguments"]["calendarId"] == "side-calendar@group"
    assert captured["arguments"]["timeMin"] == "x"


def test_no_defaults_no_change(app_module):
    """When fetch_user_defaults returns {} (no cached row), args pass through unchanged."""
    app_module._invalidate_defaults_cache()
    captured: dict = {}

    def fake_execute(action_slug, arguments, user_id=None, connected_account_id=None):
        captured["arguments"] = arguments
        return {"ok": True}

    async def fake_fetch(toolkit, user_id):
        return {}

    with patch.object(app_module, "execute_action", side_effect=fake_execute), \
         patch.object(app_module, "fetch_user_defaults", new=AsyncMock(side_effect=fake_fetch)):
        client = TestClient(app_module.app)
        resp = client.post(
            "/composio/execute",
            json={
                "action": "GMAIL_FETCH_EMAILS",
                "arguments": {"maxResults": 5},
                "user_id": "alfred-home-1",
                "connected_account_id": "ca_g",
            },
        )

    assert resp.status_code == 200
    assert captured["arguments"] == {"maxResults": 5}


def test_fetch_user_defaults_is_cached_per_ttl(app_module):
    """Multiple executes inside the TTL window hit ctrl-api at most once per (toolkit, user_id)."""
    app_module._invalidate_defaults_cache()

    def fake_execute(action_slug, arguments, user_id=None, connected_account_id=None):
        return {"ok": True}

    fetch_calls = {"n": 0}

    async def counting_fetch(toolkit, user_id):
        fetch_calls["n"] += 1
        return {"calendarId": "primary"}

    # Monkey-patch the underlying fetch via the public AsyncMock so the
    # /composio/execute handler uses it. The handler itself drives the
    # caching boundary (it calls fetch_user_defaults each time), so the
    # cache property is "the function we patched gets hit at most once
    # within TTL".
    with patch.object(app_module, "execute_action", side_effect=fake_execute), \
         patch.object(app_module, "fetch_user_defaults", new=AsyncMock(side_effect=counting_fetch)):
        client = TestClient(app_module.app)
        # 5 identical requests in quick succession.
        for _ in range(5):
            resp = client.post(
                "/composio/execute",
                json={
                    "action": "GOOGLECALENDAR_EVENTS_LIST",
                    "arguments": {},
                    "user_id": "alfred-home-1",
                    "connected_account_id": "ca_x",
                },
            )
            assert resp.status_code == 200

    # The handler invokes fetch_user_defaults each time — that's by design,
    # since fetch_user_defaults is itself responsible for caching. We're
    # asserting the public surface is wired: the handler always asks
    # fetch_user_defaults, which means it has the seam to short-circuit.
    assert fetch_calls["n"] == 5

    # Now exercise the REAL cache (not the AsyncMock) by hitting the
    # underlying httpx layer just once and confirming subsequent calls
    # short-circuit.
    app_module._invalidate_defaults_cache()
    http_calls = {"n": 0}

    class FakeResponse:
        def __init__(self):
            self.status_code = 200
        def json(self):
            return {"defaults": {"calendarId": "primary"}}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return False
        async def get(self, *args, **kwargs):
            http_calls["n"] += 1
            return FakeResponse()

    with patch.object(app_module.httpx, "AsyncClient", FakeClient):
        import asyncio

        async def hit_many():
            for _ in range(10):
                d = await app_module.fetch_user_defaults("googlecalendar", "alfred-home-1")
                assert d == {"calendarId": "primary"}

        asyncio.run(hit_many())

    assert http_calls["n"] == 1, "TTL cache should hit ctrl-api exactly once per window"


def test_fetch_user_defaults_swallows_ctrl_api_failure(app_module):
    """Real fetch_user_defaults logs + swallows ctrl-api errors → execute still runs.

    The contract: a ctrl-api hiccup MUST NOT break composio_execute. The LLM
    args go through verbatim, identical to pre-Phase-C behaviour.
    """
    app_module._invalidate_defaults_cache()
    captured: dict = {}

    def fake_execute(action_slug, arguments, user_id=None, connected_account_id=None):
        captured["arguments"] = arguments
        return {"ok": True}

    # Force the underlying httpx client to raise — exercise the REAL
    # fetch_user_defaults' try/except, not a mock.
    class ExplodingClient:
        def __init__(self, *args, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return False
        async def get(self, *args, **kwargs):
            raise RuntimeError("ctrl-api down")

    with patch.object(app_module, "execute_action", side_effect=fake_execute), \
         patch.object(app_module.httpx, "AsyncClient", ExplodingClient):
        client = TestClient(app_module.app)
        resp = client.post(
            "/composio/execute",
            json={
                "action": "GMAIL_FETCH_EMAILS",
                "arguments": {"maxResults": 3},
                "user_id": "alfred-home-1",
                "connected_account_id": "ca_g",
            },
        )

    # The execute still ran, with only the LLM-supplied args (no defaults).
    assert resp.status_code == 200
    assert captured["arguments"] == {"maxResults": 3}
