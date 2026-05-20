"""Tests for daemon._backfill_new_entities — reverse-direction entity linking."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pytest
import frontmatter

from alfred.surveyor.config import (
    ClusteringConfig,
    EntityLinkConfig,
    HdbscanConfig,
    LabelerConfig,
    LeidenConfig,
    LoggingConfig,
    MilvusConfig,
    OllamaConfig,
    OpenRouterConfig,
    PipelineConfig,
    StateConfig,
    VaultConfig,
    WatcherConfig,
)
from alfred.surveyor.daemon import Daemon
from alfred.surveyor.parser import VaultRecord
from alfred.surveyor.state import PipelineState
from alfred.surveyor.writer import VaultWriter


def _cfg(vault, state_path, threshold=0.75, max_per=5, backfill=True) -> PipelineConfig:
    return PipelineConfig(
        vault=VaultConfig(path=vault),
        watcher=WatcherConfig(),
        ollama=OllamaConfig(),
        milvus=MilvusConfig(uri=str(state_path.parent / "milvus.db")),
        clustering=ClusteringConfig(hdbscan=HdbscanConfig(), leiden=LeidenConfig()),
        openrouter=OpenRouterConfig(api_key="x"),
        labeler=LabelerConfig(),
        state=StateConfig(path=str(state_path)),
        logging=LoggingConfig(),
        entity_link=EntityLinkConfig(
            threshold=threshold, max_per_record=max_per, backfill_enabled=backfill
        ),
    )


def _write(vault: Path, rel: str, rt: str) -> None:
    full = vault / rel
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(f"---\ntype: {rt}\nname: x\n---\n\nbody\n", encoding="utf-8")


def _record(rel: str, rt: str) -> VaultRecord:
    return VaultRecord(rel_path=rel, frontmatter={"type": rt, "name": "x"}, body="", record_type=rt)


def _norm(v):
    a = np.asarray(v, dtype=np.float32)
    n = float(np.linalg.norm(a))
    return (a / n).tolist() if n > 0 else a.tolist()


@pytest.fixture
def daemon_and_vault(tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    state_path = tmp_path / "state.json"
    daemon = Daemon.__new__(Daemon)
    daemon.cfg = _cfg(vault, state_path)
    daemon.state = PipelineState(state_path=daemon.cfg.state.path)
    daemon.writer = VaultWriter(vault_path=vault, state=daemon.state)
    daemon.embedder = MagicMock()
    daemon.watcher = MagicMock()
    daemon.clusterer = MagicMock()
    daemon.labeler = MagicMock()
    daemon._shutdown_requested = False
    return daemon, vault


def test_new_matter_links_to_nearby_events(daemon_and_vault):
    """A brand-new matter with high similarity to 2 events gets written
    into both events' related_matters."""
    daemon, vault = daemon_and_vault
    _write(vault, "matter/new.md", "matter")
    _write(vault, "event/a.md", "event")
    _write(vault, "event/b.md", "event")
    _write(vault, "event/far.md", "event")

    records = {
        "matter/new.md": _record("matter/new.md", "matter"),
        "event/a.md": _record("event/a.md", "event"),
        "event/b.md": _record("event/b.md", "event"),
        "event/far.md": _record("event/far.md", "event"),
    }

    m_vec = _norm([1.0, 0.0, 0.0])
    a_vec = _norm([0.95, 0.312, 0.0])  # sim ≈ 0.95
    b_vec = _norm([0.85, 0.52, 0.0])    # sim ≈ 0.85
    far_vec = _norm([0.3, 0.95, 0.0])   # sim ≈ 0.30 below threshold
    paths = list(records.keys())
    vectors = np.asarray([m_vec, a_vec, b_vec, far_vec], dtype=np.float32)

    daemon._backfill_new_entities(
        new_entity_paths=["matter/new.md"],
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    assert frontmatter.load(vault / "event/a.md").metadata["related_matters"] == ["matter/new.md"]
    assert frontmatter.load(vault / "event/b.md").metadata["related_matters"] == ["matter/new.md"]
    assert "related_matters" not in frontmatter.load(vault / "event/far.md").metadata


def test_backfill_skips_same_type_targets(daemon_and_vault):
    """A new matter should NOT be added to another matter's related_matters."""
    daemon, vault = daemon_and_vault
    _write(vault, "matter/new.md", "matter")
    _write(vault, "matter/existing.md", "matter")
    _write(vault, "event/e.md", "event")

    records = {
        "matter/new.md": _record("matter/new.md", "matter"),
        "matter/existing.md": _record("matter/existing.md", "matter"),
        "event/e.md": _record("event/e.md", "event"),
    }

    v = _norm([1.0, 0.0])  # all three share vector → sim = 1.0
    paths = list(records.keys())
    vectors = np.asarray([v] * 3, dtype=np.float32)

    daemon._backfill_new_entities(
        new_entity_paths=["matter/new.md"],
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    # Cross-type: event got the matter link
    assert frontmatter.load(vault / "event/e.md").metadata["related_matters"] == ["matter/new.md"]
    # Same-type: existing matter did NOT get related_matters populated
    assert "related_matters" not in frontmatter.load(vault / "matter/existing.md").metadata


def test_backfill_respects_threshold(daemon_and_vault):
    daemon, vault = daemon_and_vault
    _write(vault, "matter/new.md", "matter")
    _write(vault, "event/e.md", "event")

    records = {
        "matter/new.md": _record("matter/new.md", "matter"),
        "event/e.md": _record("event/e.md", "event"),
    }

    m_vec = _norm([1.0, 0.0])
    e_vec = _norm([0.5, 0.87])  # sim ≈ 0.5 — below default 0.75
    paths = list(records.keys())
    vectors = np.asarray([m_vec, e_vec], dtype=np.float32)

    daemon._backfill_new_entities(
        new_entity_paths=["matter/new.md"],
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    assert "related_matters" not in frontmatter.load(vault / "event/e.md").metadata


def test_backfill_all_four_entity_types(daemon_and_vault):
    """Each entity type gets written to its own field."""
    daemon, vault = daemon_and_vault
    for rel, rt in [
        ("matter/m.md", "matter"),
        ("person/p.md", "person"),
        ("org/o.md", "org"),
        ("project/x.md", "project"),
        ("event/e.md", "event"),
    ]:
        _write(vault, rel, rt)
    records = {rel: _record(rel, rt) for rel, rt in [
        ("matter/m.md", "matter"),
        ("person/p.md", "person"),
        ("org/o.md", "org"),
        ("project/x.md", "project"),
        ("event/e.md", "event"),
    ]}
    v = _norm([1.0, 0.0])
    paths = list(records.keys())
    vectors = np.asarray([v] * 5, dtype=np.float32)

    daemon._backfill_new_entities(
        new_entity_paths=["matter/m.md", "person/p.md", "org/o.md", "project/x.md"],
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    md = frontmatter.load(vault / "event/e.md").metadata
    assert md["related_matters"] == ["matter/m.md"]
    assert md["related_persons"] == ["person/p.md"]
    assert md["related_orgs"] == ["org/o.md"]
    assert md["related_projects"] == ["project/x.md"]


def test_backfill_caps_max_per_record(tmp_path):
    """If many existing matters already saturate related_matters on event,
    a new matter with lower sim should NOT push out existing ones
    (writer._append_to_list_field caps by truncation at the tail of the
    append list — existing entries preserved)."""
    vault = tmp_path / "vault"
    vault.mkdir()
    state_path = tmp_path / "state.json"
    daemon = Daemon.__new__(Daemon)
    daemon.cfg = _cfg(vault, state_path, threshold=0.0, max_per=2)
    daemon.state = PipelineState(state_path=daemon.cfg.state.path)
    daemon.writer = VaultWriter(vault_path=vault, state=daemon.state)

    _write(vault, "event/e.md", "event")
    _write(vault, "matter/a.md", "matter")
    _write(vault, "matter/b.md", "matter")
    _write(vault, "matter/c.md", "matter")

    records = {
        "event/e.md": _record("event/e.md", "event"),
        "matter/a.md": _record("matter/a.md", "matter"),
        "matter/b.md": _record("matter/b.md", "matter"),
        "matter/c.md": _record("matter/c.md", "matter"),
    }

    v = _norm([1.0, 0.0])
    paths = list(records.keys())
    vectors = np.asarray([v] * 4, dtype=np.float32)

    # Backfill in sequence
    daemon._backfill_new_entities(
        new_entity_paths=["matter/a.md", "matter/b.md", "matter/c.md"],
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    md = frontmatter.load(vault / "event/e.md").metadata
    assert md["related_matters"] == ["matter/a.md", "matter/b.md"]  # capped at 2
