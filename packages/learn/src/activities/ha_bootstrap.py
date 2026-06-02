"""Activities for HaBootstrapWorkflow Phase A — registry pull + write.

Two ``@activity.defn`` activities back the workflow:

  1. ``pull_ha_registry`` — fetches the operator-configured HA URL and
     LLAT from ctrl-api, then pulls the full entity / area / device /
     automation / services surface from HA's own REST API in parallel
     and normalises each entity into the ``ha_registry`` row shape.

  2. ``write_ha_registry`` — POSTs the normalised rows to ctrl-api's
     ``/api/v1/channels/ha/registry/bulk`` route, which batch-upserts
     and tombstones vanished entities in a single transaction.

The split lets the workflow retry the pull independently of the write
(HA tends to time out more often than ctrl-api's local SQLite does),
and keeps the LLAT-touching code in one activity that operator audit
can grep for.

SECURITY: the LLAT is fetched via ctrl-api's ``GET /llat`` route — a
brand-new route in PR5 that's operator-only (AAS_API_KEY) and
rejects voice-bridge + channel-token bearers with 403. The token
lives in memory for the duration of one activity invocation and is
never persisted, logged, or echoed into the workflow's result.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config

logger = logging.getLogger("ha-bootstrap")


# ── ctrl-api helpers ─────────────────────────────────────────────────────


def _ctrl_headers() -> dict[str, str]:
    api_key = os.environ.get("AAS_API_KEY", "")
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


async def _ctrl_get(path: str) -> tuple[int, dict[str, Any]]:
    """Plain GET against ctrl-api. Returns (status, body-or-empty)."""
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


# ── HA REST helpers ──────────────────────────────────────────────────────


HA_TIMEOUT_SECONDS = float(os.environ.get("HA_BOOTSTRAP_TIMEOUT_SECONDS", "30"))


async def _ha_get(
    client: httpx.AsyncClient,
    base_url: str,
    path: str,
    llat: str,
) -> tuple[int, Any]:
    """GET against the HA REST API. Returns (status, parsed body or None).

    Caller decides how to handle 4xx — 401 means "bad LLAT" and is the
    workflow's HA_AUTH_FAILED short-circuit. We never log the LLAT
    bytes, even in error paths.
    """
    headers = {
        "Authorization": f"Bearer {llat}",
        "Content-Type": "application/json",
    }
    url = f"{base_url.rstrip('/')}{path}"
    try:
        resp = await client.get(url, headers=headers, timeout=HA_TIMEOUT_SECONDS)
    except httpx.TimeoutException as exc:
        # Re-raise as a flat exception type so the workflow's retry policy
        # can detect "transient HA timeout" and back off; the LLAT is NOT
        # in the message.
        raise RuntimeError(f"HA timeout on {path}") from exc
    except httpx.HTTPError as exc:
        raise RuntimeError(f"HA HTTP error on {path}: {type(exc).__name__}") from exc
    try:
        return resp.status_code, resp.json()
    except ValueError:
        return resp.status_code, None


# ── normalisation ────────────────────────────────────────────────────────


def _domain_of(entity_id: str) -> str | None:
    """``light.kitchen`` → ``light``. None on malformed input."""
    if not isinstance(entity_id, str) or "." not in entity_id:
        return None
    return entity_id.split(".", 1)[0] or None


def _safe_str(v: Any) -> str | None:
    if isinstance(v, str) and v:
        return v
    return None


def _ha_state_to_row(
    entity: dict[str, Any],
    entity_meta_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    """Convert an HA /api/states entity to a bulk-upsert row."""
    eid = entity.get("entity_id")
    if not isinstance(eid, str) or not eid:
        return None
    attrs = entity.get("attributes") or {}
    friendly_name = None
    if isinstance(attrs, dict):
        fn = attrs.get("friendly_name")
        if isinstance(fn, str):
            friendly_name = fn
    domain = _domain_of(eid)
    meta = entity_meta_by_id.get(eid) or {}
    return {
        "kind": "entity",
        "ha_id": eid,
        "domain": domain,
        "area_id": _safe_str(meta.get("area_id")),
        "friendly_name": friendly_name,
        "state": _safe_str(entity.get("state")),
        "attributes_json": json.dumps(attrs, ensure_ascii=False, sort_keys=True),
        "payload_json": json.dumps(entity, ensure_ascii=False, sort_keys=True),
        "last_changed": _safe_str(entity.get("last_changed")),
        "last_updated": _safe_str(entity.get("last_updated")),
    }


def _area_to_row(area: dict[str, Any]) -> dict[str, Any] | None:
    aid = area.get("area_id") or area.get("id")
    if not isinstance(aid, str) or not aid:
        return None
    return {
        "kind": "area",
        "ha_id": aid,
        "domain": None,
        "area_id": None,
        "friendly_name": _safe_str(area.get("name")),
        "state": None,
        "attributes_json": None,
        "payload_json": json.dumps(area, ensure_ascii=False, sort_keys=True),
        "last_changed": None,
        "last_updated": None,
    }


def _device_to_row(device: dict[str, Any]) -> dict[str, Any] | None:
    did = device.get("id") or device.get("device_id")
    if not isinstance(did, str) or not did:
        return None
    return {
        "kind": "device",
        "ha_id": did,
        "domain": None,
        "area_id": _safe_str(device.get("area_id")),
        "friendly_name": _safe_str(
            device.get("name_by_user") or device.get("name")
        ),
        "state": None,
        "attributes_json": None,
        "payload_json": json.dumps(device, ensure_ascii=False, sort_keys=True),
        "last_changed": None,
        "last_updated": None,
    }


def _automation_to_row(state_row: dict[str, Any]) -> dict[str, Any] | None:
    """An automation is materialised from /api/states (domain=automation).

    The detailed YAML body (per /api/automation/config/<id>) is attached
    to the row's payload_json under ``yaml_config`` so PR6's apply/rollback
    pipeline can read it without a second pull.
    """
    eid = state_row.get("entity_id")
    if not isinstance(eid, str) or not eid:
        return None
    attrs = state_row.get("attributes") or {}
    friendly_name = None
    if isinstance(attrs, dict):
        fn = attrs.get("friendly_name")
        if isinstance(fn, str):
            friendly_name = fn
    return {
        "kind": "automation",
        "ha_id": eid,
        "domain": "automation",
        "area_id": None,
        "friendly_name": friendly_name,
        "state": _safe_str(state_row.get("state")),
        "attributes_json": json.dumps(attrs, ensure_ascii=False, sort_keys=True),
        "payload_json": json.dumps(state_row, ensure_ascii=False, sort_keys=True),
        "last_changed": _safe_str(state_row.get("last_changed")),
        "last_updated": _safe_str(state_row.get("last_updated")),
    }


def _scene_to_row(state_row: dict[str, Any]) -> dict[str, Any] | None:
    eid = state_row.get("entity_id")
    if not isinstance(eid, str) or not eid:
        return None
    attrs = state_row.get("attributes") or {}
    friendly_name = None
    if isinstance(attrs, dict):
        fn = attrs.get("friendly_name")
        if isinstance(fn, str):
            friendly_name = fn
    return {
        "kind": "scene",
        "ha_id": eid,
        "domain": "scene",
        "area_id": None,
        "friendly_name": friendly_name,
        "state": _safe_str(state_row.get("state")),
        "attributes_json": json.dumps(attrs, ensure_ascii=False, sort_keys=True),
        "payload_json": json.dumps(state_row, ensure_ascii=False, sort_keys=True),
        "last_changed": _safe_str(state_row.get("last_changed")),
        "last_updated": _safe_str(state_row.get("last_updated")),
    }


def normalise_ha_pull(
    states: list[dict[str, Any]],
    areas: list[dict[str, Any]],
    devices: list[dict[str, Any]],
    entity_registry: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Combine the four HA pulls into a deduplicated list of bulk-upsert rows.

    The dedupe is keyed on ``(kind, ha_id)`` — a misbehaving HA install
    that lists the same entity twice (rare but observed on installs that
    rely on a YAML + UI hybrid) collapses to one row, with the LAST
    occurrence winning. The bulk-upsert route's PRIMARY KEY would do
    the same thing at insert time; doing it here keeps the count
    accurate before the network roundtrip.
    """
    # Index entity_registry rows by entity_id so we can attach area_id
    # to entity rows.
    entity_meta_by_id: dict[str, dict[str, Any]] = {}
    for em in entity_registry:
        if not isinstance(em, dict):
            continue
        eid = em.get("entity_id")
        if isinstance(eid, str) and eid:
            entity_meta_by_id[eid] = em

    rows: list[dict[str, Any]] = []
    for s in states or []:
        if not isinstance(s, dict):
            continue
        eid = s.get("entity_id")
        if not isinstance(eid, str):
            continue
        domain = _domain_of(eid)
        if domain == "automation":
            row = _automation_to_row(s)
        elif domain == "scene":
            row = _scene_to_row(s)
        else:
            row = _ha_state_to_row(s, entity_meta_by_id)
        if row is not None:
            rows.append(row)

    for a in areas or []:
        if isinstance(a, dict):
            row = _area_to_row(a)
            if row is not None:
                rows.append(row)

    for d in devices or []:
        if isinstance(d, dict):
            row = _device_to_row(d)
            if row is not None:
                rows.append(row)

    # Dedupe by (kind, ha_id) — last wins.
    deduped: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        key = (str(r.get("kind")), str(r.get("ha_id")))
        deduped[key] = r
    return list(deduped.values())


