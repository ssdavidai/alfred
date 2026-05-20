"""Log screen — merged, filtered log viewer."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal
from textual.screen import Screen
from textual.widgets import Footer, RichLog, Select, Checkbox
from rich.text import Text

from alfred.tui.data import FeedEntry, SEVERITY_STYLES, TOOL_COLORS


class LogScreen(Screen):
    """Full log viewer with tool and severity filters."""

    def __init__(self, tools: list[str], **kwargs) -> None:
        super().__init__(**kwargs)
        self.tools = tools
        self._tool_filter: str = "all"
        self._severity_filter: str = "all"
        self._auto_scroll: bool = True
        self._entries: list[FeedEntry] = []
        self._composed = False
        self._dirty = False

    def compose(self) -> ComposeResult:
        tool_options = [("All tools", "all")] + [
            (t.capitalize(), t) for t in self.tools
        ]
        severity_options = [
            ("All severity", "all"),
            ("Info", "info"),
            ("Success", "success"),
            ("Warning", "warning"),
            ("Error", "error"),
        ]
        with Horizontal(id="log-controls"):
            yield Select(tool_options, value="all", id="tool-filter")
            yield Select(severity_options, value="all", id="severity-filter")
            yield Checkbox("Auto-scroll", value=True, id="auto-scroll")
        yield RichLog(
            id="log-feed",
            highlight=False,
            markup=True,
            wrap=True,
            max_lines=500,
        )
        yield Footer()

    def on_mount(self) -> None:
        self._composed = True
        if self._dirty:
            self._rebuild_log()
            self._dirty = False

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id == "tool-filter":
            self._tool_filter = str(event.value)
        elif event.select.id == "severity-filter":
            self._severity_filter = str(event.value)
        self._rebuild_log()

    def on_checkbox_changed(self, event: Checkbox.Changed) -> None:
        if event.checkbox.id == "auto-scroll":
            self._auto_scroll = event.value
            log = self.query_one("#log-feed", RichLog)
            log.auto_scroll = self._auto_scroll

    def add_entry(self, entry: FeedEntry) -> None:
        """Add a new entry (safe to call before compose)."""
        self._entries.append(entry)
        if len(self._entries) > 500:
            self._entries = self._entries[-500:]
        if not self._composed:
            self._dirty = True
            return
        if self._matches_filter(entry):
            self._write_entry(entry)

    def _matches_filter(self, entry: FeedEntry) -> bool:
        if self._tool_filter != "all" and entry.tool != self._tool_filter:
            return False
        if self._severity_filter != "all" and entry.severity != self._severity_filter:
            return False
        return True

    def _rebuild_log(self) -> None:
        """Rebuild the log from scratch with current filters."""
        log = self.query_one("#log-feed", RichLog)
        log.clear()
        for entry in self._entries:
            if self._matches_filter(entry):
                self._write_entry(entry)

    def _write_entry(self, entry: FeedEntry) -> None:
        log = self.query_one("#log-feed", RichLog)
        style = SEVERITY_STYLES.get(entry.severity, "dim")
        tool_color = TOOL_COLORS.get(entry.tool, "white")

        t = Text()
        t.append(f"{entry.timestamp}  ", style="dim")
        t.append(f"{entry.tool:<10}", style=tool_color)
        if entry.severity == "warning":
            t.append("\u26a0 ", style="yellow")
        elif entry.severity == "error":
            t.append("\u2716 ", style="bold red")
        elif entry.severity == "success":
            t.append("\u2713 ", style="green")
        else:
            t.append("  ")
        t.append(entry.message, style=style)
        log.write(t)
