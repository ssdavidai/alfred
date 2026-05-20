"""State persistence — state.json load/save with extraction log and run history."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path

import structlog

log = structlog.get_logger()


@dataclass
class FileState:
    md5: str
    last_distilled: str = ""  # ISO timestamp of last extraction run
    learn_records_created: list[str] = field(default_factory=list)  # rel_paths


@dataclass
class RunResult:
    run_id: str = ""
    timestamp: str = ""
    candidates_found: int = 0
    candidates_processed: int = 0
    records_created: dict[str, int] = field(default_factory=dict)  # learn_type -> count
    batches: int = 0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> RunResult:
        return cls(**data)


@dataclass
class ExtractionLogEntry:
    timestamp: str = ""
    run_id: str = ""
    action: str = ""  # "created"
    learn_type: str = ""  # "assumption", "decision", etc.
    learn_file: str = ""  # rel_path of created learn record
    source_files: list[str] = field(default_factory=list)  # rel_paths of source records
    detail: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> ExtractionLogEntry:
        return cls(**data)


class DistillerState:
    def __init__(self, state_path: str | Path, max_run_history: int = 20) -> None:
        self.state_path = Path(state_path)
        self.max_run_history = max_run_history
        self.version: int = 1
        self.files: dict[str, FileState] = {}  # source rel_path -> state
        self.runs: dict[str, RunResult] = {}  # run_id -> result
        self.extraction_log: list[ExtractionLogEntry] = []  # permanent audit trail
        self.pending_writes: dict[str, str] = {}  # rel_path -> expected_md5
        self.last_deep_extraction: str | None = None  # ISO timestamp

    def load(self) -> None:
        """Load state from disk if it exists."""
        if not self.state_path.exists():
            log.info("state.no_existing_state", path=str(self.state_path))
            return
        with open(self.state_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        self.version = raw.get("version", 1)
        for rel, fdata in raw.get("files", {}).items():
            self.files[rel] = FileState(**fdata)
        for rid, rdata in raw.get("runs", {}).items():
            self.runs[rid] = RunResult.from_dict(rdata)
        self.extraction_log = [
            ExtractionLogEntry.from_dict(e) for e in raw.get("extraction_log", [])
        ]
        self.pending_writes = raw.get("pending_writes", {})
        self.last_deep_extraction = raw.get("last_deep_extraction")
        log.info("state.loaded", files=len(self.files), runs=len(self.runs))

    def save(self) -> None:
        """Atomic save: write to .tmp then os.replace."""
        # Trim run history
        if len(self.runs) > self.max_run_history:
            sorted_ids = sorted(
                self.runs.keys(), key=lambda k: self.runs[k].timestamp
            )
            for rid in sorted_ids[: -self.max_run_history]:
                del self.runs[rid]

        data = {
            "version": self.version,
            "files": {
                rel: {
                    "md5": fs.md5,
                    "last_distilled": fs.last_distilled,
                    "learn_records_created": fs.learn_records_created,
                }
                for rel, fs in self.files.items()
            },
            "runs": {rid: rr.to_dict() for rid, rr in self.runs.items()},
            "extraction_log": [e.to_dict() for e in self.extraction_log],
            "pending_writes": self.pending_writes,
            "last_deep_extraction": self.last_deep_extraction,
        }
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.state_path.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, self.state_path)

    def should_distill(self, rel_path: str, current_md5: str) -> bool:
        """Return True if a file needs distilling (new or changed)."""
        if rel_path not in self.files:
            return True
        return self.files[rel_path].md5 != current_md5

    def get_distilled_md5s(self) -> dict[str, str]:
        """Return {rel_path: md5} for all distilled files — used by scanner for skip logic."""
        return {rel: fs.md5 for rel, fs in self.files.items()}

    def update_file(
        self, rel_path: str, md5: str, learn_records: list[str] | None = None
    ) -> None:
        """Update or create a file entry after distillation."""
        now = datetime.now(timezone.utc).isoformat()
        if rel_path in self.files:
            self.files[rel_path].md5 = md5
            self.files[rel_path].last_distilled = now
            if learn_records:
                self.files[rel_path].learn_records_created.extend(learn_records)
        else:
            self.files[rel_path] = FileState(
                md5=md5,
                last_distilled=now,
                learn_records_created=learn_records or [],
            )

    def add_run(self, result: RunResult) -> None:
        """Record an extraction run result."""
        self.runs[result.run_id] = result

    def add_log_entry(self, entry: ExtractionLogEntry) -> None:
        """Append to the permanent extraction log."""
        self.extraction_log.append(entry)
