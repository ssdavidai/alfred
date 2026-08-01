"""Regression tests for #373 (stuck-dispatching signal recovery) and
#379 (structured closure predicates for auto-created tasks)."""
from __future__ import annotations

import asyncio
import json

from src.activities import signal_actions as sa
from src.activities.task_closure import evaluate_predicate
from src.activities.task_creation import _structured_predicate_from_strings


class _FakeStateClient:
    def __init__(self, rows):
        self.rows = rows
        self.updates: list[tuple[str, dict]] = []
        self.audits: list[dict] = []

    async def list_signals(self, **kw):
        return self.rows

    async def update_signal(self, sid, **kw):
        self.updates.append((sid, kw))

    async def append_audit(self, **kw):
        self.audits.append(kw)
        return "01AUDIT"

    async def close(self):
        return None


def _stale_row(sid, attempts=0):
    payload = {"recovery_attempts": attempts} if attempts else {}
    return {
        "id": sid,
        "status": "dispatching",
        "updated_at": "2026-01-01T00:00:00+00:00",
        "payload_json": json.dumps(payload),
    }


class TestRecoverStuckDispatchingSignals373:
    def test_stale_signal_recovers_to_unrouted(self, monkeypatch):
        fake = _FakeStateClient([_stale_row("SIG1")])
        monkeypatch.setattr(
            "src.utils.state_client.StateClient", lambda _cfg: fake
        )
        out = asyncio.run(sa.recover_stuck_dispatching_signals())
        assert out == {"examined": 1, "recovered": 1, "parked": 0}
        sid, kw = fake.updates[0]
        assert sid == "SIG1"
        assert kw["status"] == "unrouted"
        assert kw["payload"]["recovery_attempts"] == 1
        assert fake.audits[0]["action_type"] == "signal_recovery"

    def test_cap_parks_as_suppressed(self, monkeypatch):
        """#282's lesson: recovery MUST be bounded — an uncapped loop was
        itself the office-AC spam bug."""
        fake = _FakeStateClient([_stale_row("SIG2", attempts=3)])
        monkeypatch.setattr(
            "src.utils.state_client.StateClient", lambda _cfg: fake
        )
        out = asyncio.run(sa.recover_stuck_dispatching_signals())
        assert out == {"examined": 1, "recovered": 0, "parked": 1}
        sid, kw = fake.updates[0]
        assert kw["status"] == "routed_suppressed"

    def test_fresh_dispatching_left_alone(self, monkeypatch):
        from datetime import datetime, timezone

        fresh = _stale_row("SIG3")
        fresh["updated_at"] = datetime.now(timezone.utc).isoformat()
        fake = _FakeStateClient([fresh])
        monkeypatch.setattr(
            "src.utils.state_client.StateClient", lambda _cfg: fake
        )
        out = asyncio.run(sa.recover_stuck_dispatching_signals())
        assert out == {"examined": 0, "recovered": 0, "parked": 0}
        assert fake.updates == []


class TestStructuredPredicateMapping379:
    def test_payment_wins(self):
        got = _structured_predicate_from_strings(
            ["gmail:from:mailgun.com", "sure:transaction:match:Mailgun"]
        )
        assert got == {
            "kind": "payment_to_merchant",
            "fields": {"merchant": "Mailgun"},
        }

    def test_gmail_pair_maps(self):
        got = _structured_predicate_from_strings(
            ["gmail:from:mailgun.com", "gmail:subject_contains:reactivated"]
        )
        assert got == {
            "kind": "gmail_from_subject",
            "fields": {"from": "mailgun.com", "subject_contains": "reactivated"},
        }

    def test_gmail_half_pair_maps_nothing(self):
        """The matcher rejects a predicate missing either field — don't
        emit one that can never fire."""
        assert _structured_predicate_from_strings(["gmail:from:x.com"]) is None

    def test_unmappable_strings_yield_none(self):
        assert _structured_predicate_from_strings(["sure:account:acc_1"]) is None

    def test_evaluate_predicate_accepts_json_string(self):
        """The frontmatter stores the predicate as an inline JSON string;
        the consumer must parse it (it previously required a dict and
        silently fell back to the LLM)."""
        pred = json.dumps(
            {"kind": "payment_to_merchant", "fields": {"merchant": "Mailgun"}}
        )
        signal_fm = {"raw": {"merchant": "MAILGUN technologies", "amount": 35}}
        out = evaluate_predicate(pred, signal_fm)
        assert out is not None and out["closes"] is True

    def test_evaluate_predicate_garbage_string_is_none(self):
        assert evaluate_predicate("not json", {}) is None


class TestAllFourPredicateKindsCovered:
    """#379 follow-up (post-fix rescan): the mapper only covered 2 of the
    4 documented closure-predicate kinds, so thread-reply and
    calendar-accept auto-tasks still had an inert fast path."""

    def test_gmail_thread_reply(self):
        from src.activities.task_creation import _structured_predicate_from_strings

        out = _structured_predicate_from_strings(["gmail:thread:18f0abc"])
        assert out == {"kind": "gmail_thread_reply", "fields": {"thread_id": "18f0abc"}}

    def test_calendar_event_accepted(self):
        from src.activities.task_creation import _structured_predicate_from_strings

        out = _structured_predicate_from_strings(["calendar:event_accepted:evt_99"])
        assert out == {"kind": "calendar_event_accepted", "fields": {"event_id": "evt_99"}}

    def test_thread_id_outranks_from_subject(self):
        """A thread id is an exact match; from+subject is a heuristic."""
        from src.activities.task_creation import _structured_predicate_from_strings

        out = _structured_predicate_from_strings([
            "gmail:from:a@b.com", "gmail:subject_contains:invoice",
            "gmail:thread:18f0abc",
        ])
        assert out["kind"] == "gmail_thread_reply"

    def test_payment_still_wins_overall(self):
        from src.activities.task_creation import _structured_predicate_from_strings

        out = _structured_predicate_from_strings([
            "gmail:thread:18f0abc", "sure:transaction:match:ACME",
        ])
        assert out["kind"] == "payment_to_merchant"

    def test_every_mapped_kind_is_one_the_watcher_consumes(self):
        """Guard: the mapper must never invent a kind evaluate_predicate
        doesn't implement — that would look wired and silently no-op."""
        from src.activities import task_closure
        from src.activities.task_creation import _structured_predicate_from_strings

        cases = [
            ["sure:transaction:match:X"],
            ["gmail:thread:t1"],
            ["gmail:from:a@b.com", "gmail:subject_contains:s"],
            ["calendar:event_accepted:e1"],
        ]
        known = set(task_closure._PREDICATE_KINDS)
        for c in cases:
            out = _structured_predicate_from_strings(c)
            assert out is not None and out["kind"] in known, (c, out)
