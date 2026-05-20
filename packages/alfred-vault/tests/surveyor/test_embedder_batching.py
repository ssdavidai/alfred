"""Tests for embedder cloud-batching + throttle removal."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from alfred.surveyor.embedder import Embedder


def _stub_embedder(api_key: str | None = "sk-test") -> Embedder:
    """Minimal Embedder instance without Milvus/HTTP setup."""
    e = Embedder.__new__(Embedder)
    e.api_key = api_key
    e.model = "openai/text-embedding-3-small"
    e.embedding_dims = 1536
    e.embed_url = "https://openrouter.ai/api/v1/embeddings"
    e._http = None
    return e


class _FakeResponse:
    def __init__(self, json_data: dict, status_code: int = 200) -> None:
        self._json = json_data
        self.status_code = status_code
        self.text = ""

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("err", request=None, response=self)  # type: ignore[arg-type]

    def json(self) -> dict:
        return self._json


def test_throttle_zero_on_cloud() -> None:
    e = _stub_embedder(api_key="sk-test")
    assert e._is_cloud is True
    assert e._throttle_seconds == 0.0


def test_throttle_nonzero_on_local() -> None:
    e = _stub_embedder(api_key=None)
    assert e._is_cloud is False
    assert e._throttle_seconds > 0.0


@pytest.mark.asyncio
async def test_embed_batch_cloud_single_request_for_many_inputs() -> None:
    """Cloud path should issue ONE POST for a list of many texts."""
    e = _stub_embedder(api_key="sk-test")
    # Fake client returning an embeddings-shaped response
    fake_json = {
        "data": [
            {"index": 0, "embedding": [0.1, 0.2]},
            {"index": 1, "embedding": [0.3, 0.4]},
            {"index": 2, "embedding": [0.5, 0.6]},
        ]
    }
    client = MagicMock()
    client.post = AsyncMock(return_value=_FakeResponse(fake_json))
    client.is_closed = False
    e._http = client

    result = await e._embed_batch(["a", "b", "c"])
    assert result == [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]]
    assert client.post.await_count == 1  # single batched request


@pytest.mark.asyncio
async def test_embed_batch_uses_provider_index_for_ordering() -> None:
    """Reassembly must use `index` field, not response order."""
    e = _stub_embedder(api_key="sk-test")
    # Provider returns items out of order
    fake_json = {
        "data": [
            {"index": 2, "embedding": [2.0]},
            {"index": 0, "embedding": [0.0]},
            {"index": 1, "embedding": [1.0]},
        ]
    }
    client = MagicMock()
    client.post = AsyncMock(return_value=_FakeResponse(fake_json))
    client.is_closed = False
    e._http = client

    result = await e._embed_batch(["x", "y", "z"])
    assert result == [[0.0], [1.0], [2.0]]


@pytest.mark.asyncio
async def test_embed_batch_empty_input_returns_empty() -> None:
    e = _stub_embedder(api_key="sk-test")
    result = await e._embed_batch([])
    assert result == []


@pytest.mark.asyncio
async def test_embed_batch_local_falls_back_sequentially() -> None:
    """Local Ollama path has no batch endpoint — should call _embed_single per text."""
    e = _stub_embedder(api_key=None)
    e._embed_single = AsyncMock(side_effect=[[0.1], [0.2], [0.3]])

    import alfred.surveyor.embedder as emb_mod
    original = emb_mod.EMBED_THROTTLE_LOCAL
    emb_mod.EMBED_THROTTLE_LOCAL = 0.0  # speed up tests
    try:
        result = await e._embed_batch(["a", "b", "c"])
    finally:
        emb_mod.EMBED_THROTTLE_LOCAL = original

    assert result == [[0.1], [0.2], [0.3]]
    assert e._embed_single.await_count == 3
