"""Pure logic for approving an hours proposal from a Desk card (#485).

Kept separate from `decision_router` and free of HTTP so it can be tested
against real inputs rather than a mock. The migration script in #471 failed on
a live tenant precisely because its logic sat behind an unmocked call and its
tests only exercised helpers — the shape it assumed was never checked.

Two rules from #468 that this module exists to protect:

1. **Nothing is booked that Sir did not approve.** A note that cannot be parsed
   as a figure is a comment, never a number. Guessing at hours from prose would
   write a wrong total into the ledger under the appearance of his approval,
   which is worse than recording no correction at all.

2. **A correction records both figures.** The delta between the estimate and
   Sir's real number is the only feedback signal the estimator ever gets.
   Storing only the corrected value looks equivalent and quietly removes the
   feature's ability to improve.
"""

from __future__ import annotations

import re
from typing import Any

#: A correction is a bare number, optionally followed by an `h`/`hr`/`hours`
#: unit, at the very start of the note. Anchored deliberately: "6" and
#: "6.5 h — Tuesday ran short" are corrections; "looks about right, maybe
#: check Tuesday" is not, and neither is "approved, see thread 6".
_CORRECTION = re.compile(
    r"^\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:h|hr|hrs|hours)?\b",
    re.IGNORECASE,
)

#: Above this, a "correction" is far more likely a typo or a misparse than a
#: real weekly figure. A week has 168 hours; nobody bills them.
MAX_PLAUSIBLE_PERIOD_HOURS = 168.0


def parse_corrected_hours(note: str) -> float | None:
    """Return Sir's corrected total, or None when the note is just a comment.

    Returns None rather than raising: an unparseable note is the normal case,
    not an error. The caller books the original estimate unchanged.
    """
    if not note or not note.strip():
        return None
    m = _CORRECTION.match(note)
    if not m:
        return None
    try:
        value = float(m.group(1).replace(",", "."))
    except ValueError:  # pragma: no cover — regex guarantees a number
        return None
    if value < 0 or value > MAX_PLAUSIBLE_PERIOD_HOURS:
        return None
    return value


def build_acceptance(
    proposal: dict[str, Any],
    note: str,
    decision_id: str,
    now_iso: str,
) -> dict[str, Any]:
    """Build the frontmatter patch that marks a proposal accepted.

    When Sir corrected the figure, BOTH his number and the original estimate
    are recorded, plus the delta. See rule 2 in the module docstring.
    """
    estimated = proposal.get("total_hours")
    try:
        estimated_f = float(estimated) if estimated is not None else None
    except (TypeError, ValueError):
        estimated_f = None

    # A proposal is a `note`, and the validator allows only
    # active|draft|final|review. `accepted` is not a valid status, so writing
    # it 500s the PATCH and the acceptance never lands — found end-to-end on a
    # live tenant, twice.
    #
    # The valid vocabulary maps cleanly: a proposal is a `draft`, an accepted
    # period is `final`. `accepted: true` remains the machine marker, and
    # `is_already_accepted` also reads a legacy `status: accepted` so records
    # written before this keep working.
    #
    # The wider lesson, since this cost two live runs: the validator re-checks
    # the WHOLE record on any edit. An invalid value written through the
    # raw-content path (which skips validation) is inert until the first PATCH,
    # then blocks every subsequent write to that record.
    fields: dict[str, Any] = {
        "status": "final",
        "accepted": True,
        "accepted_at": now_iso,
        "accepted_by": "principal",
        "accepted_via": f"decision/{decision_id}.md",
    }

    corrected = parse_corrected_hours(note)
    if corrected is None:
        fields["accepted_total_hours"] = estimated_f
        if note.strip():
            # Preserve the comment even though it changed no number, so the
            # record shows Sir said something rather than silently approving.
            fields["acceptance_note"] = note.strip()
        return fields

    fields["accepted_total_hours"] = corrected
    fields["estimated_total_hours"] = estimated_f
    if estimated_f is not None:
        fields["correction_delta_hours"] = round(corrected - estimated_f, 2)
    fields["acceptance_note"] = note.strip()
    return fields


def is_already_accepted(proposal: dict[str, Any]) -> bool:
    """True when this proposal has already been booked.

    Guards the ledger append. A double append is a silently wrong total AND
    corrupts the next window, because the accepted ledger is the cursor that
    decides where the next period starts.
    """
    if proposal.get("accepted") is True:
        return True
    return str(proposal.get("status") or "").lower() == "accepted"


def ledger_line(proposal: dict[str, Any], accepted_hours: float | None) -> str:
    """One append-only ledger row for an accepted period."""
    start = proposal.get("period_start") or "?"
    end = proposal.get("period_end") or "?"
    hours = "?" if accepted_hours is None else f"{accepted_hours:g}"
    return f"| {start} | {end} | {hours} | accepted |"


def ledger_already_has_period(ledger_body: str, proposal: dict[str, Any]) -> bool:
    """True when this period is already booked in the ledger body.

    THE GUARD THAT ACTUALLY PROTECTS THE LEDGER. `is_already_accepted` reads
    the proposal, which is useless in the failure mode that matters: if the
    ledger append succeeds and the proposal patch then fails, the proposal
    still says `accepted: false`, so a retry sails past that check and appends
    the period a second time.

    That is not hypothetical — it happened on the first live run, when the
    proposal patch 500'd on an invalid `status` value while the ledger row had
    already landed. The claim that the ordering left "a re-runnable duplicate
    the idempotency check catches" was simply wrong; the check keyed on the one
    record that had not been written.

    So the ledger is asked about itself. A duplicate row is not merely a wrong
    total — the accepted ledger is the cursor for the next window, so it also
    corrupts the following period's boundary.
    """
    start = str(proposal.get("period_start") or "").strip()
    end = str(proposal.get("period_end") or "").strip()
    if not start or not end:
        # Cannot prove absence without a period. Refuse rather than risk a
        # duplicate: an unbooked period is recoverable, a double-booked one
        # silently mis-states both this window and the next.
        return True
    for line in ledger_body.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) >= 2 and cells[0] == start and cells[1] == end:
            return True
    return False
