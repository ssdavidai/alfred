"""Split bulk conversation exports (ChatGPT, Anthropic) into individual Markdown files.

Detects the export format from JSON structure, parses each conversation into a
readable Markdown transcript with YAML frontmatter, and writes individual files
to the curator inbox for downstream processing.
"""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator


@dataclass
class ConversationFile:
    """A parsed conversation ready to write to disk."""
    filename: str
    frontmatter: dict
    body: str


def detect_format(data: list[dict]) -> str:
    """Auto-detect export format from the first conversation's keys.

    Returns 'chatgpt' or 'anthropic'.
    Raises ValueError if format is unrecognised.
    """
    if not data:
        raise ValueError("Empty conversation list")
    sample = data[0]
    if "mapping" in sample:
        return "chatgpt"
    if "chat_messages" in sample:
        return "anthropic"
    raise ValueError(
        f"Unrecognised export format. Top-level keys: {list(sample.keys())}"
    )


# ---------------------------------------------------------------------------
# ChatGPT parser
# ---------------------------------------------------------------------------

def _walk_chatgpt_tree(mapping: dict) -> list[dict]:
    """Walk the ChatGPT mapping tree from root to leaves in conversation order.

    Returns list of message dicts (skipping nodes without a message).
    """
    # Find root: the node whose parent is None
    root_id = None
    for nid, node in mapping.items():
        if node.get("parent") is None:
            root_id = nid
            break
    if root_id is None:
        return []

    # BFS following first child (linear conversation)
    messages: list[dict] = []
    current = root_id
    while current:
        node = mapping.get(current)
        if node is None:
            break
        msg = node.get("message")
        if msg:
            messages.append(msg)
        children = node.get("children", [])
        current = children[0] if children else None
    return messages


def _epoch_to_iso(ts: float | None) -> str:
    """Convert a Unix epoch timestamp to ISO 8601 string."""
    if ts is None:
        return ""
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def parse_chatgpt(conversations: list[dict]) -> Iterator[ConversationFile]:
    """Parse a ChatGPT export into individual ConversationFile objects."""
    for conv in conversations:
        title = conv.get("title") or "Untitled"
        conv_id = conv.get("conversation_id") or conv.get("id") or ""
        created = _epoch_to_iso(conv.get("create_time"))
        updated = _epoch_to_iso(conv.get("update_time"))
        model = conv.get("default_model_slug") or ""

        mapping = conv.get("mapping", {})
        messages = _walk_chatgpt_tree(mapping)

        # Build body
        lines: list[str] = [f"# {title}", ""]
        for msg in messages:
            role = msg.get("author", {}).get("role", "")
            if role in ("system", "tool"):
                continue
            content = msg.get("content", {})
            # Skip non-text content types that are hidden
            content_type = content.get("content_type", "text")
            if content_type in ("user_editable_context",):
                continue
            parts = content.get("parts", [])
            text_parts = [str(p) for p in parts if isinstance(p, str) and p.strip()]
            if not text_parts:
                continue
            text = "\n\n".join(text_parts)
            lines.append(f"**{role}**: {text}")
            lines.append("")

        # Skip empty conversations (no user/assistant messages)
        if len(lines) <= 2:
            continue

        fm = {
            "source": "chatgpt",
            "title": title,
        }
        if created:
            fm["created"] = created
        if updated:
            fm["updated"] = updated
        if model:
            fm["model"] = model
        if conv_id:
            fm["conversation_id"] = conv_id

        yield ConversationFile(
            filename=sanitize_filename(title, "chatgpt", conv_id),
            frontmatter=fm,
            body="\n".join(lines),
        )


# ---------------------------------------------------------------------------
# Anthropic parser
# ---------------------------------------------------------------------------

