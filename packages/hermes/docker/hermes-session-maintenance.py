#!/usr/bin/env python3
"""Bound Hermes profile session stores and emit early disk alerts.

This is intentionally conservative: it prunes only stale session artifact
subdirectories/files by mtime, then runs best-effort SQLite maintenance on the
workers profile state.db. It never logs session contents.
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path


DEFAULT_RETENTION_DAYS = 2.0
DEFAULT_DISK_ALERT_PERCENT = 80.0
DEFAULT_ALERT_COOLDOWN_SECONDS = 6 * 60 * 60


@dataclass
class PruneStats:
    removed: int = 0
    bytes_reclaimed: int = 0
    errors: int = 0


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        print(f"WARN invalid {name}={raw!r}; using {default}", file=sys.stderr)
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        print(f"WARN invalid {name}={raw!r}; using {default}", file=sys.stderr)
        return default


def _path_size(path: Path) -> int:
    if path.is_file() or path.is_symlink():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    total = 0
    for root, _dirs, files in os.walk(path, onerror=lambda _e: None):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                continue
    return total


def _is_active(path: Path, now: float, min_age_seconds: float) -> bool:
    try:
        return (now - path.stat().st_mtime) < min_age_seconds
    except OSError:
        return True


def prune_sessions(profiles_dir: Path, retention_days: float) -> PruneStats:
    """Prune profile session artifacts older than retention_days by mtime."""
    stats = PruneStats()
    cutoff_seconds = max(0.0, retention_days) * 24 * 60 * 60
    now = time.time()
    if not profiles_dir.exists():
        return stats

    for sessions_dir in profiles_dir.glob("*/sessions"):
        if not sessions_dir.is_dir():
            continue
        for child in sessions_dir.iterdir():
            # Never remove a just-touched artifact; active Hermes runs update
            # their session files while in flight.
            if _is_active(child, now, cutoff_seconds):
                continue
            size = _path_size(child)
            try:
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child)
                else:
                    child.unlink()
                stats.removed += 1
                stats.bytes_reclaimed += size
            except OSError as exc:
                stats.errors += 1
                print(f"WARN failed to prune {child}: {exc}", file=sys.stderr)
    return stats


def maintain_workers_state_db(profiles_dir: Path) -> dict[str, object]:
    """Run best-effort SQLite maintenance on workers/state.db."""
    db = profiles_dir / "workers" / "state.db"
    if not db.exists():
        return {"path": str(db), "present": False}

    before = db.stat().st_size
    outcome: dict[str, object] = {"path": str(db), "present": True, "bytes_before": before}
    try:
        conn = sqlite3.connect(f"file:{db}?mode=rw", uri=True, timeout=2.0)
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.execute("PRAGMA optimize")
            conn.execute("VACUUM")
        finally:
            conn.close()
        outcome["ok"] = True
        outcome["bytes_after"] = db.stat().st_size
    except sqlite3.Error as exc:
        # Live gateways may hold locks. That is acceptable; the next tick will
        # retry. Do not kill Hermes from this maintenance path.
        outcome["ok"] = False
        outcome["error"] = str(exc)
    return outcome


def _cooldown_path(hermes_home: Path, filesystem: str) -> Path:
    safe = filesystem.replace("/", "_").replace(" ", "_") or "root"
    return hermes_home / ".maintenance" / f"disk-alert-{safe}.json"


def maybe_send_disk_alert(hermes_home: Path, threshold_percent: float, cooldown_seconds: int) -> dict[str, object]:
    usage = shutil.disk_usage(hermes_home)
    used_percent = (usage.used / usage.total) * 100 if usage.total else 0.0
    result: dict[str, object] = {
        "path": str(hermes_home),
        "used_percent": round(used_percent, 2),
        "threshold_percent": threshold_percent,
        "alerted": False,
    }
    if used_percent < threshold_percent:
        return result

    cooldown = _cooldown_path(hermes_home, str(hermes_home))
    now = time.time()
    try:
        if cooldown.exists():
            data = json.loads(cooldown.read_text() or "{}")
            if now - float(data.get("sent_at", 0)) < cooldown_seconds:
                result["cooldown"] = True
                return result
    except Exception:
        pass

    message = (
        f"Hermes disk warning: {hermes_home} is {used_percent:.1f}% full "
        f"(threshold {threshold_percent:.0f}%). Session retention ran; inspect "
        "profiles/*/sessions and profiles/workers/state.db if growth continues."
    )
    ok = _post_notification(message)
    result["alerted"] = ok
    result["message"] = message
    if ok:
        cooldown.parent.mkdir(parents=True, exist_ok=True)
        cooldown.write_text(json.dumps({"sent_at": now, "used_percent": used_percent}))
    return result


def _post_notification(message: str) -> bool:
    ctrl_url = os.environ.get("CTRL_API_URL", "http://ctrl-api:3100").rstrip("/")
    aas = os.environ.get("AAS_API_KEY", "").strip()
    if not aas:
        print("WARN disk alert not delivered: AAS_API_KEY is not set", file=sys.stderr)
        return False
    body = json.dumps({
        "message": message,
        "channel": "auto",
        "urgency": "high",
        "source_kind": "hermes-session-maintenance",
        "source_ref": "packages/hermes/docker/hermes-session-maintenance.py",
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{ctrl_url}/api/v1/notifications",
        data=body,
        headers={"Authorization": f"Bearer {aas}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return 200 <= resp.status < 300
    except (urllib.error.URLError, TimeoutError) as exc:
        print(f"WARN disk alert delivery failed: {exc}", file=sys.stderr)
        return False


def main() -> int:
    hermes_home = Path(os.environ.get("HERMES_HOME", "/hermes-state"))
    profiles_dir = hermes_home / "profiles"
    retention_days = _env_float("HERMES_SESSION_RETENTION_DAYS", DEFAULT_RETENTION_DAYS)
    disk_threshold = _env_float("HERMES_DISK_ALERT_PERCENT", DEFAULT_DISK_ALERT_PERCENT)
    cooldown = _env_int("HERMES_DISK_ALERT_COOLDOWN_SECONDS", DEFAULT_ALERT_COOLDOWN_SECONDS)

    pruned = prune_sessions(profiles_dir, retention_days)
    state_db = maintain_workers_state_db(profiles_dir)
    disk = maybe_send_disk_alert(hermes_home, disk_threshold, cooldown)

    print(json.dumps({
        "retention_days": retention_days,
        "sessions": pruned.__dict__,
        "workers_state_db": state_db,
        "disk": disk,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
