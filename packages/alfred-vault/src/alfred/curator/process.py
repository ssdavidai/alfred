"""Batch processor with Rich TUI for processing all unprocessed inbox files.

Reuses the daemon's internals (_load_skill, _create_backend, _process_file)
and the curator state system for resumability. Supports parallel processing
via -j/--jobs flag (default: 4 concurrent workers).
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)
from rich.table import Table
from rich.text import Text

if TYPE_CHECKING:
    from .config import CuratorConfig


@dataclass
class ProcessingResult:
    filename: str
    success: bool
    files_created: int = 0
    files_modified: int = 0
    error: str = ""
    elapsed_seconds: float = 0.0


@dataclass
class BatchStats:
    total: int = 0
    processed: int = 0
    created: int = 0
    modified: int = 0
    failed: int = 0
    skipped: int = 0
    start_time: float = 0.0
    active_workers: int = 0
    recent_results: list[ProcessingResult] = field(default_factory=list)


class ProcessingTUI:
    """Rich TUI for batch processing progress."""

    def __init__(self, total_files: int, concurrency: int, max_recent: int = 8) -> None:
        self.stats = BatchStats(total=total_files, start_time=time.time())
        self.concurrency = concurrency
        self.max_recent = max_recent
        self.active_files: list[str] = []
        self.progress = Progress(
            SpinnerColumn(),
            TextColumn("Processing"),
            BarColumn(bar_width=30),
            TaskProgressColumn(),
            TimeElapsedColumn(),
            TimeRemainingColumn(),
        )
        self.task_id = self.progress.add_task("batch", total=total_files)

    def add_active(self, filename: str) -> None:
        self.active_files.append(filename)
        self.stats.active_workers = len(self.active_files)

    def remove_active(self, filename: str) -> None:
        if filename in self.active_files:
            self.active_files.remove(filename)
        self.stats.active_workers = len(self.active_files)

    def update(self, result: ProcessingResult) -> None:
        self.stats.processed += 1
        if result.success:
            self.stats.created += result.files_created
            self.stats.modified += result.files_modified
        else:
            self.stats.failed += 1
        self.stats.recent_results.append(result)
        if len(self.stats.recent_results) > self.max_recent:
            self.stats.recent_results = self.stats.recent_results[-self.max_recent :]
        self.progress.advance(self.task_id)
        self.remove_active(result.filename)

    def skip(self) -> None:
        self.stats.skipped += 1
        self.progress.advance(self.task_id)

    def render(self) -> Panel:
        s = self.stats
        elapsed = time.time() - s.start_time
        rate = s.processed / elapsed * 60 if elapsed > 0 and s.processed > 0 else 0

        progress_renderable = self.progress

        # Elapsed / ETA
        elapsed_m = int(elapsed // 60)
        elapsed_h = elapsed_m // 60
        elapsed_m_rem = elapsed_m % 60
        if elapsed_h > 0:
            elapsed_str = f"{elapsed_h}h {elapsed_m_rem:02d}m"
        else:
            elapsed_str = f"{elapsed_m_rem}m {int(elapsed % 60):02d}s"

        remaining = s.total - s.processed - s.skipped
        if rate > 0:
            eta_min = remaining / rate
            eta_h = int(eta_min // 60)
            eta_m = int(eta_min % 60)
            eta_str = f"~{eta_h}h {eta_m:02d}m" if eta_h > 0 else f"~{eta_m}m"
        else:
            eta_str = "calculating..."

        time_line = Text(f"  Elapsed: {elapsed_str}  |  ETA: {eta_str}")

        # Active workers
        active_lines = []
        for fn in self.active_files[:self.concurrency]:
            active_lines.append(Text(f"    ⠋ {fn[:58]}", style="cyan"))
        workers_header = Text(f"  Workers: {s.active_workers}/{self.concurrency}", style="bold cyan")

        # Stats grid
        stats_grid = Table.grid(padding=(0, 3))
        stats_grid.add_row(
            f"  Processed  {s.processed}",
            f"Created  {s.created}",
            f"Modified  {s.modified}",
        )
        stats_grid.add_row(
            f"  Failed     {s.failed}",
            f"Skipped  {s.skipped}",
            f"Rate  {rate:.1f}/min",
        )

        # Recent results
        recent_lines = []
        for r in reversed(self.stats.recent_results[-6:]):
            name = r.filename[:44]
            if r.success:
                parts = []
                if r.files_created:
                    parts.append(f"+{r.files_created} created")
                if r.files_modified:
                    parts.append(f"+{r.files_modified} modified")
                detail = "  ".join(parts) if parts else "no changes"
                recent_lines.append(
                    Text(f"  ✓ {name}  {detail}  ~{r.elapsed_seconds:.0f}s", style="green")
                )
            else:
                err = r.error[:30] if r.error else "unknown"
                recent_lines.append(
                    Text(f"  ✗ {name}  FAILED ({err})", style="red")
                )

        render_parts: list = [
            progress_renderable,
            time_line,
            Text(""),
            workers_header,
            *active_lines,
            Text(""),
            stats_grid,
        ]
        if recent_lines:
            render_parts.append(Text(""))
            render_parts.append(Text("  Recent:", style="bold"))
            render_parts.extend(recent_lines)

        return Panel(
            Group(*render_parts),
            title="Alfred Curator Batch Process",
            border_style="blue",
        )


def _print_summary(console: Console, stats: BatchStats) -> None:
    elapsed = time.time() - stats.start_time
    elapsed_min = elapsed / 60
    rate = stats.processed / elapsed_min if elapsed_min > 0 else 0
    remaining = stats.total - stats.processed - stats.skipped

    summary = Table.grid(padding=(0, 1))
    summary.add_row(f"  Processed: {stats.processed}/{stats.total}")
    summary.add_row(f"  Created:   {stats.created} vault records")
    summary.add_row(f"  Modified:  {stats.modified} vault records")
    summary.add_row(f"  Failed:    {stats.failed}")
    summary.add_row(f"  Skipped:   {stats.skipped}")
    summary.add_row(f"  Time:      {elapsed_min:.1f} minutes")
    summary.add_row(f"  Rate:      {rate:.1f} files/min")
    if remaining > 0:
        summary.add_row("")
        summary.add_row(f"  {remaining} files remaining.")
        summary.add_row("  Run `alfred process` to continue.")

    console.print(Panel(summary, title="Summary", border_style="green"))


async def _process_one(
    inbox_file: Path,
    backend,
    skill_text: str,
    config: CuratorConfig,
    state_mgr,
    state_lock: asyncio.Lock,
    tui: ProcessingTUI,
    live: Live,
) -> None:
    """Process a single file and update TUI. Designed for concurrent use."""
    from .daemon import _process_file

    filename = inbox_file.name
    tui.add_active(filename)
    live.update(tui.render())

    t0 = time.time()
    result = ProcessingResult(filename=filename, success=False)

    try:
        await _process_file(inbox_file, backend, skill_text, config, state_mgr)

        async with state_lock:
            entry = state_mgr.state.processed.get(filename)
        if entry:
            result.success = True
            result.files_created = len(entry.files_created)
            result.files_modified = len(entry.files_modified)
        else:
            result.success = False
            result.error = "read/parse failure"
    except Exception as e:
        result.success = False
        result.error = str(e)[:100]

    result.elapsed_seconds = time.time() - t0
    tui.update(result)
    live.update(tui.render())


def _cleanup_stale_openclaw_locks() -> int:
    """Remove stale .lock files from OpenClaw session dirs where the holding PID is dead."""
    import json as _json

    cleaned = 0
    sessions_root = Path.home() / ".openclaw" / "agents"
    if not sessions_root.exists():
        return 0
    for lock_file in sessions_root.rglob("*.lock"):
        try:
            content = lock_file.read_text().strip()
            # Lock files are JSON: {"pid": 12345, "createdAt": "..."}
            pid = None
            try:
                data = _json.loads(content)
                pid = data.get("pid")
            except (_json.JSONDecodeError, AttributeError):
                # Fallback: try plain text "pid=NNNN" or bare number
                pid_str = content.split("=")[-1].strip() if "=" in content else content
                if pid_str.isdigit():
                    pid = int(pid_str)

            if pid is not None:
                try:
                    os.kill(pid, 0)  # Check if process exists
                except OSError:
                    lock_file.unlink(missing_ok=True)
                    cleaned += 1
            else:
                # Can't determine PID — remove if file is old (> 5 min)
                age = time.time() - lock_file.stat().st_mtime
                if age > 300:
                    lock_file.unlink(missing_ok=True)
                    cleaned += 1
        except Exception:
            pass
    return cleaned


async def run_batch(
    config: CuratorConfig,
    skills_dir: Path,
    limit: int | None = None,
    dry_run: bool = False,
    concurrency: int = 4,
) -> BatchStats:
    """Batch-process all unprocessed inbox files with a Rich TUI."""
    from .daemon import _create_backend, _load_skill
    from .state import StateManager
    from .watcher import InboxWatcher

    console = Console()

    # Clean up stale OpenClaw session locks from previous runs
    cleaned = _cleanup_stale_openclaw_locks()
    if cleaned:
        console.print(f"Cleaned up {cleaned} stale OpenClaw session lock(s).")

    # OpenClaw ties each agent to a single session file, so concurrent
    # invocations of the same agent deadlock.  Force serial processing.
    if config.agent.backend == "openclaw" and concurrency > 1:
        console.print(
            "[yellow]OpenClaw backend: forcing concurrency=1 "
            "(agent sessions cannot run in parallel)[/yellow]"
        )
        concurrency = 1

    # Load skill
    skill_text = _load_skill(skills_dir)

    # Create one backend per worker for full isolation
    backends = [_create_backend(config) for _ in range(concurrency)]

    # Load state
    state_mgr = StateManager(config.state.path)
    state_mgr.load()
    state_lock = asyncio.Lock()

    # Find unprocessed files
    watcher = InboxWatcher(inbox_path=config.vault.inbox_path)
    unprocessed = watcher.full_scan(
        state_processed=set(state_mgr.state.processed.keys()),
    )
    unprocessed.sort(key=lambda p: p.name)

    if limit:
        unprocessed = unprocessed[:limit]

    total = len(unprocessed)
    console.print(f"Found [bold]{total}[/bold] unprocessed files in inbox.")
    if concurrency > 1:
        console.print(f"Using [bold]{concurrency}[/bold] concurrent workers.")

    if total == 0:
        console.print("Nothing to process.")
        return BatchStats()

    if dry_run:
        console.print("\n[bold]Dry run[/bold] — would process:")
        for f in unprocessed:
            console.print(f"  {f.name}")
        console.print(f"\nTotal: {total} files")
        return BatchStats(total=total)

    # Suppress console logging to avoid corrupting TUI
    root_logger = logging.getLogger()
    saved_handlers = []
    for h in root_logger.handlers[:]:
        if isinstance(h, logging.StreamHandler) and h.stream in (sys.stdout, sys.stderr):
            saved_handlers.append(h)
            root_logger.removeHandler(h)

    tui = ProcessingTUI(total, concurrency)
    stats = tui.stats

    # Semaphore controls max concurrent workers
    sem = asyncio.Semaphore(concurrency)
    # Round-robin backend assignment
    backend_idx = 0

    async def worker(inbox_file: Path, backend) -> None:
        async with sem:
            filename = inbox_file.name
            # Skip if already processed or file gone
            if state_mgr.state.is_processed(filename) or not inbox_file.exists():
                tui.skip()
                return
            await _process_one(
                inbox_file, backend, skill_text, config, state_mgr, state_lock, tui, live,
            )

    try:
        with Live(tui.render(), console=console, refresh_per_second=4) as live:
            tasks = []
            for inbox_file in unprocessed:
                backend = backends[backend_idx % concurrency]
                backend_idx += 1
                tasks.append(asyncio.create_task(worker(inbox_file, backend)))

            # Wait for all, but handle cancellation gracefully
            await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        for h in saved_handlers:
            root_logger.addHandler(h)

        console.print()
        _print_summary(console, stats)

    return stats
