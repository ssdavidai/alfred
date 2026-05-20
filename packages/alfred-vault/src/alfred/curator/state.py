"""Persistent state tracking for processed inbox files."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .utils import get_logger

log = get_logger(__name__)


@dataclass
class ProcessedEntry:
    inbox_path: str
    processed_at: str
    files_created: list[str] = field(default_factory=list)
    files_modified: list[str] = field(default_factory=list)
    backend_used: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "inbox_path": self.inbox_path,
            "processed_at": self.processed_at,
            "files_created": self.files_created,
            "files_modified": self.files_modified,
            "backend_used": self.backend_used,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ProcessedEntry:
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


@dataclass
class State:
    version: int = 2
    last_run: str = ""
    processed: dict[str, ProcessedEntry] = field(default_factory=dict)

    def is_processed(self, filename: str) -> bool:
        return filename in self.processed

    def mark_processed(
        self,
        filename: str,
        inbox_path: str,
        files_created: list[str],
        files_modified: list[str],
        backend_used: str,
    ) -> None:
        self.processed[filename] = ProcessedEntry(
            inbox_path=inbox_path,
            processed_at=datetime.now(timezone.utc).isoformat(),
            files_created=files_created,
            files_modified=files_modified,
            backend_used=backend_used,
        )
        self.last_run = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "last_run": self.last_run,
            "processed": {k: v.to_dict() for k, v in self.processed.items()},
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> State:
        processed = {}
        for k, v in data.get("processed", {}).items():
            processed[k] = ProcessedEntry.from_dict(v)
        return cls(
            version=data.get("version", 2),
            last_run=data.get("last_run", ""),
            processed=processed,
        )


class StateManager:
    """Load/save state from a JSON file."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.state = State()

    def load(self) -> State:
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                self.state = State.from_dict(data)
                log.info("state.loaded", entries=len(self.state.processed))
            except (json.JSONDecodeError, KeyError) as e:
                log.warning("state.load_failed", error=str(e))
                self.state = State()
        return self.state

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(self.state.to_dict(), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        tmp.replace(self.path)
        log.debug("state.saved", path=str(self.path))
