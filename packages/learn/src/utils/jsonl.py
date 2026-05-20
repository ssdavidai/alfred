"""JSONL read/write helpers."""

from __future__ import annotations

import json
import os
from typing import Any


def read_jsonl(path: str) -> list[dict[str, Any]]:
    """Read all lines from a JSONL file. Returns empty list if file missing."""
    if not os.path.exists(path):
        return []
    items: list[dict[str, Any]] = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                items.append(json.loads(line))
    return items


def append_jsonl(path: str, record: dict[str, Any]) -> None:
    """Append a single JSON record to a JSONL file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(record) + "\n")


def truncate_jsonl(path: str, count: int) -> None:
    """Remove the first `count` lines from a JSONL file.

    Used to clear processed items from a queue file.
    """
    if not os.path.exists(path):
        return
    with open(path) as f:
        lines = f.readlines()
    remaining = lines[count:]
    with open(path, "w") as f:
        f.writelines(remaining)
