"""Bottom strip showing recent vault mutations."""

from __future__ import annotations

from textual.widget import Widget
from rich.text import Text

from alfred.tui.data import MutationEntry


_OP_SYM = {"create": "+", "modify": "~", "edit": "~", "delete": "-"}
_OP_STYLE = {"create": "green", "modify": "yellow", "edit": "yellow", "delete": "red"}


class MutationStrip(Widget):
    """Renders the last N mutations as a colored strip."""

    DEFAULT_CSS = """
    MutationStrip {
        height: 1;
    }
    """

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._mutations: list[MutationEntry] = []

    def set_mutations(self, muts: list[MutationEntry]) -> None:
        self._mutations = muts[:8]
        self.refresh()

    def render(self) -> Text:
        t = Text()
        if not self._mutations:
            t.append("  No mutations yet", style="dim")
            return t
        t.append("  ")
        for i, m in enumerate(self._mutations):
            if i > 0:
                t.append("  ")
            sym = _OP_SYM.get(m.op, "?")
            sty = _OP_STYLE.get(m.op, "white")
            t.append(sym, style=f"bold {sty}")
            short = m.path.rsplit("/", 1)[-1] if "/" in m.path else m.path
            t.append(short, style=sty)
        return t