def parse_anthropic(conversations: list[dict]) -> Iterator[ConversationFile]:
    """Parse an Anthropic/Claude export into individual ConversationFile objects."""
    for conv in conversations:
        title = conv.get("name") or "Untitled"
        conv_id = conv.get("uuid") or ""
        created = conv.get("created_at") or ""
        updated = conv.get("updated_at") or ""

        messages = conv.get("chat_messages", [])

        lines: list[str] = [f"# {title}", ""]
        for msg in messages:
            sender = msg.get("sender", "")
            text = msg.get("text", "")
            if not text.strip():
                continue
            lines.append(f"**{sender}**: {text}")
            lines.append("")

        if len(lines) <= 2:
            continue

        fm: dict = {
            "source": "claude",
            "title": title,
        }
        if created:
            fm["created"] = created
        if updated:
            fm["updated"] = updated
        if conv_id:
            fm["conversation_id"] = conv_id

        yield ConversationFile(
            filename=sanitize_filename(title, "claude", conv_id),
            frontmatter=fm,
            body="\n".join(lines),
        )


# ---------------------------------------------------------------------------
# Filename & I/O helpers
# ---------------------------------------------------------------------------

_NON_ALNUM = re.compile(r"[^A-Za-z0-9]+")


def sanitize_filename(title: str, source: str, conv_id: str) -> str:
    """Build a safe filename: {source}_{sanitized_title}_{short_id}.md"""
    slug = _NON_ALNUM.sub("_", title).strip("_")[:80]
    short_id = conv_id.replace("-", "")[:8]
    return f"{source}_{slug}_{short_id}.md"


def _render_frontmatter(fm: dict) -> str:
    """Render a simple YAML frontmatter block (no pyyaml dependency needed)."""
    lines = ["---"]
    for key, value in fm.items():
        # Quote strings that might confuse YAML
        if isinstance(value, str) and (":" in value or '"' in value or "\n" in value):
            escaped = value.replace("\\", "\\\\").replace('"', '\\"')
            lines.append(f'{key}: "{escaped}"')
        elif isinstance(value, str):
            lines.append(f"{key}: {value}")
        else:
            lines.append(f"{key}: {value}")
    lines.append("---")
    return "\n".join(lines)


def _strip_frontmatter(raw: str) -> str:
    """Strip YAML frontmatter from content if present."""
    if raw.startswith("---"):
        end = raw.find("---", 3)
        if end != -1:
            return raw[end + 3:].lstrip("\n")
    return raw


def _deduplicate_path(path: Path) -> Path:
    """Append _1, _2, ... if path already exists."""
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    parent = path.parent
    counter = 1
    while path.exists():
        path = parent / f"{stem}_{counter}{suffix}"
        counter += 1
    return path


def ingest_file(
    json_path: Path,
    inbox_path: Path,
    processed_path: Path | None = None,
    dry_run: bool = False,
) -> int:
    """Ingest a bulk conversation export into individual inbox files.

    Returns the number of conversation files written (or that would be written
    in dry-run mode).
    """
    # Read and strip frontmatter if present
    raw_text = json_path.read_text(encoding="utf-8")
    json_text = _strip_frontmatter(raw_text)
    data = json.loads(json_text)

    if not isinstance(data, list):
        raise ValueError(f"Expected a JSON array, got {type(data).__name__}")

    fmt = detect_format(data)
    print(f"Detected format: {fmt} ({len(data)} conversations)")

    if fmt == "chatgpt":
        conversations = parse_chatgpt(data)
    else:
        conversations = parse_anthropic(data)

    count = 0
    for conv in conversations:
        dest = inbox_path / conv.filename
        dest = _deduplicate_path(dest)

        if dry_run:
            print(f"  [dry-run] {dest.name}")
        else:
            content = _render_frontmatter(conv.frontmatter) + "\n\n" + conv.body
            inbox_path.mkdir(parents=True, exist_ok=True)
            dest.write_text(content, encoding="utf-8")
        count += 1

    action = "Would write" if dry_run else "Wrote"
    print(f"{action} {count} conversation files to {inbox_path}")

    # Move original to processed (unless dry-run)
    if not dry_run and processed_path:
        processed_path.mkdir(parents=True, exist_ok=True)
        dest_json = _deduplicate_path(processed_path / json_path.name)
        shutil.move(str(json_path), str(dest_json))
        print(f"Moved original to {dest_json}")

    return count
