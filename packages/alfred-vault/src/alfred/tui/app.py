"""AlfredApp — main Textual application for the live TUI dashboard."""

from __future__ import annotations

import multiprocessing
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable

from textual.app import App
from textual.message import Message

from alfred.tui.data import (
    DashboardData,
    FeedEntry,
    MutationEntry,
    ToolHealth,
    WorkerFeed,
    WorkerInfo,
    parse_log_line,
    parse_audit_line,
    update_health,
    interpret_and_feed,
    read_stats,
    compute_feed_health,
)
from alfred.tui.screens.dashboard import DashboardScreen
from alfred.tui.screens.logs import LogScreen
from alfred.tui.screens.mutations import MutationsScreen
from alfred.tui.screens.status import StatusScreen
from alfred.tui.widgets.confirm_dialog import ConfirmDialog


class AlfredApp(App):
    """Interactive TUI for alfred daemon monitoring."""

    CSS_PATH = "styles/alfred.tcss"

    BINDINGS = [
        ("d", "switch_screen('dashboard')", "Dashboard"),
        ("l", "switch_screen('logs')", "Logs"),
        ("m", "switch_screen('mutations')", "Mutations"),
        ("s", "switch_screen('status')", "Status"),
        ("r", "restart_worker", "Restart"),
        ("q", "request_quit", "Quit"),
    ]

    def __init__(
        self,
        tools: list[str],
        processes: dict[str, Any],
        restart_counts: dict[str, int],
        start_process: Callable[[str], Any],
        sentinel_path: Path | None,
        log_dir: Path,
        state_dir: Path,
        max_restarts: int = 5,
        missing_deps_exit: int = 78,
        version: str = "0.2.0",
    ) -> None:
        super().__init__()
        self._tools = tools
        self._processes = processes
        self._restart_counts = restart_counts
        self._start_process = start_process
        self._sentinel_path = sentinel_path
        self._log_dir = log_dir
        self._state_dir = state_dir
        self._max_restarts = max_restarts
        self._missing_deps_exit = missing_deps_exit
        self._version = version

        # Data layer
        self._data = DashboardData()
        self._data.start_time = time.time()

        for tool in tools:
            p = processes.get(tool)
            self._data.workers[tool] = WorkerInfo(
                name=tool,
                status="running" if (p and p.is_alive()) else "pending",
                pid=p.pid if p else None,
                restart_count=restart_counts.get(tool, 0),
            )
            self._data.health[tool] = ToolHealth()
            self._data.feeds[tool] = WorkerFeed()

        # File positions for tailing
        self._log_positions: dict[str, int] = {}
        self._audit_position: int = 0
        self._initial_log_done = False

        # Active tools (can shrink if deps missing)
        self._active_tools = list(tools)

        # Pre-create screens
        self._dashboard_screen = DashboardScreen(tools)
        self._log_screen = LogScreen(tools)
        self._mutations_screen = MutationsScreen()
        self._status_screen = StatusScreen(tools)

    def on_mount(self) -> None:
        # Install screens
        self.install_screen(self._dashboard_screen, name="dashboard")
        self.install_screen(self._log_screen, name="logs")
        self.install_screen(self._mutations_screen, name="mutations")
        self.install_screen(self._status_screen, name="status")

        # Push default screen
        self.push_screen("dashboard")

        # Set up pollers
        self.set_interval(0.5, self._poll_logs)
        self.set_interval(2.0, self._poll_audit)
        self.set_interval(10.0, self._poll_stats)
        self.set_interval(0.25, self._check_workers)
        self.set_interval(1.0, self._update_uptime)
        self.set_interval(5.0, self._check_sentinel)

    # ------------------------------------------------------------------
    # Screen switching
    # ------------------------------------------------------------------

    def action_switch_screen(self, screen_name: str) -> None:
        self.switch_screen(screen_name)

    # ------------------------------------------------------------------
    # Restart / Quit actions
    # ------------------------------------------------------------------

    def action_restart_worker(self) -> None:
        # Find the focused worker card
        focused = self.focused
        if focused is None:
            self.notify("Focus a worker card first (1-4)", severity="warning")
            return

        from alfred.tui.widgets.worker_card import WorkerCard

        card = focused if isinstance(focused, WorkerCard) else None
        if card is None:
            self.notify("Focus a worker card first (1-4)", severity="warning")
            return

        tool = card.tool

        def on_confirm(result: bool) -> None:
            if result:
                self._do_restart(tool)

        self.push_screen(
            ConfirmDialog(
                f"Restart {tool.capitalize()}?",
                f"This will terminate and restart the {tool} worker process.",
            ),
            on_confirm,
        )

    def _do_restart(self, tool: str) -> None:
        p = self._processes.get(tool)
        if p and p.is_alive():
            p.terminate()
            p.join(timeout=3)
            if p.is_alive():
                p.kill()

        new_p = self._start_process(tool)
        self._processes[tool] = new_p
        w = self._data.workers.get(tool)
        if w:
            w.status = "running"
            w.pid = new_p.pid
        self.notify(f"{tool.capitalize()} restarted (pid {new_p.pid})", severity="information")

    def action_request_quit(self) -> None:
        def on_confirm(result: bool) -> None:
            if result:
                self.exit()

        self.push_screen(
            ConfirmDialog(
                "Quit Alfred?",
                "All worker processes will be terminated.",
            ),
            on_confirm,
        )

    # ------------------------------------------------------------------
    # Pollers
    # ------------------------------------------------------------------

    def _poll_logs(self) -> None:
        """Tail log files and feed entries to the data layer + widgets."""
        first_cycle = not self._initial_log_done
        new_entries: list[FeedEntry] = []

        for tool in self._active_tools:
            path = self._log_dir / f"{tool}.log"
            if not path.exists():
                continue
            try:
                size = path.stat().st_size
                pos = self._log_positions.get(tool, 0)
                if size < pos:
                    pos = 0
                if size == pos:
                    continue
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    f.seek(pos)
                    new_text = f.read()
                    self._log_positions[tool] = f.tell()

                for line in new_text.splitlines():
                    entry = parse_log_line(line, tool)
                    if entry is None:
                        continue
                    if not first_cycle:
                        update_health(self._data.health[tool], entry)
                    fe = interpret_and_feed(
                        tool,
                        entry,
                        self._data.feeds[tool],
                        self._data.health[tool],
                        self._data.workers.get(tool),
                    )
                    if fe is not None and not first_cycle:
                        new_entries.append(fe)
            except OSError:
                continue

        if first_cycle:
            self._initial_log_done = True

        # Push to UI
        if new_entries:
            self._push_feed_entries(new_entries)

    def _push_feed_entries(self, entries: list[FeedEntry]) -> None:
        """Push feed entries to the dashboard cards and log screen."""
        # Dashboard cards
        if isinstance(self.screen, DashboardScreen):
            for fe in entries:
                card = self._dashboard_screen.get_card(fe.tool)
                if card:
                    card.push_feed_entry(fe)

        # Always feed to log screen
        for fe in entries:
            self._log_screen.add_entry(fe)

    def _poll_audit(self) -> None:
        """Tail audit log and feed mutations."""
        audit_path = self._log_dir / "vault_audit.log"
        if not audit_path.exists():
            return

        try:
            size = audit_path.stat().st_size
            if size < self._audit_position:
                self._audit_position = 0
            if size == self._audit_position:
                return
            with open(audit_path, "r", encoding="utf-8", errors="replace") as f:
                f.seek(self._audit_position)
                new_text = f.read()
                self._audit_position = f.tell()
        except OSError:
            return

        new_muts: list[MutationEntry] = []
        for line in new_text.splitlines():
            me = parse_audit_line(line)
            if me:
                self._data.mutations.appendleft(me)
                new_muts.append(me)

        if new_muts:
            # Update mutation strip on dashboard
            strip = self._dashboard_screen.mutation_strip
            if strip is not None:
                strip.set_mutations(list(self._data.mutations)[:8])
            # Update mutations screen
            for me in new_muts:
                self._mutations_screen.add_mutation(me)

    def _poll_stats(self) -> None:
        """Read state JSON files and update stats."""
        self._data.stats = read_stats(self._state_dir)
        self._status_screen.update_stats(self._data.stats)

    def _check_workers(self) -> None:
        """Check worker process health and handle restarts."""
        now = time.monotonic()

        for tool in list(self._active_tools):
            p = self._processes.get(tool)
            if not p:
                continue
            w = self._data.workers[tool]

            if p.is_alive():
                w.status = "running"
                w.pid = p.pid
            elif w.status != "restarting":
                exit_code = p.exitcode
                w.exit_code = exit_code
                w.pid = None

                if exit_code == self._missing_deps_exit:
                    w.status = "stopped"
                    self._active_tools = [t for t in self._active_tools if t != tool]
                    self.notify(
                        f"{tool.capitalize()} stopped: missing dependencies",
                        severity="error",
                    )
                    continue

                w.last_death = now
                self._restart_counts[tool] = self._restart_counts.get(tool, 0) + 1
                w.restart_count = self._restart_counts[tool]

                if self._restart_counts[tool] <= self._max_restarts:
                    w.status = "restarting"
                    self.notify(
                        f"{tool.capitalize()} crashed (exit {exit_code}), restarting...",
                        severity="warning",
                    )
                else:
                    w.status = "stopped"
                    self.notify(
                        f"{tool.capitalize()} exceeded restart limit",
                        severity="error",
                    )

        # Restart dead workers after cooldown
        restart_cooldown = 5.0
        for tool in list(self._active_tools):
            w = self._data.workers.get(tool)
            if w and w.status == "restarting" and (now - w.last_death) >= restart_cooldown:
                new_p = self._start_process(tool)
                self._processes[tool] = new_p
                w.status = "running"
                w.pid = new_p.pid

        # Update dashboard cards
        if isinstance(self.screen, DashboardScreen):
            for tool in self._active_tools:
                card = self._dashboard_screen.get_card(tool)
                w = self._data.workers.get(tool)
                feed = self._data.feeds.get(tool)
                if card and w and feed:
                    card.update_from_feed(w, feed)

    def _update_uptime(self) -> None:
        """Update the stats bar with current uptime and totals."""
        elapsed = int(time.time() - self._data.start_time)

        active = sum(
            1 for w in self._data.workers.values() if w.status == "running"
        )
        total_errors = sum(f.errors for f in self._data.feeds.values())
        total_warnings = sum(f.warnings for f in self._data.feeds.values())

        bar = self._dashboard_screen.stats_bar
        if bar is not None:
            bar.version = self._version
            bar.uptime_secs = elapsed
            bar.active_workers = active
            bar.total_workers = len(self._data.workers)
            bar.total_errors = total_errors
            bar.total_warnings = total_warnings

    def _check_sentinel(self) -> None:
        """Check for shutdown sentinel file (alfred down)."""
        if self._sentinel_path and self._sentinel_path.exists():
            self.exit()
