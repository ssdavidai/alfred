"""Session-scoped mutation tracking via JSONL files."""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def create_session_file() -> str:
    """Create a temporary JSONL file for mutation logging. Returns the path."""
    fd, path = tempfile.mkstemp(prefix="alfred_vault_", suffix=".jsonl")
    os.close(fd)
    return path


def log_mutation(
    session_path: str | None,
    op: str,
    path: str,
    **extra: str | list[str],
) -> None:
    """Append a mutation entry to the session file."""
    if not session_path:
        return
    entry = {
        "op": op,
        "path": path,
        "ts": datetime.now(timezone.utc).isoformat(),
        **extra,
    }
    with open(session_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def read_mutations(session_path: str) -> dict:
    """Read a session file and return {files_created, files_modified, files_deleted}.

    Returns:
        Dict with lists of affected file paths grouped by mutation type.
    """
    created: list[str] = []
    modified: list[str] = []
    deleted: list[str] = []

    path = Path(session_path)
    if not path.exists():
        return {"files_created": created, "files_modified": modified, "files_deleted": deleted}

    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        op = entry.get("op", "")
        file_path = entry.get("path", "")
        if op == "create":
            created.append(file_path)
        elif op == "edit":
            modified.append(file_path)
        elif op == "move":
            # Move = delete old + create new
            deleted.append(file_path)
            to_path = entry.get("to", "")
            if to_path:
                created.append(to_path)
        elif op == "delete":
            deleted.append(file_path)

    return {"files_created": created, "files_modified": modified, "files_deleted": deleted}


def append_to_audit_log(
    audit_path: str | Path,
    tool: str,
    mutations: dict,
    detail: str = "",
) -> None:
    """Append one JSONL line per affected file to the unified audit log.

    Args:
        audit_path: Path to the audit log file (e.g. data/vault_audit.log).
        tool: Tool name ("curator", "janitor", "distiller", "exec").
        mutations: Dict as returned by read_mutations() with files_created/modified/deleted.
        detail: Correlation info (run_id, sweep_id, inbox filename, etc.).
    """
    ts = datetime.now(timezone.utc).isoformat()
    lines: list[str] = []

    for path in mutations.get("files_created", []):
        lines.append(json.dumps({"ts": ts, "tool": tool, "op": "create", "path": path, "detail": detail}))
    for path in mutations.get("files_modified", []):
        lines.append(json.dumps({"ts": ts, "tool": tool, "op": "modify", "path": path, "detail": detail}))
    for path in mutations.get("files_deleted", []):
        lines.append(json.dumps({"ts": ts, "tool": tool, "op": "delete", "path": path, "detail": detail}))

    if not lines:
        return

    audit = Path(audit_path)
    audit.parent.mkdir(parents=True, exist_ok=True)
    with open(audit, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def cleanup_session_file(session_path: str) -> None:
    """Remove a session file after processing."""
    try:
        Path(session_path).unlink(missing_ok=True)
    except OSError:
        pass
