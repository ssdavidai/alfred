"""Process manager — `alfred up` starts all daemons via multiprocessing."""

from __future__ import annotations

import asyncio
import json
import multiprocessing
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _silence_stdio(log_file: str | None = None) -> None:
    """Redirect stdout/stderr away from the terminal in child processes for live mode.

    stderr goes to the log file (if given) so uncaught tracebacks are preserved
    for debugging. stdout goes to devnull.
    """
    sys.stdout = open(os.devnull, "w")  # noqa: SIM115 — kept open for process lifetime
    if log_file:
        sys.stderr = open(log_file, "a")  # noqa: SIM115
    else:
        sys.stderr = sys.stdout


def _run_curator(raw: dict[str, Any], skills_dir: str, suppress_stdout: bool = False) -> None:
    """Curator daemon process entry point."""
    log_cfg = raw.get("logging", {})
    log_file = f"{log_cfg.get('dir', './data')}/curator.log"
    if suppress_stdout:
        _silence_stdio(log_file)
    from alfred.curator.config import load_from_unified
    from alfred.curator.utils import setup_logging
    config = load_from_unified(raw)
    setup_logging(level=log_cfg.get("level", "INFO"), log_file=log_file, suppress_stdout=suppress_stdout)
    from alfred.curator.daemon import run
    asyncio.run(run(config, Path(skills_dir)))


def _run_janitor(raw: dict[str, Any], skills_dir: str, suppress_stdout: bool = False) -> None:
    """Janitor watch daemon process entry point."""
    log_cfg = raw.get("logging", {})
    log_file = f"{log_cfg.get('dir', './data')}/janitor.log"
    if suppress_stdout:
        _silence_stdio(log_file)
    from alfred.janitor.config import load_from_unified
    from alfred.janitor.utils import setup_logging
    config = load_from_unified(raw)
    setup_logging(level=log_cfg.get("level", "INFO"), log_file=log_file, suppress_stdout=suppress_stdout)
    from alfred.janitor.state import JanitorState
    from alfred.janitor.daemon import run_watch
    state = JanitorState(config.state.path, config.state.max_sweep_history)
    state.load()
    asyncio.run(run_watch(config, state, Path(skills_dir)))


def _run_distiller(raw: dict[str, Any], skills_dir: str, suppress_stdout: bool = False) -> None:
    """Distiller watch daemon process entry point."""
    log_cfg = raw.get("logging", {})
    log_file = f"{log_cfg.get('dir', './data')}/distiller.log"
    if suppress_stdout:
        _silence_stdio(log_file)
    from alfred.distiller.config import load_from_unified
    from alfred.distiller.utils import setup_logging
    config = load_from_unified(raw)
    setup_logging(level=log_cfg.get("level", "INFO"), log_file=log_file, suppress_stdout=suppress_stdout)
    from alfred.distiller.state import DistillerState
    from alfred.distiller.daemon import run_watch
    state = DistillerState(config.state.path, config.state.max_run_history)
    state.load()
    asyncio.run(run_watch(config, state, Path(skills_dir)))


_MISSING_DEPS_EXIT = 78  # exit code signaling missing optional dependencies


def _run_surveyor(raw: dict[str, Any], suppress_stdout: bool = False) -> None:
    """Surveyor daemon process entry point."""
    log_cfg = raw.get("logging", {})
    if suppress_stdout:
        _silence_stdio(f"{log_cfg.get('dir', './data')}/surveyor.log")
    try:
        from alfred.surveyor.config import load_from_unified
        from alfred.surveyor.utils import setup_logging
        from alfred.surveyor.daemon import Daemon
    except ImportError as e:
        sys.exit(_MISSING_DEPS_EXIT)

    config = load_from_unified(raw)
    setup_logging(level=log_cfg.get("level", "INFO"), log_file=f"{log_cfg.get('dir', './data')}/surveyor.log", suppress_stdout=suppress_stdout)
    daemon = Daemon(config)
    asyncio.run(daemon.run())


TOOL_RUNNERS = {
    "curator": _run_curator,
    "janitor": _run_janitor,
    "distiller": _run_distiller,
    "surveyor": _run_surveyor,
}


