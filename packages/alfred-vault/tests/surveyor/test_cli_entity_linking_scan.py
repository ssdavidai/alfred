"""Tests for cli._scan_entity_linking_coverage — entity-link telemetry."""
from __future__ import annotations

from pathlib import Path

from alfred.cli import _scan_entity_linking_coverage


def _w(vault: Path, rel: str, content: str) -> None:
    full = vault / rel
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")


def test_scans_empty_vault(tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    result = _scan_entity_linking_coverage(vault)
    assert result["available"] is True
    assert result["total_records_scanned"] == 0
    assert result["records_with_any_related"] == 0


def test_counts_related_fields_across_types(tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    _w(vault, "event/a.md",
       "---\ntype: event\nrelated_matters: [matter/m.md]\nrelated_persons: [person/p.md]\n---\nbody\n")
    _w(vault, "event/b.md",
       "---\ntype: event\nrelated_orgs: [org/o.md]\nrelated_projects: [project/x.md]\n---\nbody\n")
    _w(vault, "matter/m.md", "---\ntype: matter\n---\nbody\n")

    r = _scan_entity_linking_coverage(vault)
    assert r["total_records_scanned"] == 3
    assert r["records_with_related_matters"] == 1
    assert r["records_with_related_persons"] == 1
    assert r["records_with_related_orgs"] == 1
    assert r["records_with_related_projects"] == 1
    assert r["records_with_any_related"] == 2  # two events touched


def test_counts_unlinked_non_entity_records(tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    # Two events with no related_*, one matter (entity — doesn't count as unlinked)
    _w(vault, "event/a.md", "---\ntype: event\n---\nbody\n")
    _w(vault, "event/b.md", "---\ntype: event\n---\nbody\n")
    _w(vault, "matter/m.md", "---\ntype: matter\n---\nbody\n")

    r = _scan_entity_linking_coverage(vault)
    assert r["unlinked_non_entity_records"] == 2
    assert r["records_with_any_related"] == 0


def test_per_matter_counter(tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    _w(vault, "event/a.md",
       "---\ntype: event\nrelated_matters: [matter/popular.md, matter/niche.md]\n---\n")
    _w(vault, "event/b.md",
       "---\ntype: event\nrelated_matters: [matter/popular.md]\n---\n")
    _w(vault, "event/c.md",
       "---\ntype: event\nrelated_matters: [matter/popular.md]\n---\n")

    r = _scan_entity_linking_coverage(vault)
    assert r["per_matter"]["popular"] == 3
    assert r["per_matter"]["niche"] == 1


def test_malformed_file_does_not_crash(tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    _w(vault, "event/ok.md", "---\ntype: event\n---\n")
    # File with deliberately broken YAML — scanner must skip it, not crash.
    _w(vault, "event/bad.md", "---\ntype: [unclosed\n---\n")

    r = _scan_entity_linking_coverage(vault)
    # At least the good file was counted.
    assert r["total_records_scanned"] >= 1


def test_handles_list_type_frontmatter(tmp_path):
    """Regression for the Miguel crash-loop shape: `type:` as a list.
    Scanner must not crash; record_type should fall back gracefully.
    """
    vault = tmp_path / "vault"
    vault.mkdir()
    _w(vault, "contradiction/x.md",
       "---\ntype:\n- contradiction\n---\nbody\n")
    # No related_* fields → should count as unlinked_non_entity.
    r = _scan_entity_linking_coverage(vault)
    assert r["total_records_scanned"] == 1
    assert r["unlinked_non_entity_records"] == 1
