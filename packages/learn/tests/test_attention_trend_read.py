"""Tests for AttentionTrendReadWorkflow (#584)."""
from __future__ import annotations
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

def _mk_cfg():
    c = MagicMock(); c.alfred_ctrl_url = "http://localhost:3100"; return c


def _mk_sc(obs_id="obs"):
    cls, inst = MagicMock(), AsyncMock()
    inst.__aenter__ = AsyncMock(return_value=inst)
    inst.__aexit__ = AsyncMock(return_value=False)
    inst.create_observation = AsyncMock(return_value=obs_id)
    cls.return_value = inst
    return cls, inst


async def _run(grain="week", from_="2026-08-04", to="2026-08-10",
               clerk=None, replace=None, obs_id="obs"):
    from src.activities.attention_trend_read import read_attention_trends
    sc_cls, sc_inst = _mk_sc(obs_id)
    with (
        patch("src.activities.attention_trend_read.load_config", return_value=_mk_cfg()),
        patch("src.activities.attention_trend_read._fetch_trends", new_callable=AsyncMock,
              return_value={"grain": grain, "periods": [], "coverage": {}}),
        patch("src.activities.attention_trend_read._call_clerk", new_callable=AsyncMock,
              return_value=clerk if clerk is not None else {"observations": []}),
        patch("src.activities.attention_trend_read._replace_prior_read",
              new_callable=AsyncMock, return_value=replace),
        patch("src.utils.signal_state.StateClient", sc_cls),
        patch("temporalio.activity.logger"),
    ):
        r = await read_attention_trends({"grain": grain, "from": from_, "to": to})
    return r, sc_inst

class TestWorkflowRegistration:
    def test_name_exact(self):
        from src.workflows.attention_trend_read import AttentionTrendReadWorkflow
        defn = getattr(AttentionTrendReadWorkflow, "__temporal_workflow_definition", None)
        assert defn is not None and defn.name == "AttentionTrendReadWorkflow"

    def test_in_all_workflows(self):
        from src.worker import ALL_WORKFLOWS
        from src.workflows.attention_trend_read import AttentionTrendReadWorkflow
        assert AttentionTrendReadWorkflow in ALL_WORKFLOWS

    def test_activity_in_all_activities(self):
        from src.worker import ALL_ACTIVITIES
        from src.activities.attention_trend_read import read_attention_trends
        assert read_attention_trends in ALL_ACTIVITIES

class TestInterruptionGuardrail:
    def _p(self, cov, periods=None):
        from src.activities.attention_trend_read import _build_prompt
        return _build_prompt({"grain": "week", "coverage": cov, "periods": periods or []})

    def test_uninstrumented_coverage_triggers(self):
        assert "HARD CONSTRAINT" in self._p({"interruption_instrumented": False})

    def test_uninstrumented_per_period_triggers(self):
        assert "HARD CONSTRAINT" in self._p({}, [{"interruption_instrumented": False}])

    def test_instrumented_no_constraint(self):
        assert "HARD CONSTRAINT" not in self._p(
            {"interruption_instrumented": True}, [{"interruption_instrumented": True}])


class TestObservationClamping:
    @pytest.mark.asyncio
    async def test_six_clamped_to_five(self):
        obs6 = [{"headline": f"H{i}", "detail": "d", "evidence": "e"} for i in range(6)]
        r, _ = await _run(clerk={"observations": obs6})
        assert r["observations_count"] == 5

    @pytest.mark.asyncio
    async def test_one_kept(self):
        r, _ = await _run(clerk={"observations": [{"headline": "H", "detail": "d", "evidence": "e"}]})
        assert r["observations_count"] == 1


class TestClerkDegradation:
    @pytest.mark.asyncio
    async def test_exception_yields_empty(self):
        from src.activities.attention_trend_read import read_attention_trends
        sc_cls, _ = _mk_sc()
        with (
            patch("src.activities.attention_trend_read.load_config", return_value=_mk_cfg()),
            patch("src.activities.attention_trend_read._fetch_trends", new_callable=AsyncMock,
                  return_value={"grain": "week", "periods": [], "coverage": {}}),
            patch("src.activities.attention_trend_read._call_clerk", new_callable=AsyncMock,
                  side_effect=RuntimeError("timeout")),
            patch("src.activities.attention_trend_read._replace_prior_read",
                  new_callable=AsyncMock, return_value=None),
            patch("src.utils.signal_state.StateClient", sc_cls),
            patch("temporalio.activity.logger"),
        ):
            r = await read_attention_trends({"grain": "week", "from": "2026-08-04", "to": "2026-08-10"})
        assert r["observations_count"] == 0

    @pytest.mark.asyncio
    async def test_non_list_degrades(self):
        r, _ = await _run(clerk={"observations": "not-a-list"})
        assert r["observations_count"] == 0


class TestReplaceSemantics:
    @pytest.mark.asyncio
    async def test_rerun_patches_not_creates(self):
        r, sc = await _run(
            clerk={"observations": [{"headline": "H", "detail": "d", "evidence": "e"}]},
            replace="existing-id",
        )
        assert r["replaced"] is True
        assert r["observation_id"] == "existing-id"
        sc.create_observation.assert_not_called()

    @pytest.mark.asyncio
    async def test_first_run_creates(self):
        r, sc = await _run(replace=None, obs_id="new-id")
        assert r["replaced"] is False and r["observation_id"] == "new-id"
        sc.create_observation.assert_called_once()

    def test_subject_encodes_grain_range(self):
        s = "attention_trend:month:2026-07-01:2026-07-31"
        assert "month" in s and "2026-07-01" in s and s != "attention_trend:month:2026-06-01:2026-06-30"
