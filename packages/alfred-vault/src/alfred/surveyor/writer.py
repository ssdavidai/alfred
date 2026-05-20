"""Safe frontmatter write-back — alfred_tags and relationships."""

from __future__ import annotations

import os
from pathlib import Path

import frontmatter
import structlog

from .state import PipelineState
from .utils import compute_md5_bytes

log = structlog.get_logger()


class VaultWriter:
    def __init__(self, vault_path: Path, state: PipelineState) -> None:
        self.vault_path = vault_path
        self.state = state

    def write_alfred_tags(self, rel_path: str, tags: list[str]) -> None:
        """Set alfred_tags in frontmatter."""
        full_path = self.vault_path / rel_path
        if not full_path.exists():
            log.warning("writer.file_not_found", path=rel_path)
            return

        try:
            raw = full_path.read_text(encoding="utf-8")
            post = frontmatter.loads(raw)
        except Exception as e:
            log.warning("writer.parse_error", path=rel_path, error=str(e))
            return

        # Check if tags actually changed
        existing = post.metadata.get("alfred_tags", [])
        if sorted(existing) == sorted(tags):
            return

        post.metadata["alfred_tags"] = tags
        self._write_atomic(full_path, rel_path, post)
        log.info("writer.tags_written", path=rel_path, tags=tags)

    def _append_to_list_field(
        self,
        rel_path: str,
        field: str,
        new_paths: list[str],
        max_total: int | None = None,
    ) -> int:
        """Append entries to a frontmatter list field (e.g. `related_matters`)
        without removing existing entries. Returns the number of new entries
        added. Idempotent — re-calling with the same paths is a no-op.

        Invariants:
          - Never remove a human-authored or previously-written entry.
          - Dedupe against existing entries (exact string match).
          - Preserve original ordering; append new entries at the end.
          - If `max_total` is set, cap final list length (drop from the
            TAIL of new entries, not existing ones).
        """
        if not new_paths:
            return 0

        full_path = self.vault_path / rel_path
        if not full_path.exists():
            log.warning("writer.file_not_found", path=rel_path)
            return 0

        try:
            raw = full_path.read_text(encoding="utf-8")
            post = frontmatter.loads(raw)
        except Exception as e:
            log.warning("writer.parse_error", path=rel_path, error=str(e))
            return 0

        existing = post.metadata.get(field, [])
        if not isinstance(existing, list):
            # Respect unexpected scalar values — treat as a single entry
            existing = [str(existing)] if existing else []
        existing_set = set(existing)

        to_add: list[str] = []
        for p in new_paths:
            if p in existing_set:
                continue
            to_add.append(p)
            existing_set.add(p)

        if not to_add:
            return 0

        merged = existing + to_add
        if max_total is not None and len(merged) > max_total:
            # Trim from the tail so human-authored + earlier machine entries
            # are preserved. The assumption: callers already ranked
            # `new_paths` by similarity, so earliest=best.
            merged = merged[:max_total]

        # "added" = net new entries actually retained after cap.
        added_kept = max(0, len(merged) - len(existing))

        post.metadata[field] = merged
        self._write_atomic(full_path, rel_path, post)
        log.info(
            "writer.entity_links_written",
            path=rel_path,
            field=field,
            added=added_kept,
            total=len(merged),
        )
        return added_kept

    def write_related_matters(
        self,
        rel_path: str,
        matter_paths: list[str],
        max_total: int | None = None,
    ) -> int:
        """Append matter vault paths to `related_matters` frontmatter.

        Respects existing entries (both human-authored and previously
        machine-written). Returns count of newly-added entries.
        """
        return self._append_to_list_field(
            rel_path, "related_matters", matter_paths, max_total
        )

    def write_related_persons(
        self,
        rel_path: str,
        person_paths: list[str],
        max_total: int | None = None,
    ) -> int:
        """Append person vault paths to `related_persons` frontmatter."""
        return self._append_to_list_field(
            rel_path, "related_persons", person_paths, max_total
        )

    def write_related_orgs(
        self,
        rel_path: str,
        org_paths: list[str],
        max_total: int | None = None,
    ) -> int:
        """Append org vault paths to `related_orgs` frontmatter."""
        return self._append_to_list_field(
            rel_path, "related_orgs", org_paths, max_total
        )

    def write_related_projects(
        self,
        rel_path: str,
        project_paths: list[str],
        max_total: int | None = None,
    ) -> int:
        """Append project vault paths to `related_projects` frontmatter."""
        return self._append_to_list_field(
            rel_path, "related_projects", project_paths, max_total
        )

    def write_relationships(self, rel_path: str, new_rels: list[dict]) -> None:
        """Append machine-generated relationships (only those with confidence < 1.0).

        Never touch human-authored entries (those without a confidence field).
        """
        if not new_rels:
            return

        full_path = self.vault_path / rel_path
        if not full_path.exists():
            log.warning("writer.file_not_found", path=rel_path)
            return

        try:
            raw = full_path.read_text(encoding="utf-8")
            post = frontmatter.loads(raw)
        except Exception as e:
            log.warning("writer.parse_error", path=rel_path, error=str(e))
            return

        existing_rels: list[dict] = post.metadata.get("relationships", [])

        # Build set of existing machine-generated relationship targets
        existing_targets = set()
        for rel in existing_rels:
            if "confidence" in rel:
                existing_targets.add(rel.get("target", ""))

        # Only add truly new relationships
        added = 0
        for rel in new_rels:
            target = rel.get("target", "")
            if target and target not in existing_targets:
                existing_rels.append(rel)
                existing_targets.add(target)
                added += 1

        if added == 0:
            return

        post.metadata["relationships"] = existing_rels
        self._write_atomic(full_path, rel_path, post)
        log.info("writer.relationships_written", path=rel_path, added=added)

    def _write_atomic(self, full_path: Path, rel_path: str, post: frontmatter.Post) -> None:
        """Write file atomically and register expected hash in state."""
        content = frontmatter.dumps(post)
        content_bytes = content.encode("utf-8")
        expected_md5 = compute_md5_bytes(content_bytes)

        # Mark pending write BEFORE writing so the watcher ignores it
        self.state.mark_pending_write(rel_path, expected_md5)

        # Atomic write: .tmp → rename
        tmp_path = full_path.with_suffix(".md.tmp")
        try:
            tmp_path.write_bytes(content_bytes)
            os.replace(tmp_path, full_path)
        except OSError as e:
            log.error("writer.write_error", path=rel_path, error=str(e))
            # Clean up pending write on failure
            self.state.pending_writes.pop(rel_path, None)
            if tmp_path.exists():
                tmp_path.unlink()
            return

        # Update file hash in state
        self.state.update_file(rel_path, expected_md5)
