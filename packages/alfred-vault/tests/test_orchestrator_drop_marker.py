"""Worker drop visibility — a worker dropped after 5 restarts (or for missing
deps) must leave a DURABLE, machine-readable marker, not just a daemon-log line.

`alfred.orchestrator` imports cleanly in the lane venv (only stdlib +
multiprocessing), so we test the pure status-builder directly. We do NOT spawn
real daemon processes; instead we drive `_build_workers_status` with a fake
process stand-in and a `dropped` registry.
"""

from __future__ import annotations

from alfred.orchestrator import _build_workers_status


class _FakeProc:
    def __init__(self, pid, alive, exitcode=None):
        self.pid = pid
        self._alive = alive
        self.exitcode = exitcode

    def is_alive(self):
        return self._alive


def test_running_worker_reported_running():
    data = _build_workers_status(
        tools=["curator"],
        processes={"curator": _FakeProc(101, alive=True)},
        restart_counts={"curator": 0},
        dropped={},
        pid=1,
        started_at="2026-05-20T00:00:00+00:00",
    )
    assert data["tools"]["curator"]["status"] == "running"
    assert data["tools"]["curator"]["pid"] == 101


def test_dropped_worker_is_visible_even_after_removal_from_tools():
    """The bug: once a worker is removed from `tools` it vanished from
    workers.json entirely. After the fix a dropped worker carries a terminal
    `status: dropped` in the tools map AND an entry in the top-level `dropped`
    map with a human-readable reason."""
    dropped = {
        "surveyor": {
            "reason": "exceeded restart limit (5)",
            "exit_code": 1,
            "restarts": 6,
            "dropped_at": "2026-05-20T01:00:00+00:00",
        }
    }
    data = _build_workers_status(
        tools=["curator"],  # surveyor already removed from the active list
        processes={"curator": _FakeProc(101, alive=True)},
        restart_counts={"curator": 0, "surveyor": 6},
        dropped=dropped,
        pid=1,
        started_at="2026-05-20T00:00:00+00:00",
    )
    # Top-level durable marker.
    assert "surveyor" in data["dropped"]
    assert data["dropped"]["surveyor"]["reason"] == "exceeded restart limit (5)"
    assert data["dropped"]["surveyor"]["exit_code"] == 1
    # And still surfaced in the tools map (which the Ink TUI iterates).
    assert data["tools"]["surveyor"]["status"] == "dropped"
    assert data["tools"]["surveyor"]["pid"] is None
    assert data["tools"]["surveyor"]["restarts"] == 6


def test_missing_deps_drop_is_visible():
    dropped = {
        "surveyor": {
            "reason": "missing optional dependencies",
            "exit_code": 78,
            "restarts": 0,
            "dropped_at": "2026-05-20T01:00:00+00:00",
        }
    }
    data = _build_workers_status(
        tools=["curator"],
        processes={"curator": _FakeProc(101, alive=True)},
        restart_counts={"curator": 0},
        dropped=dropped,
        pid=1,
        started_at="2026-05-20T00:00:00+00:00",
    )
    assert data["dropped"]["surveyor"]["reason"] == "missing optional dependencies"
    assert data["tools"]["surveyor"]["status"] == "dropped"


def test_no_dropped_workers_yields_empty_marker():
    data = _build_workers_status(
        tools=["curator"],
        processes={"curator": _FakeProc(101, alive=True)},
        restart_counts={"curator": 0},
        dropped={},
        pid=1,
        started_at="2026-05-20T00:00:00+00:00",
    )
    assert data["dropped"] == {}
