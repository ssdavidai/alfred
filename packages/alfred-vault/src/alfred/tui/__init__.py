"""Alfred Textual TUI — interactive dashboard for ``alfred up --live``."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable


def run_textual_dashboard(
    tools: list[str],
    processes: dict[str, Any],
    restart_counts: dict[str, int],
    start_process: Callable[[str], Any],
    sentinel_path: Path | None,
    log_dir: Path,
    state_dir: Path,
    max_restarts: int = 5,
    missing_deps_exit: int = 78,
) -> None:
    """Entry point matching the ``run_live_dashboard`` signature from dashboard.py."""
    from alfred.tui.app import AlfredApp

    # Read version from package metadata
    version = "0.2.0"
    try:
        from importlib.metadata import version as pkg_version
        version = pkg_version("alfred-vault")
    except Exception:
        pass

    app = AlfredApp(
        tools=tools,
        processes=processes,
        restart_counts=restart_counts,
        start_process=start_process,
        sentinel_path=sentinel_path,
        log_dir=log_dir,
        state_dir=state_dir,
        max_restarts=max_restarts,
        missing_deps_exit=missing_deps_exit,
        version=version,
    )
    app.run()
