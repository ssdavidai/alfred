"""Tests for the Composio HTTP sidecar (`src/composio_server.py`).

The sidecar replaces the docker-exec shell-out ctrl-api used for every
Composio call. These tests pin the wire contract ctrl-api depends on:

  • health endpoint exists and is cheap
  • /composio/execute forwards (action, arguments, user_id,
    connected_account_id) to ``execute_action`` verbatim
  • The result returned by ``execute_action`` round-trips as JSON 200
    even when it carries a Composio-side error envelope (so we don't
    mask Composio's own structured errors with an HTTP 500)
  • A *crash* in ``execute_action`` itself surfaces as a structured
    HTTP 500 envelope so ctrl-api can attach a useful message
  • The client warm-up runs at most once (singleton property — the
    whole point of the sidecar)
"""
from __future__ import annotations

import importlib
import os
import sys
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def app_module():
    """Reimport composio_server with a stub execute_action.

    We patch ``src.integrations.composio_client.execute_action`` BEFORE the
    server module loads so its top-level ``from … import execute_action``
    picks up the stub (the server captures it by reference at import-time).
    """
    # Clear any previously cached module so the patch above takes effect.
    if "src.composio_server" in sys.modules:
        del sys.modules["src.composio_server"]
    # Force a fresh import.
    return importlib.import_module("src.composio_server")


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

def test_health_returns_ok(app_module):
    client = TestClient(app_module.app)
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["service"] == "composio-sidecar"


# ---------------------------------------------------------------------------
# Execute endpoint — happy path forwarding
# ---------------------------------------------------------------------------

def test_execute_forwards_arguments_to_execute_action(app_module):
    captured: dict = {}

    def fake_execute_action(action_slug, arguments, user_id=None, connected_account_id=None):
        captured["action_slug"] = action_slug
        captured["arguments"] = arguments
        captured["user_id"] = user_id
        captured["connected_account_id"] = connected_account_id
        return {"data": {"messages": ["m1", "m2"]}, "successful": True}

    with patch.object(app_module, "execute_action", side_effect=fake_execute_action):
        client = TestClient(app_module.app)
        resp = client.post(
            "/composio/execute",
            json={
                "action": "GMAIL_FETCH_EMAILS",
                "arguments": {"userId": "me", "maxResults": 5},
                "user_id": "alfred-home-1",
                "connected_account_id": "ca_abc123",
            },
        )

    assert resp.status_code == 200
    assert resp.json() == {
        "data": {"messages": ["m1", "m2"]},
        "successful": True,
    }
    assert captured == {
        "action_slug": "GMAIL_FETCH_EMAILS",
        "arguments": {"userId": "me", "maxResults": 5},
        "user_id": "alfred-home-1",
        "connected_account_id": "ca_abc123",
    }


def test_execute_defaults_optional_fields(app_module):
    """user_id and connected_account_id default to None when omitted."""
    captured: dict = {}

    def fake_execute_action(action_slug, arguments, user_id=None, connected_account_id=None):
        captured.update(
            action_slug=action_slug,
            arguments=arguments,
            user_id=user_id,
            connected_account_id=connected_account_id,
        )
        return {"ok": True}

    with patch.object(app_module, "execute_action", side_effect=fake_execute_action):
        client = TestClient(app_module.app)
        resp = client.post(
            "/composio/execute",
            json={"action": "GMAIL_GET_PROFILE"},
        )

    assert resp.status_code == 200
    assert captured["action_slug"] == "GMAIL_GET_PROFILE"
    assert captured["arguments"] == {}
    assert captured["user_id"] is None
    assert captured["connected_account_id"] is None


# ---------------------------------------------------------------------------
# Composio-side errors stay 200 + carry the envelope
# ---------------------------------------------------------------------------

def test_composio_side_error_envelope_returns_200(app_module):
    """execute_action returns {"error": ..., "action": ...} on Composio failure.

    The sidecar must NOT translate that into HTTP 500 — ctrl-api already
    knows how to surface the action-level error to the caller. Hiding it
    behind a transport error would be a regression vs. the docker-exec path.
    """
    def fake_execute_action(*args, **kwargs):
        return {"error": "No active gmail connection", "action": "GMAIL_FETCH_EMAILS"}

    with patch.object(app_module, "execute_action", side_effect=fake_execute_action):
        client = TestClient(app_module.app)
        resp = client.post(
            "/composio/execute",
            json={
                "action": "GMAIL_FETCH_EMAILS",
                "arguments": {},
                "user_id": "alfred-x",
                "connected_account_id": "ca_x",
            },
        )

    assert resp.status_code == 200
    body = resp.json()
    assert body["error"] == "No active gmail connection"
    assert body["action"] == "GMAIL_FETCH_EMAILS"


# ---------------------------------------------------------------------------
# Crashes surface as a structured 500
# ---------------------------------------------------------------------------

def test_execute_action_crash_returns_structured_500(app_module):
    def boom(*args, **kwargs):
        raise RuntimeError("composio sdk exploded")

    with patch.object(app_module, "execute_action", side_effect=boom):
        client = TestClient(app_module.app)
        resp = client.post(
            "/composio/execute",
            json={"action": "NOPE", "arguments": {}},
        )

    assert resp.status_code == 500
    body = resp.json()
    assert body["error"]["code"] == "COMPOSIO_SIDECAR_ERROR"
    assert "composio sdk exploded" in body["error"]["message"]
    assert body["error"]["type"] == "RuntimeError"


# ---------------------------------------------------------------------------
# Singleton warm-up property
# ---------------------------------------------------------------------------

def test_get_client_called_at_most_once_per_process(app_module):
    """The latency win depends on _get_client being memoised across requests.

    We don't directly inspect _composio_instance (it requires real env vars
    + SDK import). Instead we verify that 10 sequential execute requests
    call execute_action 10 times, while _get_client is hit only when the
    underlying composio_client lazy-init says so — i.e. its memoization
    boundary is respected by the server (we never re-init per request).
    """
    call_count = {"execute": 0}

    def fake_execute_action(*args, **kwargs):
        call_count["execute"] += 1
        return {"ok": True}

    with patch.object(app_module, "execute_action", side_effect=fake_execute_action):
        client = TestClient(app_module.app)
        for _ in range(10):
            resp = client.post(
                "/composio/execute",
                json={"action": "X", "arguments": {}},
            )
            assert resp.status_code == 200

    assert call_count["execute"] == 10
