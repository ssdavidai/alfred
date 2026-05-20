"""Daemon persistence — spawn, stop, and manage background Alfred processes.

Uses the re-exec pattern: ``alfred up`` re-launches itself as a detached
background process via ``alfred up --_internal-foreground``.  Cross-platform
(Windows + Unix), pure stdlib — no external dependencies.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path


# ---------------------------------------------------------------------------
# PID file helpers
# ---------------------------------------------------------------------------

def write_pid(pid_path: Path, pid: int) -> None:
    """Write a PID to the given file."""
    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text(str(pid), encoding="utf-8")


def read_pid(pid_path: Path) -> int | None:
    """Read PID from file.  Returns None if missing or malformed."""
    try:
        return int(pid_path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def remove_pid(pid_path: Path) -> None:
    """Remove a PID file if it exists."""
    try:
        pid_path.unlink(missing_ok=True)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Liveness check
# ---------------------------------------------------------------------------

def is_running(pid: int) -> bool:
    """Cross-platform check whether *pid* refers to a running process.

    On Windows ``os.kill(pid, 0)`` actually *kills* the process, so we use
    ctypes ``OpenProcess`` + ``GetExitCodeProcess`` instead.
    """
    if sys.platform == "win32":
        return _is_running_windows(pid)
    else:
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            # Process exists but we lack permission — still alive.
            return True


def _is_running_windows(pid: int) -> bool:
    """Windows-specific liveness check via kernel32."""
    import ctypes
    import ctypes.wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False

    try:
        exit_code = ctypes.wintypes.DWORD()
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return exit_code.value == STILL_ACTIVE
        return False
    finally:
        kernel32.CloseHandle(handle)


# ---------------------------------------------------------------------------
# High-level PID management
# ---------------------------------------------------------------------------

def check_already_running(pid_path: Path) -> int | None:
    """Return PID if Alfred daemon is running, else clean up stale file."""
    pid = read_pid(pid_path)
    if pid is None:
        return None
    # If the PID file points to our own process, it's stale from a previous
    # run (common in containers where PID 1 is reused across restarts).
    if pid == os.getpid():
        remove_pid(pid_path)
        return None
    if is_running(pid):
        return pid
    # Stale PID file — process no longer exists.
    remove_pid(pid_path)
    return None


# ---------------------------------------------------------------------------
# Spawn
# ---------------------------------------------------------------------------

def spawn_daemon(
    config_path: str,
    only: str | None,
    log_file: str,
) -> int:
    """Re-exec Alfred as a detached background process.  Returns the child PID."""
    cmd = [
        sys.executable, "-m", "alfred",
        "--config", config_path,
        "up", "--_internal-foreground",
    ]
    if only:
        cmd.extend(["--only", only])

    log_path = Path(log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    stdout_f = open(log_path, "a", encoding="utf-8")

    kwargs: dict = dict(
        stdin=subprocess.DEVNULL,
        stdout=stdout_f,
        stderr=stdout_f,
    )

    if sys.platform == "win32":
        DETACHED_PROCESS = 0x00000008
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_NO_WINDOW = 0x08000000
        kwargs["creationflags"] = (
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        )
    else:
        kwargs["start_new_session"] = True

    proc = subprocess.Popen(cmd, **kwargs)
    return proc.pid


# ---------------------------------------------------------------------------
# Stop
# ---------------------------------------------------------------------------

def stop_daemon(pid_path: Path) -> bool:
    """Send a shutdown signal to the running daemon.  Returns True if stopped."""
    pid = read_pid(pid_path)
    if pid is None:
        return False
    if not is_running(pid):
        remove_pid(pid_path)
        return False

    # Create sentinel file as belt-and-suspenders (for Windows compatibility)
    sentinel = pid_path.parent / "alfred.stop"
    sentinel.write_text("stop", encoding="utf-8")

    if sys.platform == "win32":
        _stop_windows(pid)
    else:
        _stop_unix(pid)

    # Clean up
    remove_pid(pid_path)
    try:
        sentinel.unlink(missing_ok=True)
    except OSError:
        pass

    return True


def _stop_unix(pid: int) -> None:
    """Graceful SIGTERM, then SIGKILL after timeout."""
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return

    for _ in range(50):  # 5 seconds
        time.sleep(0.1)
        if not is_running(pid):
            return

    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _stop_windows(pid: int) -> None:
    """Send CTRL_BREAK_EVENT (graceful), then TerminateProcess (force)."""
    import ctypes

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]

    # Try graceful shutdown via CTRL_BREAK_EVENT
    try:
        kernel32.GenerateConsoleCtrlEvent(1, pid)  # CTRL_BREAK_EVENT = 1
    except OSError:
        pass

    for _ in range(50):  # 5 seconds
        time.sleep(0.1)
        if not is_running(pid):
            return

    # Force kill
    PROCESS_TERMINATE = 0x0001
    handle = kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
    if handle:
        kernel32.TerminateProcess(handle, 1)
        kernel32.CloseHandle(handle)