# ── activities ───────────────────────────────────────────────────────────


@activity.defn(name="pull_ha_registry")
async def pull_ha_registry() -> dict[str, Any]:
    """Pull the HA registry surface from ctrl-api + HA REST.

    Returns ``{"ok": True, "rows": [...], "counts": {...}}`` on success.
    Returns ``{"ok": False, "code": "...", "rows": []}`` on a known
    fail-fast condition (HA not connected, HA 401, HA unreachable). The
    workflow's retry policy distinguishes the two — a known refusal is
    NOT retried; only the unexpected exception path is.
    """
    # (1) Confirm HA is connected and pull the URL.
    status_code, status_body = await _ctrl_get("/api/v1/channels/ha/status")
    if status_code != 200 or not isinstance(status_body, dict):
        return {"ok": False, "code": "STATUS_UNREACHABLE", "rows": []}
    if status_body.get("state") != "connected":
        return {"ok": False, "code": "HA_NOT_CONNECTED", "rows": []}
    ha_url = status_body.get("ha_url")
    if not isinstance(ha_url, str) or not ha_url:
        return {"ok": False, "code": "HA_NOT_CONNECTED", "rows": []}

    # (2) Fetch the LLAT — operator-only route.
    llat_code, llat_body = await _ctrl_get("/api/v1/channels/ha/llat")
    if llat_code == 404:
        return {"ok": False, "code": "HA_NOT_CONNECTED", "rows": []}
    if llat_code != 200 or not isinstance(llat_body, dict):
        return {"ok": False, "code": "LLAT_UNREACHABLE", "rows": []}
    llat = llat_body.get("llat")
    if not isinstance(llat, str) or not llat:
        return {"ok": False, "code": "LLAT_MISSING", "rows": []}

    # (3) Parallel pull.
    #
    # `/api/states` + `/api/services` are HA REST endpoints that work.
    # Area / device / entity registries return 404 on REST (they're
    # WS-only) — #115/#158 PR1 closes #149 by adding a ctrl-api route
    # `/api/v1/channels/ha/ws/registries` that proxies through the
    # long-lived WS client. We call it once and split the result by
    # `kind` into the three registry buckets.
    async with httpx.AsyncClient() as client:
        coros = [
            _ha_get(client, ha_url, "/api/states", llat),
            _ha_get(client, ha_url, "/api/services", llat),
        ]
        results = await asyncio.gather(*coros, return_exceptions=True)

    ws_code, ws_body = await _ctrl_get("/api/v1/channels/ha/ws/registries")

    # Check for HA 401 first — that's a known operator misconfig
    # (LLAT rotated in HA but not in Vault). Surface as a known refusal
    # so the workflow doesn't burn retries.
    statuses: list[int | None] = []
    bodies: list[Any] = []
    for r in results:
        if isinstance(r, BaseException):
            statuses.append(None)
            bodies.append(None)
            continue
        statuses.append(r[0])
        bodies.append(r[1])

    if any(s == 401 for s in statuses if s is not None):
        # NEVER include the LLAT in this message — even partially.
        return {"ok": False, "code": "HA_AUTH_FAILED", "rows": []}

    # Any non-2xx that ISN'T a 401 → transient; re-raise so Temporal retries.
    for i, (s, r) in enumerate(zip(statuses, results)):
        if isinstance(r, BaseException):
            raise RuntimeError(f"HA pull failed on call #{i}: {type(r).__name__}")
        if s is None or s >= 500:
            raise RuntimeError(f"HA pull HTTP {s} on call #{i}")

    states = bodies[0] if isinstance(bodies[0], list) else []
    services = bodies[1] if isinstance(bodies[1], list) else []

    # WS-backed registries via ctrl-api `/ws/registries`. The route
    # returns rows pre-normalised for the bulk-upsert path; we lift
    # areas/devices/entities back out so the existing normalise_ha_pull
    # contract holds (it pulls automation/scene off `/api/states` and
    # joins area_id from entity_registry). If the WS route is down the
    # workflow still proceeds with `states` + `services`, matching the
    # pre-#149 behaviour where REST 404'd these registries (logged but
    # not fatal — downstream upsert is happy with empty buckets).
    areas: list[dict[str, Any]] = []
    devices: list[dict[str, Any]] = []
    entity_reg: list[dict[str, Any]] = []
    if ws_code == 200 and isinstance(ws_body, dict) and ws_body.get("ok"):
        ws_rows = ws_body.get("rows", [])
        if isinstance(ws_rows, list):
            for row in ws_rows:
                if not isinstance(row, dict):
                    continue
                kind = row.get("kind")
                payload_raw = row.get("payload_json")
                if not isinstance(payload_raw, str):
                    continue
                try:
                    payload = json.loads(payload_raw)
                except ValueError:
                    continue
                if not isinstance(payload, dict):
                    continue
                if kind == "area":
                    areas.append(payload)
                elif kind == "device":
                    devices.append(payload)
                elif kind == "entity":
                    entity_reg.append(payload)
    else:
        logger.warning(
            "ws/registries pull failed (status=%s) — proceeding with empty area/device/entity buckets",
            ws_code,
        )

    rows = normalise_ha_pull(states, areas, devices, entity_reg)

    # Count automations + scenes separately for the workflow's audit log.
    counts = {
        "states": len(states),
        "areas": len(areas),
        "devices": len(devices),
        "entity_registry": len(entity_reg),
        "services": len(services),
        "rows": len(rows),
        "automations": sum(1 for r in rows if r.get("kind") == "automation"),
        "scenes": sum(1 for r in rows if r.get("kind") == "scene"),
        "entities": sum(1 for r in rows if r.get("kind") == "entity"),
    }
    return {"ok": True, "rows": rows, "counts": counts}


@activity.defn(name="write_ha_registry")
async def write_ha_registry(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """POST the normalised rows to ctrl-api's bulk route.

    The route handles inserted vs updated vs tombstoned in one
    transaction and returns the counts. Empty input is allowed — the
    route will tombstone every existing row, which is the right
    behaviour if HA goes from "many entities" to "zero" (an operator
    factory-reset or moved their install).
    """
    code, body = await _ctrl_post(
        "/api/v1/channels/ha/registry/bulk",
        {"rows": rows or []},
    )
    if code != 200 or not isinstance(body, dict) or not body.get("ok"):
        raise RuntimeError(f"ctrl-api bulk upsert failed: HTTP {code}")
    return {
        "ok": True,
        "inserted": int(body.get("inserted", 0)),
        "updated": int(body.get("updated", 0)),
        "tombstoned": int(body.get("tombstoned", 0)),
        "total_after": int(body.get("total_after", 0)),
    }
