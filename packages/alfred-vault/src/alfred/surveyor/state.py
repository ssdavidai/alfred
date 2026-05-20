"""State persistence — state.json load/save/diff/pending_writes."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import structlog

log = structlog.get_logger()


@dataclass
class FileState:
    md5: str
    last_embedded: str = ""
    semantic_cluster_id: int = -1
    structural_community_id: int = -1


@dataclass
class ClusterState:
    label: list[str] = field(default_factory=list)
    member_files: list[str] = field(default_factory=list)
    last_labeled: str = ""


@dataclass
class Diff:
    new: list[str] = field(default_factory=list)
    changed: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.new and not self.changed and not self.deleted

    def __repr__(self) -> str:
        return f"Diff(new={len(self.new)}, changed={len(self.changed)}, deleted={len(self.deleted)})"


class PipelineState:
    def __init__(self, state_path: str | Path) -> None:
        self.state_path = Path(state_path)
        self.version: int = 1
        self.last_run: str = ""
        self.files: dict[str, FileState] = {}
        self.clusters: dict[str, ClusterState] = {}
        self.pending_writes: dict[str, str] = {}  # rel_path -> expected_md5

    def load(self) -> None:
        """Load state from disk if it exists."""
        if not self.state_path.exists():
            log.info("state.no_existing_state", path=str(self.state_path))
            return
        with open(self.state_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        self.version = raw.get("version", 1)
        self.last_run = raw.get("last_run", "")
        for rel, fdata in raw.get("files", {}).items():
            self.files[rel] = FileState(**fdata)
        for cid, cdata in raw.get("clusters", {}).items():
            self.clusters[cid] = ClusterState(**cdata)
        self.pending_writes = raw.get("pending_writes", {})
        log.info("state.loaded", files=len(self.files), clusters=len(self.clusters))

    def save(self) -> None:
        """Atomic save: write to .tmp then os.replace."""
        self.last_run = datetime.now(timezone.utc).isoformat()
        data = {
            "version": self.version,
            "last_run": self.last_run,
            "files": {
                rel: {
                    "md5": fs.md5,
                    "last_embedded": fs.last_embedded,
                    "semantic_cluster_id": fs.semantic_cluster_id,
                    "structural_community_id": fs.structural_community_id,
                }
                for rel, fs in self.files.items()
            },
            "clusters": {
                cid: {
                    "label": cs.label,
                    "member_files": cs.member_files,
                    "last_labeled": cs.last_labeled,
                }
                for cid, cs in self.clusters.items()
            },
            "pending_writes": self.pending_writes,
        }
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.state_path.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, self.state_path)

    def compute_diff(self, current_hashes: dict[str, str]) -> Diff:
        """Compare current file hashes against stored state.

        Skips files in pending_writes whose hash matches the expected value
        (those are our own recent writes).
        """
        diff = Diff()

        # Check for new and changed
        for rel, md5 in current_hashes.items():
            # Skip our own writes
            if rel in self.pending_writes and self.pending_writes[rel] == md5:
                # Clear the pending write since it's been confirmed
                del self.pending_writes[rel]
                continue

            if rel not in self.files:
                diff.new.append(rel)
            elif self.files[rel].md5 != md5:
                diff.changed.append(rel)

        # Check for deleted
        for rel in self.files:
            if rel not in current_hashes:
                diff.deleted.append(rel)

        return diff

    def update_file(self, rel_path: str, md5: str) -> None:
        """Update or create a file entry."""
        if rel_path in self.files:
            self.files[rel_path].md5 = md5
        else:
            self.files[rel_path] = FileState(md5=md5)

    def mark_embedded(self, rel_path: str) -> None:
        """Mark a file as embedded with current timestamp."""
        if rel_path in self.files:
            self.files[rel_path].last_embedded = datetime.now(timezone.utc).isoformat()

    def remove_file(self, rel_path: str) -> None:
        """Remove a file from state."""
        self.files.pop(rel_path, None)
        self.pending_writes.pop(rel_path, None)

    def mark_pending_write(self, rel_path: str, expected_md5: str) -> None:
        """Mark a file as about to be written by us."""
        self.pending_writes[rel_path] = expected_md5

    def update_clusters(
        self,
        semantic_assignments: dict[str, int],
        structural_assignments: dict[str, int],
    ) -> None:
        """Update cluster assignments for all files."""
        for rel, cid in semantic_assignments.items():
            if rel in self.files:
                self.files[rel].semantic_cluster_id = cid
        for rel, cid in structural_assignments.items():
            if rel in self.files:
                self.files[rel].structural_community_id = cid
