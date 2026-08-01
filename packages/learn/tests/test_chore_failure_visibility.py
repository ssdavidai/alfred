"""A failed chore run must be visible on /chores (#366 follow-up).

`record_chore_run` only fires on success paths, so a chore whose run
throws leaves its vault record showing the last SUCCESSFUL run — the
dashboard reads it as healthy. Confirmed live on home: trkblint's record
showed a green manual-trigger run while Temporal had two Failed
*scheduled* ticks on the pre-#366 transport bug. You had to SSH to the
box and read Temporal to know a chore was dead.

The stamp lives in the workflow-audit emitter rather than in each of the
13 chore templates: that is the one place every workflow failure already
passes through.
"""
from __future__ import annotations

import asyncio

import pytest

from src.activities import stream_log as sl


class _FakeVaultClient:
    def __init__(self, chores):
        self._chores = chores
        self.patches: list[tuple[str, dict]] = []

    async def list_records(self, *_a, **_k):
        return self._chores

    async def patch_frontmatter(self, path, updates):
        self.patches.append((path, updates))

    async def close(self):
        return None


CHORES = [
    {"path": "chore/other.md",
     "frontmatter": {"workflow_class_name": "SomeOtherWorkflow"}},
    {"path": "chore/trkblint-household-works-ledger.md",
     "frontmatter": {"workflow_class_name": "TorokbalintHouseholdWorksLedgerWorkflow"}},
]


@pytest.fixture
def stamp(monkeypatch):
    def _run(workflow_type, error, chores=CHORES):
        fake = _FakeVaultClient(chores)
        monkeypatch.setattr(sl, "VaultClient", lambda _cfg: fake)
        asyncio.run(sl._stamp_chore_failure(workflow_type, error))
        return fake

    return _run


class TestStampsTheOwningChore:
    def test_failure_marks_the_matching_chore_record(self, stamp):
        fake = stamp("TorokbalintHouseholdWorksLedgerWorkflow", "boom: gateway 404")
        assert len(fake.patches) == 1
        path, updates = fake.patches[0]
        assert path == "chore/trkblint-household-works-ledger.md"
        assert updates["last_result"].startswith("FAILED: ")
        assert "gateway 404" in updates["last_result"]
        assert updates["last_run"]

    def test_error_detail_is_single_line_and_bounded(self, stamp):
        fake = stamp("TorokbalintHouseholdWorksLedgerWorkflow", "line1\nline2 " + "x" * 400)
        _, updates = fake.patches[0]
        assert "\n" not in updates["last_result"]
        assert len(updates["last_result"]) < 220

    def test_missing_error_still_stamps(self, stamp):
        fake = stamp("TorokbalintHouseholdWorksLedgerWorkflow", None)
        _, updates = fake.patches[0]
        assert "unknown error" in updates["last_result"]


class TestLeavesEverythingElseAlone:
    def test_non_chore_workflow_is_a_no_op(self, stamp):
        """DecisionRouter/SignalRouter failures must not touch any chore."""
        fake = stamp("DecisionRouterWorkflow", "some error")
        assert fake.patches == []

    def test_empty_workflow_type_is_a_no_op(self, stamp):
        fake = stamp("", "err")
        assert fake.patches == []

    def test_no_chores_configured_is_a_no_op(self, stamp):
        fake = stamp("AnyWorkflow", "err", chores=[])
        assert fake.patches == []

    def test_malformed_chore_records_are_skipped(self, stamp):
        fake = stamp("X", "err", chores=[{"path": "chore/a.md"}, "not-a-dict", {}])
        assert fake.patches == []
