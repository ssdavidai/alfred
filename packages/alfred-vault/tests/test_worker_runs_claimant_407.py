"""#407 — the durable worker-run claimant."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from alfred import worker_runs as wr


def _record(run_id="01KYXXXXXXXXXXXXXXXXXXXXXX", worker="janitor", state="queued", inp=None):
    now = "2026-07-23T00:00:00.000Z"
    return {
        "schema_version": 1, "run_id": run_id, "worker": worker, "state": state,
        "input": inp or {},
        "timestamps": {"created_at": now, "queued_at": now, "claimed_at": None,
                       "started_at": None, "heartbeat_at": None, "last_progress_at": None,
                       "last_successful_output_at": None, "finished_at": None, "updated_at": now},
        "reliability": {"attempt": 0, "claim_id": None, "worker_instance_id": None,
                        "pid": None, "effective_jobs": None, "heartbeat_sequence": 0,
                        "write_sequence": 0, "exit_code": None, "termination_signal": None,
                        "recovered_at": None, "recovery_reason": None},
    }


@pytest.fixture
def ledger(tmp_path, monkeypatch):
    d = tmp_path / "state" / "worker-runs"
    d.mkdir(parents=True)
    monkeypatch.setenv("ALFRED_DATA_DIR", str(tmp_path))
    return d


def _write(d: Path, rec: dict) -> Path:
    p = d / f"{rec['run_id']}.json"
    p.write_text(json.dumps(rec))
    return p


class TestCommandMapping:
    def test_janitor(self):
        cmd = wr._command_for(_record(), "/cfg.yaml")
        assert cmd == ["alfred", "--config", "/cfg.yaml", "janitor", "fix"]

    def test_distiller_with_project(self):
        cmd = wr._command_for(_record(worker="distiller", inp={"project": "x"}), None)
        assert cmd == ["alfred", "distiller", "run", "--project", "x"]

    def test_curator_unsupported(self):
        assert wr._command_for(_record(worker="curator"), None) is None


class TestClaimAndFinish:
    def test_queued_run_executes_and_succeeds(self, ledger, monkeypatch):
        rec = _record()
        p = _write(ledger, rec)
        calls = []

        class _P:
            stderr = None
            def __init__(self, cmd, **kw): calls.append(cmd)
            def poll(self): return 0
            def kill(self): pass

        monkeypatch.setattr(wr.subprocess, "Popen", _P)
        claimed = wr._scan_once("/cfg.yaml")
        assert claimed == 1
        out = json.loads(p.read_text())
        assert out["state"] == "succeeded"
        assert out["reliability"]["exit_code"] == 0
        assert out["reliability"]["claim_id"]
        assert out["timestamps"]["claimed_at"] and out["timestamps"]["finished_at"]
        assert out["reliability"]["write_sequence"] >= 2
        assert calls and calls[0][-2:] == ["janitor", "fix"]

    def test_failed_child_marks_failed_with_error(self, ledger, monkeypatch):
        import io
        rec = _record(run_id="01KYYYYYYYYYYYYYYYYYYYYYYY")
        p = _write(ledger, rec)

        class _P:
            stderr = io.BytesIO(b"boom: no gate")
            def __init__(self, cmd, **kw): pass
            def poll(self): return 3
            def kill(self): pass

        monkeypatch.setattr(wr.subprocess, "Popen", _P)
        wr._scan_once(None)
        out = json.loads(p.read_text())
        assert out["state"] == "failed"
        assert out["reliability"]["exit_code"] == 3
        assert "boom" in out["last_error"]

    def test_curator_run_fails_visibly_not_stuck(self, ledger):
        rec = _record(run_id="01KYZZZZZZZZZZZZZZZZZZZZZZ", worker="curator")
        p = _write(ledger, rec)
        wr._scan_once(None)
        out = json.loads(p.read_text())
        assert out["state"] == "failed"
        assert "no one-shot executor" in out["last_error"]

    def test_non_queued_untouched(self, ledger):
        rec = _record(run_id="01KYWWWWWWWWWWWWWWWWWWWWWW", state="running")
        p = _write(ledger, rec)
        assert wr._scan_once(None) == 0
        assert json.loads(p.read_text())["state"] == "running"

    def test_tmp_files_skipped(self, ledger):
        (ledger / ".01KYVVVV.123.abc.tmp").write_text("{}")
        assert wr._scan_once(None) == 0
