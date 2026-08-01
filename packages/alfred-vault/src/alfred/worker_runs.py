"""Durable worker-run claimant (#407).

ctrl-api enqueues manual runs (janitor fix / curator process / distiller
run) as JSON records under ``$ALFRED_DATA_DIR/state/worker-runs/`` and
answers 202 with a status URL — but until this module, NOTHING claimed
them: runs sat ``queued`` forever (two on home since 2026-07-23) and every
dashboard trigger was a silent no-op.

This is the executor half of that ledger. A single thread inside the
``alfred up`` supervisor polls the directory, claims queued runs by
atomically rewriting the record (same dot-prefixed ``.tmp`` + rename
discipline ctrl's ledger.ts uses — its directory listing skips those
names), executes the mapped CLI, heartbeats while the child runs, and
finishes the record with ``succeeded``/``failed`` + exit code.

Single-claimant by design: ctrl-api never claims, and only one vault
daemon runs per tenant, so claiming needs no cross-process locking —
the atomic rename is belt enough.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import structlog

log = structlog.get_logger("alfred.worker_runs")

POLL_INTERVAL_SECONDS = 15
HEARTBEAT_INTERVAL_SECONDS = 45
RUN_TIMEOUT_SECONDS = 6 * 3600  # mirrors the ledger's run_timeout_seconds


def runs_directory() -> Path:
    return Path(os.environ.get("ALFRED_DATA_DIR", "/alfred-data")) / "state" / "worker-runs"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _atomic_write(path: Path, record: dict[str, Any]) -> None:
    tmp = path.parent / f".{path.stem}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
    tmp.write_text(json.dumps(record) + "\n", encoding="utf-8")
    tmp.replace(path)


def _touch(record: dict[str, Any]) -> None:
    record["reliability"]["write_sequence"] = int(record["reliability"].get("write_sequence") or 0) + 1
    record["timestamps"]["updated_at"] = _now()


def _command_for(record: dict[str, Any], config_path: str | None) -> list[str] | None:
    """Map a run record to its CLI invocation; None = unsupported worker."""
    base = ["alfred"]
    if config_path:
        base += ["--config", config_path]
    worker = record.get("worker")
    inp = record.get("input") or {}
    if worker == "janitor":
        return base + ["janitor", "fix"]
    if worker == "distiller":
        cmd = base + ["distiller", "run"]
        if inp.get("project"):
            cmd += ["--project", str(inp["project"])]
        return cmd
    # curator: the daemon processes the inbox continuously; there is no
    # one-shot CLI yet. Fail the run VISIBLY rather than leaving it queued.
    return None


def _claim(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    now = _now()
    record["state"] = "running"
    ts = record["timestamps"]
    ts["claimed_at"] = now
    ts["started_at"] = now
    ts["heartbeat_at"] = now
    ts["last_progress_at"] = now
    rel = record["reliability"]
    rel["attempt"] = int(rel.get("attempt") or 0) + 1
    rel["claim_id"] = uuid.uuid4().hex
    rel["worker_instance_id"] = f"vault-daemon-{os.getpid()}"
    rel["pid"] = os.getpid()
    _touch(record)
    _atomic_write(path, record)
    return record


def _finish(path: Path, record: dict[str, Any], *, exit_code: int | None, error: str | None = None) -> None:
    now = _now()
    record["state"] = "succeeded" if exit_code == 0 else "failed"
    record["timestamps"]["finished_at"] = now
    record["timestamps"]["last_progress_at"] = now
    if exit_code == 0:
        record["timestamps"]["last_successful_output_at"] = now
    record["reliability"]["exit_code"] = exit_code
    if error:
        record["last_error"] = str(error)[:500]
    _touch(record)
    _atomic_write(path, record)


def _execute(path: Path, record: dict[str, Any], config_path: str | None) -> None:
    cmd = _command_for(record, config_path)
    if cmd is None:
        log.warning("worker_runs.unsupported", run_id=record.get("run_id"), worker=record.get("worker"))
        _finish(path, record, exit_code=1,
                error=f"no one-shot executor for worker={record.get('worker')} (v1: janitor, distiller)")
        return

    log.info("worker_runs.exec", run_id=record.get("run_id"), cmd=" ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    deadline = time.monotonic() + RUN_TIMEOUT_SECONDS
    last_beat = time.monotonic()
    while True:
        rc = proc.poll()
        if rc is not None:
            err = (proc.stderr.read() or b"").decode("utf-8", "replace")[:500] if proc.stderr else None
            _finish(path, record, exit_code=rc, error=err if rc != 0 else None)
            log.info("worker_runs.done", run_id=record.get("run_id"), exit_code=rc)
            return
        if time.monotonic() > deadline:
            proc.kill()
            record["reliability"]["termination_signal"] = "SIGKILL"
            record["state"] = "timed_out"
            record["timestamps"]["finished_at"] = _now()
            _touch(record)
            _atomic_write(path, record)
            log.warning("worker_runs.timeout", run_id=record.get("run_id"))
            return
        if time.monotonic() - last_beat >= HEARTBEAT_INTERVAL_SECONDS:
            record["timestamps"]["heartbeat_at"] = _now()
            record["reliability"]["heartbeat_sequence"] = (
                int(record["reliability"].get("heartbeat_sequence") or 0) + 1
            )
            _touch(record)
            _atomic_write(path, record)
            last_beat = time.monotonic()
        time.sleep(2)


def _scan_once(config_path: str | None) -> int:
    directory = runs_directory()
    if not directory.is_dir():
        return 0
    claimed = 0
    for entry in sorted(directory.iterdir()):
        if entry.name.startswith(".") or not entry.name.endswith(".json"):
            continue
        try:
            record = json.loads(entry.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("worker_runs.unreadable", file=entry.name, err=str(exc)[:120])
            continue
        if not isinstance(record, dict) or record.get("state") != "queued":
            continue
        try:
            record = _claim(entry, record)
            claimed += 1
            _execute(entry, record, config_path)
        except Exception as exc:  # noqa: BLE001 — one bad run must not kill the loop
            log.warning("worker_runs.run_failed", file=entry.name, err=str(exc)[:200])
            try:
                _finish(entry, record, exit_code=1, error=str(exc))
            except Exception:  # noqa: BLE001
                pass
    return claimed


def start_claimant(config_path: str | None) -> threading.Thread:
    """Start the background claim loop; returns the (daemon) thread."""

    def _loop() -> None:
        log.info("worker_runs.claimant_started", dir=str(runs_directory()))
        while True:
            try:
                _scan_once(config_path)
            except Exception as exc:  # noqa: BLE001
                log.warning("worker_runs.scan_error", err=str(exc)[:200])
            time.sleep(POLL_INTERVAL_SECONDS)

    t = threading.Thread(target=_loop, name="alfred-run-claimant", daemon=True)
    t.start()
    return t
