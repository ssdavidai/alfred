"""Health status indicator widget."""

from __future__ import annotations

from textual.widget import Widget
from textual.reactive import reactive

from alfred.tui.data import HEALTH_DISPLAY


class HealthBadge(Widget):
    """Colored health indicator: idle/working/degraded/failing/stopped/restarting."""

    DEFAULT_CSS = """
    HealthBadge {
        width: auto;
        height: 1;
    }
    """

    health: reactive[str] = reactive("pending")

    def render(self) -> str:
        label, _ = HEALTH_DISPLAY.get(self.health, ("\u25cb ?", "dim"))
        return label

    def watch_health(self, value: str) -> None:
        # Remove old health-* classes, add new one
        for cls in list(self.classes):
            if cls.startswith("health-"):
                self.remove_class(cls)
        self.add_class(f"health-{value}")
