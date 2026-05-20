"""Dashboard screen — 2x2 worker grid with stats bar and mutation strip."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Container
from textual.screen import Screen
from textual.widgets import Footer

from alfred.tui.widgets.worker_card import WorkerCard
from alfred.tui.widgets.stats_bar import StatsBar
from alfred.tui.widgets.mutation_strip import MutationStrip


class DashboardScreen(Screen):
    """Default screen: 2x2 worker grid + stats bar + mutation strip."""

    BINDINGS = [
        ("1", "focus_worker(0)", "Worker 1"),
        ("2", "focus_worker(1)", "Worker 2"),
        ("3", "focus_worker(2)", "Worker 3"),
        ("4", "focus_worker(3)", "Worker 4"),
    ]

    def __init__(self, tools: list[str], **kwargs) -> None:
        super().__init__(**kwargs)
        self.tools = tools
        self._composed = False

    def compose(self) -> ComposeResult:
        yield StatsBar(id="stats-bar")
        with Container(id="worker-grid"):
            for tool in self.tools:
                yield WorkerCard(tool, id=f"card-{tool}")
        yield MutationStrip(id="mutation-strip")
        yield Footer()

    def on_mount(self) -> None:
        self._composed = True

    def on_resize(self, event) -> None:
        if not self._composed:
            return
        grid = self.query_one("#worker-grid")
        if event.size.width < 100:
            grid.add_class("narrow")
        else:
            grid.remove_class("narrow")

    def action_focus_worker(self, index: int) -> None:
        cards = list(self.query(WorkerCard))
        if 0 <= index < len(cards):
            cards[index].focus()

    @property
    def stats_bar(self) -> StatsBar | None:
        if not self._composed:
            return None
        try:
            return self.query_one("#stats-bar", StatsBar)
        except Exception:
            return None

    @property
    def mutation_strip(self) -> MutationStrip | None:
        if not self._composed:
            return None
        try:
            return self.query_one("#mutation-strip", MutationStrip)
        except Exception:
            return None

    def get_card(self, tool: str) -> WorkerCard | None:
        if not self._composed:
            return None
        try:
            return self.query_one(f"#card-{tool}", WorkerCard)
        except Exception:
            return None
