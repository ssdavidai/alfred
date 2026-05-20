"""Mutations screen — searchable vault mutation history table."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import DataTable, Footer, Static

from alfred.tui.data import MutationEntry


_OP_STYLE = {"create": "green", "modify": "yellow", "edit": "yellow", "delete": "red"}


class MutationsScreen(Screen):
    """Sortable DataTable of vault mutations."""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._mutations: list[MutationEntry] = []
        self._composed = False
        self._dirty = False  # new data arrived before compose

    def compose(self) -> ComposeResult:
        yield Static("", id="mutations-header")
        yield DataTable(id="mutations-table")
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one("#mutations-table", DataTable)
        table.add_columns("Time", "Tool", "Op", "Path")
        table.cursor_type = "row"
        table.zebra_stripes = True
        self._composed = True
        if self._dirty:
            self._rebuild_table()
            self._dirty = False

    def add_mutation(self, mut: MutationEntry) -> None:
        """Append a single new mutation (safe to call before compose)."""
        self._mutations.insert(0, mut)
        if not self._composed:
            self._dirty = True
            return
        table = self.query_one("#mutations-table", DataTable)
        table.add_row(mut.timestamp, mut.tool, mut.op, mut.path)
        self._update_header()

    def _rebuild_table(self) -> None:
        table = self.query_one("#mutations-table", DataTable)
        table.clear()
        for m in self._mutations:
            table.add_row(m.timestamp, m.tool, m.op, m.path)
        self._update_header()

    def _update_header(self) -> None:
        header = self.query_one("#mutations-header", Static)
        header.update(f"  Vault Mutations — {len(self._mutations)} total")
