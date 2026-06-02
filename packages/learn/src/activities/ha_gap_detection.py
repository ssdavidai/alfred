"""HaBootstrapWorkflow Phase B + C — gap detection + proposal generation (#110 PR6).

Phase A (#110 PR5) populates ``ha_registry`` every 6h. Phase B reads
that registry, scans for the 8 baseline patterns the spec lists, and
emits an ``ha_gap`` row per missing capability. Phase C then templates
a concrete ``ha_proposal`` row (YAML automation) per open gap so the
principal can click "Apply" on the HaCard.

The 8 gap kinds (per spec):

  1. ``no_morning_routine`` — no automation lights up the house in
     6am–9am, neither via ``sun.below_horizon`` nor ``time`` trigger.
  2. ``no_bedtime_routine`` — no automation turns lights off + locks
     doors with a ``time`` trigger after 22:00.
  3. ``no_motion_lighting`` — ``binary_sensor.*motion*`` exists in an
     area but no automation in that area triggers on it.
  4. ``no_away_mode`` — ``device_tracker.*`` exists but no automation
     triggers on ``not_home``.
  5. ``no_security_camera_notification`` — ``camera.*`` entities exist
     but no automation pushes a notification on motion.
  6. ``no_vacation_mode`` — no ``input_boolean`` named ``vacation*``
     or ``away*`` with associated lighting-randomization automation.
  7. ``no_climate_schedule`` — ``climate.*`` exists but no automation
     adjusts setpoint by time-of-day.
  8. ``no_party_mode`` — no ``input_boolean`` named ``party*`` with
     scene activation.

The functions in this module are intentionally PURE (no I/O, no
network, no LLM). The workflow side wraps them as
``@activity.defn`` entry points that fetch the registry from
ctrl-api, run detect/generate, and POST the rows back. Keeping the
core logic pure means we can unit-test every gap kind under
``pytest`` without a Temporal harness or a fake HTTP server.

Privacy: the YAML templates use ``area_id`` placeholders pulled
straight from ``ha_registry.area_id`` (no PII), and never reflect
any user-supplied attribute body. ``decision_ref`` minting happens
in ctrl-api at apply-time, not here.

Storage contract (no migration in PR6 — re-uses the PR1 schema):

  ``ha_gap`` columns:
    * ``id``           — ulid, minted at insert time
    * ``ts``           — discovered_at (ISO-8601)
    * ``kind``         — one of the 8 kinds above
    * ``evidence``     — JSON string carrying area_id / device_id /
                         summary / severity / extra context (the
                         columns the spec asks for that aren't in
                         the PR1 schema — they ride here)
    * ``fix_pack``     — baseline pack id (== ``kind`` today)
    * ``proposal_ref`` — set to the ``ha_proposal.id`` once Phase C
                         emits one
    * ``status``       — open|addressed|dismissed
    * ``created_at``   — DB default

The detector returns a list of ``HaGapRow`` typed dicts; the
generator returns ``HaProposalRow`` dicts. Both shapes match what
ctrl-api's bulk-upsert + proposal-create routes accept.
"""
from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, TypedDict

import httpx
from temporalio import activity

from src.config import load_config

logger = logging.getLogger("ha-gap-detection")


# ─────────────────────────────────────────────────────────────────────────
# Types — kept narrow on purpose. The detector returns plain dicts so
# the workflow can JSON-serialise straight to ctrl-api without a
# pydantic dance.
# ─────────────────────────────────────────────────────────────────────────


class HaGapRow(TypedDict, total=False):
    kind: str
    summary: str
    severity: str
    area_id: str | None
    device_id: str | None
    discovered_at: str
    evidence: dict[str, Any]


class HaProposalRow(TypedDict, total=False):
    kind: str
    summary: str
    yaml: str
    gap_id: str | None


# Registry shape we accept — same shape ctrl-api's GET /registry
# returns. Each list is a list of payload dicts (the raw HA records).
class HaRegistry(TypedDict, total=False):
    entities: list[dict[str, Any]]
    areas: list[dict[str, Any]]
    devices: list[dict[str, Any]]
    automations: list[dict[str, Any]]
    scenes: list[dict[str, Any]]
    helpers: list[dict[str, Any]]


# ─────────────────────────────────────────────────────────────────────────
# Helpers — registry shape normalisation
# ─────────────────────────────────────────────────────────────────────────


def _entities(reg: HaRegistry) -> list[dict[str, Any]]:
    e = reg.get("entities")
    return e if isinstance(e, list) else []


def _areas(reg: HaRegistry) -> list[dict[str, Any]]:
    a = reg.get("areas")
    return a if isinstance(a, list) else []


