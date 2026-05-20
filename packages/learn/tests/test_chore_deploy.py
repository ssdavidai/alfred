"""Tests for deploy_generated_template and restart_learn_worker (Step 4, S4-7).

The deploy activity writes to /alfred-data/user-chores/ which doesn't
exist in the test environment. All filesystem-facing tests patch the
module-level path constants to point at a tmp_path so they run
hermetically. The restart activity is tested with a mocked httpx
AsyncClient.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from temporalio.testing import ActivityEnvironment

from src.activities import chore_generation
from src.activities.chore_generation import (
    deploy_generated_template,
    restart_learn_worker,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_deploy(source: str, module_name: str, class_name: str) -> dict:
    env = ActivityEnvironment()
    return asyncio.run(env.run(deploy_generated_template, source, module_name, class_name))


def _run_restart() -> dict:
    env = ActivityEnvironment()
    return asyncio.run(env.run(restart_learn_worker))


def _patch_deploy_paths(tmp_path: Path):
    """Redirect user-chores dir and audit log into a test tmp_path.

    Returns the patch context managers that the caller should use as
    `with _patch_deploy_paths(tmp_path): ...`.
    """
    from contextlib import ExitStack
    stack = ExitStack()
    stack.enter_context(patch.object(
        chore_generation, "_USER_CHORES_DIR_PATH", tmp_path / "user-chores"
    ))
    stack.enter_context(patch.object(
        chore_generation, "_DEPLOY_AUDIT_LOG", tmp_path / "audit.jsonl"
    ))
    return stack


_SAMPLE_SOURCE = '"""Sample generated template."""\nfrom __future__ import annotations\n# body\n'


# ---------------------------------------------------------------------------
# deploy_generated_template — happy path
# ---------------------------------------------------------------------------

class TestDeployHappyPath:
    def test_writes_file_and_audit(self, tmp_path):
        with _patch_deploy_paths(tmp_path):
            result = _run_deploy(_SAMPLE_SOURCE, "sample_module", "SampleWorkflow")

        assert result["ok"] is True
        assert result["idempotent"] is False
        assert result["bytes_written"] == len(_SAMPLE_SOURCE)
        assert result["source_hash"] == hashlib.sha256(_SAMPLE_SOURCE.encode()).hexdigest()

        written = (tmp_path / "user-chores" / "sample_module.py").read_text()
        assert written == _SAMPLE_SOURCE

        audit_entries = [
            json.loads(line)
            for line in (tmp_path / "audit.jsonl").read_text().splitlines()
            if line.strip()
        ]
        assert len(audit_entries) == 1
        assert audit_entries[0]["status"] == "ok"
        assert audit_entries[0]["module_name"] == "sample_module"
        assert audit_entries[0]["workflow_class_name"] == "SampleWorkflow"

    def test_returns_absolute_path(self, tmp_path):
        with _patch_deploy_paths(tmp_path):
            result = _run_deploy(_SAMPLE_SOURCE, "foo", "FooWorkflow")
        assert result["ok"] is True
        assert Path(result["path"]).is_absolute()
        assert result["path"].endswith("foo.py")

    def test_creates_user_chores_directory_if_missing(self, tmp_path):
        # Intentionally don't mkdir the target — the activity should create it
        assert not (tmp_path / "user-chores").exists()
        with _patch_deploy_paths(tmp_path):
            result = _run_deploy(_SAMPLE_SOURCE, "auto_mkdir", "AutoMkdirWorkflow")
        assert result["ok"] is True
        assert (tmp_path / "user-chores").is_dir()


# ---------------------------------------------------------------------------
# deploy_generated_template — idempotency
# ---------------------------------------------------------------------------

class TestDeployIdempotency:
    def test_second_deploy_same_content_is_noop(self, tmp_path):
        with _patch_deploy_paths(tmp_path):
            first = _run_deploy(_SAMPLE_SOURCE, "idemp", "IdempWorkflow")
            second = _run_deploy(_SAMPLE_SOURCE, "idemp", "IdempWorkflow")

        assert first["ok"] is True and first["idempotent"] is False
        assert second["ok"] is True and second["idempotent"] is True
        assert second["bytes_written"] == 0
        assert second["source_hash"] == first["source_hash"]

    def test_different_content_overwrites_existing(self, tmp_path):
        v1 = '"""v1"""\n'
        v2 = '"""v2"""\n'
        with _patch_deploy_paths(tmp_path):
            first = _run_deploy(v1, "evolving", "EvolvingWorkflow")
            second = _run_deploy(v2, "evolving", "EvolvingWorkflow")

        assert first["ok"] is True and first["idempotent"] is False
        assert second["ok"] is True and second["idempotent"] is False
        # The second write overwrote the first
        assert (tmp_path / "user-chores" / "evolving.py").read_text() == v2
        assert first["source_hash"] != second["source_hash"]

    def test_idempotent_skip_logged_to_audit(self, tmp_path):
        with _patch_deploy_paths(tmp_path):
            _run_deploy(_SAMPLE_SOURCE, "auditskip", "AuditSkipWorkflow")
            _run_deploy(_SAMPLE_SOURCE, "auditskip", "AuditSkipWorkflow")

        audit_entries = [
            json.loads(line)
            for line in (tmp_path / "audit.jsonl").read_text().splitlines()
            if line.strip()
        ]
        assert len(audit_entries) == 2
        assert audit_entries[0]["status"] == "ok"
        assert audit_entries[1]["status"] == "idempotent_skip"


# ---------------------------------------------------------------------------
# deploy_generated_template — precondition guards
# ---------------------------------------------------------------------------

class TestDeployPreconditions:
    def test_empty_source_rejected(self, tmp_path):
        with _patch_deploy_paths(tmp_path):
            result = _run_deploy("", "foo", "FooWorkflow")
        assert result["ok"] is False
        assert "empty" in result["error"].lower()
        # File should not have been created
        assert not (tmp_path / "user-chores" / "foo.py").exists()

    def test_whitespace_source_rejected(self, tmp_path):
        with _patch_deploy_paths(tmp_path):
            result = _run_deploy("   \n\t\n", "foo", "FooWorkflow")
        assert result["ok"] is False
        assert "empty" in result["error"].lower()

    def test_invalid_module_name_rejected(self, tmp_path):
        with _patch_deploy_paths(tmp_path):
            result = _run_deploy(_SAMPLE_SOURCE, "bad-name!", "BadWorkflow")
        assert result["ok"] is False
        assert "module_name" in result["error"]

    def test_empty_module_name_rejected(self, tmp_path):
        with _patch_deploy_paths(tmp_path):
            result = _run_deploy(_SAMPLE_SOURCE, "", "EmptyWorkflow")
        assert result["ok"] is False


# ---------------------------------------------------------------------------
# deploy_generated_template — atomicity
# ---------------------------------------------------------------------------

class TestDeployAtomicity:
    def test_no_temp_files_left_on_success(self, tmp_path):
        with _patch_deploy_paths(tmp_path):
            result = _run_deploy(_SAMPLE_SOURCE, "atomic", "AtomicWorkflow")
        assert result["ok"] is True
        # After a successful write, only the final file exists in the dir
        files = list((tmp_path / "user-chores").iterdir())
        assert len(files) == 1
        assert files[0].name == "atomic.py"


# ---------------------------------------------------------------------------
# restart_learn_worker
# ---------------------------------------------------------------------------

class TestRestartLearnWorker:
    def test_no_token_returns_error(self, monkeypatch):
        monkeypatch.delenv("AAS_API_KEY", raising=False)
        monkeypatch.delenv("OPENCLAW_GATEWAY_TOKEN_FILE", raising=False)
        result = _run_restart()
        assert result["ok"] is False
        assert "AAS_API_KEY" in result["error"]

    def test_successful_restart_returns_ok(self, monkeypatch):
        monkeypatch.setenv("AAS_API_KEY", "test-token")

        mock_response = type("R", (), {
            "status_code": 200,
            "text": '{"ok":true,"ready_after_seconds":3}',
        })()

        mock_client = AsyncMock()
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.return_value = None
        mock_client.post = AsyncMock(return_value=mock_response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = _run_restart()

        assert result["ok"] is True
        assert result["status_code"] == 200
        assert result["status"] == "restarted"

    def test_rate_limited_is_in_progress_not_success(self, monkeypatch):
        """#S2-2: 429 means a restart is underway elsewhere, but THIS call did
        not confirm one — it is in_progress (ok=False), not a confirmed
        success. Reporting 429 as success masked stuck retry storms that left
        chores unregistered (S2-1)."""
        monkeypatch.setenv("AAS_API_KEY", "test-token")

        mock_response = type("R", (), {
            "status_code": 429,
            "text": '{"error":"rate limited"}',
        })()

        mock_client = AsyncMock()
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.return_value = None
        mock_client.post = AsyncMock(return_value=mock_response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = _run_restart()

        assert result["ok"] is False
        assert result["status"] == "in_progress"
        assert result["in_progress"] is True
        assert result["status_code"] == 429

    def test_unexpected_status_treated_as_failure(self, monkeypatch):
        monkeypatch.setenv("AAS_API_KEY", "test-token")

        mock_response = type("R", (), {
            "status_code": 500,
            "text": "internal server error",
        })()

        mock_client = AsyncMock()
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.return_value = None
        mock_client.post = AsyncMock(return_value=mock_response)

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = _run_restart()

        assert result["ok"] is False
        assert result["status_code"] == 500
        assert result["status"] == "failed"
        assert "500" in result["error"]

    def test_connection_error_is_in_progress_not_success(self, monkeypatch):
        """#S2-2: a dropped connection might be our own worker dying — OR a
        genuine ctrl-api outage. We cannot tell, so it's in_progress
        (ok=False), not a confirmed success. The previous ok=True hid real
        outages and made the schedule-vs-register race (S2-1) invisible."""
        import httpx as _httpx
        monkeypatch.setenv("AAS_API_KEY", "test-token")

        mock_client = AsyncMock()
        mock_client.__aenter__.return_value = mock_client
        mock_client.__aexit__.return_value = None
        mock_client.post = AsyncMock(
            side_effect=_httpx.ConnectError("connection reset")
        )

        with patch("httpx.AsyncClient", return_value=mock_client):
            result = _run_restart()

        assert result["ok"] is False
        assert result["status"] == "in_progress"
        assert result["in_progress"] is True
        assert result["status_code"] is None
        assert "note" in result
