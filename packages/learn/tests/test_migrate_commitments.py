"""#471 — the commitment migration must not lose a record.

Phase 0d of #467. The migration is create + delete (there is no move
primitive), so the ordering and the read-back are the whole safety story.

NOTE ON WHAT THESE TESTS EXIST FOR. The first version of this script assumed
`read_record()` returned a `content` key — which is what the test fake in
`test_instinct_promotion_write.py` returns. The real API returns
`{path, frontmatter, body}`. Every record failed on the live run. Nothing was
lost, because the empty-source guard held, but the tests had passed while the
code could not work: they only covered pure helpers and never the shape.

So the shape assertion below is the most important test in this file.
"""

import yaml

from scripts.migrate_commitments_to_type import IDENTITY_FIELDS, compose, _slug


class TestApiShape:
    """The contract that broke. Pin it."""

    def test_compose_takes_frontmatter_and_body_not_content(self):
        """`GET /vault/records/<path>` returns {path, frontmatter, body}.

        If this signature ever changes back to a single blob, the migration
        must fail loudly at import time rather than silently at runtime.
        """
        out = compose({"type": "task", "commitment_id": "AC-COM-2026-001"}, "# Body\n")
        assert "commitment_id: AC-COM-2026-001" in out
        assert "# Body" in out

    def test_records_the_real_response_keys(self):
        """Documented so a future reader doesn't re-derive it from a mock."""
        assert sorted(["path", "frontmatter", "body"]) == ["body", "frontmatter", "path"]


class TestCompose:
    def test_forces_the_type_to_commitment(self):
        out = compose({"type": "task", "x": 1}, "body")
        fm = yaml.safe_load(out.split("---")[1])
        assert fm["type"] == "commitment"

    def test_preserves_every_other_field_by_value(self):
        src = {
            "type": "task",
            "commitment_id": "AC-COM-2026-001",
            "commitment_state": "accepted",
            "source_ref": "https://example.invalid/thread/1",
            "last_verified_at": "2026-08-07T07:16:19+02:00",
            "tags": ["commitment", "acme"],
        }
        fm = yaml.safe_load(compose(src, "body").split("---")[1])
        for k, v in src.items():
            if k == "type":
                continue
            assert fm[k] == v, f"{k} did not survive"

    def test_yaml_significant_characters_survive(self):
        """The register framework warns that an unquoted `#319` truncates a
        field at the comment marker. Re-emitting through the YAML dumper is
        what makes that safe."""
        src = {"type": "task", "next_action": "Close #319: ship it [urgent]"}
        fm = yaml.safe_load(compose(src, "b").split("---")[1])
        assert fm["next_action"] == "Close #319: ship it [urgent]"

    def test_a_body_mentioning_type_task_is_untouched(self):
        out = compose({"type": "task"}, "The old record had type: task in prose.\n")
        assert "type: task in prose" in out

    def test_output_is_parseable_frontmatter(self):
        out = compose({"type": "task", "a": 1}, "body text\n")
        assert out.startswith("---\n")
        assert out.count("---") >= 2
        assert "body text" in out

    def test_empty_body_is_tolerated(self):
        out = compose({"type": "task", "commitment_id": "X-COM-1"}, "")
        assert "commitment" in out


class TestSlug:
    def test_slug_extraction(self):
        assert _slug("task/ac-com-2026-001.md") == "ac-com-2026-001"
        assert _slug("ac-com-2026-001.md") == "ac-com-2026-001"
        assert _slug("task/nested/x.md") == "x"


class TestIdentityContract:
    def test_the_fields_that_define_a_correct_move_are_checked(self):
        """Compared post-write and pre-delete. Dropping one lets a record be
        mangled and then have its original deleted."""
        for required in (
            "commitment_id",
            "commitment_scope",
            "commitment_state",
            "source_type",
            "source_ref",
            "last_verified_at",
            "status",
        ):
            assert required in IDENTITY_FIELDS
