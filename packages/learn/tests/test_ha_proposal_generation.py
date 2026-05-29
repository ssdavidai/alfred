"""HaBootstrapWorkflow Phase C — proposal generation tests (#110 PR6).

8 tests — one per gap kind — assert that ``generate_proposal()``
emits a valid YAML automation for each of the 8 baseline gaps.

We don't bring a full YAML parser as a dependency (the file is plain
ASCII templates kept inline in the activity module). Each test:

  1. Calls ``generate_proposal()`` with a synthetic ``HaGapRow``.
  2. Asserts the returned dict has the required keys.
  3. Asserts the YAML body carries the load-bearing service / trigger
     fragments the spec asks for.
"""
from __future__ import annotations

import pytest

from src.activities.ha_gap_detection import generate_proposal


def _gap(kind: str, **kwargs):
    base = {
        "kind": kind,
        "summary": f"{kind} summary",
        "severity": "medium",
        "area_id": None,
        "device_id": None,
        "discovered_at": "2026-05-29T00:00:00Z",
        "evidence": {},
    }
    base.update(kwargs)
    return base


class TestProposalGeneration:
    def test_morning(self) -> None:
        p = generate_proposal(_gap("no_morning_routine"))
        assert p["kind"] == "no_morning_routine"
        assert "platform: sun" in p["yaml"]
        assert "event: sunrise" in p["yaml"]
        assert "light.turn_on" in p["yaml"]
        assert "alias:" in p["yaml"]
        assert "mode: single" in p["yaml"]

    def test_bedtime(self) -> None:
        p = generate_proposal(_gap("no_bedtime_routine"))
        assert p["kind"] == "no_bedtime_routine"
        assert "platform: time" in p["yaml"]
        assert "light.turn_off" in p["yaml"]
        assert "lock.lock" in p["yaml"]

    def test_motion_lighting_with_area(self) -> None:
        p = generate_proposal(_gap("no_motion_lighting", area_id="hallway"))
        assert p["kind"] == "no_motion_lighting"
        assert "binary_sensor" in p["yaml"]
        assert "light.turn_on" in p["yaml"]
        assert "area_id: hallway" in p["yaml"]

    def test_motion_lighting_no_area_falls_back(self) -> None:
        p = generate_proposal(_gap("no_motion_lighting", area_id=None))
        # Should still produce a valid YAML; the target falls back to
        # entity_id: all when there's no area to scope on.
        assert "light.turn_on" in p["yaml"]
        assert "entity_id: all" in p["yaml"]

    def test_away_mode(self) -> None:
        p = generate_proposal(_gap("no_away_mode"))
        assert p["kind"] == "no_away_mode"
        assert "not_home" in p["yaml"]
        assert "light.turn_off" in p["yaml"]
        assert "lock.lock" in p["yaml"]

    def test_security_camera_notify(self) -> None:
        p = generate_proposal(_gap("no_security_camera_notification"))
        assert p["kind"] == "no_security_camera_notification"
        assert "notify." in p["yaml"]
        assert "Camera" in p["yaml"] or "Motion" in p["yaml"]

    def test_vacation_mode(self) -> None:
        p = generate_proposal(_gap("no_vacation_mode"))
        assert p["kind"] == "no_vacation_mode"
        assert "input_boolean.vacation" in p["yaml"]
        assert "light.turn_on" in p["yaml"]

    def test_climate_schedule(self) -> None:
        p = generate_proposal(_gap("no_climate_schedule"))
        assert p["kind"] == "no_climate_schedule"
        assert "climate.set_temperature" in p["yaml"]
        assert "platform: time" in p["yaml"]

    def test_party_mode(self) -> None:
        p = generate_proposal(_gap("no_party_mode"))
        assert p["kind"] == "no_party_mode"
        assert "input_boolean.party" in p["yaml"]
        assert "scene.turn_on" in p["yaml"]

    def test_unknown_kind_raises(self) -> None:
        with pytest.raises(ValueError):
            generate_proposal(_gap("no_such_gap"))

    def test_summary_persists(self) -> None:
        p = generate_proposal(_gap("no_morning_routine", summary="Custom copy"))
        assert p["summary"] == "Custom copy"