def _devices(reg: HaRegistry) -> list[dict[str, Any]]:
    d = reg.get("devices")
    return d if isinstance(d, list) else []


def _automations(reg: HaRegistry) -> list[dict[str, Any]]:
    a = reg.get("automations")
    return a if isinstance(a, list) else []


def _helpers(reg: HaRegistry) -> list[dict[str, Any]]:
    h = reg.get("helpers")
    return h if isinstance(h, list) else []


def _entity_id(record: dict[str, Any]) -> str:
    eid = record.get("entity_id") or record.get("ha_id")
    return eid if isinstance(eid, str) else ""


def _domain_of(entity_id: str) -> str:
    if "." not in entity_id:
        return ""
    return entity_id.split(".", 1)[0]


def _attrs(record: dict[str, Any]) -> dict[str, Any]:
    a = record.get("attributes")
    return a if isinstance(a, dict) else {}


def _entities_by_domain(reg: HaRegistry, domain: str) -> list[dict[str, Any]]:
    out = []
    for e in _entities(reg):
        if not isinstance(e, dict):
            continue
        eid = _entity_id(e)
        if _domain_of(eid) == domain:
            out.append(e)
    return out


def _area_of(record: dict[str, Any]) -> str | None:
    aid = record.get("area_id")
    if isinstance(aid, str) and aid:
        return aid
    return None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ─────────────────────────────────────────────────────────────────────────
# Automation introspection — every gap detector reduces to "is there an
# automation that does X?". We give them a single shared inspection
# layer over the automation list.
#
# An automation is a dict with at least ``entity_id`` (automation.foo);
# its triggers + actions can live in the top-level ``attributes`` or
# under a ``yaml_config`` blob (the PR5 normaliser stashes
# ``/api/config/automation/config/<id>`` there when available). We try
# both paths.
# ─────────────────────────────────────────────────────────────────────────


def _automation_blocks(auto: dict[str, Any]) -> dict[str, Any]:
    """Return a dict with normalised triggers/actions/conditions lists."""
    blocks: dict[str, list[Any]] = {
        "triggers": [],
        "actions": [],
        "conditions": [],
    }

    # YAML config attached by PR5 normaliser.
    yaml_config = auto.get("yaml_config")
    if isinstance(yaml_config, dict):
        for src_key, dst_key in (
            ("trigger", "triggers"),
            ("triggers", "triggers"),
            ("action", "actions"),
            ("actions", "actions"),
            ("condition", "conditions"),
            ("conditions", "conditions"),
        ):
            v = yaml_config.get(src_key)
            if isinstance(v, list):
                blocks[dst_key].extend(v)
            elif isinstance(v, dict):
                blocks[dst_key].append(v)

    # Some HA versions surface "trigger"/"action" under attributes.
    attrs = _attrs(auto)
    for src_key, dst_key in (
        ("trigger", "triggers"),
        ("triggers", "triggers"),
        ("action", "actions"),
        ("actions", "actions"),
    ):
        v = attrs.get(src_key)
        if isinstance(v, list):
            blocks[dst_key].extend(v)

    # Friendly area hint sits at the top of the row (HA's UI lets you
    # assign an automation to an area for organisation).
    return blocks


def _automation_area_ids(auto: dict[str, Any]) -> set[str]:
    """All area_id hints we can read off an automation row.

    HA's automation YAML lets ``target: { area_id: kitchen }`` appear in
    any action block. We collect all of them — a single automation can
    be "in" multiple areas.
    """
    ids: set[str] = set()
    direct = _area_of(auto)
    if direct:
        ids.add(direct)

    blocks = _automation_blocks(auto)
    for action in blocks["actions"]:
        if not isinstance(action, dict):
            continue
        target = action.get("target")
        if isinstance(target, dict):
            aid = target.get("area_id")
            if isinstance(aid, str):
                ids.add(aid)
            elif isinstance(aid, list):
                for v in aid:
                    if isinstance(v, str):
                        ids.add(v)
        # Top-level area_id on the action block.
        aid = action.get("area_id")
        if isinstance(aid, str):
            ids.add(aid)
    return ids


def _automation_trigger_kinds(auto: dict[str, Any]) -> list[dict[str, Any]]:
    """Return all trigger blocks as a flat list."""
    blocks = _automation_blocks(auto)
    return [t for t in blocks["triggers"] if isinstance(t, dict)]


