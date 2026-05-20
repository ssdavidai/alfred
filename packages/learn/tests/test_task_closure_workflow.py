"""Tests for TaskClosureWatcherWorkflow and the SM-D-W4 v2 retrofit.

Two layers of coverage:

* Pure-function unit tests on ``propose_task_closure`` — the propose
  function the universal mutator invokes when a (task, signal,
  assessment) triple lands a match.
* End-to-end workflow test through ``WorkflowEnvironment`` — the
  ``workflow.patched("task_closure_state_mutator_v1")`` gate fires in a
  fresh-history environment so the v2 fan-out is exercised alongside
  the legacy ``write_closure_decision`` path.

Stubbing strategy matches ``test_plane_reverse_sync_workflow.py`` —
replacement activities under the same registered name via
``@activity.defn(name=...)`` so the workflow runs end-to-end without
touching ctrl-api or clerk.
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

from src.activities.state_mutator import ObservedWindow, ProposedMutation
from src.activities.task_closure import propose_task_closure
from src.workflows.task_closure import (
    TASK_CLOSURE_STATE_MUTATOR_PATCH,
    TaskClosureResult,
    TaskClosureWatcherWorkflow,
)


# ---------------------------------------------------------------------------
# Propose function unit tests — direct, no Temporal.
# ---------------------------------------------------------------------------


class TestProposeTaskClosure:
    """Coverage on the (target, observed, args) → ProposedMutation contract."""

    def _window(self) -> ObservedWindow:
        now = datetime.now(timezone.utc)
        return ObservedWindow(
            start=now, end=now,
            signal_paths=[], decision_paths=[], other_refs=[],
        )

    def test_high_confidence_match_returns_mutation(self):
        async def _go():
            return await propose_task_closure(
                target={"frontmatter": {"status": "open"}, "as_of": None},
                observed=self._window(),
                args={
                    "signal_path": "signal/2026-05-13-buyer-replied.md",
                    "signal_stem": "2026-05-13-buyer-replied",
                    "assessment": {
                        "closes": True,
                        "confidence": 0.92,
                        "reasoning": "Reply from buyer in the same thread",
                    },
                },
            )

        result = asyncio.run(_go())
        assert isinstance(result, ProposedMutation)
        assert result.fields == {
            "status": "closed",
            "outcome": (
                "auto-closed by signal 2026-05-13-buyer-replied: "
                "Reply from buyer in the same thread"
            ),
        }
        assert result.confidence == 0.92
        # Reason carries the signal path + reasoning for the audit trail.
        assert "2026-05-13-buyer-replied" in result.reason
        assert "Reply from buyer" in result.reason

    def test_already_closed_task_returns_none(self):
        """A duplicate signal hitting an already-closed task is a no-op."""
        async def _go():
            return await propose_task_closure(
                target={"frontmatter": {"status": "closed"}},
                observed=self._window(),
                args={
                    "signal_path": "signal/x.md",
                    "signal_stem": "x",
                    "assessment": {
                        "closes": True, "confidence": 0.95, "reasoning": "dup",
                    },
                },
            )

        assert asyncio.run(_go()) is None

    def test_already_archived_task_returns_none(self):
        async def _go():
            return await propose_task_closure(
                target={"frontmatter": {"status": "archived"}},
                observed=self._window(),
                args={
                    "signal_path": "signal/x.md",
                    "signal_stem": "x",
                    "assessment": {
                        "closes": True, "confidence": 0.95, "reasoning": "dup",
                    },
                },
            )

        assert asyncio.run(_go()) is None

    def test_assessment_closes_false_returns_none(self):
        async def _go():
            return await propose_task_closure(
                target={"frontmatter": {"status": "open"}},
                observed=self._window(),
                args={
                    "signal_path": "signal/x.md",
                    "signal_stem": "x",
                    "assessment": {
                        "closes": False, "confidence": 0.9, "reasoning": "no",
                    },
                },
            )

        assert asyncio.run(_go()) is None

    def test_zero_confidence_returns_none(self):
        async def _go():
            return await propose_task_closure(
                target={"frontmatter": {"status": "open"}},
                observed=self._window(),
                args={
                    "signal_path": "signal/x.md",
                    "signal_stem": "x",
                    "assessment": {
                        "closes": True, "confidence": 0.0, "reasoning": "",
                    },
                },
            )

        assert asyncio.run(_go()) is None

    def test_missing_signal_stem_still_emits(self):
        """``outcome`` falls back to a stemless string when stem is empty.

        The audit record still resolves through ``signal_path`` so we
        don't lose provenance — the human-readable summary just drops
        the short form.
        """
        async def _go():
            return await propose_task_closure(
                target={"frontmatter": {"status": "open"}},
                observed=self._window(),
                args={
                    "signal_path": "signal/x.md",
                    "signal_stem": "",
                    "assessment": {
                        "closes": True, "confidence": 0.95, "reasoning": "ok",
                    },
                },
            )

        result = asyncio.run(_go())
        assert isinstance(result, ProposedMutation)
        assert result.fields["outcome"].startswith("auto-closed:")


# ---------------------------------------------------------------------------
# Workflow integration — SM-D-W4 patched-gate fan-out.
# ---------------------------------------------------------------------------


_CALL_LOG: list[tuple[str, Any]] = []


def _reset_log() -> None:
    _CALL_LOG.clear()


def _make_stubs(
    *,
    open_tasks: list[dict[str, Any]],
    signals: list[dict[str, Any]],
    assessments: dict[tuple[str, str], dict[str, Any]],
    predicate_overrides: Optional[dict[tuple[str, str], dict[str, Any]]] = None,
    write_decision_ok: bool = True,
    v2_applied: bool = True,
) -> tuple[list, dict[str, Any]]:
    """Replacement activities for one workflow run.

    ``assessments`` keys by (task_path, signal_path); the LLM stub
    returns the canned verdict. ``predicate_overrides`` lets a test
    force a predicate hit instead.
    """
    predicate_overrides = predicate_overrides or {}
    state: dict[str, Any] = {
        "decisions_written": [],
        "v2_calls": [],
    }

    @activity.defn(name="list_open_tasks")
    async def stub_list_tasks() -> list[dict[str, Any]]:
        _CALL_LOG.append(("list_tasks", None))
        return list(open_tasks)

    @activity.defn(name="list_recent_signals")
    async def stub_list_signals(
        lookback_min: int = 30,
    ) -> list[dict[str, Any]]:
        _CALL_LOG.append(("list_signals", lookback_min))
        return list(signals)

    @activity.defn(name="assess_closure_predicate")
    async def stub_predicate(
        task: dict[str, Any], signal: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        key = (task.get("path", ""), signal.get("path", ""))
        _CALL_LOG.append(("predicate", key))
        return predicate_overrides.get(key)

    @activity.defn(name="assess_closure")
    async def stub_assess(
        task: dict[str, Any], signal: dict[str, Any],
    ) -> dict[str, Any]:
        key = (task.get("path", ""), signal.get("path", ""))
        _CALL_LOG.append(("assess", key))
        return assessments.get(
            key,
            {"closes": False, "confidence": 0.0, "reasoning": "no-match"},
        )

    @activity.defn(name="write_closure_decision")
    async def stub_write_decision(
        task: dict[str, Any],
        signal: dict[str, Any],
        assessment: dict[str, Any],
    ) -> dict[str, Any]:
        _CALL_LOG.append((
            "write_decision",
            (task.get("path"), signal.get("path"), assessment),
        ))
        state["decisions_written"].append({
            "task_path": task.get("path"),
            "signal_path": signal.get("path"),
            "assessment": dict(assessment),
        })
        if not write_decision_ok:
            return {"ok": False, "error": "stubbed failure"}
        return {"ok": True, "decision": {"id": "stub-dec"}}

    @activity.defn(name="apply_task_closure_v2")
    async def stub_apply_v2(
        task_path: str,
        signal_path: str,
        signal_stem: str,
        assessment: dict[str, Any],
        mode: str = "live",
    ) -> dict[str, Any]:
        _CALL_LOG.append(("v2", (task_path, signal_path, mode)))
        state["v2_calls"].append({
            "task_path": task_path,
            "signal_path": signal_path,
            "signal_stem": signal_stem,
            "assessment": dict(assessment),
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
        stub_list_tasks,
        stub_list_signals,
        stub_predicate,
        stub_assess,
        stub_write_decision,
        stub_apply_v2,
    ], state


async def _run_workflow(stubs: list) -> TaskClosureResult:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"task-closure-test-{uuid.uuid4()}"
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[TaskClosureWatcherWorkflow],
            activities=stubs,
        )
        async with worker:
            result = await client.execute_workflow(
                TaskClosureWatcherWorkflow.run,
                id=f"task-closure-run-{uuid.uuid4()}",
                task_queue=tq,
            )
    return result


def _signal(
    *,
    path: str,
    stem: str,
    matter_refs: list[str],
    headline: str = "Buyer replied",
) -> dict[str, Any]:
    return {
        "path": path,
        "stem": stem,
        "headline": headline,
        "body": "...",
        "kind": "composio-gmail-incoming",
        "created": "2026-05-13T12:00:00Z",
        "matter_refs": matter_refs,
        "fm": {},
    }


def _task(
    *,
    path: str,
    stem: str,
    name: str,
    matter_ref: str,
    closure_predicate: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    return {
        "path": path,
        "stem": stem,
        "name": name,
        "matter_ref": matter_ref,
        "current_state": "",
        "as_of": "",
        "closure_predicate": closure_predicate,
    }


class TestStateMutatorV2Fanout:
    """Phase D contract: ``workflow.patched(...)`` fires in the fresh-history
    WorkflowEnvironment so the v2 wrapper is invoked alongside the
    legacy decision write whenever the workflow closes a task.
    """

    def test_high_confidence_match_emits_v2(self):
        """Single (task, signal) pair with conf ≥ HIGH_CONFIDENCE_THRESHOLD
        produces one decision write + one v2 call."""
        _reset_log()
        task = _task(
            path="task/reply-to-anna.md",
            stem="reply-to-anna",
            name="Reply to Anna",
            matter_ref="matter/clients.md",
        )
        signal = _signal(
            path="signal/2026-05-13-anna-replied.md",
            stem="2026-05-13-anna-replied",
            matter_refs=["matter/clients.md"],
        )
        stubs, state = _make_stubs(
            open_tasks=[task],
            signals=[signal],
            assessments={
                (task["path"], signal["path"]): {
                    "closes": True,
                    "confidence": 0.92,
                    "reasoning": "Anna sent a reply",
                },
            },
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.closures_written == 1
        # Legacy decision write fired.
        assert len(state["decisions_written"]) == 1
        # SM-D-W4: v2 wrapper also fired exactly once with the right shape.
        assert len(state["v2_calls"]) == 1
        call = state["v2_calls"][0]
        assert call["task_path"] == task["path"]
        assert call["signal_path"] == signal["path"]
        assert call["signal_stem"] == signal["stem"]
        assert call["mode"] == "live"
        assert call["assessment"]["closes"] is True

    def test_predicate_match_also_emits_v2(self):
        """Predicate-match path (no LLM call) still produces a v2 audit."""
        _reset_log()
        task = _task(
            path="task/wait-for-payment.md",
            stem="wait-for-payment",
            name="Wait for payment",
            matter_ref="matter/inv-7.md",
            closure_predicate={
                "kind": "payment_to_merchant",
                "fields": {"merchant": "olive & brown"},
            },
        )
        signal = _signal(
            path="signal/2026-05-13-payment.md",
            stem="2026-05-13-payment",
            matter_refs=["matter/inv-7.md"],
        )
        predicate_result = {
            "closes": True,
            "confidence": 1.0,
            "reasoning": "predicate:payment_to_merchant",
        }
        stubs, state = _make_stubs(
            open_tasks=[task],
            signals=[signal],
            assessments={},
            predicate_overrides={
                (task["path"], signal["path"]): predicate_result,
            },
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.closures_written == 1
        assert result.pairs_predicate_matched == 1
        # The LLM assess_closure stub should NOT have fired.
        assert all(c[0] != "assess" for c in _CALL_LOG)
        # Decision + v2 both fired.
        assert len(state["decisions_written"]) == 1
        assert len(state["v2_calls"]) == 1
        assert (
            state["v2_calls"][0]["assessment"]["reasoning"]
            == "predicate:payment_to_merchant"
        )

    def test_medium_confidence_skip_no_v2(self):
        """Below-threshold confidence skips both decision write and v2."""
        _reset_log()
        task = _task(
            path="task/maybe.md",
            stem="maybe",
            name="Maybe",
            matter_ref="matter/clients.md",
        )
        signal = _signal(
            path="signal/uncertain.md",
            stem="uncertain",
            matter_refs=["matter/clients.md"],
        )
        stubs, state = _make_stubs(
            open_tasks=[task],
            signals=[signal],
            assessments={
                (task["path"], signal["path"]): {
                    "closes": True, "confidence": 0.55, "reasoning": "soft",
                },
            },
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.closures_written == 0
        assert state["decisions_written"] == []
        assert state["v2_calls"] == []

    def test_v2_failure_does_not_break_loop(self):
        """A v2 stub that returns applied=False does not erase the decision
        write — closures_written still reflects the legacy path."""
        _reset_log()
        task = _task(
            path="task/reply.md",
            stem="reply",
            name="Reply",
            matter_ref="matter/m.md",
        )
        signal = _signal(
            path="signal/s.md",
            stem="s",
            matter_refs=["matter/m.md"],
        )
        stubs, state = _make_stubs(
            open_tasks=[task],
            signals=[signal],
            assessments={
                (task["path"], signal["path"]): {
                    "closes": True, "confidence": 0.9, "reasoning": "ok",
                },
            },
            v2_applied=False,
        )
        result = asyncio.run(_run_workflow(stubs))
        # Legacy path still ran.
        assert result.closures_written == 1
        assert len(state["decisions_written"]) == 1
        # v2 was invoked but reported applied=False.
        assert len(state["v2_calls"]) == 1

    def test_no_close_no_v2(self):
        """Pair where assessment.closes=False emits no decision and no v2."""
        _reset_log()
        task = _task(
            path="task/a.md",
            stem="a",
            name="A",
            matter_ref="matter/m.md",
        )
        signal = _signal(
            path="signal/s.md",
            stem="s",
            matter_refs=["matter/m.md"],
        )
        stubs, state = _make_stubs(
            open_tasks=[task],
            signals=[signal],
            assessments={
                (task["path"], signal["path"]): {
                    "closes": False, "confidence": 0.9, "reasoning": "topical",
                },
            },
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.closures_written == 0
        assert state["decisions_written"] == []
        assert state["v2_calls"] == []


class TestStateMutatorPatchedGateName:
    """The patched-gate constant is the single source of truth — assert
    its literal value so that a future rename surfaces as a test break
    instead of silently breaking replay safety."""

    def test_patch_constant_matches_spec(self):
        assert (
            TASK_CLOSURE_STATE_MUTATOR_PATCH
            == "task_closure_state_mutator_v1"
        )
