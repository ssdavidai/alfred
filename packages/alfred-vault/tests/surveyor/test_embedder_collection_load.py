"""An existing Milvus collection must be LOADED before it can be queried.

milvus-lite persists the collection's data across restarts but not its loaded
state. `create_collection()` loads implicitly, so a fresh deploy worked — and
then every restart afterwards left the collection in state 'released', with
every query failing:

    MilvusException: (code=101, message=Collection 'vault_embeddings' is in
    state 'released'; call load() first)

_ensure_collection() returned early on the happy path (collection exists, dims
match) without ever loading. These tests pin both paths.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from alfred.surveyor.embedder import Embedder


def _embedder_with(milvus) -> Embedder:
    e = Embedder.__new__(Embedder)          # bypass __init__ / real connections
    e.milvus = milvus
    e.collection_name = "vault_embeddings"
    e.embedding_dims = 1024
    e.state = MagicMock()
    return e


def _existing_collection_client(dim: int = 1024) -> MagicMock:
    m = MagicMock()
    m.has_collection.return_value = True
    m.describe_collection.return_value = {
        "fields": [{"name": "embedding", "params": {"dim": dim}}]
    }
    return m


def test_existing_collection_is_loaded_not_just_returned():
    """The regression. Dims match, so the method returns early — it must load
    first, or every query after a restart fails."""
    m = _existing_collection_client()
    _embedder_with(m)._ensure_collection()
    m.load_collection.assert_called_once_with("vault_embeddings")
    m.create_collection.assert_not_called()


def test_load_failure_is_logged_not_raised():
    """A failed load makes the surveyor useless but must not take the worker
    down; the query that follows reports the real error."""
    m = _existing_collection_client()
    m.load_collection.side_effect = RuntimeError("milvus down")
    _embedder_with(m)._ensure_collection()   # must not raise


def test_load_is_called_on_the_create_path_too():
    """create_index() does not load either, so the fresh-collection path needs
    it explicitly rather than relying on create_collection's implicit load."""
    m = MagicMock()
    m.has_collection.return_value = False
    e = _embedder_with(m)
    e._ensure_collection()
    m.create_collection.assert_called_once()
    m.load_collection.assert_called_once_with("vault_embeddings")
