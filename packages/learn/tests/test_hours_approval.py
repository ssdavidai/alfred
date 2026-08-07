"""#485 — approving an hours proposal from a Desk card.

The two behaviours worth defending, per #468:

1. Nothing is booked that Sir did not approve. An unparseable note is a
   comment, never a guessed number.
2. A correction records both figures. The delta is the only feedback signal
   the estimator gets; storing only the corrected value looks equivalent and
   silently removes the feature's ability to improve.
"""

from src.matching.hours_approval import (
    MAX_PLAUSIBLE_PERIOD_HOURS,
    build_acceptance,
    is_already_accepted,
    ledger_line,
    parse_corrected_hours,
)


class TestParseCorrectedHours:
    def test_bare_number(self):
        assert parse_corrected_hours("6") == 6.0

    def test_decimal_and_unit(self):
        assert parse_corrected_hours("6.5h") == 6.5
        assert parse_corrected_hours("6.5 hours") == 6.5
        assert parse_corrected_hours("7 hrs") == 7.0

    def test_comma_decimal(self):
        # Sir writes in a locale where the comma is the decimal separator.
        assert parse_corrected_hours("6,25") == 6.25

    def test_number_then_explanation(self):
        assert parse_corrected_hours("6.5 — Tuesday ran short") == 6.5

    def test_prose_is_a_comment_not_a_number(self):
        """The rule that keeps a misparse out of the ledger."""
        for note in (
            "looks about right",
            "approved",
            "fine, but check Tuesday next time",
            "see thread 6 for context",
            "",
            "   ",
        ):
            assert parse_corrected_hours(note) is None, note

    def test_implausible_totals_are_rejected(self):
        # A week has 168 hours. A bigger "correction" is a typo or a misparse.
        assert parse_corrected_hours("800") is None
        assert parse_corrected_hours(str(MAX_PLAUSIBLE_PERIOD_HOURS + 1)) is None
        assert parse_corrected_hours("168") == 168.0

    def test_a_trailing_number_is_not_a_correction(self):
        # Anchored at the start on purpose: "issue 6" must not book 6 hours.
        assert parse_corrected_hours("approved, closes issue 6") is None


class TestBuildAcceptance:
    PROPOSAL = {"total_hours": 8.0, "period_start": "2026-08-01", "period_end": "2026-08-07"}

    def test_plain_approval_books_the_estimate(self):
        f = build_acceptance(self.PROPOSAL, "", "abc123", "2026-08-07T18:00:00+02:00")
        assert f["accepted"] is True
        assert f["accepted_total_hours"] == 8.0
        assert "correction_delta_hours" not in f

    def test_correction_records_both_figures_and_the_delta(self):
        """The feedback signal. Without this the estimator never improves."""
        f = build_acceptance(self.PROPOSAL, "6", "abc123", "2026-08-07T18:00:00+02:00")
        assert f["accepted_total_hours"] == 6.0
        assert f["estimated_total_hours"] == 8.0
        assert f["correction_delta_hours"] == -2.0

    def test_comment_without_a_number_preserves_the_comment(self):
        f = build_acceptance(
            self.PROPOSAL, "fine but tighten Tuesday", "abc", "2026-08-07T18:00:00+02:00"
        )
        assert f["accepted_total_hours"] == 8.0
        assert f["acceptance_note"] == "fine but tighten Tuesday"
        assert "correction_delta_hours" not in f

    def test_records_which_decision_booked_it(self):
        f = build_acceptance(self.PROPOSAL, "", "d-99", "2026-08-07T18:00:00+02:00")
        assert f["accepted_via"] == "decision/d-99.md"

    def test_missing_estimate_does_not_crash_or_invent_a_delta(self):
        f = build_acceptance({"period_start": "a", "period_end": "b"}, "6", "x", "t")
        assert f["accepted_total_hours"] == 6.0
        assert "correction_delta_hours" not in f


class TestIdempotency:
    def test_accepted_flag_blocks_a_second_append(self):
        assert is_already_accepted({"accepted": True}) is True

    def test_status_blocks_a_second_append(self):
        assert is_already_accepted({"status": "accepted"}) is True

    def test_open_proposal_is_appendable(self):
        assert is_already_accepted({"accepted": False, "status": "proposed"}) is False

    def test_double_append_would_corrupt_the_next_window(self):
        # Not just a wrong total: the accepted ledger is the cursor that
        # decides where the next period starts.
        p = {"accepted": False}
        assert is_already_accepted(p) is False
        p.update(build_acceptance(p, "", "d1", "t"))
        assert is_already_accepted(p) is True


class TestLedgerLine:
    def test_row_shape(self):
        line = ledger_line(
            {"period_start": "2026-08-01", "period_end": "2026-08-07"}, 6.5
        )
        assert line == "| 2026-08-01 | 2026-08-07 | 6.5 | accepted |"

    def test_whole_numbers_do_not_render_a_trailing_zero(self):
        assert "| 8 |" in ledger_line({"period_start": "a", "period_end": "b"}, 8.0)
