"""Tests for the archive-instead-of-delete behaviour of `_clear_agent_sessions`.

The vault-worker daemons (curator, janitor, distiller) used to wipe their
OpenClaw session directories between runs to avoid session-lock deadlock.
Side effect: every per-call token-usage record (input/output/cacheRead/
cacheWrite/cost — written by openclaw to the jsonl) was permanently destroyed
before anyone could aggregate it, killing fleet-wide cost observability.

The fix moves session files into ``<sessions_dir>/_archive/<run-stamp>/``
instead of unlinking them. These tests exercise that path against a fake
``$HOME`` so we don't touch the real openclaw state.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from alfred.curator.backends.openclaw import (
    _clear_agent_sessions as curator_clear,
)
from alfred.distiller.backends.openclaw import (
    _clear_agent_sessions as distiller_clear,
)
from alfred.janitor.backends.openclaw import (
    _clear_agent_sessions as janitor_clear,
)


@pytest.fixture
def fake_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect Path.home() into a tmp dir for the duration of the test."""
    monkeypatch.setenv("HOME", str(tmp_path))
    # On some platforms Path.home() consults pwd before $HOME — patch it too.
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    return tmp_path


def _seed_session_files(home: Path, agent_id: str) -> Path:
    """Create a sessions dir with a representative jsonl + lock + sessions.json."""
    sessions_dir = home / ".openclaw" / "agents" / agent_id / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    (sessions_dir / "curator-abc123.jsonl").write_text(
        '{"role":"assistant","usage":{"input":42,"output":7,"cost":0.0001}}\n'
    )
    (sessions_dir / "curator-abc123.jsonl.lock").write_text("")
    (sessions_dir / "sessions.json").write_text("{}")
    return sessions_dir


@pytest.mark.parametrize(
    "clear_fn,agent_id",
    [
        (curator_clear, "curator-test"),
        (janitor_clear, "janitor-test"),
        (distiller_clear, "distiller-test"),
    ],
)
def test_clear_agent_sessions_archives_instead_of_deleting(
    clear_fn,
    agent_id: str,
    fake_home: Path,
) -> None:
    sessions_dir = _seed_session_files(fake_home, agent_id)

    # Sanity: files are in place pre-clear.
    assert (sessions_dir / "curator-abc123.jsonl").exists()
    assert (sessions_dir / "curator-abc123.jsonl.lock").exists()
    assert (sessions_dir / "sessions.json").exists()

    clear_fn(agent_id)

    # Top-level files have been moved out of sessions_dir...
    assert not (sessions_dir / "curator-abc123.jsonl").exists()
    assert not (sessions_dir / "curator-abc123.jsonl.lock").exists()
    assert not (sessions_dir / "sessions.json").exists()

    # ...and into a single timestamped folder under _archive/.
    archive_root = sessions_dir / "_archive"
    assert archive_root.exists() and archive_root.is_dir()
    stamps = list(archive_root.iterdir())
    assert len(stamps) == 1, f"expected one archive folder, got {stamps}"
    archived_files = sorted(p.name for p in stamps[0].iterdir())
    assert archived_files == sorted(
        ["curator-abc123.jsonl", "curator-abc123.jsonl.lock", "sessions.json"]
    )

    # The original jsonl payload survives the move — the whole point of the change.
    payload = (stamps[0] / "curator-abc123.jsonl").read_text()
    assert '"input":42' in payload
    assert '"cost":0.0001' in payload


def test_clear_agent_sessions_is_noop_when_dir_missing(fake_home: Path) -> None:
    # No sessions dir for this agent — should not raise, should not create anything.
    curator_clear("nonexistent-agent")
    assert not (fake_home / ".openclaw" / "agents" / "nonexistent-agent").exists()


def test_clear_agent_sessions_does_not_recurse_into_archive(fake_home: Path) -> None:
    """Two back-to-back invocations must not re-archive the prior _archive/ folder."""
    sessions_dir = _seed_session_files(fake_home, "curator-test")

    curator_clear("curator-test")
    first_run_archives = sorted(p.name for p in (sessions_dir / "_archive").iterdir())
    assert len(first_run_archives) == 1

    # Seed a second run's worth of files.
    (sessions_dir / "curator-xyz999.jsonl").write_text(
        '{"role":"assistant","usage":{"input":1,"output":1}}\n'
    )

    curator_clear("curator-test")

    # _archive/ must still be only two stamps deep — the previous archive folder
    # was NOT moved into a nested archive.
    second_run_archives = sorted(p.name for p in (sessions_dir / "_archive").iterdir())
    assert len(second_run_archives) == 2, second_run_archives
    # And no _archive sub-folder should have been treated as a session file.
    for stamp in second_run_archives:
        for entry in (sessions_dir / "_archive" / stamp).iterdir():
            assert entry.name != "_archive"
