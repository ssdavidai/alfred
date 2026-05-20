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
        """Compact markdown listing grouped by type."""
        lines: list[str] = []
        for rec_type in sorted(self.records_by_type.keys()):
            records = self.records_by_type[rec_type]
            lines.append(f"### {rec_type} ({len(records)} records)")
            for rec in sorted(records, key=lambda r: r.name):
                status_part = f" — status: {rec.status}" if rec.status else ""
                lines.append(f"- [[{rec.path}|{rec.name}]]{status_part}")
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
        rel = md_file.relative_to(vault_path)
        parts = rel.parts
        if any(p in ignore for p in parts):
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
