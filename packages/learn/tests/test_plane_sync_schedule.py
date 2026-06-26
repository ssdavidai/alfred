"""Tests for ``al-plane-sync`` schedule registration (#536 B5).

The production code path is ``scripts.register_schedules.register_plane_sync``
which takes a connected ``temporalio.client.Client`` and the task_queue name,
consults the ``PLANE_SYNC_ENABLED`` env flag, and either creates, leaves, or
deletes the ``al-plane-sync`` schedule accordingly.

These tests exercise all four combinations (flag × existence) with a mocked
Temporal client — no real Temporal server is required.
"""
from __future__ import annotations

import asyncio
from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock

import pytest

from temporalio.client import (
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleIntervalSpec,
    ScheduleOverlapPolicy,
    SchedulePolicy,
)
from temporalio.service import RPCError, RPCStatusCode

from scripts.register_schedules import (
    PLANE_RECONCILIATION_SCHEDULE_ID,
    PLANE_RECONCILIATION_WORKFLOW,
    PLANE_REVERSE_SYNC_SCHEDULE_ID,
    PLANE_REVERSE_SYNC_WORKFLOW,
    PLANE_SYNC_SCHEDULE_ID,
    PLANE_SYNC_WORKFLOW,
    _plane_sync_enabled,
    register_plane_reconciliation,
    register_plane_reverse_sync,
    register_plane_sync,
)


# ---------------------------------------------------------------------------
# _plane_sync_enabled flag parsing
# ---------------------------------------------------------------------------

class TestPlaneSyncEnabledFlag:
    def test_unset(self, monkeypatch):
        monkeypatch.delenv("PLANE_SYNC_ENABLED", raising=False)
        assert _plane_sync_enabled() is False

    def test_true(self, monkeypatch):
        monkeypatch.setenv("PLANE_SYNC_ENABLED", "true")
        assert _plane_sync_enabled() is True

    def test_true_mixed_case(self, monkeypatch):
        monkeypatch.setenv("PLANE_SYNC_ENABLED", "True")
        assert _plane_sync_enabled() is True

    def test_true_with_whitespace(self, monkeypatch):
        monkeypatch.setenv("PLANE_SYNC_ENABLED", "  true  ")
        assert _plane_sync_enabled() is True

    def test_false_values(self, monkeypatch):
        for value in ("false", "0", "no", "", "FALSE", "1"):
            monkeypatch.setenv("PLANE_SYNC_ENABLED", value)
            assert _plane_sync_enabled() is False, (
                f"{value!r} must be treated as disabled"
            )


# ---------------------------------------------------------------------------
# register_plane_sync: enabled path
# ---------------------------------------------------------------------------

def _rpc_error(status: RPCStatusCode) -> RPCError:
    return RPCError("stub", status, None)


def _mock_client() -> tuple[MagicMock, MagicMock]:
    client = MagicMock()
    client.create_schedule = AsyncMock()
    handle = MagicMock()
    handle.describe = AsyncMock()
    handle.delete = AsyncMock()
    handle.update = AsyncMock()
    client.get_schedule_handle = MagicMock(return_value=handle)
    return client, handle


class TestRegisterPlaneSyncEnabled:
    @pytest.fixture(autouse=True)
    def enable_flag(self, monkeypatch):
        monkeypatch.setenv("PLANE_SYNC_ENABLED", "true")

    def test_creates_schedule_with_correct_spec(self):
        client, _handle = _mock_client()

        asyncio.run(register_plane_sync(client, "alfred-learn"))

        client.create_schedule.assert_awaited_once()
        call_args = client.create_schedule.await_args
        assert call_args is not None

        schedule_id, schedule = call_args.args
        assert schedule_id == PLANE_SYNC_SCHEDULE_ID

        assert isinstance(schedule, Schedule)

        # Action: workflow name + task queue
        action = schedule.action
        assert isinstance(action, ScheduleActionStartWorkflow)
        assert action.workflow == PLANE_SYNC_WORKFLOW
        assert action.task_queue == "alfred-learn"
        assert action.id == f"{PLANE_SYNC_SCHEDULE_ID}-run"
        # Workflow reads its own env — no args.
        assert list(action.args) == []

        # Spec: single 15-minute interval
        spec = schedule.spec
        assert len(spec.intervals) == 1
        interval = spec.intervals[0]
        assert isinstance(interval, ScheduleIntervalSpec)
        assert interval.every == timedelta(minutes=15)
        assert not spec.calendars

        # Policy: SKIP overlap
        policy = schedule.policy
        assert isinstance(policy, SchedulePolicy)
        assert policy.overlap == ScheduleOverlapPolicy.SKIP

    def test_already_exists_reconciles_interval(self):
        client, handle = _mock_client()
        client.create_schedule.side_effect = _rpc_error(
            RPCStatusCode.ALREADY_EXISTS
        )

        # Must not raise — on ALREADY_EXISTS it reconciles the interval
        # in place (so existing tenants pick up the new 15-min cadence).
        asyncio.run(register_plane_sync(client, "alfred-learn"))

        client.create_schedule.assert_awaited_once()
        handle.update.assert_awaited_once()

    def test_already_exists_string_match_tolerated(self):
        """Non-RPCError paths (e.g. wrapper exceptions) still match by substring."""
        client, _handle = _mock_client()
        client.create_schedule.side_effect = RuntimeError(
            "schedule already exists"
        )

        asyncio.run(register_plane_sync(client, "alfred-learn"))

        client.create_schedule.assert_awaited_once()

    def test_real_temporal_error_propagates(self):
        client, _handle = _mock_client()
        client.create_schedule.side_effect = _rpc_error(
            RPCStatusCode.UNAVAILABLE
        )

        with pytest.raises(RPCError):
            asyncio.run(register_plane_sync(client, "alfred-learn"))


