"""#471 — the commitment migration must not lose a record.

Phase 0d of #467. The migration is create + delete (there is no move
primitive), so the ordering and the read-back are the whole safety story.
These pin them.
"""

import pytest

from scripts.migrate_commitments_to_type import IDENTITY_FIELDS, _retype, _slug


class TestRetype:
    def test_rewrites_the_frontmatter_type(self):
        raw = '---\ntype: "task"\ncommitment_id: "AC-COM-2026-001"\n---\nbody\n'
        assert 'type: "commitment"' in _retype(raw)
        assert 'type: "task"' not in _retype(raw)

    def test_handles_unquoted_type(self):
        raw = "---\ntype: task\nstatus: todo\n---\nbody\n"
        assert 'type: "commitment"' in _retype(raw)

    def test_leaves_the_body_alone(self):
        """A body mentioning `type: task` must not be rewritten."""
        raw = '---\ntype: "task"\n---\nThe old record had type: task in prose.\n'
        out = _retype(raw)
        assert out.count("commitment") == 1
        assert "type: task in prose" in out

    def test_only_the_first_occurrence(self):
        raw = '---\ntype: "task"\nnote: "was type: task"\n---\nbody\n'
        out = _retype(raw)
        assert out.count('type: "commitment"') == 1

    def test_passthrough_without_frontmatter(self):
        assert _retype("no frontmatter here") == "no frontmatter here"

    def test_passthrough_on_unterminated_frontmatter(self):
        raw = '---\ntype: "task"\nnever closed\n'
        assert _retype(raw) == raw


class TestSlug:
    @pytest.mark.parametrize(
        "path,expected",
        [
            ("task/ac-com-2026-001.md", "ac-com-2026-001"),
            ("ac-com-2026-001.md", "ac-com-2026-001"),
            ("task/nested/x.md", "x"),
        ],
    )
    def test_slug_extraction(self, path, expected):
        assert _slug(path) == expected


class TestIdentityContract:
    def test_the_fields_that_define_a_correct_move_are_checked(self):
        """These are compared post-write and pre-delete. Dropping one from the
        list means a record could be silently mangled and then the original
        deleted."""
        for required in (
            "commitment_id",
            "commitment_scope",
            "commitment_state",
            "source_ref",
            "last_verified_at",
            "status",
        ):
            assert required in IDENTITY_FIELDS

    def test_provenance_is_not_droppable(self):
        """source_* is how a commitment proves where it came from."""
        assert "source_type" in IDENTITY_FIELDS
        assert "source_ref" in IDENTITY_FIELDS
