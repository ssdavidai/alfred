"""#328 — matter-completion routes through apply_state_change_v2 (canonical
`completed`, audited), and the legacy `resolved` full-record PATCH is gone.
"""
from __future__ import annotations

import asyncio
import inspect

from src.activities import tasks as tasks_mod
from src.activities.state_mutator import ObservedWindow, _resolve_propose_fn


def _ow():
    from datetime import datetime, timezone
    n = datetime.now(timezone.utc)
    return ObservedWindow(start=n, end=n, signal_paths=[], decision_paths=[], other_refs=[])


class TestProposeMatterResolved:
    def test_registered_under_name(self):
        fn = _resolve_propose_fn("task_runner.matter_resolved")
        assert fn is not None

    def test_proposes_completed_canonical(self):
        fn = _resolve_propose_fn("task_runner.matter_resolved")
        out = asyncio.run(fn(target={"frontmatter": {"status": "active"}},
                             observed=_ow(), args={"trigger_task": "task/x.md"}))
        assert out is not None
        assert out.fields == {"status": "completed"}   # NOT legacy 'resolved'
        assert out.confidence == 1.0

    def test_idempotent_on_terminal(self):
        fn = _resolve_propose_fn("task_runner.matter_resolved")
        for st in ("completed", "archived", "abandoned"):
            out = asyncio.run(fn(target={"frontmatter": {"status": st}},
                                 observed=_ow(), args={}))
            assert out is None, st


class TestLegacyWriterGone:
    def test_no_status_resolved_fullrecord_write(self):
        src = inspect.getsource(tasks_mod.evaluate_consequentials)
        assert '"status": "resolved"' not in src
        assert 'apply_state_change_v2' in src
        # the old full-record matter overwrite is gone
        assert 'write_record(matter_type' not in src
