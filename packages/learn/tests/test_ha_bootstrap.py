"""HaBootstrapWorkflow Phase A — pull + normalise + write tests (#110 PR5).

Three test suites:

  1. ``TestNormalisePull`` — pure normaliser tests against synthetic HA
     payloads (no network).
  2. ``TestPullActivity`` — activity-level tests with httpx.MockTransport
     covering the ctrl-api + HA round-trip (status, LLAT, parallel pull,
     401 short-circuit, transient-timeout retry).
  3. ``TestWorkflow`` — end-to-end Temporal workflow test using
     ``WorkflowEnvironment.start_time_skipping()`` with stub activities
     so we can drive the retry policy + audit-log path without a real
     HA install or ctrl-api.

Privacy: LLAT bytes used in tests are synthetic placeholders
(``llat_TEST_…``); the tests assert no test fixture ever exposes a
real-looking token.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import httpx
import pytest
from temporalio import activity
from temporalio.client import Client
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from src.activities.ha_bootstrap import (
    normalise_ha_pull,
    pull_ha_registry,
    write_ha_registry,
)
from src.workflows.ha_bootstrap import HaBootstrapWorkflow


# ─────────────────────────────────────────────────────────────────────────
# 1. Pure normaliser tests
# ─────────────────────────────────────────────────────────────────────────


class TestNormalisePull:
    def test_entity_with_area_attached(self):
        states = [
            {
                "entity_id": "light.kitchen",
                "state": "on",
                "attributes": {"friendly_name": "Kitchen Light"},
                "last_changed": "2026-05-29T10:00:00Z",
                "last_updated": "2026-05-29T10:00:00Z",
            }
        ]
        entity_reg = [
            {"entity_id": "light.kitchen", "area_id": "kitchen", "device_id": "dev-1"}
        ]
        rows = normalise_ha_pull(states, [], [], entity_reg)
        assert len(rows) == 1
        r = rows[0]
        assert r["kind"] == "entity"
        assert r["ha_id"] == "light.kitchen"
        assert r["domain"] == "light"
        assert r["area_id"] == "kitchen"
        assert r["friendly_name"] == "Kitchen Light"
        assert r["state"] == "on"

    def test_automation_classified_separately(self):
        states = [
            {
                "entity_id": "automation.morning_routine",
                "state": "on",
                "attributes": {"friendly_name": "Morning"},
            }
        ]
        rows = normalise_ha_pull(states, [], [], [])
        assert len(rows) == 1
        assert rows[0]["kind"] == "automation"
        assert rows[0]["domain"] == "automation"
        assert rows[0]["friendly_name"] == "Morning"

    def test_scene_classified_separately(self):
        states = [
            {
                "entity_id": "scene.movie_time",
                "state": "scening",
                "attributes": {},
            }
        ]
        rows = normalise_ha_pull(states, [], [], [])
        assert len(rows) == 1
        assert rows[0]["kind"] == "scene"
        assert rows[0]["domain"] == "scene"

    def test_dedupes_duplicate_entity_ids(self):
        # Two states with same entity_id → one row (last wins).
        states = [
            {
                "entity_id": "light.kitchen",
                "state": "off",
                "attributes": {"friendly_name": "Old"},
            },
            {
                "entity_id": "light.kitchen",
                "state": "on",
                "attributes": {"friendly_name": "New"},
            },
        ]
        rows = normalise_ha_pull(states, [], [], [])
        assert len(rows) == 1
        assert rows[0]["state"] == "on"
        assert rows[0]["friendly_name"] == "New"

    def test_empty_input_returns_empty(self):
        assert normalise_ha_pull([], [], [], []) == []

    def test_skips_malformed_entities(self):
        states = [
            {"foo": "bar"},  # no entity_id
            None,  # type: ignore[list-item]
            {"entity_id": ""},  # empty
            {"entity_id": "light.ok", "state": "on", "attributes": {}},
        ]
        rows = normalise_ha_pull(states, [], [], [])
        assert len(rows) == 1
        assert rows[0]["ha_id"] == "light.ok"

    def test_areas_and_devices_rolled_in(self):
        areas = [{"area_id": "kitchen", "name": "Kitchen"}]
        devices = [{"id": "dev-1", "name": "Hub", "area_id": "kitchen"}]
        rows = normalise_ha_pull([], areas, devices, [])
        kinds = sorted([r["kind"] for r in rows])
        assert kinds == ["area", "device"]


# ─────────────────────────────────────────────────────────────────────────
# 2. Activity-level tests — mocked httpx for ctrl-api + HA
# ─────────────────────────────────────────────────────────────────────────


class ScriptedTransport(httpx.AsyncBaseTransport):
    """Replay scripted responses for both ctrl-api and HA URLs."""

    def __init__(self, handler):
        self._handler = handler
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._handler(request)


@pytest.fixture
def mock_ha(monkeypatch):
    """Patch httpx.AsyncClient inside src.activities.ha_bootstrap."""
    holder: dict[str, Any] = {"handler": None, "transport": None, "requests": []}
    original = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        handler = holder["handler"]
        if handler is None:
            raise RuntimeError("mock_ha handler not set")
        transport = ScriptedTransport(handler)
        holder["transport"] = transport
        # The activity uses two clients (ctrl + HA) — collect requests
        # on the shared holder so tests can introspect.
        original_handle = transport.handle_async_request

        async def trapping(req):
            holder["requests"].append(req)
            return await original_handle(req)

        transport.handle_async_request = trapping  # type: ignore[method-assign]
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(
        "src.activities.ha_bootstrap.httpx.AsyncClient", fake_client
    )
    monkeypatch.setenv("AAS_API_KEY", "test-key")
    monkeypatch.setenv(
        "ALFRED_CTRL_URL", "http://ctrl.test"
    )
    yield holder


HA_URL = "http://ha.test:8123"
LLAT = "llat_TEST_" + "0" * 40


def _ha_pull_handler(
    *,
    status_state: str = "connected",
    llat_status: int = 200,
    states_status: int = 200,
    states_body: list[dict[str, Any]] | None = None,
    areas_body: list[dict[str, Any]] | None = None,
    devices_body: list[dict[str, Any]] | None = None,
    entity_reg_body: list[dict[str, Any]] | None = None,
    services_body: list[dict[str, Any]] | None = None,
    ha_states_status_override: int | None = None,
    raise_on: str | None = None,
):
    """Build a handler that scripts all 7 round-trips a happy pull does."""
    states_body = states_body if states_body is not None else []
    areas_body = areas_body if areas_body is not None else []
    devices_body = devices_body if devices_body is not None else []
    entity_reg_body = entity_reg_body if entity_reg_body is not None else []
    services_body = services_body if services_body is not None else []

    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        full = str(req.url)
        if raise_on and raise_on in full:
            raise httpx.TimeoutException("boom", request=req)
        # ctrl-api status
        if path == "/api/v1/channels/ha/status":
            return httpx.Response(
                200,
                json={
                    "connected": status_state == "connected",
                    "state": status_state,
                    "ha_url": HA_URL,
                    "ha_version": "2026.5.0",
                    "last_test_ok": True,
                    "last_test_at": None,
                    "error": None,
                },
            )
        # ctrl-api LLAT
        if path == "/api/v1/channels/ha/llat":
            if llat_status == 200:
                return httpx.Response(200, json={"llat": LLAT})
            return httpx.Response(llat_status, json={"error": "x"})
        # ctrl-api Tier 4 WS-backed registries (#115/#158 PR1 closes #149).
        # The activity now calls THIS route instead of HA REST for area /
        # device / entity registries — REST returned 404 for these
        # WS-only registries.
        if path == "/api/v1/channels/ha/ws/registries":
            ts = "2026-05-29T00:00:00Z"
            rows = []
            for a in areas_body:
                rows.append(
                    {
                        "kind": "area",
                        "ha_id": a.get("area_id", ""),
                        "payload_json": json.dumps(a),
                        "friendly_name": a.get("name"),
                        "area_id": a.get("area_id"),
                        "domain": None,
                        "last_seen_at": ts,
                    }
                )
            for d in devices_body:
                rows.append(
                    {
                        "kind": "device",
                        "ha_id": d.get("id", ""),
                        "payload_json": json.dumps(d),
                        "friendly_name": d.get("name"),
                        "area_id": d.get("area_id"),
                        "domain": None,
                        "last_seen_at": ts,
                    }
                )
            for e in entity_reg_body:
                rows.append(
                    {
                        "kind": "entity",
                        "ha_id": e.get("entity_id", ""),
                        "payload_json": json.dumps(e),
                        "friendly_name": e.get("name"),
                        "area_id": e.get("area_id"),
                        "domain": "light",
                        "last_seen_at": ts,
                    }
                )
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "counts": {
                        "areas": len(areas_body),
                        "devices": len(devices_body),
                        "entities": len(entity_reg_body),
                        "scenes": 0,
                        "scripts": 0,
                    },
                    "rows": rows,
                },
            )
        # HA REST surface — `/api/states` + `/api/services` still REST.
        if path == "/api/states":
            code = ha_states_status_override or states_status
            return httpx.Response(code, json=states_body)
        if path == "/api/services":
            return httpx.Response(200, json=services_body)
        return httpx.Response(404, json={"error": "no route"})

    return handler


class TestPullActivity:
    @pytest.mark.asyncio
    async def test_happy_path_parallel_pull(self, mock_ha):
        mock_ha["handler"] = _ha_pull_handler(
            states_body=[
                {
                    "entity_id": "light.kitchen",
                    "state": "on",
                    "attributes": {"friendly_name": "Kitchen"},
                },
            ],
            areas_body=[{"area_id": "kitchen", "name": "Kitchen"}],
            devices_body=[{"id": "dev-1", "name": "Hub"}],
            entity_reg_body=[{"entity_id": "light.kitchen", "area_id": "kitchen"}],
        )
        result = await pull_ha_registry()
        assert result["ok"] is True
        rows = result["rows"]
        # 1 entity + 1 area + 1 device
        kinds = sorted(r["kind"] for r in rows)
        assert kinds == ["area", "device", "entity"]
        entity_row = next(r for r in rows if r["kind"] == "entity")
        assert entity_row["area_id"] == "kitchen"
        assert result["counts"]["entities"] == 1

        # Audit: confirm exactly the 5 round-trips fired (3 ctrl, 2 HA).
        # #115/#158 PR1 closed #149: area/device/entity registries are no
        # longer fetched from HA REST (which 404'd them — they're WS-only)
        # but from ctrl-api's `/api/v1/channels/ha/ws/registries` route
        # that proxies through the long-lived HA WS client.
        paths = [str(r.url.path) for r in mock_ha["requests"]]
        assert paths.count("/api/v1/channels/ha/status") == 1
        assert paths.count("/api/v1/channels/ha/llat") == 1
        assert paths.count("/api/v1/channels/ha/ws/registries") == 1
        assert paths.count("/api/states") == 1
        assert paths.count("/api/services") == 1
        # The old REST registry routes MUST NOT be hit any more.
        assert paths.count("/api/config/area_registry/list") == 0
        assert paths.count("/api/config/device_registry/list") == 0
        assert paths.count("/api/config/entity_registry/list") == 0

    @pytest.mark.asyncio
    async def test_ha_401_does_not_raise(self, mock_ha):
        # HA returns 401 on a rotated LLAT — activity must surface a
        # known refusal (ok=False) rather than re-raise, so the workflow
        # doesn't burn retries.
        mock_ha["handler"] = _ha_pull_handler(
            ha_states_status_override=401,
        )
        result = await pull_ha_registry()
        assert result["ok"] is False
        assert result["code"] == "HA_AUTH_FAILED"
        assert result["rows"] == []
        # The LLAT must not appear in the result envelope.
        assert LLAT not in str(result)

    @pytest.mark.asyncio
    async def test_ha_not_connected(self, mock_ha):
        mock_ha["handler"] = _ha_pull_handler(status_state="unconfigured")
        result = await pull_ha_registry()
        assert result["ok"] is False
        assert result["code"] == "HA_NOT_CONNECTED"

    @pytest.mark.asyncio
    async def test_ha_5xx_reraises_for_retry(self, mock_ha):
        # HA 5xx is transient — activity re-raises so Temporal retries.
        mock_ha["handler"] = _ha_pull_handler(ha_states_status_override=503)
        with pytest.raises(RuntimeError):
            await pull_ha_registry()

    @pytest.mark.asyncio
    async def test_empty_ha_install_returns_empty_rows(self, mock_ha):
        # An HA install with zero entities is a real case (fresh install,
        # no integrations yet). The activity must return ok=True with
        # rows=[] so the writer can tombstone any previous-run residue.
        mock_ha["handler"] = _ha_pull_handler(
            states_body=[],
            areas_body=[],
            devices_body=[],
            entity_reg_body=[],
        )
        result = await pull_ha_registry()
        assert result["ok"] is True
        assert result["rows"] == []
        assert result["counts"]["rows"] == 0


class TestWriteActivity:
    @pytest.mark.asyncio
    async def test_posts_bulk_payload(self, mock_ha, monkeypatch):
        captured: dict[str, Any] = {}

        def handler(req: httpx.Request) -> httpx.Response:
            assert req.url.path == "/api/v1/channels/ha/registry/bulk"
            import json as _json

            captured["body"] = _json.loads(req.content.decode("utf-8"))
            captured["auth"] = req.headers.get("authorization")
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "inserted": 1,
                    "updated": 0,
                    "tombstoned": 2,
                    "total_after": 3,
                },
            )

        mock_ha["handler"] = handler
        rows = [
            {
                "kind": "entity",
                "ha_id": "light.kitchen",
                "domain": "light",
                "payload_json": "{}",
            }
        ]
        result = await write_ha_registry(rows)
        assert result["ok"] is True
        assert result["inserted"] == 1
        assert result["tombstoned"] == 2
        # Auth header carries the operator AAS_API_KEY (not the LLAT).
        assert captured["auth"] == "Bearer test-key"
        assert LLAT not in captured["auth"]

    @pytest.mark.asyncio
    async def test_bulk_500_reraises(self, mock_ha):
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "boom"})

        mock_ha["handler"] = handler
        with pytest.raises(RuntimeError):
            await write_ha_registry([])


# ─────────────────────────────────────────────────────────────────────────
# 3. Workflow-level tests — Temporal time-skipping environment
# ─────────────────────────────────────────────────────────────────────────


def _make_stubs(
    *,
    pull_result: dict[str, Any] | None = None,
    pull_raises_n: int = 0,
    write_result: dict[str, Any] | None = None,
    detect_result: dict[str, Any] | None = None,
    proposals_result: dict[str, Any] | None = None,
):
    """Build stub activities the workflow can execute under WorkflowEnvironment.

    ``pull_raises_n`` controls the transient-failure simulation: the
    first N invocations raise so the workflow's retry policy kicks in.
    """
    call_log: list[tuple[str, Any]] = []

    pull_calls = {"n": 0}

    @activity.defn(name="pull_ha_registry")
    async def stub_pull() -> dict[str, Any]:
        pull_calls["n"] += 1
        call_log.append(("pull", pull_calls["n"]))
        if pull_calls["n"] <= pull_raises_n:
            raise RuntimeError("simulated HA timeout")
        if pull_result is not None:
            return pull_result
        return {
            "ok": True,
            "rows": [],
            "counts": {
                "states": 0,
                "areas": 0,
                "devices": 0,
                "entity_registry": 0,
                "services": 0,
                "rows": 0,
                "entities": 0,
                "automations": 0,
                "scenes": 0,
            },
        }

    @activity.defn(name="write_ha_registry")
    async def stub_write(rows: list[dict[str, Any]]) -> dict[str, Any]:
        call_log.append(("write", len(rows)))
        if write_result is not None:
            return write_result
        return {
            "ok": True,
            "inserted": len(rows),
            "updated": 0,
            "tombstoned": 0,
            "total_after": len(rows),
        }

    # PR6 — Phase B + Phase C stubs. The default is "no gaps emitted"
    # which means no proposals get queued either; tests that want to
    # exercise the gap+proposal path can replace the stubs.
    @activity.defn(name="detect_ha_gaps")
    async def stub_detect() -> dict[str, Any]:
        call_log.append(("detect", 0))
        if detect_result is not None:
            return detect_result
        return {
            "ok": True,
            "gaps": [],
            "inserted": 0,
            "updated": 0,
            "addressed": 0,
            "dismissed": 0,
        }

    @activity.defn(name="generate_ha_proposals")
    async def stub_proposals(gaps: list[dict[str, Any]]) -> dict[str, Any]:
        call_log.append(("proposals", len(gaps)))
        if proposals_result is not None:
            return proposals_result
        return {"ok": True, "created": 0, "skipped": 0}

    return [stub_pull, stub_write, stub_detect, stub_proposals], call_log


async def _run_workflow(stubs: list) -> dict[str, Any]:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"ha-bootstrap-test-{uuid.uuid4()}"
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[HaBootstrapWorkflow],
            activities=stubs,
        )
        async with worker:
            return await client.execute_workflow(
                HaBootstrapWorkflow.run,
                id=f"ha-bootstrap-run-{uuid.uuid4()}",
                task_queue=tq,
            )


class TestWorkflow:
    def test_workflow_happy_path(self):
        stubs, log = _make_stubs(
            pull_result={
                "ok": True,
                "rows": [
                    {"kind": "entity", "ha_id": "light.kitchen", "payload_json": "{}"},
                ],
                "counts": {
                    "states": 1,
                    "areas": 0,
                    "devices": 0,
                    "entity_registry": 1,
                    "services": 0,
                    "rows": 1,
                    "entities": 1,
                    "automations": 0,
                    "scenes": 0,
                },
            },
            write_result={
                "ok": True,
                "inserted": 1,
                "updated": 0,
                "tombstoned": 0,
                "total_after": 1,
            },
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result["ok"] is True
        assert result["rows"] == 1
        assert result["write"]["inserted"] == 1
        # Pull happened once + write happened once + detect (Phase B)
        # ran once. With an empty gap list, the proposal phase (C) is
        # short-circuited.
        steps = [c[0] for c in log]
        assert steps[:2] == ["pull", "write"]
        assert "detect" in steps
        # No gaps emitted by the stub → Phase C is skipped.
        assert "proposals" not in steps

    def test_workflow_retries_transient_pull_failure(self):
        # First pull raises (network blip); retry policy retries up to 3
        # attempts. Second attempt succeeds.
        stubs, log = _make_stubs(pull_raises_n=1)
        result = asyncio.run(_run_workflow(stubs))
        assert result["ok"] is True
        # Two pull attempts (first raised, second succeeded) + one write.
        pull_count = sum(1 for c in log if c[0] == "pull")
        write_count = sum(1 for c in log if c[0] == "write")
        assert pull_count == 2
        assert write_count == 1

    def test_workflow_audits_known_refusal_without_retry(self):
        # The pull activity returns ok=False on a known refusal
        # (HA_AUTH_FAILED / HA_NOT_CONNECTED). The workflow MUST audit
        # this as a refusal — NOT retry — and skip the write.
        stubs, log = _make_stubs(
            pull_result={"ok": False, "code": "HA_AUTH_FAILED", "rows": []},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result["ok"] is False
        assert result["code"] == "HA_AUTH_FAILED"
        # Exactly one pull attempt (no retry on known refusal), no write.
        assert [c[0] for c in log] == ["pull"]

    def test_workflow_handles_empty_pull(self):
        # HA install with zero entities — pull returns ok=True with empty
        # rows; workflow still calls write so vanished entities can be
        # tombstoned (a real case: principal cleared their HA install).
        stubs, log = _make_stubs(
            pull_result={
                "ok": True,
                "rows": [],
                "counts": {
                    "states": 0,
                    "areas": 0,
                    "devices": 0,
                    "entity_registry": 0,
                    "services": 0,
                    "rows": 0,
                    "entities": 0,
                    "automations": 0,
                    "scenes": 0,
                },
            },
            write_result={
                "ok": True,
                "inserted": 0,
                "updated": 0,
                "tombstoned": 5,
                "total_after": 5,
            },
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result["ok"] is True
        assert result["rows"] == 0
        assert result["write"]["tombstoned"] == 5
        # PR6 — Phase B always runs after a successful write, even with
        # zero rows (the registry may have just been cleared and the gap
        # detector should re-evaluate accordingly).
        steps = [c[0] for c in log]
        assert steps[:2] == ["pull", "write"]
        assert "detect" in steps

    def test_workflow_runs_phase_b_and_c_when_gaps_present(self):
        # Phase B emits two gaps → Phase C runs against them.
        stubs, log = _make_stubs(
            detect_result={
                "ok": True,
                "gaps": [
                    {
                        "id": "01HX0000000000000000000001",
                        "kind": "no_morning_routine",
                        "summary": "No morning lighting.",
                        "severity": "medium",
                        "area_id": None,
                        "status": "open",
                    },
                    {
                        "id": "01HX0000000000000000000002",
                        "kind": "no_motion_lighting",
                        "summary": "No motion light in hallway.",
                        "severity": "low",
                        "area_id": "hallway",
                        "status": "open",
                    },
                ],
                "inserted": 2,
                "updated": 0,
                "addressed": 0,
                "dismissed": 0,
            },
            proposals_result={"ok": True, "created": 2, "skipped": 0},
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result["ok"] is True
        assert result["gap_phase"]["ok"] is True
        assert result["gap_phase"]["gap_count"] == 2
        assert result["proposal_phase"]["ok"] is True
        assert result["proposal_phase"]["created"] == 2
        steps = [c[0] for c in log]
        # Pull → write → detect → proposals, in that order.
        assert steps == ["pull", "write", "detect", "proposals"]
        # Phase C received the two gaps from Phase B.
        prop_invocation = next(c for c in log if c[0] == "proposals")
        assert prop_invocation[1] == 2