def _automation_action_services(auto: dict[str, Any]) -> list[str]:
    """Return all ``service`` strings referenced anywhere in actions.

    ``light.turn_on``, ``notify.mobile_app_iphone``, ``lock.lock`` —
    flat list, preserves order, includes duplicates.
    """
    out: list[str] = []
    blocks = _automation_blocks(auto)
    for action in blocks["actions"]:
        if not isinstance(action, dict):
            continue
        svc = action.get("service")
        if isinstance(svc, str):
            out.append(svc)
        # Some YAMLs use {service: light.turn_on, target: ...}; some
        # use the script-style {action: light.turn_on}.
        alt = action.get("action")
        if isinstance(alt, str) and "." in alt:
            out.append(alt)
    return out


def _trigger_references_entity(
    trigger: dict[str, Any], entity_id: str,
) -> bool:
    """True iff trigger watches the given entity_id (state platform)."""
    plat = trigger.get("platform") or trigger.get("trigger")
    if plat != "state":
        return False
    eid = trigger.get("entity_id")
    if isinstance(eid, str):
        return eid == entity_id
    if isinstance(eid, list):
        return entity_id in eid
    return False


def _trigger_is_sun(trigger: dict[str, Any]) -> bool:
    plat = trigger.get("platform") or trigger.get("trigger")
    return plat == "sun"


def _trigger_is_time(trigger: dict[str, Any]) -> bool:
    plat = trigger.get("platform") or trigger.get("trigger")
    return plat == "time"


def _trigger_time_at(trigger: dict[str, Any]) -> str | None:
    at = trigger.get("at")
    if isinstance(at, str):
        return at
    if isinstance(at, list) and at and isinstance(at[0], str):
        return at[0]
    return None


def _hour_of(time_str: str | None) -> int | None:
    """Parse "HH:MM[:SS]" → integer hour. None on malformed."""
    if not isinstance(time_str, str):
        return None
    m = re.match(r"^(\d{1,2}):(\d{2})", time_str.strip())
    if not m:
        return None
    h = int(m.group(1))
    if 0 <= h <= 23:
        return h
    return None


# ─────────────────────────────────────────────────────────────────────────
# Gap detectors — one per kind. Each returns a list[HaGapRow] (may be
# empty). detect_gaps() chains them all.
# ─────────────────────────────────────────────────────────────────────────


def _gap_no_morning_routine(reg: HaRegistry) -> list[HaGapRow]:
    """Gap if no automation turns lights on in 6am-9am or near sunrise."""
    autos = _automations(reg)
    lights = _entities_by_domain(reg, "light")
    if not lights:
        # No lights at all — not a fixable gap, skip.
        return []

    for auto in autos:
        triggers = _automation_trigger_kinds(auto)
        services = _automation_action_services(auto)
        has_light_turn_on = any(
            s == "light.turn_on" or s == "scene.turn_on" for s in services
        )
        if not has_light_turn_on:
            continue
        for trig in triggers:
            if _trigger_is_sun(trig):
                event = trig.get("event") or ""
                if event in ("sunrise", "sunset"):
                    if event == "sunrise":
                        return []
                # sun.below_horizon is technically a state trigger but
                # HA's modern YAML uses `platform: sun` with event.
                continue
            if _trigger_is_time(trig):
                at = _trigger_time_at(trig)
                h = _hour_of(at)
                if h is not None and 6 <= h < 9:
                    return []

    # No qualifying automation — surface the gap once. We don't
    # localise per-area; morning is whole-home.
    return [
        HaGapRow(
            kind="no_morning_routine",
            summary="No morning lighting routine — lights aren't woken at sunrise.",
            severity="medium",
            area_id=None,
            device_id=None,
            evidence={"light_count": len(lights)},
        )
    ]


def _gap_no_bedtime_routine(reg: HaRegistry) -> list[HaGapRow]:
    """Gap if no time-triggered automation after 22:00 turns lights off + locks doors."""
    autos = _automations(reg)
    has_lights = bool(_entities_by_domain(reg, "light"))
    has_locks = bool(_entities_by_domain(reg, "lock"))
    if not has_lights and not has_locks:
        return []

    for auto in autos:
        triggers = _automation_trigger_kinds(auto)
        services = _automation_action_services(auto)
        has_late_time_trigger = False
        for trig in triggers:
            if _trigger_is_time(trig):
                h = _hour_of(_trigger_time_at(trig))
                if h is not None and (h >= 22 or h <= 2):
                    has_late_time_trigger = True
                    break
        if not has_late_time_trigger:
            continue

        turns_lights_off = any(s == "light.turn_off" for s in services)
        locks_doors = any(s == "lock.lock" for s in services)
        # If lights exist, we want light-off; if locks exist, we want lock.
        ok = True
        if has_lights and not turns_lights_off:
            ok = False
        if has_locks and not locks_doors:
            ok = False
        if ok:
            return []

    return [
        HaGapRow(
            kind="no_bedtime_routine",
            summary="No bedtime routine — lights stay on and doors aren't auto-locked at night.",
            severity="medium",
            area_id=None,
            device_id=None,
            evidence={"has_lights": has_lights, "has_locks": has_locks},
        )
    ]


