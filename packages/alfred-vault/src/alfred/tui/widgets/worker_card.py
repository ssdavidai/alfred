"""Worker card — composite widget showing one tool's live feed."""

from __future__ import annotations

from textual.widget import Widget
from textual.widgets import RichLog, Static
from textual.reactive import reactive
from rich.text import Text

from alfred.tui.data import (
    TOOL_COLORS,
    SEVERITY_STYLES,
    HEALTH_DISPLAY,
    WorkerFeed,
    WorkerInfo,
    FeedEntry,
    compute_feed_health,
    format_llm_usage,
)


class WorkerCard(Widget, can_focus=True):
    """Composite card for a single worker: header + step + scrollable feed + footer."""

    DEFAULT_CSS = """
    WorkerCard {
        layout: vertical;
    }
    """

    # init=False prevents watchers from firing before compose()
    tool: reactive[str] = reactive("", init=False)
    current_step: reactive[str] = reactive("", init=False)
    health_status: reactive[str] = reactive("pending", init=False)
    pid: reactive[int | None] = reactive(None, init=False)
    llm_usage: reactive[str] = reactive("", init=False)

    def __init__(self, tool: str, **kwargs) -> None:
        super().__init__(**kwargs)
        # Store for use before mount; reactive assignment deferred
        self._init_tool = tool
        self.add_class(f"tool-{tool}")

    def compose(self):
        yield Static("", id="card-header", classes="card-header")
        yield Static("", id="card-step", classes="card-step")
        yield RichLog(
            id="card-feed",
            classes="card-feed",
            highlight=False,
            markup=True,
            wrap=True,
            max_lines=50,
        )
        yield Static("", id="card-footer", classes="card-footer")

    def on_mount(self) -> None:
        # Now child widgets exist — safe to set reactives
        self.tool = self._init_tool
        self._refresh_header()
        self._refresh_step()

    def watch_tool(self, value: str) -> None:
        self._refresh_header()

    def watch_health_status(self, value: str) -> None:
        self._refresh_header()

    def watch_pid(self, value: int | None) -> None:
        self._refresh_header()

    def watch_current_step(self, value: str) -> None:
        self._refresh_step()

    def watch_llm_usage(self, value: str) -> None:
        footer = self.query_one("#card-footer", Static)
        footer.update(value)

    def _refresh_step(self) -> None:
        color = TOOL_COLORS.get(self.tool, "white")
        step_widget = self.query_one("#card-step", Static)
        step_widget.update(Text(self.current_step or "Idle", style=f"bold {color}"))

    def _refresh_header(self) -> None:
        color = TOOL_COLORS.get(self.tool, "white")
        health_label, health_style = HEALTH_DISPLAY.get(
            self.health_status, ("\u25cb ?", "dim")
        )
        t = Text()
        t.append(f"  {self.tool.upper()}", style=f"bold {color}")
        t.append(f"          {health_label}", style=health_style)
        if self.pid:
            t.append(f"   pid {self.pid}", style="dim")
        header = self.query_one("#card-header", Static)
        header.update(t)

    def push_feed_entry(self, entry: FeedEntry) -> None:
        """Append a parsed feed entry to the RichLog."""
        feed = self.query_one("#card-feed", RichLog)
        style = SEVERITY_STYLES.get(entry.severity, "dim")

        t = Text()
        t.append(f"{entry.timestamp}  ", style="dim")
        if entry.severity == "warning":
            t.append("\u26a0 ", style="yellow")
        elif entry.severity == "error":
            t.append("\u2716 ", style="bold red")
        elif entry.severity == "success":
            t.append("\u2713 ", style="green")
        t.append(entry.message, style=style)
        feed.write(t)

    def update_from_feed(self, worker: WorkerInfo, feed: WorkerFeed) -> None:
        """Bulk-update card state from data layer."""
        self.health_status = compute_feed_health(worker, feed)
        self.pid = worker.pid
        self.current_step = feed.current_step or (
            "Watching inbox..." if self.tool == "curator" else "Idle"
        )
        self.llm_usage = format_llm_usage(self.tool, feed)
