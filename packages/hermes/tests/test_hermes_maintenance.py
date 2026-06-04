"""Static and smoke tests for Hermes profile disk maintenance (GH #241)."""
from pathlib import Path
import os
import sqlite3
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "docker" / "hermes-maintenance.sh"
SUPERVISOR = ROOT / "docker" / "supervisor.sh"
DOCKERFILE = ROOT / "Dockerfile"
RUNBOOK = ROOT.parent.parent / "docs" / "HERMES-DISK-MAINTENANCE.md"


def test_supervisor_runs_maintenance_watchdog():
    src = SUPERVISOR.read_text()
    assert "hermes-maintenance" in src
    assert "/opt/hermes-supervisor/hermes-maintenance.sh" in src
    assert "HERMES_MAINTENANCE_ENABLED" in src


def test_dockerfile_bakes_maintenance_script():
    src = DOCKERFILE.read_text()
    assert "COPY packages/hermes/docker/hermes-maintenance.sh" in src
    assert "/opt/hermes-supervisor/hermes-maintenance.sh" in src
    assert "chmod +x /opt/hermes-supervisor/supervisor.sh" in src


def test_runbook_documents_safe_cleanup_paths():
    src = RUNBOOK.read_text()
    assert "profiles/<profile>/sessions" in src
    assert "profiles/<profile>/state.db" in src
    assert "Stop Hermes first" in src
    assert "Do not delete `auth.json`" in src


def test_maintenance_once_prunes_old_sessions_and_vacuums_state(tmp_path):
    profiles = tmp_path / "profiles"
    sessions = profiles / "workers" / "sessions"
    sessions.mkdir(parents=True)
    stale = sessions / "stale-session"
    fresh = sessions / "fresh-session"
    stale.mkdir()
    fresh.mkdir()

    old = time.time() - (4 * 24 * 60 * 60)
    os.utime(stale, (old, old))

    db = profiles / "workers" / "state.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE t (v TEXT)")
    con.execute("INSERT INTO t VALUES ('ok')")
    con.commit()
    con.close()

    env = os.environ.copy()
    env.update(
        {
            "HERMES_HOME": str(tmp_path),
            "HERMES_SESSION_RETENTION_DAYS": "2",
            "HERMES_STATE_DB_VACUUM_INTERVAL_SECONDS": "0",
            "HERMES_DISK_ALERT_THRESHOLD": "100",
        }
    )
    result = subprocess.run(
        ["bash", str(SCRIPT), "--once"],
        cwd=str(ROOT),
        env=env,
        text=True,
        capture_output=True,
        timeout=20,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert not stale.exists()
    assert fresh.exists()
    con = sqlite3.connect(db)
    assert con.execute("SELECT v FROM t").fetchone() == ("ok",)
    con.close()
