"""#454 P1 — a backlog clear-out is one gesture, not N lessons.

Replays the 2026-07-15 shape: 28 `intent: done` decisions inside 23 minutes,
which Reflection read as 28 independent lessons and generalised into a
suppression rule carrying the principal's client domain.
"""

from datetime import datetime, timedelta, timezone

from src.matching.bursts import (
    BURST_MIN_SIZE,
    annotate_decision_bursts,
    burst_summary,
)

BASE = datetime(2026, 7, 15, 9, 6, 25, tzinfo=timezone.utc)


def _obs(offset_s, intent="done", kind="decision", sender="x@example.com"):
    return {
        "path": f"obs-{offset_s}",
        "frontmatter": {
            "source_kind": kind,
            "intent": intent,
            "sender": sender,
            "created": (BASE + timedelta(seconds=offset_s)).isoformat(),
        },
    }


class TestBurstDetection:
    def test_the_2026_07_15_clearout_is_one_burst(self):
        # 28 clicks, ~50s apart — the real shape.
        obs = [_obs(i * 50) for i in range(28)]
        annotate_decision_bursts(obs)
        sizes = burst_summary(obs)
        assert len(sizes) == 1
        assert list(sizes.values()) == [28]
        assert all(o["frontmatter"]["burst_size"] == 28 for o in obs)
        assert len({o["frontmatter"]["burst_id"] for o in obs}) == 1

    def test_nothing_is_dropped(self):
        """Bookkeeping: every row must survive so it gets marked processed."""
        obs = [_obs(i * 50) for i in range(28)]
        out = annotate_decision_bursts(obs)
        assert len(out) == 28
        assert [o["path"] for o in out] == [f"obs-{i * 50}" for i in range(28)]

    def test_ordinary_spaced_decisions_are_not_a_burst(self):
        obs = [_obs(i * 3600) for i in range(6)]  # one an hour
        annotate_decision_bursts(obs)
        assert burst_summary(obs) == {}

    def test_short_run_below_threshold_is_not_a_burst(self):
        obs = [_obs(i * 30) for i in range(BURST_MIN_SIZE - 1)]
        annotate_decision_bursts(obs)
        assert burst_summary(obs) == {}

    def test_different_intents_do_not_merge(self):
        obs = [_obs(i * 30, intent="done") for i in range(6)]
        obs += [_obs(i * 30 + 5, intent="noise") for i in range(6)]
        annotate_decision_bursts(obs)
        ids = {o["frontmatter"]["burst_id"] for o in obs}
        assert len(ids) == 2

    def test_signal_observations_are_ignored(self):
        obs = [_obs(i * 30, kind="signal") for i in range(10)]
        annotate_decision_bursts(obs)
        assert burst_summary(obs) == {}

    def test_two_separate_sittings_are_two_bursts(self):
        morning = [_obs(i * 30) for i in range(6)]
        evening = [_obs(40000 + i * 30) for i in range(6)]
        obs = morning + evening
        annotate_decision_bursts(obs)
        assert len(burst_summary(obs)) == 2

    def test_gap_inside_a_run_splits_it(self):
        obs = [_obs(i * 30) for i in range(6)] + [_obs(6 * 30 + 600)]
        annotate_decision_bursts(obs)
        assert obs[-1]["frontmatter"].get("burst_id") is None


class TestRobustness:
    def test_missing_or_bad_timestamps_are_skipped(self):
        obs = [_obs(i * 30) for i in range(6)]
        obs.append({"path": "no-ts", "frontmatter": {
            "source_kind": "decision", "intent": "done"}})
        obs.append({"path": "bad-ts", "frontmatter": {
            "source_kind": "decision", "intent": "done", "created": "nonsense"}})
        annotate_decision_bursts(obs)
        assert obs[-1]["frontmatter"].get("burst_id") is None
        assert obs[-2]["frontmatter"].get("burst_id") is None

    def test_missing_intent_is_skipped(self):
        obs = [{"path": f"o{i}", "frontmatter": {
            "source_kind": "decision",
            "created": (BASE + timedelta(seconds=i * 30)).isoformat(),
        }} for i in range(10)]
        annotate_decision_bursts(obs)
        assert burst_summary(obs) == {}

    def test_empty_input(self):
        assert annotate_decision_bursts([]) == []
        assert burst_summary([]) == {}

    def test_naive_timestamps_are_handled(self):
        obs = [{"path": f"o{i}", "frontmatter": {
            "source_kind": "decision", "intent": "done",
            "created": (BASE + timedelta(seconds=i * 30))
            .replace(tzinfo=None).isoformat(),
        }} for i in range(6)]
        annotate_decision_bursts(obs)
        assert len(burst_summary(obs)) == 1
