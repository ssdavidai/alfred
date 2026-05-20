"""Tests for daemon._link_entities_in_clusters."""
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


def _make_config(vault: Path, state_path: Path, threshold: float = 0.75, max_per: int = 5) -> PipelineConfig:
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


def _write(vault: Path, rel: str, record_type: str, name: str = "x") -> None:
    full = vault / rel
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(
        f"---\ntype: {record_type}\nname: {name}\n---\n\nbody\n",
        encoding="utf-8",
    )


def _record(rel: str, rt: str) -> VaultRecord:
    return VaultRecord(rel_path=rel, frontmatter={"type": rt, "name": "x"}, body="", record_type=rt)


def _normalise(vec: list[float]) -> list[float]:
    a = np.asarray(vec, dtype=np.float32)
    n = float(np.linalg.norm(a))
    return (a / n).tolist() if n > 0 else a.tolist()


@pytest.fixture
def daemon_and_vault(tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    state_path = tmp_path / "state.json"
    cfg = _make_config(vault, state_path)

    # Stub daemon — we only need writer + cfg + state for the test.
    daemon = Daemon.__new__(Daemon)
    daemon.cfg = cfg
    daemon.state = PipelineState(state_path=cfg.state.path)
    daemon.writer = VaultWriter(vault_path=vault, state=daemon.state)
    daemon.embedder = MagicMock()
    daemon.watcher = MagicMock()
    daemon.clusterer = MagicMock()
    daemon.labeler = MagicMock()
    daemon._shutdown_requested = False
    return daemon, vault


def test_links_events_to_matter_above_threshold(daemon_and_vault):
    daemon, vault = daemon_and_vault
    # Create vault records
    _write(vault, "matter/erste.md", "matter")
    _write(vault, "event/a.md", "event")
    _write(vault, "event/b.md", "event")
    daemon.state.update_file("matter/erste.md", "h1")
    daemon.state.update_file("event/a.md", "h2")
    daemon.state.update_file("event/b.md", "h3")

    records = {
        "matter/erste.md": _record("matter/erste.md", "matter"),
        "event/a.md": _record("event/a.md", "event"),
        "event/b.md": _record("event/b.md", "event"),
    }
    # Unit-norm vectors; matter is "baseline"; event/a is 0.9 similar; event/b is 0.3 similar.
    matter_vec = _normalise([1.0, 0.0, 0.0, 0.0])
    a_vec = _normalise([0.9, 0.436, 0.0, 0.0])  # cos ≈ 0.9
    b_vec = _normalise([0.3, 0.95, 0.0, 0.0])   # cos ≈ 0.3

    paths = ["matter/erste.md", "event/a.md", "event/b.md"]
    vectors = np.asarray([matter_vec, a_vec, b_vec], dtype=np.float32)
    cluster_members = {0: paths[:]}

    daemon._link_entities_in_clusters(
        changed_cluster_ids={0},
        cluster_members=cluster_members,
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    # event/a (sim 0.9) should be linked, event/b (sim 0.3) should NOT be linked
    a_md = frontmatter.load(vault / "event/a.md").metadata
    b_md = frontmatter.load(vault / "event/b.md").metadata
    assert a_md.get("related_matters") == ["matter/erste.md"]
    assert "related_matters" not in b_md


def test_separates_entity_types_into_own_fields(daemon_and_vault):
    daemon, vault = daemon_and_vault
    _write(vault, "matter/m.md", "matter")
    _write(vault, "person/p.md", "person")
    _write(vault, "org/o.md", "org")
    _write(vault, "project/x.md", "project")
    _write(vault, "event/e.md", "event")
    for p in ["matter/m.md", "person/p.md", "org/o.md", "project/x.md", "event/e.md"]:
        daemon.state.update_file(p, "h")

    records = {
        "matter/m.md": _record("matter/m.md", "matter"),
        "person/p.md": _record("person/p.md", "person"),
        "org/o.md": _record("org/o.md", "org"),
        "project/x.md": _record("project/x.md", "project"),
        "event/e.md": _record("event/e.md", "event"),
    }
    # All 5 same vector so all sims = 1.0
    v = _normalise([1.0, 0.0])
    paths = list(records.keys())
    vectors = np.asarray([v] * 5, dtype=np.float32)
    cluster_members = {7: paths[:]}

    daemon._link_entities_in_clusters(
        changed_cluster_ids={7},
        cluster_members=cluster_members,
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    e_md = frontmatter.load(vault / "event/e.md").metadata
    assert e_md.get("related_matters") == ["matter/m.md"]
    assert e_md.get("related_persons") == ["person/p.md"]
    assert e_md.get("related_orgs") == ["org/o.md"]
    assert e_md.get("related_projects") == ["project/x.md"]


def test_cluster_without_entities_noop(daemon_and_vault):
    daemon, vault = daemon_and_vault
    _write(vault, "event/a.md", "event")
    _write(vault, "event/b.md", "event")
    records = {
        "event/a.md": _record("event/a.md", "event"),
        "event/b.md": _record("event/b.md", "event"),
    }
    v = _normalise([1.0])
    daemon._link_entities_in_clusters(
        changed_cluster_ids={0},
        cluster_members={0: list(records.keys())},
        records=records,
        all_paths=list(records.keys()),
        all_vectors=np.asarray([v, v], dtype=np.float32),
    )
    # No writes
    assert "related_matters" not in frontmatter.load(vault / "event/a.md").metadata
    assert "related_matters" not in frontmatter.load(vault / "event/b.md").metadata


def test_multiple_matters_ranked_by_similarity(daemon_and_vault):
    daemon, vault = daemon_and_vault
    _write(vault, "matter/close.md", "matter")
    _write(vault, "matter/less-close.md", "matter")
    _write(vault, "matter/distant.md", "matter")
    _write(vault, "event/e.md", "event")
    for p in ["matter/close.md", "matter/less-close.md", "matter/distant.md", "event/e.md"]:
        daemon.state.update_file(p, "h")

    records = {
        "matter/close.md": _record("matter/close.md", "matter"),
        "matter/less-close.md": _record("matter/less-close.md", "matter"),
        "matter/distant.md": _record("matter/distant.md", "matter"),
        "event/e.md": _record("event/e.md", "event"),
    }
    # event/e most similar to close (0.95), less to less-close (0.8), distant (0.3 — below threshold)
    e_vec = _normalise([1.0, 0.0, 0.0])
    close_vec = _normalise([0.95, 0.312, 0.0])
    less_vec = _normalise([0.8, 0.6, 0.0])
    distant_vec = _normalise([0.3, 0.95, 0.0])
    paths = list(records.keys())
    vectors = np.asarray([close_vec, less_vec, distant_vec, e_vec], dtype=np.float32)

    daemon._link_entities_in_clusters(
        changed_cluster_ids={0},
        cluster_members={0: paths[:]},
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    e_md = frontmatter.load(vault / "event/e.md").metadata
    # Distant is below threshold (0.75); close + less-close both above
    # Order by similarity desc: close first, then less-close.
    assert e_md["related_matters"] == ["matter/close.md", "matter/less-close.md"]


def test_respects_max_per_record(tmp_path):
    # Shrink max_per_record to 2, expect only top 2 similarity hits
    vault = tmp_path / "vault"
    vault.mkdir(exist_ok=True)
    state_path = tmp_path / "state.json"
    cfg = _make_config(vault, state_path, threshold=0.0, max_per=2)
    daemon = Daemon.__new__(Daemon)
    daemon.cfg = cfg
    daemon.state = PipelineState(state_path=cfg.state.path)
    daemon.writer = VaultWriter(vault_path=vault, state=daemon.state)

    _write(vault, "event/e.md", "event")
    matter_paths = []
    for i in range(5):
        _write(vault, f"matter/m{i}.md", "matter")
        matter_paths.append(f"matter/m{i}.md")
        daemon.state.update_file(f"matter/m{i}.md", "h")
    daemon.state.update_file("event/e.md", "h")

    records = {p: _record(p, "matter") for p in matter_paths}
    records["event/e.md"] = _record("event/e.md", "event")

    e_vec = _normalise([1.0, 0.0, 0.0, 0.0])
    # Decreasing similarity
    matter_vecs = [
        _normalise([1.0, 0.01, 0.0, 0.0]),    # 0.99
        _normalise([0.9, 0.2, 0.0, 0.0]),     # ≈0.97
        _normalise([0.8, 0.4, 0.0, 0.0]),     # ≈0.89
        _normalise([0.6, 0.6, 0.0, 0.0]),     # ≈0.71
        _normalise([0.4, 0.8, 0.0, 0.0]),     # ≈0.45
    ]
    paths = matter_paths + ["event/e.md"]
    vectors = np.asarray(matter_vecs + [e_vec], dtype=np.float32)

    daemon._link_entities_in_clusters(
        changed_cluster_ids={0},
        cluster_members={0: paths[:]},
        records=records,
        all_paths=paths,
        all_vectors=vectors,
    )

    e_md = frontmatter.load(vault / "event/e.md").metadata
    assert e_md["related_matters"] == ["matter/m0.md", "matter/m1.md"]
