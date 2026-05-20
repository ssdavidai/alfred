"""Tests for Embedder.get_all_embeddings pagination.

The surveyor daemon crash-looped on David's vault (12,372 entities) because
`get_all_embeddings()` issued a single `milvus.query(limit=16_000)` and tripped
milvus-lite's segcore per-query result-size cap:

    pymilvus.exceptions.MilvusException:
        query results exceed the limit size at ... SegmentInterface.cpp:116

The fix switches to `query_iterator` with a smaller page size, stitching
batches into a single result. These tests exercise that path via a fake
iterator so we don't need a real Milvus instance.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import numpy as np

from alfred.surveyor.embedder import Embedder, _encode_id


def _stub_embedder() -> Embedder:
    """Bare-bones Embedder without real Milvus/HTTP setup."""
    e = Embedder.__new__(Embedder)
    e.collection_name = "vault"
    e.milvus = MagicMock()
    return e


def _fake_iterator(pages: list[list[dict]]) -> MagicMock:
    """Build a fake query_iterator that yields the given pages, then empty."""
    it = MagicMock()
    # next() returns each page then an empty list to signal exhaustion.
    # The real API also returns [] once exhausted, so a plain side_effect
    # with a trailing [] matches production behaviour.
    it.next.side_effect = list(pages) + [[]]
    it.close = MagicMock()
    return it


def _make_rows(n: int, offset: int = 0, dim: int = 4) -> list[dict]:
    """Build n fake Milvus rows with encoded IDs and dummy vectors."""
    rows: list[dict] = []
    for i in range(n):
        idx = offset + i
        rows.append({
            "id": _encode_id(f"entity/e-{idx}.md"),
            "embedding": [float(idx)] * dim,
        })
    return rows


def test_get_all_embeddings_concatenates_pages() -> None:
    """Iterator returns [2000, 2000, 372] → we see 4,372 stitched rows."""
    e = _stub_embedder()
    page1 = _make_rows(2000, offset=0)
    page2 = _make_rows(2000, offset=2000)
    page3 = _make_rows(372, offset=4000)
    e.milvus.query_iterator = MagicMock(
        return_value=_fake_iterator([page1, page2, page3])
    )

    result = e.get_all_embeddings()
    assert result is not None
    paths, vectors = result

    assert len(paths) == 4372
    assert vectors.shape == (4372, 4)
    # Ordering is preserved (important: clusterer maps paths[i] ↔ vectors[i])
    assert paths[0] == "entity/e-0.md"
    assert paths[1999] == "entity/e-1999.md"
    assert paths[2000] == "entity/e-2000.md"
    assert paths[4371] == "entity/e-4371.md"
    assert vectors.dtype == np.float32
    # Iterator cursor is always closed (server-side resource)
    e.milvus.query_iterator.return_value.close.assert_called_once()


def test_get_all_embeddings_empty_collection_returns_none() -> None:
    """Empty collection (iterator yields nothing) → None, not ([], array([]))."""
    e = _stub_embedder()
    e.milvus.query_iterator = MagicMock(return_value=_fake_iterator([]))

    assert e.get_all_embeddings() is None


def test_get_all_embeddings_single_page_under_batch_size() -> None:
    """Collection smaller than batch_size still works and decodes IDs."""
    e = _stub_embedder()
    rows = _make_rows(17, offset=0)
    e.milvus.query_iterator = MagicMock(return_value=_fake_iterator([rows]))

    result = e.get_all_embeddings()
    assert result is not None
    paths, vectors = result
    assert len(paths) == 17
    assert vectors.shape == (17, 4)
    assert paths[0] == "entity/e-0.md"


def test_get_all_embeddings_decodes_url_encoded_ids() -> None:
    """Milvus stores URL-encoded IDs; caller expects vault-relative paths."""
    e = _stub_embedder()
    # A path that definitely gets percent-encoded: spaces, apostrophes.
    raw_path = "matter/Acme's Big Deal.md"
    rows = [{
        "id": _encode_id(raw_path),
        "embedding": [0.1, 0.2, 0.3, 0.4],
    }]
    e.milvus.query_iterator = MagicMock(return_value=_fake_iterator([rows]))

    result = e.get_all_embeddings()
    assert result is not None
    paths, _ = result
    assert paths == [raw_path]


def test_get_all_embeddings_closes_iterator_on_exception() -> None:
    """If iteration blows up mid-way, the iterator cursor still gets closed."""
    e = _stub_embedder()
    it = MagicMock()
    it.next.side_effect = RuntimeError("segcore boom")
    it.close = MagicMock()
    e.milvus.query_iterator = MagicMock(return_value=it)

    try:
        e.get_all_embeddings()
    except RuntimeError:
        pass
    it.close.assert_called_once()