_MOTION_AREA_KEYWORDS = ("hall", "bath", "corridor", "landing", "entry", "foyer", "stair")


def _is_motion_sensor(entity: dict[str, Any]) -> bool:
    eid = _entity_id(entity)
    if _domain_of(eid) != "binary_sensor":
        return False
    if "motion" in eid.lower():
        return True
    attrs = _attrs(entity)
    dc = attrs.get("device_class")
    if isinstance(dc, str) and dc == "motion":
        return True
    return False


def _gap_no_motion_lighting(reg: HaRegistry) -> list[HaGapRow]:
    """Gap PER AREA: motion sensor exists but no automation triggers off it.

    Restricted to the canonical "passing-through" areas (hallway,
    bathroom, foyer, …) — kitchens and bedrooms typically don't want
    motion-on lights because the principal is doing intentional work
    there.
    """
    autos = _automations(reg)
    area_id_to_name: dict[str, str] = {}
    for a in _areas(reg):
        if not isinstance(a, dict):
            continue
        aid = a.get("ha_id") or a.get("area_id") or a.get("id")
        nm = a.get("name") or a.get("friendly_name") or aid
        if isinstance(aid, str):
            area_id_to_name[aid] = nm if isinstance(nm, str) else aid

    gaps: list[HaGapRow] = []
    seen_areas: set[str] = set()

    for sensor in _entities(reg):
        if not isinstance(sensor, dict):
            continue
        if not _is_motion_sensor(sensor):
            continue
        area_id = _area_of(sensor)
        if not area_id:
            continue
        if area_id in seen_areas:
            continue
        # Only flag the "passing through" areas.
        name = (area_id_to_name.get(area_id) or area_id).lower()
        if not any(k in name or k in area_id.lower() for k in _MOTION_AREA_KEYWORDS):
            continue
        seen_areas.add(area_id)

        # Is there an automation in this area that's triggered by this
        # sensor and turns a light on?
        eid = _entity_id(sensor)
        covered = False
        for auto in autos:
            triggers = _automation_trigger_kinds(auto)
            if not any(_trigger_references_entity(t, eid) for t in triggers):
                continue
            services = _automation_action_services(auto)
            if any(s in ("light.turn_on", "scene.turn_on", "switch.turn_on") for s in services):
                covered = True
                break
        if covered:
            continue

        gaps.append(
            HaGapRow(
                kind="no_motion_lighting",
                summary=(
                    f"Motion sensor in {area_id_to_name.get(area_id, area_id)} "
                    f"isn't wired to a light — dark walks at night."
                ),
                severity="low",
                area_id=area_id,
                device_id=None,
                evidence={"sensor": eid, "area": area_id_to_name.get(area_id, area_id)},
            )
        )
    return gaps


def _gap_no_away_mode(reg: HaRegistry) -> list[HaGapRow]:
    """Gap if device_tracker.* exists but no automation triggers on not_home."""
    trackers = _entities_by_domain(reg, "device_tracker")
    if not trackers:
        return []

    autos = _automations(reg)
    for auto in autos:
        triggers = _automation_trigger_kinds(auto)
        for trig in triggers:
            plat = trig.get("platform") or trig.get("trigger")
            if plat != "state":
                continue
            to = trig.get("to") or trig.get("to_state")
            if to == "not_home":
                return []
            # numeric_state / zone-leave variant.
            eid = trig.get("entity_id")
            entities = eid if isinstance(eid, list) else [eid] if isinstance(eid, str) else []
            if any(
                isinstance(e, str) and e.startswith("device_tracker.")
                for e in entities
            ):
                # Found a device_tracker watcher — count it.
                return []

    return [
        HaGapRow(
            kind="no_away_mode",
            summary="No away-mode automation — Alfred can't dim or lock when the house empties.",
            severity="medium",
            area_id=None,
            device_id=None,
            evidence={"tracker_count": len(trackers)},
        )
    ]


