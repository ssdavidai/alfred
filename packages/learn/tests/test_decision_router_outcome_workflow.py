"""Tests for DecisionRouterWorkflow and the SM-D-W7 outcome-linkage retrofit.

Two layers:

* Unit tests on ``propose_decision_outcome_link`` — the deterministic
  propose function that translates a matched (decision, outcome,
  task_ref) triple into a ``{status, outcome}`` mutation.
* Workflow-level test that the patched gate
  ``decision_router_outcome_state_mutator_v1`` fires in a
  fresh-history environment and the v2 fan-out runs once per match
  with ``task_ref``.
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from temporalio import activity
from temporalio.client import Client
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from src.activities.decision_router import propose_decision_outcome_link
from src.activities.state_mutator import ObservedWindow, ProposedMutation
from src.workflows.decision_router import (
    DECISION_ROUTER_OUTCOME_STATE_MUTATOR_PATCH,
    DecisionRouterWorkflow,
)


# ---------------------------------------------------------------------------
# Propose function unit tests
# ---------------------------------------------------------------------------


class TestProposeDecisionOutcomeLink:
    def _window(self) -> ObservedWindow:
        now = datetime.now(timezone.utc)
        return ObservedWindow(
            start=now, end=now,
            signal_paths=[], decision_paths=[], other_refs=[],
        )

    def test_open_task_returns_close_mutation(self):
        async def _go():
            return await propose_decision_outcome_link(
                target={"frontmatter": {"status": "open"}},
                observed=self._window(),
                args={
                    "decision_id": "2026-05-13-abc",
                    "outcome_record": "signal/2026-05-13-agent-completed.md",
                    "intent": "delegate",
                    "source_headline": "Reply to client about pricing",
                },
            )

        result = asyncio.run(_go())
        assert isinstance(result, ProposedMutation)
        assert result.fields["status"] == "closed"
        assert "signal/2026-05-13-agent-completed.md" in result.fields["outcome"]
        assert "Reply to client about pricing" in result.fields["outcome"]
        assert result.confidence == 1.0

    def test_outcome_without_headline_still_emits(self):
        async def _go():
            return await propose_decision_outcome_link(
                target={"frontmatter": {"status": "open"}},
                observed=self._window(),
                args={
                    "decision_id": "d1",
                    "outcome_record": "signal/done.md",
                    "intent": "delegate",
                    "source_headline": "",
                },
            )

        result = asyncio.run(_go())
        assert isinstance(result, ProposedMutation)
        assert result.fields["outcome"] == "resolved by outcome signal/done.md"

    def test_already_closed_task_returns_none(self):
        async def _go():
            return await propose_decision_outcome_link(
                target={"frontmatter": {"status": "closed"}},
                observed=self._window(),
                args={
                    "decision_id": "d1",
                    "outcome_record": "signal/x.md",
                    "intent": "delegate",
                    "source_headline": "",
                },
            )

        assert asyncio.run(_go()) is None

    def test_missing_outcome_record_returns_none(self):
        async def _go():
            return await propose_decision_outcome_link(
                target={"frontmatter": {"status": "open"}},
                observed=self._window(),
                args={
                    "decision_id": "d1",
                    "outcome_record": "",
                    "intent": "delegate",
                    "source_headline": "",
                },
            )

        assert asyncio.run(_go()) is None


# ---------------------------------------------------------------------------
# Workflow integration — SM-D-W7 patched-gate fan-out.
# ---------------------------------------------------------------------------


_CALL_LOG: list[tuple[str, Any]] = []


def _reset_log() -> None:
    _CALL_LOG.clear()


def _make_stubs(
    *,
    opens: Optional[list[dict[str, Any]]] = None,
    reverseds: Optional[list[dict[str, Any]]] = None,
    outcome_matches: Optional[list[dict[str, Any]]] = None,
    outcome_checked: int = 0,
    v2_applied: bool = True,
) -> tuple[list, dict[str, Any]]:
    opens = opens or []
    reverseds = reverseds or []
    outcome_matches = outcome_matches or []

    state: dict[str, Any] = {
        "v2_calls": [],
        "routed": [],
        "reverseds_processed": [],
    }

    @activity.defn(name="list_decisions_by_state")
    async def stub_list(state_filter: str) -> list[dict[str, Any]]:
        _CALL_LOG.append(("list", state_filter))
        if state_filter == "open":
            return list(opens)
        if state_filter == "reversed":
            return list(reverseds)
        return []

    @activity.defn(name="route_decision")
    async def stub_route(decision: dict[str, Any]) -> dict[str, Any]:
        _CALL_LOG.append(("route", decision.get("id")))
        state["routed"].append(dict(decision))
        return {
            "id": decision.get("id"),
            "next_state": "completed",
            "actions": [],
        }

    @activity.defn(name="reverse_decision")
    async def stub_reverse(decision: dict[str, Any]) -> dict[str, Any]:
        _CALL_LOG.append(("reverse", decision.get("id")))
        state["reverseds_processed"].append(dict(decision))
        return {"id": decision.get("id"), "actions_undone": []}

    @activity.defn(name="check_decision_outcomes")
    async def stub_outcomes() -> dict[str, Any]:
        _CALL_LOG.append(("outcomes", None))
        return {
            "checked": outcome_checked or len(outcome_matches),
            "matched": len(outcome_matches),
            "matches": list(outcome_matches),
        }

    @activity.defn(name="apply_decision_outcome_link_v2")
    async def stub_apply_v2(
        task_path: str,
        decision_id: str,
        outcome_record: str,
        intent: str,
        source_headline: str,
        mode: str = "live",
    ) -> dict[str, Any]:
        _CALL_LOG.append(("v2", (task_path, decision_id, outcome_record)))
        state["v2_calls"].append({
            "task_path": task_path,
            "decision_id": decision_id,
            "outcome_record": outcome_record,
            "intent": intent,
            "source_headline": source_headline,
            "mode": mode,
        })
        if not v2_applied:
            return {"applied": False, "error": "stubbed failure"}
        return {
            "applied": True,
            "audit_record_path": (
                f"event/state-change-stub-{task_path.replace('/', '-')}.md"
            ),
            "timeline_entry_id": "stub-ulid",
            "new_as_of": "2026-05-13T12:00:00Z",
            "effective_mode": mode,
            "pending_confirmation": False,
        }

    return [
        stub_list,
        stub_route,
        stub_reverse,
        stub_outcomes,
        stub_apply_v2,
    ], state


async def _run_workflow(stubs: list) -> dict[str, Any]:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"dr-test-{uuid.uuid4()}"
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[DecisionRouterWorkflow],
            activities=stubs,
        )
        async with worker:
            result = await client.execute_workflow(
                DecisionRouterWorkflow.run,
                id=f"dr-run-{uuid.uuid4()}",
                task_queue=tq,
            )
    return result


class TestStateMutatorV2OutcomeFanout:
    def test_match_with_task_ref_emits_v2(self):
        """A check_decision_outcomes match with a non-empty task_ref
        produces one v2 audit call under the patched gate."""
        _reset_log()
        match = {
            "decision_id": "2026-05-13-d1",
            "outcome_record": "signal/2026-05-13-agent-done.md",
            "task_ref": "task/reply-client.md",
            "intent": "delegate",
            "source_record": "needs_attention/abc.md",
            "source_headline": "Pricing reply",
        }
        stubs, state = _make_stubs(outcome_matches=[match], outcome_checked=1)
        result = asyncio.run(_run_workflow(stubs))

        assert result["outcomes_matched"] == 1
        assert len(state["v2_calls"]) == 1
        call = state["v2_calls"][0]
        assert call["task_path"] == "task/reply-client.md"
        assert call["decision_id"] == "2026-05-13-d1"
        assert call["outcome_record"] == "signal/2026-05-13-agent-done.md"
        assert call["intent"] == "delegate"
        assert call["source_headline"] == "Pricing reply"
        assert call["mode"] == "live"

    def test_match_without_task_ref_skips_v2(self):
        """A match without ``task_ref`` skips v2 — the decision-side
        flip is the only write we can do."""
        _reset_log()
        match = {
            "decision_id": "d1",
            "outcome_record": "signal/done.md",
            "task_ref": "",
            "intent": "delegate",
            "source_record": "needs_attention/abc.md",
            "source_headline": "",
        }
        stubs, state = _make_stubs(outcome_matches=[match], outcome_checked=1)
        result = asyncio.run(_run_workflow(stubs))

        assert result["outcomes_matched"] == 1
        assert state["v2_calls"] == []

    def test_multiple_matches_all_emit(self):
        _reset_log()
        matches = [
            {
                "decision_id": f"d{i}",
                "outcome_record": f"signal/out-{i}.md",
                "task_ref": f"task/t-{i}.md",
                "intent": "delegate",
                "source_record": "",
                "source_headline": f"task {i}",
            }
            for i in range(3)
        ]
        stubs, state = _make_stubs(outcome_matches=matches, outcome_checked=3)
        result = asyncio.run(_run_workflow(stubs))

        assert result["outcomes_matched"] == 3
        assert len(state["v2_calls"]) == 3
        task_paths = sorted(c["task_path"] for c in state["v2_calls"])
        assert task_paths == ["task/t-0.md", "task/t-1.md", "task/t-2.md"]

    def test_no_outcomes_no_v2(self):
        _reset_log()
        stubs, state = _make_stubs(outcome_matches=[], outcome_checked=0)
        result = asyncio.run(_run_workflow(stubs))
        assert result["outcomes_matched"] == 0
        assert state["v2_calls"] == []

    def test_v2_failure_does_not_break_other_matches(self):
        """A v2 stub that returns applied=False for one match doesn't
        prevent the workflow from completing — and other matches in the
        same batch still get attempted in subsequent runs."""
        _reset_log()
        matches = [
            {
                "decision_id": "d-fail",
                "outcome_record": "signal/x.md",
                "task_ref": "task/t-fail.md",
                "intent": "delegate",
                "source_record": "",
                "source_headline": "",
            },
            {
                "decision_id": "d-ok",
                "outcome_record": "signal/y.md",
                "task_ref": "task/t-ok.md",
                "intent": "delegate",
                "source_record": "",
                "source_headline": "",
            },
        ]
        # v2_applied=False applies uniformly here — we're testing that
        # both still get invoked (i.e. one failure doesn't short-circuit).
        stubs, state = _make_stubs(
            outcome_matches=matches, outcome_checked=2, v2_applied=False,
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result["outcomes_matched"] == 2
        # Both v2 calls were attempted.
        assert len(state["v2_calls"]) == 2


class TestPatchedGateName:
    def test_patch_constant_matches_spec(self):
        assert (
            DECISION_ROUTER_OUTCOME_STATE_MUTATOR_PATCH
            == "decision_router_outcome_state_mutator_v1"
        )
