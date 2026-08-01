"""Regression tests for the signal stuck-dispatching sweep (#373).

`dispatching` is the #54 mark-before-dispatch guard state. If the router
dies between the mark and the dispatch (crash, OOM, gateway outage) the
signal is stranded forever, because the router only ever selects
`unrouted`. Decisions gained a recovery sweep after the office-AC
incident; signals never did.

The office-AC incident is also why this sweep is BOUNDED: there, an
UNCAPPED `recover_stuck_dispatching` loop was itself the bug (#282). So
these tests pin the cap as hard as they pin the recovery.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest

from src.activities import signal_actions as sa


def _iso(dt: datetime) -> str:
    return dt.isoformat()


STALE = _iso(datetime.now(timezone.utc) - timedelta(hours=2))
FRESH = _iso(datetime.now(timezone.utc))


class _FakeStateClient:
    def __init__(self, rows):
        self._rows = rows
        self.updates: list[tuple[str, dict]] = []
        self.audits: list[dict] = []

    async def list_signals(self, **_kw):
        return self._rows

    async def update_signal(self, sid, **kwargs):
        self.updates.append((sid, kwargs))

    async def append_audit(self, **kwargs):
        self.audits.append(kwargs)
        return "01AUDIT"

    async def close(self):
        return None


@pytest.fixture
def run_sweep(monkeypatch):
    """Run the sweep against a fake StateClient.

    The activity imports StateClient lazily from src.utils.state_client, so
    that module attribute is what must be patched. Using monkeypatch (not a
    manual set/restore) keeps the patch scoped to the test — an earlier
    hand-rolled version leaked the fake across files and made unrelated
    suites fail depending on collection order.
    """

    def _run(rows, **kwargs):
        fake = _FakeStateClient(rows)
        import src.utils.state_client as sc_mod

        monkeypatch.setattr(sc_mod, "StateClient", lambda _cfg: fake)
        return asyncio.run(sa.recover_stuck_dispatching_signals(**kwargs)), fake

    return _run


class TestRecoversStrandedSignals:
    def test_stale_dispatching_signal_returns_to_unrouted(self, run_sweep):
        out, fake = run_sweep([
            {"id": "01STALE", "updated_at": STALE, "payload_json": "{}"},
        ])
        assert out["recovered"] == 1
        assert out["parked"] == 0
        sid, kwargs = fake.updates[0]
        assert sid == "01STALE"
        assert kwargs["status"] == "unrouted"
        assert kwargs["payload"]["recovery_attempts"] == 1
        assert fake.audits, "a recovery must leave an audit row"

    def test_fresh_dispatching_signal_is_left_alone(self, run_sweep):
        """A dispatch may legitimately be in flight — don't yank it."""
        out, fake = run_sweep([
            {"id": "01FRESH", "updated_at": FRESH, "payload_json": "{}"},
        ])
        assert out == {"examined": 0, "recovered": 0, "parked": 0}
        assert fake.updates == []

    def test_attempt_counter_increments(self, run_sweep):
        out, fake = run_sweep([
            {"id": "01AGAIN", "updated_at": STALE,
             "payload_json": json.dumps({"recovery_attempts": 1})},
        ])
        assert out["recovered"] == 1
        assert fake.updates[0][1]["payload"]["recovery_attempts"] == 2


class TestBoundedByDesign:
    """#282's lesson: an uncapped recovery loop IS the incident."""

    def test_exhausted_signal_is_parked_not_relooped(self, run_sweep):
        out, fake = run_sweep([
            {"id": "01EXHAUSTED", "updated_at": STALE,
             "payload_json": json.dumps({"recovery_attempts": 3})},
        ])
        assert out["parked"] == 1
        assert out["recovered"] == 0
        sid, kwargs = fake.updates[0]
        assert kwargs["status"] == "routed_suppressed", (
            "past the cap the signal must be parked terminal, never "
            "flipped back to unrouted again"
        )

    def test_cap_is_configurable_and_respected(self, run_sweep):
        out, _ = run_sweep(
            [{"id": "01X", "updated_at": STALE,
              "payload_json": json.dumps({"recovery_attempts": 1})}],
            max_recoveries=1,
        )
        assert out["parked"] == 1

    def test_empty_queue_is_a_no_op(self, run_sweep):
        out, fake = run_sweep([])
        assert out == {"examined": 0, "recovered": 0, "parked": 0}
        assert fake.updates == [] and fake.audits == []


class TestRobustness:
    def test_malformed_payload_does_not_crash(self, run_sweep):
        out, _ = run_sweep([
            {"id": "01BAD", "updated_at": STALE, "payload_json": "{not json"},
        ])
        assert out["recovered"] == 1

    def test_row_without_id_is_skipped(self, run_sweep):
        out, fake = run_sweep([{"updated_at": STALE, "payload_json": "{}"}])
        assert out["recovered"] == 0
        assert fake.updates == []