def _gap_no_security_camera_notification(reg: HaRegistry) -> list[HaGapRow]:
    """Gap if camera.* exists but no automation notifies on motion."""
    cameras = _entities_by_domain(reg, "camera")
    if not cameras:
        return []

    motion_sensors = [
        e for e in _entities(reg) if isinstance(e, dict) and _is_motion_sensor(e)
    ]
    if not motion_sensors:
        return []

    autos = _automations(reg)
    motion_ids = {_entity_id(s) for s in motion_sensors}
    for auto in autos:
        triggers = _automation_trigger_kinds(auto)
        triggered_by_motion = False
        for trig in triggers:
            eid = trig.get("entity_id")
            if isinstance(eid, str) and eid in motion_ids:
                triggered_by_motion = True
                break
            if isinstance(eid, list) and any(e in motion_ids for e in eid):
                triggered_by_motion = True
                break
        if not triggered_by_motion:
            continue
        services = _automation_action_services(auto)
        if any(s.startswith("notify.") or s == "persistent_notification.create" for s in services):
            return []

    return [
        HaGapRow(
            kind="no_security_camera_notification",
            summary="Cameras + motion sensors live, but no notification fires on motion.",
            severity="high",
            area_id=None,
            device_id=None,
            evidence={"camera_count": len(cameras), "motion_sensor_count": len(motion_sensors)},
        )
    ]


def _input_boolean_names(reg: HaRegistry) -> list[str]:
    """All input_boolean entity ids (e.g. ``input_boolean.vacation_mode``)."""
    names: list[str] = []
    for e in _entities(reg):
        if not isinstance(e, dict):
            continue
        eid = _entity_id(e)
        if _domain_of(eid) == "input_boolean":
            names.append(eid)
    for h in _helpers(reg):
        if not isinstance(h, dict):
            continue
        eid = _entity_id(h)
        if _domain_of(eid) == "input_boolean":
            names.append(eid)
    return names


def _gap_no_vacation_mode(reg: HaRegistry) -> list[HaGapRow]:
    """Gap if no input_boolean named vacation*|away* exists with light-randomisation."""
    bools = _input_boolean_names(reg)
    has_vacation_helper = any(
        ("vacation" in b.split(".", 1)[1].lower() if "." in b else False)
        or ("away" in b.split(".", 1)[1].lower() if "." in b else False)
        for b in bools
    )
    lights = _entities_by_domain(reg, "light")
    if not lights:
        return []
    if not has_vacation_helper:
        return [
            HaGapRow(
                kind="no_vacation_mode",
                summary="No vacation mode — lights won't randomise when you're away.",
                severity="low",
                area_id=None,
                device_id=None,
                evidence={"light_count": len(lights), "input_booleans_present": bools},
            )
        ]
    # Helper exists — is any automation triggered by it AND randomising lights?
    autos = _automations(reg)
    vacation_ids = {b for b in bools if "vacation" in b.lower() or "away" in b.lower()}
    for auto in autos:
        triggers = _automation_trigger_kinds(auto)
        if not any(
            isinstance(t.get("entity_id"), str) and t.get("entity_id") in vacation_ids
            for t in triggers
        ):
            continue
        services = _automation_action_services(auto)
        if any(s in ("light.turn_on", "scene.turn_on") for s in services):
            return []
    return [
        HaGapRow(
            kind="no_vacation_mode",
            summary="Vacation helper exists but isn't wired to randomise lights.",
            severity="low",
            area_id=None,
            device_id=None,
            evidence={"input_booleans_present": list(vacation_ids)},
        )
    ]


def _gap_no_climate_schedule(reg: HaRegistry) -> list[HaGapRow]:
    """Gap if climate.* exists but no automation adjusts setpoint by time-of-day."""
    climates = _entities_by_domain(reg, "climate")
    if not climates:
        return []
    autos = _automations(reg)
    for auto in autos:
        triggers = _automation_trigger_kinds(auto)
        has_time_trigger = any(_trigger_is_time(t) for t in triggers)
        if not has_time_trigger:
            continue
        services = _automation_action_services(auto)
        if any(
            s in (
                "climate.set_temperature",
                "climate.set_hvac_mode",
                "climate.set_preset_mode",
            )
            for s in services
        ):
            return []
    return [
        HaGapRow(
            kind="no_climate_schedule",
            summary="Climate runs flat — no time-of-day setpoint adjustment.",
            severity="low",
            area_id=None,
            device_id=None,
            evidence={"climate_count": len(climates)},
        )
    ]


