"""Tests for ``fetch_single_plane_record`` — single-record fetch for nudge sync (#574).

Mocks the ctrl-api HTTP client to return canned record payloads. Covers:

* Valid matter path → shaped like ``fetch_changed_matters`` entries.
* Valid task path → shaped like ``fetch_changed_tasks`` entries
  including derived ``matter_slug`` from frontmatter ``related_matters``.
* 404 response → returns ``None`` instead of raising.
* Invalid record_type → ValueError at the boundary.
* Invalid slug (path traversal / slash) → ValueError.
"""
from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest
from temporalio.testing import ActivityEnvironment

from src.activities.plane_sync import fetch_single_plane_record


class _FakeResponse:
    def __init__(self, status_code: int, payload: dict[str, Any] | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> dict[str, Any]:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            # Craft a real HTTPStatusError so the activity's except
            # branches exercise the actual httpx type.
            req = httpx.Request("GET", "http://ctrl-api/test")
            raw = httpx.Response(self.status_code, request=req)
            raise httpx.HTTPStatusError(
                f"{self.status_code}", request=req, response=raw
            )


class _FakeInnerClient:
    def __init__(self, response: _FakeResponse):
        self._response = response
        self.last_path: str | None = None

    async def get(self, path: str, **_: Any) -> _FakeResponse:
        self.last_path = path
        return self._response


class _FakeVaultClient:
    def __init__(self, response: _FakeResponse):
        self._client = _FakeInnerClient(response)

    async def close(self) -> None:
        return None


@pytest.fixture
def patch_vault(monkeypatch):
    """Return a factory that patches VaultClient with a canned response."""

    def _install(response: _FakeResponse) -> _FakeVaultClient:
        fake = _FakeVaultClient(response)
        monkeypatch.setattr(
            "src.activities.plane_sync.VaultClient",
            lambda cfg: fake,
        )
        return fake

    return _install


def _run(activity_fn, *args) -> Any:
    env = ActivityEnvironment()
    return asyncio.run(env.run(activity_fn, *args))


class TestMatterFetch:
    def test_happy_path(self, patch_vault):
        payload = {
            "path": "matter/alpha.md",
            "frontmatter": {
                "name": "Alpha",
                "created": "2026-04-20",
                "updated": "2026-04-21",
            },
            "body": "Alpha body text",
        }
        fake = patch_vault(_FakeResponse(200, payload))
        result = _run(fetch_single_plane_record, "matter", "alpha")
        assert fake._client.last_path == "/api/v1/vault/records/matter/alpha.md"
        assert result is not None
        assert result["slug"] == "alpha"
        assert result["path"] == "matter/alpha.md"
        assert result["frontmatter"]["name"] == "Alpha"
        assert result["body"] == "Alpha body text"
        # Matter records don't expose matter_slug (that's a task field).
        assert "matter_slug" not in result

    def test_404_returns_none(self, patch_vault):
        patch_vault(_FakeResponse(404, {}))
        result = _run(fetch_single_plane_record, "matter", "nope")
        assert result is None


class TestTaskFetch:
    def test_resolves_related_matters_to_matter_slug(self, patch_vault):
        payload = {
            "path": "task/deploy-v2.md",
            "frontmatter": {
                "name": "Deploy v2",
                "created": "2026-04-22",
                "related_matters": ["matter/client-x.md"],
            },
            "body": "Ship the release",
        }
        patch_vault(_FakeResponse(200, payload))
        result = _run(fetch_single_plane_record, "task", "deploy-v2")
        assert result is not None
        assert result["slug"] == "deploy-v2"
        assert result["matter_slug"] == "client-x"

    def test_no_matter_link_returns_none_matter_slug(self, patch_vault):
        payload = {
            "path": "task/orphan.md",
            "frontmatter": {"name": "Orphan", "created": "2026-04-22"},
            "body": "",
        }
        patch_vault(_FakeResponse(200, payload))
        result = _run(fetch_single_plane_record, "task", "orphan")
        assert result is not None
        assert result["matter_slug"] is None


class TestInputValidation:
    def test_invalid_record_type_raises(self):
        with pytest.raises(ValueError):
            _run(fetch_single_plane_record, "project", "foo")

    def test_slug_with_slash_rejected(self):
        with pytest.raises(ValueError):
            _run(fetch_single_plane_record, "matter", "foo/bar")

    def test_slug_with_traversal_rejected(self):
        with pytest.raises(ValueError):
            _run(fetch_single_plane_record, "matter", "..sneaky")

    def test_empty_slug_rejected(self):
        with pytest.raises(ValueError):
            _run(fetch_single_plane_record, "matter", "")