# ---------------------------------------------------------------------------
# register_plane_sync: disabled path
# ---------------------------------------------------------------------------

class TestRegisterPlaneSyncDisabled:
    @pytest.fixture(autouse=True)
    def disable_flag(self, monkeypatch):
        monkeypatch.delenv("PLANE_SYNC_ENABLED", raising=False)

    def test_no_schedule_existing_is_noop(self):
        client, handle = _mock_client()
        # describe() raises NOT_FOUND — schedule doesn't exist.
        handle.describe.side_effect = _rpc_error(RPCStatusCode.NOT_FOUND)

        asyncio.run(register_plane_sync(client, "alfred-learn"))

        client.get_schedule_handle.assert_called_once_with(
            PLANE_SYNC_SCHEDULE_ID
        )
        handle.describe.assert_awaited_once()
        handle.delete.assert_not_called()
        client.create_schedule.assert_not_called()

    def test_existing_schedule_is_deleted(self):
        client, handle = _mock_client()
        # describe() succeeds — schedule exists.
        handle.describe.return_value = MagicMock()

        asyncio.run(register_plane_sync(client, "alfred-learn"))

        handle.describe.assert_awaited_once()
        handle.delete.assert_awaited_once()
        client.create_schedule.assert_not_called()

    def test_describe_non_notfound_error_propagates(self):
        client, handle = _mock_client()
        handle.describe.side_effect = _rpc_error(RPCStatusCode.UNAVAILABLE)

        with pytest.raises(RPCError):
            asyncio.run(register_plane_sync(client, "alfred-learn"))

        handle.delete.assert_not_called()
        client.create_schedule.assert_not_called()

    def test_explicit_false_behaves_like_unset(self, monkeypatch):
        monkeypatch.setenv("PLANE_SYNC_ENABLED", "false")
        client, handle = _mock_client()
        handle.describe.side_effect = _rpc_error(RPCStatusCode.NOT_FOUND)

        asyncio.run(register_plane_sync(client, "alfred-learn"))

        client.create_schedule.assert_not_called()
        handle.delete.assert_not_called()


# ---------------------------------------------------------------------------
# Connect failure in main() path exits non-zero
# ---------------------------------------------------------------------------

class TestRegisterAllConnectFailure:
    def test_connect_failure_bubbles_out(self, monkeypatch):
        """If Temporal is unreachable, register_all must raise so main() exits non-zero."""
        from scripts import register_schedules as mod

        async def boom(_host):
            raise ConnectionError("temporal unreachable")

        monkeypatch.setattr(mod.Client, "connect", AsyncMock(side_effect=boom))

        with pytest.raises(ConnectionError):
            asyncio.run(mod.register_all())

    def test_main_exits_on_connect_failure(self, monkeypatch):
        from scripts import register_schedules as mod

        async def failing_register_all():
            raise ConnectionError("boom")

        monkeypatch.setattr(mod, "register_all", failing_register_all)

        with pytest.raises(SystemExit) as excinfo:
            mod.main()
        assert excinfo.value.code == 1


# ---------------------------------------------------------------------------
# Reverse sync schedule (B7)
# ---------------------------------------------------------------------------