def _gap_no_party_mode(reg: HaRegistry) -> list[HaGapRow]:
    """Gap if no input_boolean named party* with scene activation."""
    bools = _input_boolean_names(reg)
    party_bools = [b for b in bools if "party" in b.lower()]
    scenes = reg.get("scenes") or []
    if not isinstance(scenes, list):
        scenes = []
    # If you have no scenes at all, party-mode is hard to template, but
    # we still surface the gap so the operator sees the option.
    if not party_bools:
        return [
            HaGapRow(
                kind="no_party_mode",
                summary="No party mode — single tap to turn the house into a party.",
                severity="low",
                area_id=None,
                device_id=None,
                evidence={"scene_count": len(scenes)},
            )
        ]
    # Helper exists — is an automation triggered by it activating a scene?
    autos = _automations(reg)
    party_ids = set(party_bools)
    for auto in autos:
        triggers = _automation_trigger_kinds(auto)
        if not any(
            isinstance(t.get("entity_id"), str) and t.get("entity_id") in party_ids
            for t in triggers
        ):
            continue
        services = _automation_action_services(auto)
        if "scene.turn_on" in services:
            return []
    return [
        HaGapRow(
            kind="no_party_mode",
            summary="Party helper exists but no scene activates from it.",
            severity="low",
            area_id=None,
            device_id=None,
            evidence={"input_booleans_present": list(party_ids)},
        )
    ]


# ─────────────────────────────────────────────────────────────────────────
# Public — detect_gaps + generate_proposal
# ─────────────────────────────────────────────────────────────────────────


_DETECTORS = (
    _gap_no_morning_routine,
    _gap_no_bedtime_routine,
    _gap_no_motion_lighting,
    _gap_no_away_mode,
    _gap_no_security_camera_notification,
    _gap_no_vacation_mode,
    _gap_no_climate_schedule,
    _gap_no_party_mode,
)


def detect_gaps(registry: HaRegistry) -> list[HaGapRow]:
    """Run all 8 baseline-pattern detectors against the registry.

    Returns a list of HaGapRow dicts — one per missing capability.
    Each row carries the discovery timestamp so ctrl-api can dedupe.
    Empty registries → empty list (nothing to detect).
    """
    if not isinstance(registry, dict):
        return []
    now = _utc_now_iso()
    gaps: list[HaGapRow] = []
    for detector in _DETECTORS:
        try:
            results = detector(registry)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "ha-gap-detection: detector %s crashed: %s",
                detector.__name__,
                exc,
            )
            continue
        for r in results:
            r["discovered_at"] = now
            gaps.append(r)
    return gaps


# ─────────────────────────────────────────────────────────────────────────
# YAML templates — one per gap kind. Kept inline (no jinja, no external
# files) so the image size stays flat. Each template is plain ASCII;
# the principal can customise post-apply.
# ─────────────────────────────────────────────────────────────────────────


def _yaml_morning() -> str:
    return (
        "alias: 'Alfred · Morning lighting'\n"
        "description: 'Wakes lights gently at sunrise.'\n"
        "trigger:\n"
        "  - platform: sun\n"
        "    event: sunrise\n"
        "    offset: '-00:30:00'\n"
        "action:\n"
        "  - service: light.turn_on\n"
        "    target:\n"
        "      entity_id: all\n"
        "    data:\n"
        "      brightness_pct: 60\n"
        "      transition: 300\n"
        "mode: single\n"
    )


def _yaml_bedtime() -> str:
    return (
        "alias: 'Alfred · Bedtime'\n"
        "description: 'Lights off + doors locked at 22:30.'\n"
        "trigger:\n"
        "  - platform: time\n"
        "    at: '22:30:00'\n"
        "action:\n"
        "  - service: light.turn_off\n"
        "    target:\n"
        "      entity_id: all\n"
        "  - service: lock.lock\n"
        "    target:\n"
        "      entity_id: all\n"
        "mode: single\n"
    )


def _yaml_motion_lighting(area_id: str | None) -> str:
    target = (
        f"      area_id: {area_id}\n"
        if isinstance(area_id, str) and area_id
        else "      entity_id: all\n"
    )
    area_label = area_id or "area"
    return (
        f"alias: 'Alfred · Motion lighting · {area_label}'\n"
        "description: 'Turn the light on when motion is detected.'\n"
        "trigger:\n"
        "  - platform: state\n"
        "    entity_id: binary_sensor.motion\n"
        "    to: 'on'\n"
        "action:\n"
        "  - service: light.turn_on\n"
        "    target:\n"
        f"{target}"
        "    data:\n"
        "      brightness_pct: 80\n"
        "      transition: 1\n"
        "mode: single\n"
    )


def _yaml_away_mode() -> str:
    return (
        "alias: 'Alfred · Away mode'\n"
        "description: 'Dim lights + lock doors when everyone leaves.'\n"
        "trigger:\n"
        "  - platform: state\n"
        "    entity_id: group.family\n"
        "    to: 'not_home'\n"
        "action:\n"
        "  - service: light.turn_off\n"
        "    target:\n"
        "      entity_id: all\n"
        "  - service: lock.lock\n"
        "    target:\n"
        "      entity_id: all\n"
        "mode: single\n"
    )


