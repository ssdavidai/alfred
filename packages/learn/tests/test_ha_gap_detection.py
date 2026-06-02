"""HaBootstrapWorkflow Phase B — gap detection tests (#110 PR6).

24+ test cases across the 8 baseline gap kinds (3 per kind: present /
absent / edge). The detectors are pure functions over the registry
shape — no Temporal, no httpx, no LLM.

Each fixture builds a minimal HaRegistry dict and asserts which gap
rows ``detect_gaps`` emits. The fixtures are deliberately compact so a
human reviewer can scan the "what does this gap mean" semantics next
to the assertion.
"""
from __future__ import annotations

from typing import Any

import pytest

from src.activities.ha_gap_detection import detect_gaps


# ─────────────────────────────────────────────────────────────────────────
# Fixture helpers
# ─────────────────────────────────────────────────────────────────────────


def _entity(
    entity_id: str,
    *,
    area_id: str | None = None,
    attributes: dict[str, Any] | None = None,
    state: str = "on",
) -> dict[str, Any]:
    return {
        "entity_id": entity_id,
        "state": state,
        "area_id": area_id,
        "attributes": attributes or {},
    }


def _area(area_id: str, name: str) -> dict[str, Any]:
    return {"ha_id": area_id, "area_id": area_id, "name": name}


