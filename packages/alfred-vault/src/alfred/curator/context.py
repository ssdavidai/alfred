"""Build a compact vault context snapshot for the agent prompt."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import frontmatter

from .utils import get_logger

log = get_logger(__name__)


@dataclass
class RecordSummary:
    path: str  # relative to vault root
    name: str
    status: str = ""
    extra: dict[str, str] = field(default_factory=dict)


@dataclass
class VaultContext:
    records_by_type: dict[str, list[RecordSummary]] = field(default_factory=dict)

    @property
    def total_records(self) -> int:
        return sum(len(v) for v in self.records_by_type.values())

    def to_prompt_text(self) -> str:
        """Compact entity index grouped by type.

        Emits a slim name-only index instead of full record listings.
        The LLM only needs entity names for dedup awareness — Stage 2
        Python does the actual filesystem check.
        Ref: ssdavidai/alfred#14 (curator token reduction)
        """
        lines: list[str] = []
        for rec_type in sorted(self.records_by_type.keys()):
            records = self.records_by_type[rec_type]
            names = [r.name for r in sorted(records, key=lambda r: r.name)]
            lines.append(f"### {rec_type} ({len(names)})")
            # Comma-separated names, wrapping at ~120 chars per line
            current_line = ""
            for name in names:
                addition = name if not current_line else f", {name}"
                if current_line and len(current_line) + len(addition) > 120:
                    lines.append(current_line)
                    current_line = name
                else:
                    current_line += addition
            if current_line:
                lines.append(current_line)
            lines.append("")
        return "\n".join(lines)


def build_vault_context(
    vault_path: Path,
    ignore_dirs: list[str] | None = None,
) -> VaultContext:
    """Walk vault, parse frontmatter of every .md, group by type."""
    ignore = set(ignore_dirs or [])
    ignore.add(".obsidian")
    ctx = VaultContext()

    for md_file in vault_path.rglob("*.md"):
        # Skip ignored directories
        rel = md_file.relative_to(vault_path)
        parts = rel.parts
        if any(p in ignore for p in parts):
            continue
        # Skip inbox files
        if parts[0] == "inbox":
            continue

        try:
            post = frontmatter.load(str(md_file))
        except Exception:
            continue

        rec_type = post.metadata.get("type", "")
        if not rec_type:
            continue

        name = md_file.stem
        status = str(post.metadata.get("status", ""))
        rel_path = str(rel).replace("\\", "/")
        # Remove .md extension for wikilink style
        if rel_path.endswith(".md"):
            rel_path = rel_path[:-3]

        summary = RecordSummary(path=rel_path, name=name, status=status)
        ctx.records_by_type.setdefault(rec_type, []).append(summary)

    log.info(
        "context.built",
        types=len(ctx.records_by_type),
        total=ctx.total_records,
    )
    return ctx
