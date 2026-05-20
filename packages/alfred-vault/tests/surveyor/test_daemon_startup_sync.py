"""Tests for daemon._startup_sync — drift detection + idempotent resume."""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from alfred.surveyor.daemon import Daemon
from alfred.surveyor.state import PipelineState, FileState


def _make_daemon(tmp_path: Path) -> Daemon:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "event").mkdir()

    daemon = Daemon.__new__(Daemon)
    daemon._shutdown_requested = False
    daemon.cfg = MagicMock()
    daemon.cfg.vault.path = vault
    daemon.cfg.labeler.max_concurrent = 8
    daemon.cfg.labeler.min_cluster_size_to_label = 2
    daemon.state = PipelineState(state_path=tmp_path / "state.json")
    daemon.watcher = MagicMock()
    daemon.embedder = MagicMock()
    daemon.embedder.process_diff = AsyncMock(return_value={})
    daemon.clusterer = MagicMock()
    daemon.labeler = MagicMock()
    daemon.writer = MagicMock()
    # Bypass cluster_and_label — tested separately
    daemon._cluster_and_label = AsyncMock()
    return daemon


@pytest.mark.asyncio
async def test_startup_sync_cold_start_embeds_everything(tmp_path):
    """No prior state → every on-disk file is 'new' and goes through embedder."""
    daemon = _make_daemon(tmp_path)
    vault = daemon.cfg.vault.path
    (vault / "event" / "a.md").write_text("---\ntype: event\n---\nbody\n")
    (vault / "event" / "b.md").write_text("---\ntype: event\n---\nbody\n")

    daemon.watcher.full_scan.return_value = {
        "event/a.md": "md5-a",
        "event/b.md": "md5-b",
    }

    await daemon._startup_sync()

    call = daemon.embedder.process_diff.await_args
    # positional args: (new, changed, deleted)
    new_paths, changed_paths, deleted_paths = call.args
    assert sorted(new_paths) == ["event/a.md", "event/b.md"]
    assert changed_paths == []
    assert deleted_paths == []


@pytest.mark.asyncio
async def test_startup_sync_picks_up_drift(tmp_path):
    """Files on disk but absent from state (Rapali's drift) are detected as new."""
    daemon = _make_daemon(tmp_path)
    vault = daemon.cfg.vault.path
    (vault / "event" / "existing.md").write_text("x")
    (vault / "event" / "drifted.md").write_text("x")
    # State knows only about existing.md
    daemon.state.update_file("event/existing.md", "md5-existing")

    daemon.watcher.full_scan.return_value = {
        "event/existing.md": "md5-existing",
        "event/drifted.md": "md5-drifted",
    }

    await daemon._startup_sync()

    new_paths, changed_paths, deleted_paths = daemon.embedder.process_diff.await_args.args
    assert new_paths == ["event/drifted.md"]
    assert changed_paths == []
    assert deleted_paths == []


@pytest.mark.asyncio
async def test_startup_sync_is_idempotent_when_state_matches_disk(tmp_path):
    """Resume case: state already matches disk → no re-embed fires."""
    daemon = _make_daemon(tmp_path)
    vault = daemon.cfg.vault.path
    (vault / "event" / "a.md").write_text("x")
    daemon.state.update_file("event/a.md", "md5-a")

    daemon.watcher.full_scan.return_value = {"event/a.md": "md5-a"}

    await daemon._startup_sync()

    new_paths, changed_paths, deleted_paths = daemon.embedder.process_diff.await_args.args
    assert new_paths == []
    assert changed_paths == []
    assert deleted_paths == []


@pytest.mark.asyncio
async def test_startup_sync_detects_changed_md5(tmp_path):
    """File modified while surveyor was down → reported as changed."""
    daemon = _make_daemon(tmp_path)
    vault = daemon.cfg.vault.path
    (vault / "event" / "a.md").write_text("x")
    daemon.state.update_file("event/a.md", "md5-old")

    daemon.watcher.full_scan.return_value = {"event/a.md": "md5-new"}

    await daemon._startup_sync()

    new_paths, changed_paths, deleted_paths = daemon.embedder.process_diff.await_args.args
    assert new_paths == []
    assert changed_paths == ["event/a.md"]
    assert deleted_paths == []


@pytest.mark.asyncio
async def test_startup_sync_detects_deleted_files(tmp_path):
    """File in state but no longer on disk → reported as deleted."""
    daemon = _make_daemon(tmp_path)
    daemon.state.update_file("event/was_here.md", "md5")

    # Nothing on disk now
    daemon.watcher.full_scan.return_value = {}

    await daemon._startup_sync()

    new_paths, changed_paths, deleted_paths = daemon.embedder.process_diff.await_args.args
    assert new_paths == []
    assert changed_paths == []
    assert deleted_paths == ["event/was_here.md"]


@pytest.mark.asyncio
async def test_startup_sync_saves_state_after_embed_phase(tmp_path):
    """Checkpoint: state.save() called BEFORE labeling so embed work
    survives a crash in _cluster_and_label."""
    daemon = _make_daemon(tmp_path)
    save_order: list[str] = []
    original_save = daemon.state.save

    def _traced_save():
        save_order.append("save")
        return original_save()

    daemon.state.save = _traced_save

    async def _trace_label(_records, newly_added_entity_paths=None):
        save_order.append("cluster_and_label")

    daemon._cluster_and_label = _trace_label
    daemon.watcher.full_scan.return_value = {}

    await daemon._startup_sync()

    # Two saves total: one after embed, one after labeling.
    assert save_order.count("save") == 2
    # The pre-labeling save must happen before _cluster_and_label runs.
    assert save_order.index("save") < save_order.index("cluster_and_label")
