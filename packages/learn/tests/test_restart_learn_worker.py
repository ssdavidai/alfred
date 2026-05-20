"""#S2-2 — restart_learn_worker must not report success when the restart
genuinely failed. The old code returned ok=True on ConnectError and 429,
hiding real failures (ctrl-api outage / never-confirmed restart) so the
schedule-vs-register race (S2-1) was undetectable. Status mapping now:
200 -> restarted(ok); 429/Connect -> in_progress(not ok); else -> failed.
"""
from __future__ import annotations

import asyncio

import httpx
from temporalio import activity
from temporalio.testing import ActivityEnvironment
from unittest.mock import patch

from src.activities import chore_generation
from src.activities.chore_generation import restart_learn_worker


def _run():
    env = ActivityEnvironment()

    @activity.defn(name="_test_wrapper")
    async def _wrapper():
        return await restart_learn_worker()

    return asyncio.run(env.run(_wrapper))


class _Resp:
    def __init__(self, status_code, text=""):
        self.status_code = status_code
        self.text = text


def _run_with(resp=None, raise_exc=None):
    class _C:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **k):
            if raise_exc is not None:
                raise raise_exc
            return resp

    with patch.object(chore_generation, "_resolve_ctrl_api_token", lambda: "tok"), \
         patch.object(chore_generation, "_restart_learn_endpoint", lambda: "http://x"), \
         patch("httpx.AsyncClient", return_value=_C()):
        return _run()


def test_200_is_confirmed_success():
    result = _run_with(_Resp(200, "ok"))
    assert result["ok"] is True
    assert result["status"] == "restarted"


def test_429_is_in_progress_not_success():
    result = _run_with(_Resp(429, "rate limited"))
    assert result["ok"] is False
    assert result["status"] == "in_progress"
    assert result.get("in_progress") is True


def test_connect_error_is_in_progress_not_success():
    result = _run_with(raise_exc=httpx.ConnectError("boom"))
    assert result["ok"] is False
    assert result["status"] == "in_progress"
    assert result.get("in_progress") is True


def test_unexpected_status_is_failure():
    result = _run_with(_Resp(500, "internal error"))
    assert result["ok"] is False
    assert result["status"] == "failed"
    assert "error" in result


def test_unexpected_exception_is_failure():
    result = _run_with(raise_exc=RuntimeError("kaboom"))
    assert result["ok"] is False
    assert result["status"] == "failed"


def test_missing_token_is_failure():
    p2 = patch.object(chore_generation, "_restart_learn_endpoint", lambda: "http://x")
    with patch.object(chore_generation, "_resolve_ctrl_api_token", lambda: ""), p2:
        result = _run()
    assert result["ok"] is False
    assert result["status"] == "failed"
