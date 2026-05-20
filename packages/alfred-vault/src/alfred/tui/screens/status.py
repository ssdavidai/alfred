"""Status screen — deep per-tool stats with run history."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Container
from textual.screen import Screen
from textual.widgets import Footer

from alfred.tui.data import ToolStats, short_ago
from alfred.tui.widgets.stat_card import StatCard


class StatusScreen(Screen):
    """2x2 grid of per-tool stat cards."""

    def __init__(self, tools: list[str], **kwargs) -> None:
        super().__init__(**kwargs)
        self.tools = tools
        self._last_stats: ToolStats | None = None
        self._composed = False

    def compose(self) -> ComposeResult:
        with Container(id="status-grid"):
            for tool in self.tools:
                yield StatCard(tool, id=f"stat-{tool}")
        yield Footer()

    def on_mount(self) -> None:
        self._composed = True
        if self._last_stats is not None:
            self._apply_stats(self._last_stats)

    def update_stats(self, stats: ToolStats) -> None:
        """Refresh stat cards (safe to call before compose)."""
        self._last_stats = stats
        if not self._composed:
            return
        self._apply_stats(stats)

    def _apply_stats(self, stats: ToolStats) -> None:
        mapping = {
            "curator": [
                ("Processed", str(stats.curator_processed)),
                ("Last run", short_ago(stats.curator_last_run)),
            ],
            "janitor": [
                ("Tracked", f"{stats.janitor_tracked} files"),
                ("Issues", f"{stats.janitor_issues} open"),
                ("Sweeps", f"{stats.janitor_sweeps} completed"),
            ],
            "distiller": [
                ("Sources", f"{stats.distiller_sources} tracked"),
                ("Learnings", f"{stats.distiller_learnings} created"),
                ("Runs", f"{stats.distiller_runs} completed"),
            ],
            "surveyor": [
                ("Tracked", f"{stats.surveyor_tracked} files"),
                ("Clusters", str(stats.surveyor_clusters)),
                ("Last run", short_ago(stats.surveyor_last_run)),
            ],
        }

        for tool in self.tools:
            try:
                card = self.query_one(f"#stat-{tool}", StatCard)
                card.set_stats(mapping.get(tool, []))
            except Exception:
                pass
