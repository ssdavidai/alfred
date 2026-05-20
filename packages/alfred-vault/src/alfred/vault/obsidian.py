"""Optional Obsidian CLI integration — uses Obsidian's live index when available.

Obsidian 1.12+ ships a CLI that exposes the running app's indexes, search,
and property management. When Obsidian is running, these operations are faster
and more accurate than filesystem-based equivalents. All functions return None
on failure so callers can fall back gracefully.

Requires: ``obsidian`` on PATH and Obsidian running with an open vault.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from functools import lru_cache


@lru_cache(maxsize=1)
def is_available() -> bool:
    """Check if the Obsidian CLI is installed and responsive."""
    if not shutil.which("obsidian"):
        return False
    try:
        result = subprocess.run(
            ["obsidian", "vault", "json"],
            capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


def _run(args: list[str], timeout: int = 10) -> str | None:
    """Run an Obsidian CLI command and return stdout, or None on failure."""
    try:
        result = subprocess.run(
            ["obsidian", *args],
            capture_output=True, text=True, timeout=timeout,
        )
        if result.returncode != 0:
            return None
        return result.stdout
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


def _run_json(args: list[str], timeout: int = 10) -> dict | list | None:
    """Run an Obsidian CLI command with JSON output, return parsed result."""
    raw = _run([*args, "json"], timeout=timeout)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return None


# --- Read operations ---


def read_properties(file: str) -> dict | None:
    """Read frontmatter properties via Obsidian's parser.

    Args:
        file: Wikilink-style name (e.g. "person/John Smith") or exact path.

    Returns:
        Dict of properties, or None if Obsidian CLI unavailable/failed.
    """
    return _run_json(["properties", f'file="{file}"'])


def read_file(file: str) -> str | None:
    """Read file content via Obsidian CLI.

    Args:
        file: Wikilink-style name or path.

    Returns:
        File content string, or None on failure.
    """
    return _run([f'read', f'file="{file}"'])


# --- Search operations ---


def search_content(query: str, limit: int = 50) -> list[dict] | None:
    """Full-text search using Obsidian's live index.

    Args:
        query: Search query (supports Obsidian query operators).
        limit: Max results.

    Returns:
        List of result dicts, or None if unavailable.
    """
    return _run_json(["search", f'query="{query}"', f"limit={limit}"])


def search_files(folder: str | None = None, ext: str = "md") -> list[dict] | None:
    """List files in vault, optionally filtered by folder.

    Returns:
        List of file info dicts, or None if unavailable.
    """
    args = ["files"]
    if folder:
        args.append(f'folder="{folder}"')
    args.append(f"ext={ext}")
    return _run_json(args)


# --- Write operations ---


def set_property(file: str, name: str, value: str) -> bool:
    """Set a frontmatter property via Obsidian CLI.

    Returns:
        True if successful, False otherwise.
    """
    result = _run(["property:set", f'file="{file}"', f'name="{name}"', f'value="{value}"'])
    return result is not None


def append_content(file: str, content: str) -> bool:
    """Append content to a file via Obsidian CLI.

    Returns:
        True if successful, False otherwise.
    """
    result = _run(["append", f'file="{file}"', f'content="{content}"'])
    return result is not None


def create_from_template(name: str, template: str) -> bool:
    """Create a file from an Obsidian template.

    Args:
        name: New file name (without .md).
        template: Template name.

    Returns:
        True if successful, False otherwise.
    """
    result = _run(["create", f'name="{name}"', f'template="{template}"', "silent"])
    return result is not None


def move_file(file: str, to: str) -> bool:
    """Move/rename a file via Obsidian CLI (updates all wikilinks automatically).

    This is a major advantage over filesystem rename — Obsidian updates all
    references across the vault.

    Returns:
        True if successful, False otherwise.
    """
    result = _run(["move", f'file="{file}"', f'to="{to}"'])
    return result is not None


def delete_file(file: str, permanent: bool = False) -> bool:
    """Delete a file via Obsidian CLI.

    Args:
        file: File to delete.
        permanent: If True, skip trash. Default moves to Obsidian trash.

    Returns:
        True if successful, False otherwise.
    """
    args = ["delete", f'file="{file}"']
    if permanent:
        args.append("permanent")
    result = _run(args)
    return result is not None


# --- Graph / link analysis ---


def get_backlinks(file: str) -> list[dict] | None:
    """Get files that link TO a given file.

    Returns:
        List of backlink dicts, or None if unavailable.
    """
    return _run_json(["backlinks", f'file="{file}"'])


def get_unresolved_links() -> list[dict] | None:
    """Get all unresolved/broken wikilinks in the vault.

    Returns:
        List of unresolved link dicts, or None if unavailable.
    """
    return _run_json(["unresolved"])


def get_orphans() -> list[dict] | None:
    """Get files with no backlinks.

    Returns:
        List of orphan file dicts, or None if unavailable.
    """
    return _run_json(["orphans"])
