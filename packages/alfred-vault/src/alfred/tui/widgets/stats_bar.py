"""Top stats bar: version, uptime, worker count, error/warning totals."""

from __future__ import annotations

import time

from textual.widget import Widget
from textual.reactive import reactive


class StatsBar(Widget):
    """Persistent top bar showing system-wide stats."""

    version: reactive[str] = reactive("0.0.0")
    uptime_secs: reactive[int] = reactive(0)
    active_workers: reactive[int] = reactive(0)
    total_workers: reactive[int] = reactive(0)
    total_errors: reactive[int] = reactive(0)
    total_warnings: reactive[int] = reactive(0)

    def render(self) -> str:
        h, remainder = divmod(self.uptime_secs, 3600)
        m, s = divmod(remainder, 60)
        if h:
            uptime = f"{h}h {m:02d}m"
        else:
            uptime = f"{m}m {s:02d}s"

        parts = [
            f"alfred v{self.version}",
            f"Up: {uptime}",
            f"Workers: {self.active_workers}/{self.total_workers}",
        ]

        if self.total_errors > 0:
            parts.append(f"Errors: {self.total_errors}")
        if self.total_warnings > 0:
            parts.append(f"Warnings: {self.total_warnings}")
        if self.total_errors == 0 and self.total_warnings == 0:
            parts.append("No errors")

        return "    ".join(parts)
