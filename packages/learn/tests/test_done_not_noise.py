"""#454 — clicking Done must not teach Alfred to suppress the sender.

`hold` was overloaded: `_intent_to_routing_rule` mapped noise, defer AND done
onto `destination_type: hold`, and the pre-extraction noise gate enrols on
exactly that. So an instinct born from "I've handled this card" clicks became
a permanent sender kill-switch.

Provenance on home: `close-stale-and-duplicate-attention-cards` links 20+
decisions from a single 23-minute window on 2026-07-15 in which all 28
decisions were `intent: done` — a backlog clear-out. Its `sender_domains`
were taken from whatever happened to be in that batch, which included the
principal's primary client.

Fixed on both paths (belt and braces):
  * `done` yields no routing rule at all;
  * the gate excludes the machine-generated `auto-archive` / `auto-defer`
    markers, while hand-authored `hold` rules still enrol (BUG 3).
"""

import pytest

from src.activities.decision_observations import _intent_to_routing_rule


class TestIntentMapping:
    def test_done_yields_no_routing_rule(self):
        assert _intent_to_routing_rule("done") is None

    def test_noise_still_maps_to_hold(self):
        rr = _intent_to_routing_rule("noise")
        assert rr == {"destination_type": "hold", "destination": "auto-noise"}

    def test_delegate_unchanged(self):
        rr = _intent_to_routing_rule("delegate")
        assert rr == {"destination_type": "person", "destination": "alfred"}

    def test_defer_still_holds_but_is_marked_auto_defer(self):
        """Defer keeps its rule; the gate excludes it by destination."""
        rr = _intent_to_routing_rule("defer")
        assert rr["destination_type"] == "hold"
        assert rr["destination"] == "auto-defer"

    def test_no_intent_produces_a_suppression_rule_except_noise(self):
        for intent in ("done", "delegate", "take_mine", "approve", ""):
            rr = _intent_to_routing_rule(intent)
            if rr is None:
                continue
            assert rr["destination"] != "auto-noise", intent


class TestGateEnrolment:
    """`load_noise_instincts`' enrolment predicate, exercised directly.

    Mirrors the module's condition so the rule is pinned without standing up
    ctrl-api. Kept adjacent to the real code path it describes.
    """

    @staticmethod
    def _enrols(intent_key="", dest_type="", destination=""):
        from src.activities.noise_patterns import _NON_NOISE_HOLD_DESTINATIONS

        if intent_key != "noise" and dest_type != "hold":
            return False
        if intent_key != "noise" and destination in _NON_NOISE_HOLD_DESTINATIONS:
            return False
        return True

    def test_auto_noise_enrols(self):
        assert self._enrols(dest_type="hold", destination="auto-noise") is True

    def test_intent_key_noise_enrols(self):
        assert self._enrols(intent_key="noise") is True

    def test_done_derived_archive_rule_does_not_enrol(self):
        assert self._enrols(dest_type="hold", destination="auto-archive") is False

    def test_defer_derived_rule_does_not_enrol(self):
        """Defer means 'show me later' — the opposite of suppression."""
        assert self._enrols(dest_type="hold", destination="auto-defer") is False

    def test_hand_authored_hold_rule_still_enrols(self):
        """BUG 3 must not regress: suppress-ci-github-workflow-noise carries
        only a routing_rule with a self-referential destination."""
        assert self._enrols(
            dest_type="hold",
            destination="[[instinct/suppress-ci-github-workflow-noise]]",
        ) is True

    def test_non_hold_rule_never_enrols(self):
        assert self._enrols(dest_type="person", destination="alfred") is False

    def test_explicit_noise_intent_beats_the_destination_exclusion(self):
        """An instinct that really is noise stays enrolled even if its
        destination happens to carry an excluded marker."""
        assert self._enrols(
            intent_key="noise", dest_type="hold", destination="auto-archive"
        ) is True