class TestRegisterPlaneReverseSyncEnabled:
    @pytest.fixture(autouse=True)
    def enable_flag(self, monkeypatch):
        monkeypatch.setenv("PLANE_SYNC_ENABLED", "true")

    def test_creates_schedule_with_15min_interval_and_skip_overlap(self):
        client, _handle = _mock_client()

        asyncio.run(register_plane_reverse_sync(client, "alfred-learn"))

        client.create_schedule.assert_awaited_once()
        schedule_id, schedule = client.create_schedule.await_args.args
        assert schedule_id == PLANE_REVERSE_SYNC_SCHEDULE_ID

        action = schedule.action
        assert isinstance(action, ScheduleActionStartWorkflow)
        assert action.workflow == PLANE_REVERSE_SYNC_WORKFLOW
        assert action.task_queue == "alfred-learn"
        assert action.id == f"{PLANE_REVERSE_SYNC_SCHEDULE_ID}-run"
        assert list(action.args) == []

        spec = schedule.spec
        assert len(spec.intervals) == 1
        assert spec.intervals[0].every == timedelta(minutes=15)
        assert not spec.calendars

        policy = schedule.policy
        assert isinstance(policy, SchedulePolicy)
        assert policy.overlap == ScheduleOverlapPolicy.SKIP

    def test_already_exists_reconciles_interval(self):
        client, handle = _mock_client()
        client.create_schedule.side_effect = _rpc_error(
            RPCStatusCode.ALREADY_EXISTS
        )
        asyncio.run(register_plane_reverse_sync(client, "alfred-learn"))
        client.create_schedule.assert_awaited_once()
        handle.update.assert_awaited_once()

    def test_real_temporal_error_propagates(self):
        client, _handle = _mock_client()
        client.create_schedule.side_effect = _rpc_error(
            RPCStatusCode.UNAVAILABLE
        )
        with pytest.raises(RPCError):
            asyncio.run(register_plane_reverse_sync(client, "alfred-learn"))


class TestRegisterPlaneReverseSyncDisabled:
    @pytest.fixture(autouse=True)
    def disable_flag(self, monkeypatch):
        monkeypatch.delenv("PLANE_SYNC_ENABLED", raising=False)

    def test_absent_schedule_is_noop(self):
        client, handle = _mock_client()
        handle.describe.side_effect = _rpc_error(RPCStatusCode.NOT_FOUND)
        asyncio.run(register_plane_reverse_sync(client, "alfred-learn"))
        handle.describe.assert_awaited_once()
        handle.delete.assert_not_called()
        client.create_schedule.assert_not_called()

    def test_existing_schedule_is_deleted(self):
        client, handle = _mock_client()
        handle.describe.return_value = MagicMock()
        asyncio.run(register_plane_reverse_sync(client, "alfred-learn"))
        handle.describe.assert_awaited_once()
        handle.delete.assert_awaited_once()
        client.create_schedule.assert_not_called()


# ---------------------------------------------------------------------------
# Reconciliation schedule (REST-delete workaround sweep)
# ---------------------------------------------------------------------------

class TestRegisterPlaneReconciliationEnabled:
    @pytest.fixture(autouse=True)
    def enable_flag(self, monkeypatch):
        monkeypatch.setenv("PLANE_SYNC_ENABLED", "true")

    def test_creates_schedule_with_1h_interval_and_skip_overlap(self):
        client, _handle = _mock_client()

        asyncio.run(register_plane_reconciliation(client, "alfred-learn"))

        client.create_schedule.assert_awaited_once()
        schedule_id, schedule = client.create_schedule.await_args.args
        assert schedule_id == PLANE_RECONCILIATION_SCHEDULE_ID

        action = schedule.action
        assert isinstance(action, ScheduleActionStartWorkflow)
        assert action.workflow == PLANE_RECONCILIATION_WORKFLOW
        assert action.task_queue == "alfred-learn"
        assert action.id == f"{PLANE_RECONCILIATION_SCHEDULE_ID}-run"
        assert list(action.args) == []

        spec = schedule.spec
        assert len(spec.intervals) == 1
        assert spec.intervals[0].every == timedelta(hours=1)
        assert not spec.calendars

        policy = schedule.policy
        assert isinstance(policy, SchedulePolicy)
        assert policy.overlap == ScheduleOverlapPolicy.SKIP

    def test_already_exists_is_tolerated(self):
        client, _handle = _mock_client()
        client.create_schedule.side_effect = _rpc_error(
            RPCStatusCode.ALREADY_EXISTS
        )
        asyncio.run(register_plane_reconciliation(client, "alfred-learn"))
        client.create_schedule.assert_awaited_once()


class TestRegisterPlaneReconciliationDisabled:
    @pytest.fixture(autouse=True)
    def disable_flag(self, monkeypatch):
        monkeypatch.delenv("PLANE_SYNC_ENABLED", raising=False)

    def test_absent_schedule_is_noop(self):
        client, handle = _mock_client()
        handle.describe.side_effect = _rpc_error(RPCStatusCode.NOT_FOUND)
        asyncio.run(register_plane_reconciliation(client, "alfred-learn"))
        handle.describe.assert_awaited_once()
        handle.delete.assert_not_called()
        client.create_schedule.assert_not_called()

    def test_existing_schedule_is_deleted(self):
        client, handle = _mock_client()
        handle.describe.return_value = MagicMock()
        asyncio.run(register_plane_reconciliation(client, "alfred-learn"))
        handle.describe.assert_awaited_once()
        handle.delete.assert_awaited_once()
        client.create_schedule.assert_not_called()
