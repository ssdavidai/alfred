"""Regression tests for the ChorePromotion Temporal sandbox fix (#312).

`ChorePromotionReflectionWorkflow` read `os.environ` from inside workflow
code, so Temporal rejected every activation with:

    Cannot access os.environ.__getitem__ from inside a workflow

The flag now lives in a dedicated activity (activities run outside the
deterministic sandbox), matching the rule documented in
`workflows/meeting_capture.py`.
"""
from __future__ import annotations

import inspect

from src.activities.chore_promotion import promotion_auto_pr_enabled
from src.workflows import chore_promotion as workflow_module


async def test_auto_pr_disabled_by_default(monkeypatch):
    monkeypatch.delenv("ALFRED_PROMOTION_AUTO_PR", raising=False)
    assert await promotion_auto_pr_enabled() is False


async def test_auto_pr_enabled_when_flag_true(monkeypatch):
    monkeypatch.setenv("ALFRED_PROMOTION_AUTO_PR", "true")
    assert await promotion_auto_pr_enabled() is True


async def test_auto_pr_flag_is_case_and_space_insensitive(monkeypatch):
    monkeypatch.setenv("ALFRED_PROMOTION_AUTO_PR", "  TRUE  ")
    assert await promotion_auto_pr_enabled() is True


async def test_auto_pr_other_values_are_off(monkeypatch):
    for value in ("false", "1", "yes", "", "no"):
        monkeypatch.setenv("ALFRED_PROMOTION_AUTO_PR", value)
        assert await promotion_auto_pr_enabled() is False, value


def test_workflow_module_never_touches_os_environ():
    """The structural guard: workflow code must not read env at all.

    Temporal re-imports and replays workflow modules inside its sandbox, so
    any `os.environ` access here is a latent activation failure — exactly
    what #312 was. Keep this assertion; it is cheaper than another incident.
    """
    source = inspect.getsource(workflow_module)
    assert "os.environ" not in source
    assert "getenv" not in source
