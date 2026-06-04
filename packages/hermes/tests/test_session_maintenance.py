"""Session retention guardrails for GH #241.

The maintenance helper must keep workers session artifacts/state.db bounded
without touching fresh in-flight sessions or requiring a live Hermes gateway.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import sys
import time
from collections import namedtuple
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent.parent / "docker" / "hermes-session-maintenance.py"
SUPERVISOR = Path(__file__).resolve().parent.parent / "docker" / "supervisor.sh"
DOCKERFILE = Path(__file__).resolve().parent.parent / "Dockerfile"
COMPOSE = Path(__file__).resolve().parents[2] / "docker-compose.yaml"


def _load_module():
    spec = importlib.util.spec_from_file_location("session_maintenance", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_prunes_only_stale_session_artifacts(tmp_path):
    mod = _load_module()
    sessions = tmp_path / "profiles" / "workers" / "sessions"
    old = sessions / "old-run"
    fresh = sessions / "fresh-run"
    old.mkdir(parents=True)
    fresh.mkdir(parents=True)
    (old / "payload.txt").write_text("old payload")
    (fresh / "payload.txt").write_text("fresh payload")

    old_time = time.time() - (3 * 24 * 60 * 60)
    os.utime(old, (old_time, old_time))
    os.utime(old / "payload.txt", (old_time, old_time))

    stats = mod.prune_sessions(tmp_path / "profiles", retention_days=2)

    assert stats.removed == 1
    assert stats.bytes_reclaimed >= len("old payload")
    assert not old.exists()
    assert fresh.exists()


def test_workers_state_db_maintenance_preserves_valid_db(tmp_path):
    mod = _load_module()
    db = tmp_path / "profiles" / "workers" / "state.db"
    db.parent.mkdir(parents=True)
    conn = sqlite3.connect(db)
    conn.execute("create table t(id integer primary key, value text)")
    conn.execute("insert into t(value) values ('ok')")
    conn.commit()
    conn.close()

    outcome = mod.maintain_workers_state_db(tmp_path / "profiles")

    assert outcome["present"] is True
    assert outcome["ok"] is True
    conn = sqlite3.connect(db)
    try:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert conn.execute("select value from t").fetchone()[0] == "ok"
    finally:
        conn.close()


def test_disk_alert_uses_cooldown_and_notification(monkeypatch, tmp_path):
    mod = _load_module()
    sent: list[str] = []
    monkeypatch.setattr(mod, "_post_notification", lambda message: sent.append(message) or True)
    DiskUsage = namedtuple("usage", "total used free")
    monkeypatch.setattr(mod.shutil, "disk_usage", lambda _p: DiskUsage(total=100, used=90, free=10))

    first = mod.maybe_send_disk_alert(tmp_path, threshold_percent=80, cooldown_seconds=3600)
    second = mod.maybe_send_disk_alert(tmp_path, threshold_percent=80, cooldown_seconds=3600)

    assert first["alerted"] is True
    assert second["alerted"] is False
    assert second["cooldown"] is True
    assert len(sent) == 1
    assert "Hermes disk warning" in sent[0]


def test_supervisor_runs_maintenance_loop_and_image_copies_helper():
    supervisor = SUPERVISOR.read_text()
    dockerfile = DOCKERFILE.read_text()
    compose = COMPOSE.read_text()

    assert "run_session_maintenance_loop" in supervisor
    assert "hermes-session-maintenance.py" in supervisor
    assert "HERMES_SESSION_MAINTENANCE_INTERVAL_SECONDS" in supervisor
    assert "COPY packages/hermes/docker/hermes-session-maintenance.py" in dockerfile
    assert "AAS_API_KEY=${AAS_API_KEY}" in compose
