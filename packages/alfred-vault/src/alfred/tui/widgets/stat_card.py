"""Per-tool stat card for the Status screen."""

from __future__ import annotations

from textual.widget import Widget
from rich.text import Text

from alfred.tui.data import TOOL_COLORS


class StatCard(Widget):
    """Displays a set of key-value stats for one tool."""

    def __init__(self, tool: str, **kwargs) -> None:
        super().__init__(**kwargs)
        self.tool = tool
        self._stats: list[tuple[str, str]] = []
        self.add_class(f"tool-{tool}")

    def set_stats(self, stats: list[tuple[str, str]]) -> None:
        """Update displayed stats as (label, value) pairs."""
        self._stats = stats
        self.refresh()

    def render(self) -> Text:
        color = TOOL_COLORS.get(self.tool, "white")
        t = Text()
        t.append(f"  {self.tool.capitalize()}\n", style=f"bold {color}")
        t.append("\n")
        for label, value in self._stats:
            t.append(f"  {label}: ", style="dim")
            t.append(f"{value}\n", style="bold")
        return t
