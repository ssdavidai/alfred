"""#485 — the router wiring, not just the pure logic.

WHY THIS FILE EXISTS SEPARATELY. `test_hours_approval.py` covers the pure
module and proves nothing about whether the router calls it correctly, in the
right order, against the real response shape. That gap is exactly how the #471
migration shipped broken: its helpers were tested, its read path was not.

The fake client below mirrors ctrl-api's actual response shape —
`{path, frontmatter, body}` — because assuming a `content` key is the specific
mistake that cost a live run today.
"""

import asyncio

import pytest

from src.activities.decision_router import _accept_hours_proposal_if_any

CARD = "needs_attention/2026-08-07T18-00-00Z-abc.md"
PROPOSAL = "note/acme-timesheet-proposal-2026-08-07.md"
LEDGER = "note/acme-timesheet.md"


class FakeResp:
    def __init__(self, payload, status=200):
        self._p, self.status_code = payload, status

    def json(self):
        return self._p

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeClient:
    """Records the order of writes — the property that matters most here."""

    def __init__(self, card_fm, proposal_fm, ledger_fails=False, ledger_body=""):
        self.card_fm = card_fm
        self.proposal_fm = dict(proposal_fm)
        self.ledger_fails = ledger_fails
        self.ledger_body = ledger_body
        self.writes: list[str] = []

    async def get(self, path):
        rel = path.replace("/api/v1/vault/records/", "")
        if rel == CARD:
            return FakeResp({"path": rel, "frontmatter": self.card_fm, "body": ""})
        if rel == PROPOSAL:
            return FakeResp({"path": rel, "frontmatter": self.proposal_fm, "body": ""})
        if rel == LEDGER:
            return FakeResp({"path": rel, "frontmatter": {}, "body": self.ledger_body})
        return FakeResp({}, 404)

    async def patch(self, path, json=None):
        rel = path.replace("/api/v1/vault/records/", "")
        if rel == LEDGER:
            if self.ledger_fails:
                return FakeResp({}, 500)
            self.writes.append("ledger")
            self.ledger_body += "\n" + ((json or {}).get("body_append") or "")
            return FakeResp({"ok": True})
        if rel == PROPOSAL:
            self.writes.append("proposal")
            self.proposal_fm.update((json or {}).get("set") or {})
            return FakeResp({"ok": True})
        return FakeResp({}, 404)


HOURS_CARD = {
    "approval_kind": "hours_proposal",
    "proposal_ref": PROPOSAL,
    "ledger_ref": LEDGER,
}
OPEN_PROPOSAL = {
    "accepted": False,
    "status": "proposed",
    "total_hours": 8.0,
    "period_start": "2026-08-01",
    "period_end": "2026-08-07",
}


def run(c, note=""):
    return asyncio.run(_accept_hours_proposal_if_any(c, CARD, note, "dec-1"))


class TestNoOpPaths:
    def test_ordinary_card_is_untouched(self):
        """The common case. Every non-hours `done` click must be unaffected."""
        c = FakeClient({"action_what": "reply to the plumber"}, OPEN_PROPOSAL)
        assert run(c) is None
        assert c.writes == []

    def test_card_missing_refs_books_nothing(self):
        c = FakeClient({"approval_kind": "hours_proposal"}, OPEN_PROPOSAL)
        assert run(c) is None
        assert c.writes == []


class TestOrdering:
    def test_ledger_is_written_before_the_proposal_is_marked_accepted(self):
        """The ordering rule, asserted rather than commented.

        Reversed, a partial failure marks the proposal accepted with nothing
        in the ledger — the hours vanish AND the next window skips the period,
        because the accepted ledger is the cursor.
        """
        c = FakeClient(HOURS_CARD, OPEN_PROPOSAL)
        run(c)
        assert c.writes == ["ledger", "proposal"]

    def test_a_failed_ledger_write_leaves_the_proposal_open(self):
        c = FakeClient(HOURS_CARD, OPEN_PROPOSAL, ledger_fails=True)
        with pytest.raises(Exception):
            run(c)
        assert "proposal" not in c.writes
        assert c.proposal_fm["accepted"] is False


class TestBooking:
    def test_plain_approval_books_the_estimate(self):
        c = FakeClient(HOURS_CARD, OPEN_PROPOSAL)
        out = run(c)
        assert out["hours"] == 8.0 and out["corrected"] is False
        assert c.proposal_fm["accepted"] is True

    def test_correction_books_the_corrected_figure(self):
        c = FakeClient(HOURS_CARD, OPEN_PROPOSAL)
        out = run(c, note="6")
        assert out["hours"] == 6.0 and out["corrected"] is True
        assert c.proposal_fm["estimated_total_hours"] == 8.0
        assert c.proposal_fm["correction_delta_hours"] == -2.0

    def test_prose_note_books_the_estimate_and_guesses_nothing(self):
        c = FakeClient(HOURS_CARD, OPEN_PROPOSAL)
        out = run(c, note="approved, closes issue 6")
        assert out["hours"] == 8.0
        assert "correction_delta_hours" not in c.proposal_fm


class TestIdempotency:
    def test_second_approval_does_not_append_again(self):
        already = dict(OPEN_PROPOSAL, accepted=True, status="accepted")
        c = FakeClient(HOURS_CARD, already)
        out = run(c)
        assert out["skipped"] == "already_accepted"
        assert c.writes == []


class TestReadBack:
    def test_a_silent_no_op_patch_is_caught(self):
        """CLAUDE.md 15.1 — this PATCH route can 200 while writing nothing.

        The ledger row is already appended at that point, so failing loudly is
        the only way the discrepancy gets noticed.
        """

        class NoOpPatch(FakeClient):
            async def patch(self, path, json=None):
                rel = path.replace("/api/v1/vault/records/", "")
                if rel == LEDGER:
                    self.writes.append("ledger")
                return FakeResp({"ok": True})  # 200, wrote nothing

        c = NoOpPatch(HOURS_CARD, OPEN_PROPOSAL)
        with pytest.raises(RuntimeError, match="did not read back as accepted"):
            run(c)

    def test_a_retry_after_a_failed_proposal_patch_does_not_double_book(self):
        """The live failure, reproduced.

        On the first real run the ledger row landed and the proposal patch
        500'd (invalid `status` for a note). The proposal therefore still reads
        accepted:false, so `is_already_accepted` waves the retry through — and
        the old code would have appended the period a second time.

        A duplicate is not just a wrong total: the accepted ledger is the
        cursor for the next window, so it corrupts the following period too.
        """
        booked = "| 2026-08-01 | 2026-08-07 | 6 | accepted |\n"
        c = FakeClient(HOURS_CARD, OPEN_PROPOSAL, ledger_body=booked)
        out = run(c, note="6")
        assert c.writes == ["proposal"], "must not append the ledger again"
        assert c.ledger_body.count("2026-08-01 | 2026-08-07") == 1
        assert c.proposal_fm["accepted"] is True, "and must close the gap"
        assert out["hours"] == 6.0
