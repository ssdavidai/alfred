"""State persistence — state.json load/save with open issues and fix log."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import structlog

from .issues import FixLogEntry, SweepResult

log = structlog.get_logger()


@dataclass
class FileState:
    md5: str
    last_scanned: str = ""
    open_issues: list[str] = field(default_factory=list)  # issue codes
    # Issue #15: staleness tracking for Stage 3 stub enrichment
    enrichment_attempts: int = 0
    last_enrichment_attempt: str = ""
    enrichment_stale: bool = False


class JanitorState:
    def __init__(self, state_path: str | Path, max_sweep_history: int = 20) -> None:
        self.state_path = Path(state_path)
        self.max_sweep_history = max_sweep_history
        self.version: int = 1
        self.files: dict[str, FileState] = {}  # rel_path -> FileState
        self.sweeps: dict[str, SweepResult] = {}  # sweep_id -> SweepResult
        self.fix_log: list[FixLogEntry] = []  # permanent audit trail
        self.ignored: dict[str, str] = {}  # rel_path -> reason
        self.pending_writes: dict[str, str] = {}  # rel_path -> expected_md5
        self.last_deep_sweep: str | None = None  # ISO timestamp
        # Issue #15: event-driven deep sweeps — store previous sweep's issue snapshot
        self.previous_sweep_issues: dict[str, list[str]] = {}  # rel_path -> [issue_codes]

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
        for sid, sdata in raw.get("sweeps", {}).items():
            self.sweeps[sid] = SweepResult.from_dict(sdata)
        self.fix_log = [FixLogEntry.from_dict(e) for e in raw.get("fix_log", [])]
        self.ignored = raw.get("ignored", {})
        self.pending_writes = raw.get("pending_writes", {})
        self.last_deep_sweep = raw.get("last_deep_sweep")
        self.previous_sweep_issues = raw.get("previous_sweep_issues", {})
        log.info("state.loaded", files=len(self.files), sweeps=len(self.sweeps))

    def save(self) -> None:
        """Atomic save: write to .tmp then os.replace."""
        # Trim sweep history
        if len(self.sweeps) > self.max_sweep_history:
            sorted_ids = sorted(self.sweeps.keys(), key=lambda k: self.sweeps[k].timestamp)
            for sid in sorted_ids[:-self.max_sweep_history]:
                del self.sweeps[sid]

        data = {
            "version": self.version,
            "files": {
                rel: {
                    "md5": fs.md5,
                    "last_scanned": fs.last_scanned,
                    "open_issues": fs.open_issues,
                    "enrichment_attempts": fs.enrichment_attempts,
                    "last_enrichment_attempt": fs.last_enrichment_attempt,
                    "enrichment_stale": fs.enrichment_stale,
                }
                for rel, fs in self.files.items()
            },
            "sweeps": {sid: sr.to_dict() for sid, sr in self.sweeps.items()},
            "fix_log": [e.to_dict() for e in self.fix_log],
            "ignored": self.ignored,
            "pending_writes": self.pending_writes,
            "last_deep_sweep": self.last_deep_sweep,
            "previous_sweep_issues": self.previous_sweep_issues,
        }
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.state_path.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, self.state_path)

    def should_scan(self, rel_path: str, current_md5: str) -> bool:
        """Return True if a file needs scanning (changed or has open issues)."""
        if rel_path in self.ignored:
            return False
        if rel_path not in self.files:
            return True
        fs = self.files[rel_path]
        if fs.md5 != current_md5:
            return True
        if fs.open_issues:
            return True
        return False

    def update_file(self, rel_path: str, md5: str, issue_codes: list[str] | None = None) -> None:
        """Update or create a file entry after scanning."""
        now = datetime.now(timezone.utc).isoformat()
        if rel_path in self.files:
            self.files[rel_path].md5 = md5
            self.files[rel_path].last_scanned = now
            self.files[rel_path].open_issues = issue_codes or []
        else:
            self.files[rel_path] = FileState(
                md5=md5,
                last_scanned=now,
                open_issues=issue_codes or [],
            )

    def remove_file(self, rel_path: str) -> None:
        """Remove a file from state."""
        self.files.pop(rel_path, None)
        self.pending_writes.pop(rel_path, None)

    def add_sweep(self, result: SweepResult) -> None:
        """Record a sweep result."""
        self.sweeps[result.sweep_id] = result

    def add_fix_log(self, entry: FixLogEntry) -> None:
        """Append to the permanent fix log."""
        self.fix_log.append(entry)

    def ignore_file(self, rel_path: str, reason: str = "") -> None:
        """Add a file to the ignore list."""
        self.ignored[rel_path] = reason

    # --- Issue #15: enrichment staleness helpers ---

    def record_enrichment_attempt(self, rel_path: str, max_attempts: int = 3) -> None:
        """Increment enrichment attempt counter; mark stale after max_attempts."""
        if rel_path not in self.files:
            return
        fs = self.files[rel_path]
        fs.enrichment_attempts += 1
        fs.last_enrichment_attempt = datetime.now(timezone.utc).isoformat()
        if fs.enrichment_attempts >= max_attempts:
            fs.enrichment_stale = True

    def reset_enrichment_staleness(self, rel_path: str) -> None:
        """Reset staleness when file content changes (hash mismatch)."""
        if rel_path not in self.files:
            return
        fs = self.files[rel_path]
        fs.enrichment_attempts = 0
        fs.last_enrichment_attempt = ""
        fs.enrichment_stale = False

    def is_enrichment_stale(self, rel_path: str) -> bool:
        """Return True if this file has exhausted enrichment attempts."""
        if rel_path not in self.files:
            return False
        return self.files[rel_path].enrichment_stale

    # --- Issue #15: event-driven deep sweep helpers ---

    def get_new_issues(
        self, current_issues: dict[str, list[str]],
    ) -> dict[str, list[str]]:
        """Compare current issues against previous snapshot.

        Returns only files with NEW issue codes not in the previous snapshot.
        """
        new: dict[str, list[str]] = {}
        for path, codes in current_issues.items():
            prev_codes = set(self.previous_sweep_issues.get(path, []))
            novel = [c for c in codes if c not in prev_codes]
            if novel:
                new[path] = novel
        return new

    def save_sweep_issues(self, issues: dict[str, list[str]]) -> None:
        """Store the current sweep's issue snapshot for next comparison."""
        self.previous_sweep_issues = issues
