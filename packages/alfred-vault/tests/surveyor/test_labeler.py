"""Tests for surveyor labeler — entity slug inclusion + merge behaviour,
gateway-absent failure, and Hermes response-extraction paths."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from alfred.surveyor.config import LabelerConfig, LabelerGatewayConfig
from alfred.surveyor.labeler import (
    ENTITY_RECORD_TYPES,
    Labeler,
    _slug_from_rel_path,
)
from alfred.surveyor.parser import VaultRecord


def _record(rel_path: str, record_type: str, name: str = "") -> VaultRecord:
    return VaultRecord(
        rel_path=rel_path,
        frontmatter={"type": record_type, "name": name},
        body="body content",
        record_type=record_type,
    )


def test_slug_from_rel_path_basic():
    assert _slug_from_rel_path("matter/alfred-product-development-launch.md") == (
        "alfred-product-development-launch"
    )


def test_slug_from_rel_path_nested():
    assert _slug_from_rel_path("person/some-nested/jazmin-rapali.md") == "jazmin-rapali"


def test_slug_from_rel_path_no_extension():
    assert _slug_from_rel_path("matter/foo") == "foo"


def test_entity_record_types_snapshot():
    # Bug #13 removed "matter" — it is not a canonical vault KNOWN_TYPE.
    # Lock the entity set so accidental changes require a test update.
    assert ENTITY_RECORD_TYPES == {"person", "org", "matter"}


def _make_labeler(llm_response: str | None) -> Labeler:
    gateway = LabelerGatewayConfig(
        hermes_gateway_url="http://hermes-test:18790",
        hermes_gateway_token="test-token",
    )
    labeler_cfg = LabelerConfig(
        max_files_per_cluster_context=20,
        body_preview_chars=200,
        min_cluster_size_to_label=2,
    )
    labeler = Labeler(gateway, labeler_cfg)
    labeler._llm_call = AsyncMock(return_value=llm_response)  # type: ignore[method-assign]
    return labeler


@pytest.mark.asyncio
async def test_label_cluster_includes_entity_slug_first():
    # Use a "person" record — "person" is a canonical entity type.
    # "matter" is NOT an entity type (bug #13 removed it).
    labeler = _make_labeler(
        llm_response='["construction/residential", "project-management"]',
    )
    records = {
        "person/jazmin-rapali.md": _record(
            "person/jazmin-rapali.md", "person", "Jazmin"
        ),
        "event/2026-04-10-foo.md": _record("event/2026-04-10-foo.md", "event"),
        "event/2026-04-11-bar.md": _record("event/2026-04-11-bar.md", "event"),
    }
    tags = await labeler.label_cluster(
        cluster_id=1,
        member_paths=list(records.keys()),
        records=records,
    )
    assert tags[0] == "jazmin-rapali"
    assert "construction/residential" in tags
    assert "project-management" in tags


@pytest.mark.asyncio
async def test_label_cluster_includes_multiple_entity_slugs():
    # person, org and matter are the three canonical entity types. Bug #13 had
    # this backwards — it treated `matter` as the phantom and kept `project`,
    # the type ctrl-api actually rejects — so this test used to assert that the
    # matter slug must NOT appear. It should, and now does.
    labeler = _make_labeler(llm_response='["makerspace"]')
    records = {
        "matter/erste-makerspace.md": _record("matter/erste-makerspace.md", "matter"),
        "person/jazmin-rapali.md": _record("person/jazmin-rapali.md", "person"),
        "org/erste-bank.md": _record("org/erste-bank.md", "org"),
        "event/foo.md": _record("event/foo.md", "event"),
    }
    tags = await labeler.label_cluster(
        cluster_id=2,
        member_paths=list(records.keys()),
        records=records,
    )
    entity_slugs = {"jazmin-rapali", "erste-bank", "erste-makerspace"}
    assert entity_slugs.issubset(set(tags))
    # Entity slugs should come first (before LLM tags)
    assert set(tags[: len(entity_slugs)]) == entity_slugs
    assert "makerspace" in tags
    # `matter` IS an entity type, so its slug is a canonical tag.
    assert "erste-makerspace" in tags


@pytest.mark.asyncio
async def test_label_cluster_no_entity_returns_llm_only():
    labeler = _make_labeler(
        llm_response='["infrastructure", "devops"]',
    )
    records = {
        "note/x.md": _record("note/x.md", "note"),
        "event/y.md": _record("event/y.md", "event"),
        "observation/z.md": _record("observation/z.md", "observation"),
    }
    tags = await labeler.label_cluster(
        cluster_id=3,
        member_paths=list(records.keys()),
        records=records,
    )
    assert tags == ["infrastructure", "devops"]


@pytest.mark.asyncio
async def test_label_cluster_llm_response_none_still_returns_entity_slugs():
    # Use "person" — a canonical entity type — to verify entity-slug extraction
    # when the LLM returns None.  "matter" is not an entity type (bug #13).
    labeler = _make_labeler(llm_response=None)
    records = {
        "person/important.md": _record("person/important.md", "person"),
        "event/a.md": _record("event/a.md", "event"),
    }
    tags = await labeler.label_cluster(
        cluster_id=4,
        member_paths=list(records.keys()),
        records=records,
    )
    assert tags == ["important"]


@pytest.mark.asyncio
async def test_label_cluster_llm_tag_matching_slug_is_deduped():
    # LLM returns a tag that happens to match the entity slug — should not duplicate
    labeler = _make_labeler(
        llm_response='["erste-makerspace", "banking"]',
    )
    records = {
        "matter/erste-makerspace.md": _record("matter/erste-makerspace.md", "matter"),
        "event/q.md": _record("event/q.md", "event"),
    }
    tags = await labeler.label_cluster(
        cluster_id=5,
        member_paths=list(records.keys()),
        records=records,
    )
    assert tags.count("erste-makerspace") == 1
    assert "banking" in tags


@pytest.mark.asyncio
async def test_label_cluster_below_min_size_returns_empty():
    labeler = _make_labeler(llm_response='["x"]')
    records = {
        "matter/solo.md": _record("matter/solo.md", "matter"),
    }
    tags = await labeler.label_cluster(
        cluster_id=6,
        member_paths=list(records.keys()),
        records=records,
    )
    assert tags == []


# --- Gateway-absent failure tests ---

def _make_labeler_no_gateway() -> Labeler:
    """Labeler with no Hermes gateway configured."""
    gateway = LabelerGatewayConfig(hermes_gateway_url="")
    labeler_cfg = LabelerConfig(min_cluster_size_to_label=2)
    return Labeler(gateway, labeler_cfg)


@pytest.mark.asyncio
async def test_llm_call_raises_when_gateway_not_configured():
    """Missing gateway URL raises RuntimeError immediately — no provider fallback."""
    labeler = _make_labeler_no_gateway()
    with pytest.raises(RuntimeError, match="SURVEYOR_HERMES_GATEWAY_URL"):
        await labeler._llm_call("test prompt")


@pytest.mark.asyncio
async def test_label_cluster_propagates_gateway_error():
    """label_cluster surfaces the RuntimeError when gateway is unconfigured."""
    labeler = _make_labeler_no_gateway()
    records = {
        "note/a.md": _record("note/a.md", "note"),
        "note/b.md": _record("note/b.md", "note"),
    }
    with pytest.raises(RuntimeError, match="SURVEYOR_HERMES_GATEWAY_URL"):
        await labeler.label_cluster(1, list(records.keys()), records)


# --- Hermes response-extraction tests ---

@pytest.mark.asyncio
async def test_llm_call_hermes_retries_on_429(monkeypatch):
    """429 responses trigger retry with backoff; eventual success returns text."""
    gateway = LabelerGatewayConfig(
        hermes_gateway_url="http://hermes-test:18790",
        hermes_gateway_token="tok",
    )
    labeler = Labeler(gateway, LabelerConfig())

    call_count = {"n": 0}

    class FakeResp:
        def __init__(self, status, body=""):
            self.status_code = status
            self.text = body
        def json(self):
            return {"output": "done"}

    async def fake_post(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] < 2:
            return FakeResp(429)
        return FakeResp(200)

    monkeypatch.setattr("asyncio.sleep", AsyncMock())

    import httpx
    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(side_effect=fake_post)

    with patch("alfred.surveyor.labeler.httpx.AsyncClient", return_value=mock_client):
        result = await labeler._llm_call_hermes("prompt")

    assert result == "done"
    assert call_count["n"] == 2


@pytest.mark.asyncio
async def test_llm_call_hermes_returns_none_on_4xx(monkeypatch):
    """Non-retryable 4xx (e.g. 401 auth) returns None immediately."""
    gateway = LabelerGatewayConfig(
        hermes_gateway_url="http://hermes-test:18790",
        hermes_gateway_token="bad-tok",
    )
    labeler = Labeler(gateway, LabelerConfig())

    class FakeResp:
        status_code = 401
        text = "Unauthorized"
        def json(self):
            return {}

    monkeypatch.setattr("asyncio.sleep", AsyncMock())

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    mock_client.post = AsyncMock(return_value=FakeResp())

    with patch("alfred.surveyor.labeler.httpx.AsyncClient", return_value=mock_client):
        result = await labeler._llm_call_hermes("prompt")

    assert result is None