def _yaml_security_notify() -> str:
    return (
        "alias: 'Alfred · Camera motion notify'\n"
        "description: 'Push a notification when motion fires near a camera.'\n"
        "trigger:\n"
        "  - platform: state\n"
        "    entity_id: binary_sensor.motion\n"
        "    to: 'on'\n"
        "action:\n"
        "  - service: notify.mobile_app\n"
        "    data:\n"
        "      title: 'Motion at home'\n"
        "      message: 'Camera saw movement.'\n"
        "mode: single\n"
    )


def _yaml_vacation_mode() -> str:
    return (
        "alias: 'Alfred · Vacation lighting'\n"
        "description: 'Randomise lights while vacation mode is on.'\n"
        "trigger:\n"
        "  - platform: state\n"
        "    entity_id: input_boolean.vacation_mode\n"
        "    to: 'on'\n"
        "action:\n"
        "  - service: light.turn_on\n"
        "    target:\n"
        "      entity_id: all\n"
        "    data:\n"
        "      brightness_pct: 50\n"
        "  - delay:\n"
        "      minutes: 90\n"
        "  - service: light.turn_off\n"
        "    target:\n"
        "      entity_id: all\n"
        "mode: restart\n"
    )


def _yaml_climate_schedule() -> str:
    return (
        "alias: 'Alfred · Climate schedule'\n"
        "description: 'Adjust setpoint by time of day.'\n"
        "trigger:\n"
        "  - platform: time\n"
        "    at: '06:30:00'\n"
        "    id: morning\n"
        "  - platform: time\n"
        "    at: '22:00:00'\n"
        "    id: night\n"
        "action:\n"
        "  - choose:\n"
        "      - conditions:\n"
        "          - condition: trigger\n"
        "            id: morning\n"
        "        sequence:\n"
        "          - service: climate.set_temperature\n"
        "            data:\n"
        "              temperature: 21\n"
        "      - conditions:\n"
        "          - condition: trigger\n"
        "            id: night\n"
        "        sequence:\n"
        "          - service: climate.set_temperature\n"
        "            data:\n"
        "              temperature: 18\n"
        "mode: single\n"
    )


def _yaml_party_mode() -> str:
    return (
        "alias: 'Alfred · Party mode'\n"
        "description: 'One tap turns the house into a party.'\n"
        "trigger:\n"
        "  - platform: state\n"
        "    entity_id: input_boolean.party_mode\n"
        "    to: 'on'\n"
        "action:\n"
        "  - service: scene.turn_on\n"
        "    target:\n"
        "      entity_id: scene.party\n"
        "mode: single\n"
    )


_YAML_BY_KIND = {
    "no_morning_routine": lambda gap: _yaml_morning(),
    "no_bedtime_routine": lambda gap: _yaml_bedtime(),
    "no_motion_lighting": lambda gap: _yaml_motion_lighting(gap.get("area_id")),
    "no_away_mode": lambda gap: _yaml_away_mode(),
    "no_security_camera_notification": lambda gap: _yaml_security_notify(),
    "no_vacation_mode": lambda gap: _yaml_vacation_mode(),
    "no_climate_schedule": lambda gap: _yaml_climate_schedule(),
    "no_party_mode": lambda gap: _yaml_party_mode(),
}


def generate_proposal(gap: HaGapRow) -> HaProposalRow:
    """Template a concrete ha_proposal row from one gap row.

    Returns ``{kind, summary, yaml, gap_id}``. The ``gap_id`` is the
    ulid the bulk-upsert route minted; the workflow passes it through
    from the bulk-upsert response (or None for ad-hoc generation).

    Raises ``ValueError`` on an unknown gap kind.
    """
    kind = gap.get("kind", "")
    if kind not in _YAML_BY_KIND:
        raise ValueError(f"unknown gap kind: {kind!r}")
    yaml = _YAML_BY_KIND[kind](gap)
    summary = gap.get("summary") or kind
    return HaProposalRow(
        kind=kind,
        summary=summary,
        yaml=yaml,
        gap_id=gap.get("id") if isinstance(gap.get("id"), str) else None,
    )


# ─────────────────────────────────────────────────────────────────────────
# Activities — Phase B + Phase C entry points wired into the workflow.
#
# Both are thin orchestrators over ctrl-api (read registry, write
# gaps, write proposals). The detect/generate work happens in the
# pure functions above so the activities can be re-tried freely
# without re-running the actual detection logic on stale state.
# ─────────────────────────────────────────────────────────────────────────


