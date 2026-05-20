"""Frontmatter/body parsing and wikilink extraction."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import frontmatter

WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")

# Embed pattern: ![[something.base#Section]] or ![[file]]
EMBED_RE = re.compile(r"!\[\[[^\]]+\]\]")

# KEN dynamic section markers
KEN_DYNAMIC_RE = re.compile(
    r"<!-- KEN:DYNAMIC -->.*?<!-- END KEN:DYNAMIC -->",
    re.DOTALL,
)


@dataclass
class VaultRecord:
    rel_path: str
    frontmatter: dict
    body: str
    record_type: str
    wikilinks: list[str] = field(default_factory=list)


def extract_wikilinks(text: str) -> list[str]:
    """Extract all wikilink targets from text (frontmatter + body)."""
    return WIKILINK_RE.findall(text)


def parse_file(vault_path: Path, rel_path: str) -> VaultRecord:
    """Parse a vault markdown file into a VaultRecord."""
    full_path = vault_path / rel_path
    raw_text = full_path.read_text(encoding="utf-8")
    post = frontmatter.loads(raw_text)

    fm = dict(post.metadata)
    body = post.content
    record_type = fm.get("type", "")

    wikilinks = extract_wikilinks(raw_text)

    return VaultRecord(
        rel_path=rel_path,
        frontmatter=fm,
        body=body,
        record_type=record_type,
        wikilinks=wikilinks,
    )


def stripped_body_length(body: str) -> int:
    """Return body length after stripping embeds, KEN dynamic sections, and whitespace."""
    text = EMBED_RE.sub("", body)
    text = KEN_DYNAMIC_RE.sub("", text)
    # Strip markdown headings that are just structural
    lines = []
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("#") and len(stripped.lstrip("#").strip()) == 0:
            continue
        lines.append(stripped)
    return len("\n".join(lines).strip())
