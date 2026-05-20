"""Tests for surveyor writer — structured entity-link writeback."""
from __future__ import annotations

import json
from pathlib import Path

import frontmatter
import pytest

from alfred.surveyor.state import PipelineState
from alfred.surveyor.writer import VaultWriter


@pytest.fixture
def vault_with_record(tmp_path: Path):
    """Build a real tiny vault + PipelineState + VaultWriter."""
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "event").mkdir()
    ev = vault / "event" / "test-event.md"
    ev.write_text(
        "---\ntype: event\nname: Test Event\nstatus: active\n---\n\nEvent body.\n",
        encoding="utf-8",
    )
    state = PipelineState(state_path=tmp_path / "state.json")
    state.update_file("event/test-event.md", "hash-placeholder")
    writer = VaultWriter(vault_path=vault, state=state)
    return vault, state, writer, "event/test-event.md"


def _read_metadata(vault: Path, rel: str) -> dict:
    with open(vault / rel, encoding="utf-8") as f:
        return frontmatter.load(f).metadata


def test_write_related_matters_new_record(vault_with_record):
    _, _, writer, rel = vault_with_record
    added = writer.write_related_matters(rel, ["matter/erste.md", "matter/nova.md"])
    assert added == 2
    md = _read_metadata(writer.vault_path, rel)
    assert md["related_matters"] == ["matter/erste.md", "matter/nova.md"]


def test_write_related_matters_dedupes(vault_with_record):
    _, _, writer, rel = vault_with_record
    writer.write_related_matters(rel, ["matter/a.md"])
    added = writer.write_related_matters(rel, ["matter/a.md", "matter/b.md"])
    assert added == 1  # only matter/b.md is new
    md = _read_metadata(writer.vault_path, rel)
    assert md["related_matters"] == ["matter/a.md", "matter/b.md"]


def test_write_related_matters_preserves_existing_human_entries(vault_with_record, tmp_path):
    vault, state, writer, rel = vault_with_record
    # Human-authored existing entry
    (vault / rel).write_text(
        "---\ntype: event\nname: X\nrelated_matters: [matter/human-added.md]\n---\n\nBody.\n",
        encoding="utf-8",
    )
    state.update_file(rel, "new-hash")
    added = writer.write_related_matters(rel, ["matter/machine-added.md"])
    assert added == 1
    md = _read_metadata(vault, rel)
    assert md["related_matters"] == ["matter/human-added.md", "matter/machine-added.md"]


def test_write_related_matters_caps_at_max_total(vault_with_record):
    _, _, writer, rel = vault_with_record
    paths = [f"matter/{i}.md" for i in range(10)]
    added = writer.write_related_matters(rel, paths, max_total=3)
    assert added == 3
    md = _read_metadata(writer.vault_path, rel)
    # First 3 are kept; callers rank before passing so earliest = best
    assert md["related_matters"] == ["matter/0.md", "matter/1.md", "matter/2.md"]


def test_write_related_persons_separate_field(vault_with_record):
    _, _, writer, rel = vault_with_record
    writer.write_related_matters(rel, ["matter/a.md"])
    writer.write_related_persons(rel, ["person/b.md"])
    md = _read_metadata(writer.vault_path, rel)
    assert md["related_matters"] == ["matter/a.md"]
    assert md["related_persons"] == ["person/b.md"]


def test_write_related_orgs_and_projects_separate_fields(vault_with_record):
    _, _, writer, rel = vault_with_record
    writer.write_related_orgs(rel, ["org/x.md"])
    writer.write_related_projects(rel, ["project/y.md"])
    md = _read_metadata(writer.vault_path, rel)
    assert md["related_orgs"] == ["org/x.md"]
    assert md["related_projects"] == ["project/y.md"]


def test_empty_list_is_noop(vault_with_record):
    _, _, writer, rel = vault_with_record
    added = writer.write_related_matters(rel, [])
    assert added == 0
    md = _read_metadata(writer.vault_path, rel)
    assert "related_matters" not in md


def test_nonexistent_file_is_noop(tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    state = PipelineState(state_path=tmp_path / "state.json")
    writer = VaultWriter(vault_path=vault, state=state)
    added = writer.write_related_matters("event/missing.md", ["matter/a.md"])
    assert added == 0


def test_existing_scalar_value_handled(vault_with_record):
    """Some vault records have a scalar (string) value in the field by mistake —
    upgrade it to a list on next write rather than crashing.
    """
    vault, state, writer, rel = vault_with_record
    (vault / rel).write_text(
        "---\ntype: event\nrelated_matters: matter/old-scalar.md\n---\n\nBody.\n",
        encoding="utf-8",
    )
    state.update_file(rel, "hash-b")
    added = writer.write_related_matters(rel, ["matter/new.md"])
    assert added == 1
    md = _read_metadata(vault, rel)
    assert md["related_matters"] == ["matter/old-scalar.md", "matter/new.md"]


def test_multiple_fields_independent(vault_with_record):
    """All four fields can coexist on the same record without interference."""
    _, _, writer, rel = vault_with_record
    writer.write_related_matters(rel, ["matter/a.md"])
    writer.write_related_persons(rel, ["person/p.md"])
    writer.write_related_orgs(rel, ["org/o.md"])
    writer.write_related_projects(rel, ["project/x.md"])
    md = _read_metadata(writer.vault_path, rel)
    assert md["related_matters"] == ["matter/a.md"]
    assert md["related_persons"] == ["person/p.md"]
    assert md["related_orgs"] == ["org/o.md"]
    assert md["related_projects"] == ["project/x.md"]