def _ctrl_headers() -> dict[str, str]:
    api_key = os.environ.get("AAS_API_KEY", "")
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


async def _ctrl_get(path: str) -> tuple[int, dict[str, Any]]:
    config = load_config()
    url = f"{config.alfred_ctrl_url}{path}"
    async with httpx.AsyncClient(timeout=30.0) as http:
        resp = await http.get(url, headers=_ctrl_headers())
        try:
            body = resp.json()
        except ValueError:
            body = {}
        return resp.status_code, body


async def _ctrl_post(path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    config = load_config()
    url = f"{config.alfred_ctrl_url}{path}"
    async with httpx.AsyncClient(timeout=60.0) as http:
        resp = await http.post(url, headers=_ctrl_headers(), json=body)
        try:
            data = resp.json()
        except ValueError:
            data = {}
        return resp.status_code, data


@activity.defn(name="detect_ha_gaps")
async def detect_ha_gaps() -> dict[str, Any]:
    """Phase B: read ctrl-api's registry, run detect_gaps, bulk-upsert gaps.

    Returns ``{"ok": True, "gaps": [...], "inserted": N, "addressed": M,
    "dismissed": K}`` on success, or ``{"ok": False, "code": "..."}`` on
    a known failure path.

    The ``gaps`` list in the response carries the server-minted ``id``
    values so the caller (Phase C) can attach them to the proposal
    rows it generates next.
    """
    code, body = await _ctrl_get("/api/v1/channels/ha/registry")
    if code != 200 or not isinstance(body, dict):
        return {"ok": False, "code": "REGISTRY_UNREACHABLE", "gaps": []}

    registry: HaRegistry = body  # type: ignore[assignment]
    gaps = detect_gaps(registry)

    upsert_code, upsert_body = await _ctrl_post(
        "/api/v1/channels/ha/gaps/bulk",
        {"rows": gaps},
    )
    if upsert_code != 200 or not isinstance(upsert_body, dict) or not upsert_body.get("ok"):
        return {"ok": False, "code": "GAP_BULK_FAILED", "gaps": []}

    return {
        "ok": True,
        "gaps": upsert_body.get("gaps") or [],
        "inserted": int(upsert_body.get("inserted", 0)),
        "updated": int(upsert_body.get("updated", 0)),
        "addressed": int(upsert_body.get("addressed", 0)),
        "dismissed": int(upsert_body.get("dismissed", 0)),
    }


@activity.defn(name="generate_ha_proposals")
async def generate_ha_proposals(gaps: list[dict[str, Any]]) -> dict[str, Any]:
    """Phase C: template a proposal per open gap, POST each to ctrl-api.

    Already-applied or already-addressed gaps are skipped — the bulk
    route also filters them, but we double-check on this side so a
    flaky network doesn't queue two proposals for the same gap.

    Returns ``{"ok": True, "created": N, "skipped": M}``.
    """
    if not isinstance(gaps, list):
        return {"ok": False, "code": "BAD_GAPS_INPUT", "created": 0, "skipped": 0}

    created = 0
    skipped = 0
    for gap in gaps:
        if not isinstance(gap, dict):
            skipped += 1
            continue
        status = gap.get("status")
        if status and status != "open":
            skipped += 1
            continue
        if gap.get("proposal_ref"):
            skipped += 1
            continue
        try:
            proposal = generate_proposal(gap)  # type: ignore[arg-type]
        except ValueError as exc:
            logger.warning("generate_ha_proposals: skipping gap: %s", exc)
            skipped += 1
            continue
        # Stamp the FK link to the gap row.
        body = {
            "kind": proposal["kind"],
            "summary": proposal["summary"],
            "yaml": proposal["yaml"],
        }
        gap_id = gap.get("id")
        if isinstance(gap_id, str) and gap_id:
            body["gap_id"] = gap_id
        code, resp = await _ctrl_post("/api/v1/channels/ha/proposal", body)
        if code != 200 or not isinstance(resp, dict) or not resp.get("ok"):
            logger.warning(
                "generate_ha_proposals: proposal POST failed kind=%s code=%s",
                proposal.get("kind"),
                code,
            )
            skipped += 1
            continue
        created += 1

    return {"ok": True, "created": created, "skipped": skipped}


# Used by tests to mint a deterministic ID-less gap; not part of the
# activity surface itself.
def _mint_gap_id() -> str:  # pragma: no cover - trivial
    return uuid.uuid4().hex