def run_all(
    raw: dict[str, Any],
    only: str | None = None,
    skills_dir: Path | None = None,
    pid_path: Path | None = None,
    live_mode: bool = False,
) -> None:
    """Start selected daemons as child processes with auto-restart."""
    if skills_dir is None:
        from alfred._data import get_skills_dir
        skills_dir = get_skills_dir()

    skills_dir_str = str(skills_dir)

    # Write PID file so ``alfred down`` can find us
    if pid_path is not None:
        from alfred.daemon import write_pid
        write_pid(pid_path, os.getpid())

    # Determine which tools to run
    if only:
        tools = [t.strip() for t in only.split(",")]
    else:
        tools = ["curator", "janitor", "distiller"]
        # Only add surveyor if config section exists
        if "surveyor" in raw:
            tools.append("surveyor")

    # Validate tool names
    for tool in tools:
        if tool not in TOOL_RUNNERS:
            print(f"Unknown tool: {tool}")
            print(f"Available: {', '.join(TOOL_RUNNERS.keys())}")
            sys.exit(1)

    if not live_mode:
        print(f"Starting daemons: {', '.join(tools)}")

    processes: dict[str, multiprocessing.Process] = {}
    restart_counts: dict[str, int] = {}

    suppress_stdout = live_mode

    def start_process(tool: str) -> multiprocessing.Process:
        runner = TOOL_RUNNERS[tool]
        if tool == "surveyor":
            p = multiprocessing.Process(target=runner, args=(raw, suppress_stdout), name=f"alfred-{tool}")
        else:
            p = multiprocessing.Process(target=runner, args=(raw, skills_dir_str, suppress_stdout), name=f"alfred-{tool}")
        p.daemon = True
        p.start()
        if not live_mode:
            print(f"  [{tool}] started (pid {p.pid})")
        return p

    # Start all — stagger by 10s to avoid thundering herd on shared infra
    for i, tool in enumerate(tools):
        if i > 0:
            time.sleep(10)
        processes[tool] = start_process(tool)
        restart_counts[tool] = 0

    # Sentinel file path — ``alfred down`` creates this to signal shutdown
    sentinel_path = pid_path.parent / "alfred.stop" if pid_path else None

    log_dir = Path(raw.get("logging", {}).get("dir", "./data"))
    workers_json_path = log_dir / "workers.json"
    started_at = datetime.now(timezone.utc).isoformat()

    def _write_workers_json() -> None:
        """Write current process status to workers.json for the Ink TUI."""
        data = {
            "pid": os.getpid(),
            "started_at": started_at,
            "tools": {},
        }
        for tool in tools:
            p = processes.get(tool)
            if p is None:
                data["tools"][tool] = {"pid": None, "status": "stopped", "restarts": restart_counts.get(tool, 0)}
                continue
            alive = p.is_alive()
            data["tools"][tool] = {
                "pid": p.pid if alive else None,
                "status": "running" if alive else "stopped",
                "restarts": restart_counts.get(tool, 0),
            }
            if not alive and p.exitcode is not None:
                data["tools"][tool]["exit_code"] = p.exitcode
        try:
            workers_json_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except OSError:
            pass

    # Write initial workers.json
    _write_workers_json()
    last_workers_write = time.monotonic()

    if live_mode:
        # Live TUI dashboard mode — prefer Textual, fall back to Rich Live
        try:
            from alfred.tui import run_textual_dashboard
            run_textual_dashboard(
                tools=tools,
                processes=processes,
                restart_counts=restart_counts,
                start_process=start_process,
                sentinel_path=sentinel_path,
                log_dir=log_dir,
                state_dir=log_dir,
            )
        except ImportError:
            from alfred.dashboard import run_live_dashboard
            run_live_dashboard(
                tools=tools,
                processes=processes,
                restart_counts=restart_counts,
                start_process=start_process,
                sentinel_path=sentinel_path,
                log_dir=log_dir,
                state_dir=log_dir,
            )
    else:
        # Plain text monitor loop
        try:
            while True:
                time.sleep(5)

                # Periodically write workers.json for the Ink TUI
                now = time.monotonic()
                if now - last_workers_write >= 2:
                    _write_workers_json()
                    last_workers_write = now

                # Check for shutdown sentinel
                if sentinel_path and sentinel_path.exists():
                    print("Shutdown sentinel detected, stopping...")
                    break

                for tool in list(tools):
                    p = processes[tool]
                    if not p.is_alive():
                        exit_code = p.exitcode
                        if exit_code == _MISSING_DEPS_EXIT:
                            print(f"  [{tool}] missing dependencies, not restarting")
                            tools = [t for t in tools if t != tool]
                            continue
                        restart_counts[tool] += 1
                        if restart_counts[tool] <= 5:
                            print(f"  [{tool}] exited ({exit_code}), restarting ({restart_counts[tool]}/5)...")
                            processes[tool] = start_process(tool)
                        else:
                            print(f"  [{tool}] exceeded restart limit, giving up")
                            tools = [t for t in tools if t != tool]

                if not tools:
                    print("All daemons failed, exiting.")
                    break
        except KeyboardInterrupt:
            print("\nShutting down...")

    # Terminate child processes
    for tool, p in processes.items():
        if p.is_alive():
            p.terminate()
            p.join(timeout=5)
            if p.is_alive():
                p.kill()
            print(f"  [{tool}] stopped")
    print("All daemons stopped.")

    # Clean up PID file and sentinel
    if pid_path:
        from alfred.daemon import remove_pid
        remove_pid(pid_path)
    if sentinel_path:
        try:
            sentinel_path.unlink(missing_ok=True)
        except OSError:
            pass
    try:
        workers_json_path.unlink(missing_ok=True)
    except OSError:
        pass
