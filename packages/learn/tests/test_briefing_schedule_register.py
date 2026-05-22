"""F33a — BriefingWorkflow is a built-in scheduled pair, not a chore.

The morning + evening brief was never scheduled by register_schedules
(only a duplicate Opus-generated morning_briefing chore fired). The brief
must be a mandatory built-in: register BriefingWorkflow at 05:00 / 17:00
in the user's LOCAL timezone, passing the positional slot string per C10
(BriefingWorkflow.run(self, slot)).
"""
from __future__ import annotations

from temporalio.client import ScheduleSpec

import scripts.register_schedules as mod


def _briefing_entries() -> list[dict]:
    entries = mod._build_schedule_entries("Europe/London")
    return [e for e in entries if e.get("workflow") == "BriefingWorkflow"]


def test_morning_and_evening_briefing_registered():
    briefs = _briefing_entries()
    ids = {e["id"] for e in briefs}
    assert "al-briefing-morning" in ids
    assert "al-briefing-evening" in ids


def test_briefing_fires_in_user_local_tz():
    for e in _briefing_entries():
        spec: ScheduleSpec = e["spec"]
        # Calendar schedules carry the tenant tz so 5am/5pm are LOCAL,
        # not UTC.
        assert spec.time_zone_name == "Europe/London"
        assert spec.calendars, f"{e['id']} must be a calendar schedule"


def test_briefing_passes_positional_slot_arg():
    by_id = {e["id"]: e for e in _briefing_entries()}
    # C10: the schedule passes a positional slot STRING matching
    # BriefingWorkflow.run(self, slot) — not a dict.
    assert by_id["al-briefing-morning"].get("args") == ["morning"]
    assert by_id["al-briefing-evening"].get("args") == ["evening"]


def test_briefing_slots_at_5am_and_5pm():
    by_id = {e["id"]: e for e in _briefing_entries()}
    m_cal = by_id["al-briefing-morning"]["spec"].calendars[0]
    e_cal = by_id["al-briefing-evening"]["spec"].calendars[0]
    assert m_cal.hour[0].start == 5
    assert e_cal.hour[0].start == 17