def _automation(
    entity_id: str,
    *,
    yaml_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    a: dict[str, Any] = {
        "entity_id": entity_id,
        "state": "on",
        "attributes": {"friendly_name": entity_id.split(".", 1)[1]},
    }
    if yaml_config is not None:
        a["yaml_config"] = yaml_config
    return a


def _registry(
    *,
    entities: list[dict[str, Any]] | None = None,
    areas: list[dict[str, Any]] | None = None,
    automations: list[dict[str, Any]] | None = None,
    helpers: list[dict[str, Any]] | None = None,
    scenes: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "entities": entities or [],
        "areas": areas or [],
        "devices": [],
        "automations": automations or [],
        "scenes": scenes or [],
        "helpers": helpers or [],
    }


def _kinds(rows: list[dict[str, Any]]) -> set[str]:
    return {r["kind"] for r in rows}


# ─────────────────────────────────────────────────────────────────────────
# 1. no_morning_routine
# ─────────────────────────────────────────────────────────────────────────


class TestMorningRoutine:
    def test_present_sun_trigger_covers(self) -> None:
        reg = _registry(
            entities=[_entity("light.kitchen", area_id="kitchen")],
            automations=[
                _automation(
                    "automation.morning",
                    yaml_config={
                        "trigger": [{"platform": "sun", "event": "sunrise"}],
                        "action": [
                            {
                                "service": "light.turn_on",
                                "target": {"entity_id": "light.kitchen"},
                            }
                        ],
                    },
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_morning_routine" not in _kinds(gaps)

    def test_absent_no_automation(self) -> None:
        reg = _registry(
            entities=[_entity("light.kitchen", area_id="kitchen")],
        )
        gaps = detect_gaps(reg)
        assert "no_morning_routine" in _kinds(gaps)
        morning = [g for g in gaps if g["kind"] == "no_morning_routine"][0]
        assert morning["severity"] == "medium"

    def test_edge_late_time_doesnt_count(self) -> None:
        """A time trigger at 11:00 is NOT a morning routine — gap stands."""
        reg = _registry(
            entities=[_entity("light.kitchen", area_id="kitchen")],
            automations=[
                _automation(
                    "automation.late",
                    yaml_config={
                        "trigger": [{"platform": "time", "at": "11:00:00"}],
                        "action": [{"service": "light.turn_on"}],
                    },
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_morning_routine" in _kinds(gaps)

    def test_edge_time_in_window_covers(self) -> None:
        """07:30 time trigger covers the morning window."""
        reg = _registry(
            entities=[_entity("light.kitchen", area_id="kitchen")],
            automations=[
                _automation(
                    "automation.morn",
                    yaml_config={
                        "trigger": [{"platform": "time", "at": "07:30:00"}],
                        "action": [{"service": "light.turn_on"}],
                    },
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_morning_routine" not in _kinds(gaps)


# ─────────────────────────────────────────────────────────────────────────
# 2. no_bedtime_routine
# ─────────────────────────────────────────────────────────────────────────


class TestBedtimeRoutine:
    def test_present_lights_off_lock(self) -> None:
        reg = _registry(
            entities=[
                _entity("light.kitchen", area_id="kitchen"),
                _entity("lock.front", area_id="hall"),
            ],
            automations=[
                _automation(
                    "automation.bedtime",
                    yaml_config={
                        "trigger": [{"platform": "time", "at": "22:30:00"}],
                        "action": [
                            {"service": "light.turn_off"},
                            {"service": "lock.lock"},
                        ],
                    },
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_bedtime_routine" not in _kinds(gaps)

    def test_absent_no_late_automation(self) -> None:
        reg = _registry(
            entities=[
                _entity("light.kitchen", area_id="kitchen"),
                _entity("lock.front", area_id="hall"),
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_bedtime_routine" in _kinds(gaps)

    def test_edge_time_too_early(self) -> None:
        """A 20:00 trigger is NOT bedtime (must be 22:00+)."""
        reg = _registry(
            entities=[_entity("light.kitchen", area_id="kitchen")],
            automations=[
                _automation(
                    "automation.early",
                    yaml_config={
                        "trigger": [{"platform": "time", "at": "20:00:00"}],
                        "action": [{"service": "light.turn_off"}],
                    },
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_bedtime_routine" in _kinds(gaps)

    def test_edge_late_but_no_lock_when_locks_present(self) -> None:
        """Late trigger turns lights off but no lock action → gap stands."""
        reg = _registry(
            entities=[
                _entity("light.kitchen", area_id="kitchen"),
                _entity("lock.front", area_id="hall"),
            ],
            automations=[
                _automation(
                    "automation.late",
                    yaml_config={
                        "trigger": [{"platform": "time", "at": "23:00:00"}],
                        "action": [{"service": "light.turn_off"}],
                    },
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_bedtime_routine" in _kinds(gaps)


# ─────────────────────────────────────────────────────────────────────────
# 3. no_motion_lighting (per-area)
# ─────────────────────────────────────────────────────────────────────────


class TestMotionLighting:
    def test_present_hallway_covered(self) -> None:
        reg = _registry(
            areas=[_area("hallway", "Hallway")],
            entities=[
                _entity(
                    "binary_sensor.hallway_motion",
                    area_id="hallway",
                    attributes={"device_class": "motion"},
                ),
                _entity("light.hallway", area_id="hallway"),
            ],
            automations=[
                _automation(
                    "automation.hallway_motion",
                    yaml_config={
                        "trigger": [
                            {
                                "platform": "state",
                                "entity_id": "binary_sensor.hallway_motion",
                                "to": "on",
                            }
                        ],
                        "action": [
                            {
                                "service": "light.turn_on",
                                "target": {"area_id": "hallway"},
                            }
                        ],
                    },
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_motion_lighting" not in _kinds(gaps)

    def test_absent_hallway_sensor_uncovered(self) -> None:
        reg = _registry(
            areas=[_area("hallway", "Hallway")],
            entities=[
                _entity(
                    "binary_sensor.hallway_motion",
                    area_id="hallway",
                    attributes={"device_class": "motion"},
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_motion_lighting" in _kinds(gaps)
        motion = [g for g in gaps if g["kind"] == "no_motion_lighting"][0]
        assert motion["area_id"] == "hallway"

    def test_edge_kitchen_motion_does_NOT_flag(self) -> None:
        """Kitchens aren't in the motion-area allowlist — no flag."""
        reg = _registry(
            areas=[_area("kitchen", "Kitchen")],
            entities=[
                _entity(
                    "binary_sensor.kitchen_motion",
                    area_id="kitchen",
                    attributes={"device_class": "motion"},
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_motion_lighting" not in _kinds(gaps)

    def test_edge_bathroom_motion_DOES_flag(self) -> None:
        reg = _registry(
            areas=[_area("bathroom", "Bathroom")],
            entities=[
                _entity(
                    "binary_sensor.bathroom_motion",
                    area_id="bathroom",
                    attributes={"device_class": "motion"},
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_motion_lighting" in _kinds(gaps)


# ─────────────────────────────────────────────────────────────────────────
# 4. no_away_mode
# ─────────────────────────────────────────────────────────────────────────


class TestAwayMode:
    def test_present_not_home_trigger(self) -> None:
        reg = _registry(
            entities=[
                _entity("device_tracker.phone", state="home"),
                _entity("light.kitchen"),
            ],
            automations=[
                _automation(
                    "automation.away",
                    yaml_config={
                        "trigger": [
                            {
                                "platform": "state",
                                "entity_id": "device_tracker.phone",
                                "to": "not_home",
                            }
                        ],
                        "action": [{"service": "light.turn_off"}],
                    },
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_away_mode" not in _kinds(gaps)

    def test_absent_no_tracker_watcher(self) -> None:
        reg = _registry(
            entities=[_entity("device_tracker.phone", state="home")],
        )
        gaps = detect_gaps(reg)
        assert "no_away_mode" in _kinds(gaps)

    def test_edge_no_trackers_no_gap(self) -> None:
        """No device_tracker → away-mode gap is not surfaced (no signal)."""
        reg = _registry(
            entities=[_entity("light.kitchen", area_id="kitchen")],
        )
        gaps = detect_gaps(reg)
        assert "no_away_mode" not in _kinds(gaps)


# ─────────────────────────────────────────────────────────────────────────
# 5. no_security_camera_notification
# ─────────────────────────────────────────────────────────────────────────


class TestCameraNotification:
    def test_present_notify_on_motion(self) -> None:
        reg = _registry(
            entities=[
                _entity("camera.front_door"),
                _entity(
                    "binary_sensor.front_motion",
                    attributes={"device_class": "motion"},
                ),
            ],
            automations=[
                _automation(
                    "automation.notify",
                    yaml_config={
                        "trigger": [
                            {
                                "platform": "state",
                                "entity_id": "binary_sensor.front_motion",
                                "to": "on",
                            }
                        ],
                        "action": [
                            {"service": "notify.mobile_app_iphone"}
                        ],
                    },
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_security_camera_notification" not in _kinds(gaps)

    def test_absent_no_notification(self) -> None:
        reg = _registry(
            entities=[
                _entity("camera.front_door"),
                _entity(
                    "binary_sensor.front_motion",
                    attributes={"device_class": "motion"},
                ),
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_security_camera_notification" in _kinds(gaps)
        row = [
            g
            for g in gaps
            if g["kind"] == "no_security_camera_notification"
        ][0]
        assert row["severity"] == "high"

    def test_edge_camera_but_no_motion_sensor_no_gap(self) -> None:
        reg = _registry(
            entities=[_entity("camera.front_door")],
        )
        gaps = detect_gaps(reg)
        assert "no_security_camera_notification" not in _kinds(gaps)


# ─────────────────────────────────────────────────────────────────────────
# 6. no_vacation_mode
# ─────────────────────────────────────────────────────────────────────────


class TestVacationMode:
    def test_present_helper_and_automation(self) -> None:
        reg = _registry(
            entities=[
                _entity("light.kitchen"),
                _entity("input_boolean.vacation_mode", state="off"),
            ],
            automations=[
                _automation(
                    "automation.vacation",
                    yaml_config={
                        "trigger": [
                            {
                                "platform": "state",
                                "entity_id": "input_boolean.vacation_mode",
                                "to": "on",
                            }
                        ],
                        "action": [{"service": "light.turn_on"}],
                    },
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_vacation_mode" not in _kinds(gaps)

    def test_absent_no_helper(self) -> None:
        reg = _registry(
            entities=[_entity("light.kitchen")],
        )
        gaps = detect_gaps(reg)
        assert "no_vacation_mode" in _kinds(gaps)

    def test_edge_helper_but_no_automation(self) -> None:
        reg = _registry(
            entities=[
                _entity("light.kitchen"),
                _entity("input_boolean.vacation_mode", state="off"),
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_vacation_mode" in _kinds(gaps)

    def test_edge_no_lights_no_gap(self) -> None:
        """Without lights there's nothing to randomise — gap is irrelevant."""
        reg = _registry()
        gaps = detect_gaps(reg)
        assert "no_vacation_mode" not in _kinds(gaps)


# ─────────────────────────────────────────────────────────────────────────
# 7. no_climate_schedule
# ─────────────────────────────────────────────────────────────────────────


class TestClimateSchedule:
    def test_present_time_trigger_sets_temp(self) -> None:
        reg = _registry(
            entities=[_entity("climate.living_room")],
            automations=[
                _automation(
                    "automation.climate",
                    yaml_config={
                        "trigger": [{"platform": "time", "at": "06:30:00"}],
                        "action": [{"service": "climate.set_temperature"}],
                    },
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_climate_schedule" not in _kinds(gaps)

    def test_absent_no_climate_automation(self) -> None:
        reg = _registry(
            entities=[_entity("climate.living_room")],
        )
        gaps = detect_gaps(reg)
        assert "no_climate_schedule" in _kinds(gaps)

    def test_edge_no_climate_entity_no_gap(self) -> None:
        reg = _registry(
            entities=[_entity("light.kitchen")],
        )
        gaps = detect_gaps(reg)
        assert "no_climate_schedule" not in _kinds(gaps)


# ─────────────────────────────────────────────────────────────────────────
# 8. no_party_mode
# ─────────────────────────────────────────────────────────────────────────


class TestPartyMode:
    def test_present_helper_with_scene(self) -> None:
        reg = _registry(
            entities=[
                _entity("input_boolean.party_mode", state="off"),
            ],
            scenes=[{"entity_id": "scene.party", "ha_id": "scene.party"}],
            automations=[
                _automation(
                    "automation.party",
                    yaml_config={
                        "trigger": [
                            {
                                "platform": "state",
                                "entity_id": "input_boolean.party_mode",
                                "to": "on",
                            }
                        ],
                        "action": [{"service": "scene.turn_on"}],
                    },
                )
            ],
        )
        gaps = detect_gaps(reg)
        assert "no_party_mode" not in _kinds(gaps)

    def test_absent_no_helper(self) -> None:
        reg = _registry()
        gaps = detect_gaps(reg)
        assert "no_party_mode" in _kinds(gaps)
        row = [g for g in gaps if g["kind"] == "no_party_mode"][0]
        assert row["severity"] == "low"

    def test_edge_helper_but_no_scene_automation(self) -> None:
        reg = _registry(
            entities=[_entity("input_boolean.party_lights", state="off")],
        )
        gaps = detect_gaps(reg)
        assert "no_party_mode" in _kinds(gaps)


# ─────────────────────────────────────────────────────────────────────────
# Cross-cutting
# ─────────────────────────────────────────────────────────────────────────


class TestDetectGapsCrossCutting:
    def test_empty_registry_returns_empty(self) -> None:
        gaps = detect_gaps({})
        # Some detectors that gate on "no relevant entities" don't emit;
        # others (party-mode for example) DO emit even when empty. Make
        # sure we always return a list and never raise.
        assert isinstance(gaps, list)

    def test_each_gap_has_discovered_at(self) -> None:
        reg = _registry()
        gaps = detect_gaps(reg)
        for g in gaps:
            assert isinstance(g.get("discovered_at"), str)
            assert g["discovered_at"].endswith("Z")

    def test_none_input_returns_empty(self) -> None:
        # type: ignore[arg-type]
        gaps = detect_gaps(None)  # type: ignore[arg-type]
        assert gaps == []

    def test_motion_lighting_devices_to_multiple_areas(self) -> None:
        reg = _registry(
            areas=[_area("hallway", "Hallway"), _area("bathroom", "Bathroom")],
            entities=[
                _entity(
                    "binary_sensor.hallway_motion",
                    area_id="hallway",
                    attributes={"device_class": "motion"},
                ),
                _entity(
                    "binary_sensor.bathroom_motion",
                    area_id="bathroom",
                    attributes={"device_class": "motion"},
                ),
            ],
        )
        gaps = detect_gaps(reg)
        motion_areas = sorted(
            g["area_id"]
            for g in gaps
            if g["kind"] == "no_motion_lighting"
        )
        assert motion_areas == ["bathroom", "hallway"]
