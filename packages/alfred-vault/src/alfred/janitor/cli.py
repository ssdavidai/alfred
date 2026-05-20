"""Subcommand implementations for the janitor CLI."""

from __future__ import annotations

import asyncio
from pathlib import Path

from .backends import build_issue_report
from .config import JanitorConfig
from .daemon import run_sweep, run_watch
from .issues import Severity
from .state import JanitorState
from .utils import get_logger

log = get_logger(__name__)


def _init_state(config: JanitorConfig) -> JanitorState:
    state = JanitorState(config.state.path, config.state.max_sweep_history)
    state.load()
    return state


def cmd_scan(config: JanitorConfig, skills_dir: Path, structural_only: bool = False) -> None:
    """Run Phase 1 scan, print issue report, no fixes."""
    state = _init_state(config)
    result = asyncio.run(run_sweep(
        config, state, skills_dir,
        structural_only=True,  # scan never invokes agent
        fix_mode=False,
    ))

    # Print report
    if not result.issues:
        print("No issues found.")
        return

    print(f"\n=== Sweep {result.sweep_id} — {result.timestamp} ===")
    print(f"Files scanned: {result.files_scanned}")
    print(f"Issues found: {result.issues_found}")
    for sev, count in sorted(result.issues_by_severity.items()):
        print(f"  {sev}: {count}")
    print()
    print(build_issue_report(result.issues))


def cmd_fix(config: JanitorConfig, skills_dir: Path, structural_only: bool = False) -> None:
    """Run scan + invoke agent to fix issues."""
    state = _init_state(config)
    result = asyncio.run(run_sweep(
        config, state, skills_dir,
        structural_only=structural_only,
        fix_mode=True,
    ))

    print(f"\n=== Sweep {result.sweep_id} — {result.timestamp} ===")
    print(f"Files scanned: {result.files_scanned}")
    print(f"Issues found: {result.issues_found}")
    print(f"Files fixed: {result.files_fixed}")
    print(f"Files deleted: {result.files_deleted}")
    print(f"Agent invoked: {result.agent_invoked}")

    if result.issues:
        print()
        for sev, count in sorted(result.issues_by_severity.items()):
            print(f"  {sev}: {count}")


def cmd_watch(config: JanitorConfig, skills_dir: Path) -> None:
    """Daemon mode — sweep on interval."""
    state = _init_state(config)
    try:
        asyncio.run(run_watch(config, state, skills_dir))
    except KeyboardInterrupt:
        log.info("daemon.interrupted")
        print("\nStopped.")


def cmd_status(config: JanitorConfig) -> None:
    """Show last sweep result, open issue count, state summary."""
    state = _init_state(config)

    total_files = len(state.files)
    total_ignored = len(state.ignored)
    open_issues: dict[str, int] = {}
    files_with_issues = 0
    files_with_janitor_note = 0

    for fs in state.files.values():
        if fs.open_issues:
            files_with_issues += 1
            for code in fs.open_issues:
                open_issues[code] = open_issues.get(code, 0) + 1

    print(f"=== Janitor Status ===")
    print(f"Tracked files: {total_files}")
    print(f"Ignored files: {total_ignored}")
    print(f"Files with open issues: {files_with_issues}")
    print(f"Total sweeps recorded: {len(state.sweeps)}")
    print(f"Fix log entries: {len(state.fix_log)}")

    if open_issues:
        print(f"\nOpen issues by code:")
        for code, count in sorted(open_issues.items()):
            print(f"  {code}: {count}")

    # Last sweep
    if state.sweeps:
        last = max(state.sweeps.values(), key=lambda s: s.timestamp)
        print(f"\nLast sweep: {last.sweep_id} at {last.timestamp}")
        print(f"  Issues found: {last.issues_found}")
        print(f"  Files fixed: {last.files_fixed}")
        print(f"  Files deleted: {last.files_deleted}")

    # Recent fix log
    if state.fix_log:
        recent = state.fix_log[-5:]
        print(f"\nRecent fix log:")
        for entry in recent:
            print(f"  [{entry.timestamp}] {entry.action} {entry.file} ({entry.issue_code}) — {entry.detail}")


def cmd_history(config: JanitorConfig, limit: int = 10) -> None:
    """Show past sweep results."""
    state = _init_state(config)

    if not state.sweeps:
        print("No sweep history.")
        return

    sorted_sweeps = sorted(state.sweeps.values(), key=lambda s: s.timestamp, reverse=True)
    shown = sorted_sweeps[:limit]

    print(f"=== Sweep History (last {len(shown)}) ===\n")
    print(f"{'ID':<10} {'Timestamp':<28} {'Issues':<8} {'Fixed':<8} {'Deleted':<8}")
    print("-" * 70)
    for sweep in shown:
        print(
            f"{sweep.sweep_id:<10} {sweep.timestamp:<28} "
            f"{sweep.issues_found:<8} {sweep.files_fixed:<8} {sweep.files_deleted:<8}"
        )


def cmd_ignore(config: JanitorConfig, file_path: str, reason: str = "") -> None:
    """Add a file to the ignore list."""
    state = _init_state(config)

    # Normalize path
    rel = file_path.replace("\\", "/")
    state.ignore_file(rel, reason)
    state.save()

    print(f"Ignored: {rel}")
    if reason:
        print(f"  Reason: {reason}")
