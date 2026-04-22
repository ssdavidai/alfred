"""Tests for daemon._link_noise_points_to_entities."""
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


def _cfg(vault: Path, state_path: Path, threshold: float = 0.75, max_per: int = 5) -> PipelineConfig:
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
        entity_link=EntityLinkConfig(threshold=threshold, max_per_record=max_per),
    )


def _write(vault: Path, rel: str, rt: str) -> None:
    full = vault / rel
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(f"---\ntype: {rt}\nname: x\n---\n\nbody\n", encoding="utf-8")


def _record(rel: str, rt: str) -> VaultRecord:
    return VaultRecord(rel_path=rel, frontmatter={"type": rt, "name": "x"}, body="", record_type=rt)


def _norm(v: list[float]) -> list[float]:
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


def test_noise_point_event_links_to_matter_above_threshold(daemon_and_vault):
    """A noise-point event record with high similarity to an entity gets linked."""
    daemon, vault = daemon_and_vault
    _write(vault, "matter/primary.md", "matter")
    _write(vault, "event/lonely.md", "event")
    daemon.state.update_file("matter/primary.md", "h1")
    daemon.state.update_file("event/lonely.md", "h2")

    records = {
        "matter/primary.md": _record("matter/primary.md", "matter"),
        "event/lonely.md": _record("event/lonely.md", "event"),
    }

    matter_vec = _norm([1.0, 0.0, 0.0])
    event_vec = _norm([0.95, 0.312, 0.0])  # sim ≈ 0.95
    paths = ["matter/primary.md", "event/lonely.md"]
    vectors = np.asarray([matter_vec, event_vec], dtype=np.float32)

    daemon._link_noise_points_to_entities(
        noise_paths=["event/lonely.md"],
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    md = frontmatter.load(vault / "event/lonely.md").metadata
    assert md.get("related_matters") == ["matter/primary.md"]


def test_noise_event_below_threshold_not_linked(daemon_and_vault):
    daemon, vault = daemon_and_vault
    _write(vault, "matter/m.md", "matter")
    _write(vault, "event/e.md", "event")
    records = {
        "matter/m.md": _record("matter/m.md", "matter"),
        "event/e.md": _record("event/e.md", "event"),
    }
    matter_vec = _norm([1.0, 0.0, 0.0])
    event_vec = _norm([0.3, 0.95, 0.0])  # sim ≈ 0.3 — below default 0.75
    paths = list(records.keys())
    vectors = np.asarray([matter_vec, event_vec], dtype=np.float32)

    daemon._link_noise_points_to_entities(
        noise_paths=["event/e.md"],
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    md = frontmatter.load(vault / "event/e.md").metadata
    assert "related_matters" not in md


def test_noise_point_all_four_entity_types(daemon_and_vault):
    """One noise event linked to each entity type in one pass."""
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

    # All five share the same vector → sim ≈ 1.0 for all entity comparisons
    v = _norm([1.0, 0.0])
    paths = list(records.keys())
    vectors = np.asarray([v] * 5, dtype=np.float32)

    daemon._link_noise_points_to_entities(
        noise_paths=["event/e.md"],
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    md = frontmatter.load(vault / "event/e.md").metadata
    assert md.get("related_matters") == ["matter/m.md"]
    assert md.get("related_persons") == ["person/p.md"]
    assert md.get("related_orgs") == ["org/o.md"]
    assert md.get("related_projects") == ["project/x.md"]


def test_noise_entity_source_skips_same_type_targets(daemon_and_vault):
    """If the noise source is a matter, don't populate its related_matters
    (that would create matter→matter chains). Other types still allowed.
    """
    daemon, vault = daemon_and_vault
    _write(vault, "matter/src.md", "matter")
    _write(vault, "matter/other.md", "matter")
    _write(vault, "person/p.md", "person")
    records = {
        "matter/src.md": _record("matter/src.md", "matter"),
        "matter/other.md": _record("matter/other.md", "matter"),
        "person/p.md": _record("person/p.md", "person"),
    }

    v = _norm([1.0, 0.0])
    paths = list(records.keys())
    vectors = np.asarray([v] * 3, dtype=np.float32)

    daemon._link_noise_points_to_entities(
        noise_paths=["matter/src.md"],
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    md = frontmatter.load(vault / "matter/src.md").metadata
    # No matter→matter self-type linkage
    assert "related_matters" not in md
    # Cross-type still works
    assert md.get("related_persons") == ["person/p.md"]


def test_noise_point_sorted_by_similarity(daemon_and_vault):
    daemon, vault = daemon_and_vault
    for rel in ["matter/close.md", "matter/less.md", "matter/distant.md", "event/e.md"]:
        _write(vault, rel, rel.split("/")[0])
    records = {
        "matter/close.md": _record("matter/close.md", "matter"),
        "matter/less.md": _record("matter/less.md", "matter"),
        "matter/distant.md": _record("matter/distant.md", "matter"),
        "event/e.md": _record("event/e.md", "event"),
    }

    e_vec = _norm([1.0, 0.0, 0.0])
    close_vec = _norm([0.95, 0.312, 0.0])   # ~0.95
    less_vec = _norm([0.8, 0.6, 0.0])        # ~0.80
    distant_vec = _norm([0.3, 0.95, 0.0])    # ~0.30 below threshold
    paths = list(records.keys())
    vectors = np.asarray([close_vec, less_vec, distant_vec, e_vec], dtype=np.float32)

    daemon._link_noise_points_to_entities(
        noise_paths=["event/e.md"],
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    md = frontmatter.load(vault / "event/e.md").metadata
    # Close first, then less-close. Distant below threshold.
    assert md["related_matters"] == ["matter/close.md", "matter/less.md"]


def test_noise_point_no_entities_is_noop(daemon_and_vault):
    daemon, vault = daemon_and_vault
    _write(vault, "event/a.md", "event")
    _write(vault, "event/b.md", "event")
    records = {
        "event/a.md": _record("event/a.md", "event"),
        "event/b.md": _record("event/b.md", "event"),
    }
    v = _norm([1.0, 0.0])
    paths = list(records.keys())
    vectors = np.asarray([v, v], dtype=np.float32)

    daemon._link_noise_points_to_entities(
        noise_paths=list(records.keys()),
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    # No entity records → no writes
    for p in records:
        md = frontmatter.load(vault / p).metadata
        assert "related_matters" not in md
        assert "related_persons" not in md
