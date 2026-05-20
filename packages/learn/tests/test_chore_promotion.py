"""Tests for S5-2 chore promotion reflection activities.

Covers:
  - `scan_user_chores_directory` file discovery + stats enrichment
  - `identify_promotion_candidates` threshold filtering + 90-day staleness
  - `draft_promotion_proposal` Opus parse + fallback + class extraction
  - `save_promotion_draft` persistence + ok=False refusal
  - `_parse_promotion_response` malformed / missing / fenced inputs

Filesystem and LLM I/O are mocked via tmp_path + monkeypatch so
nothing touches the real /alfred-data directory or OpenRouter.
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

from temporalio.testing import ActivityEnvironment

from src.activities import chore_promotion
from src.activities.chore_promotion import (
    _parse_promotion_response,
    create_github_promotion_pr,
    draft_promotion_proposal,
    identify_promotion_candidates,
    save_promotion_draft,
    scan_user_chores_directory,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(activity_fn, *args):
    env = ActivityEnvironment()
    return asyncio.run(env.run(activity_fn, *args))


_GOOD_TEMPLATE_SOURCE = '''"""Generated chore template for promotion testing."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from temporalio import workflow


@dataclass
class TestInput:
    chore_slug: str


@dataclass
class TestResult:
    notes: str = ""


@workflow.defn(name="PromotionTestWorkflow")
class PromotionTestWorkflow:
    @workflow.run
    async def run(self, input: TestInput) -> TestResult:
        return TestResult(notes="ok")
'''


# ---------------------------------------------------------------------------
# scan_user_chores_directory
# ---------------------------------------------------------------------------

class TestScanUserChoresDirectory:
    def test_missing_directory_returns_empty(self, tmp_path):
        with patch.object(chore_promotion, "_USER_CHORES_DIR", tmp_path / "missing"):
            result = _run(scan_user_chores_directory)
        assert result == []

    def test_empty_directory_returns_empty(self, tmp_path):
        d = tmp_path / "user-chores"
        d.mkdir()
        with patch.object(chore_promotion, "_USER_CHORES_DIR", d):
            # get_chore_run_statistics reads from its own path; patch it too
            with patch("src.workflows.chores._base._CHORE_RUN_HISTORY_PATH", tmp_path / "hist.jsonl"):
                result = _run(scan_user_chores_directory)
        assert result == []

    def test_single_template_discovered(self, tmp_path):
        d = tmp_path / "user-chores"
        d.mkdir()
        (d / "promotion_test.py").write_text(_GOOD_TEMPLATE_SOURCE)
        with patch.object(chore_promotion, "_USER_CHORES_DIR", d):
            with patch("src.workflows.chores._base._CHORE_RUN_HISTORY_PATH", tmp_path / "hist.jsonl"):
                result = _run(scan_user_chores_directory)
        assert len(result) == 1
        entry = result[0]
        assert entry["module_name"] == "promotion_test"
        assert entry["file_path"].endswith("promotion_test.py")
        assert entry["bytes"] == len(_GOOD_TEMPLATE_SOURCE)
        assert entry["source"] == _GOOD_TEMPLATE_SOURCE
        assert entry["slug_guesses"] == ["promotion-test", "promotion_test"]
        assert entry["stats"]["total_runs"] == 0  # no history yet

    def test_multiple_templates_sorted(self, tmp_path):
        d = tmp_path / "user-chores"
        d.mkdir()
        (d / "b_template.py").write_text(_GOOD_TEMPLATE_SOURCE)
        (d / "a_template.py").write_text(_GOOD_TEMPLATE_SOURCE)
        (d / "c_template.py").write_text(_GOOD_TEMPLATE_SOURCE)
        with patch.object(chore_promotion, "_USER_CHORES_DIR", d):
            with patch("src.workflows.chores._base._CHORE_RUN_HISTORY_PATH", tmp_path / "hist.jsonl"):
                result = _run(scan_user_chores_directory)
        # Sorted alphabetically by filename
        assert [e["module_name"] for e in result] == [
            "a_template",
            "b_template",
            "c_template",
        ]

    def test_underscore_prefixed_files_skipped(self, tmp_path):
        d = tmp_path / "user-chores"
        d.mkdir()
        (d / "_private.py").write_text(_GOOD_TEMPLATE_SOURCE)
        (d / "__init__.py").write_text("")
        (d / "real_template.py").write_text(_GOOD_TEMPLATE_SOURCE)
        with patch.object(chore_promotion, "_USER_CHORES_DIR", d):
            with patch("src.workflows.chores._base._CHORE_RUN_HISTORY_PATH", tmp_path / "hist.jsonl"):
                result = _run(scan_user_chores_directory)
        assert len(result) == 1
        assert result[0]["module_name"] == "real_template"

    def test_stats_enrichment_from_history(self, tmp_path):
        d = tmp_path / "user-chores"
        d.mkdir()
        (d / "watch_stuff.py").write_text(_GOOD_TEMPLATE_SOURCE)
        # Seed history under the kebab-case slug
        hist = tmp_path / "hist.jsonl"
        hist.write_text(
            '\n'.join([
                '{"timestamp": 100.0, "chore_slug": "watch-stuff", "result_summary": "ok", "was_dry_run": false}',
                '{"timestamp": 200.0, "chore_slug": "watch-stuff", "result_summary": "ok", "was_dry_run": false}',
                '{"timestamp": 300.0, "chore_slug": "watch-stuff", "result_summary": "ok", "was_dry_run": false}',
            ])
        )
        with patch.object(chore_promotion, "_USER_CHORES_DIR", d):
            with patch("src.workflows.chores._base._CHORE_RUN_HISTORY_PATH", hist):
                result = _run(scan_user_chores_directory)
        assert result[0]["stats"]["total_runs"] == 3
        assert result[0]["stats"]["live_runs"] == 3


# ---------------------------------------------------------------------------
# identify_promotion_candidates
# ---------------------------------------------------------------------------

class TestIdentifyPromotionCandidates:
    def _make_entry(self, total, live, last_run_ago_days, module="test"):
        return {
            "module_name": module,
            "file_path": f"/tmp/{module}.py",
            "bytes": 100,
            "source": "...",
            "slug_guesses": [module],
            "stats": {
                "total_runs": total,
                "live_runs": live,
                "dry_runs": total - live,
                "first_run": time.time() - 10_000_000,
                "last_run": time.time() - (last_run_ago_days * 86400),
                "recent_runs": [],
            },
        }

    def test_meets_all_thresholds(self):
        entry = self._make_entry(total=25, live=25, last_run_ago_days=7)
        result = _run(identify_promotion_candidates, [entry], 20, 0.95)
        assert len(result) == 1
        assert result[0]["success_rate"] == 1.0
        assert result[0]["meets_thresholds"]["actual_runs"] == 25

    def test_below_min_runs_rejected(self):
        entry = self._make_entry(total=15, live=15, last_run_ago_days=7)
        result = _run(identify_promotion_candidates, [entry], 20, 0.95)
        assert result == []

    def test_below_success_rate_rejected(self):
        entry = self._make_entry(total=25, live=20, last_run_ago_days=7)  # 80%
        result = _run(identify_promotion_candidates, [entry], 20, 0.95)
        assert result == []

    def test_stale_more_than_90_days_rejected(self):
        entry = self._make_entry(total=25, live=25, last_run_ago_days=100)
        result = _run(identify_promotion_candidates, [entry], 20, 0.95)
        assert result == []

    def test_missing_last_run_rejected(self):
        entry = self._make_entry(total=25, live=25, last_run_ago_days=0)
        entry["stats"]["last_run"] = None
        result = _run(identify_promotion_candidates, [entry], 20, 0.95)
        assert result == []

    def test_mixed_list_filtered_correctly(self):
        entries = [
            self._make_entry(total=30, live=30, last_run_ago_days=1, module="winner"),
            self._make_entry(total=5, live=5, last_run_ago_days=1, module="too_few"),
            self._make_entry(total=30, live=20, last_run_ago_days=1, module="bad_rate"),
            self._make_entry(total=30, live=30, last_run_ago_days=95, module="stale"),
        ]
        result = _run(identify_promotion_candidates, entries, 20, 0.95)
        assert len(result) == 1
        assert result[0]["module_name"] == "winner"

    def test_custom_thresholds_respected(self):
        entry = self._make_entry(total=10, live=8, last_run_ago_days=1)
        # Default thresholds reject; lower bar accepts
        assert _run(identify_promotion_candidates, [entry], 20, 0.95) == []
        passed = _run(identify_promotion_candidates, [entry], 10, 0.8)
        assert len(passed) == 1


# ---------------------------------------------------------------------------
# draft_promotion_proposal
# ---------------------------------------------------------------------------

class TestDraftPromotionProposal:
    def _candidate(self):
        return {
            "module_name": "promotion_test",
            "source": _GOOD_TEMPLATE_SOURCE,
            "stats": {
                "total_runs": 30,
                "live_runs": 29,
                "dry_runs": 1,
                "first_run": 1.0,
                "last_run": 100.0,
                "recent_runs": [
                    {"timestamp": 90.0, "result_summary": "ok", "was_dry_run": False},
                ],
            },
        }

    def test_empty_source_returns_error(self):
        candidate = {"module_name": "x", "source": "", "stats": {}}
        result = _run(draft_promotion_proposal, candidate)
        assert result["ok"] is False
        assert "no source" in result["error"]

    def test_unparseable_source_returns_error(self):
        candidate = {
            "module_name": "bad",
            "source": "::: this isn't python :::",
            "stats": {},
        }
        result = _run(draft_promotion_proposal, candidate)
        assert result["ok"] is False
        assert "workflow class" in result["error"]

    def test_happy_path_llm_json_response(self):
        candidate = self._candidate()
        good_response = json.dumps({
            "pr_title": "chore: promote promotion_test to standard library",
            "pr_body": "## Why\n\nThis template has run 30 times with 97% success rate.\n\n## Concerns\n\nNone.",
        })
        with patch(
            "src.activities.chore_promotion._call_llm",
            new=AsyncMock(return_value=good_response),
        ):
            result = _run(draft_promotion_proposal, candidate)
        assert result["ok"] is True
        assert result["workflow_class_name"] == "PromotionTestWorkflow"
        assert "promotion_test" in result["pr_title"]
        assert "97%" in result["pr_body"]
        assert result["python_source"] == _GOOD_TEMPLATE_SOURCE
        assert result["candidate_stats"]["total_runs"] == 30

    def test_llm_exception_returns_structured_error(self):
        candidate = self._candidate()
        with patch(
            "src.activities.chore_promotion._call_llm",
            new=AsyncMock(side_effect=RuntimeError("openrouter 503")),
        ):
            result = _run(draft_promotion_proposal, candidate)
        assert result["ok"] is False
        assert "LLM call failed" in result["error"]
        assert "503" in result["error"]

    def test_malformed_llm_response_uses_defaults(self):
        candidate = self._candidate()
        with patch(
            "src.activities.chore_promotion._call_llm",
            new=AsyncMock(return_value="not json at all just prose"),
        ):
            result = _run(draft_promotion_proposal, candidate)
        # Still ok=True because we return defaults on parse failure
        assert result["ok"] is True
        assert "promotion_test" in result["pr_title"]
        assert "manually" in result["pr_body"]


# ---------------------------------------------------------------------------
# _parse_promotion_response (pure helper)
# ---------------------------------------------------------------------------

class TestParsePromotionResponse:
    def test_plain_json(self):
        raw = json.dumps({"pr_title": "T", "pr_body": "B"})
        title, body = _parse_promotion_response(raw, "mod")
        assert title == "T"
        assert body == "B"

    def test_markdown_fenced_json(self):
        raw = "```json\n" + json.dumps({"pr_title": "T", "pr_body": "B"}) + "\n```"
        title, body = _parse_promotion_response(raw, "mod")
        assert title == "T"

    def test_leading_explanation_stripped(self):
        raw = "Here is my proposal:\n\n" + json.dumps({"pr_title": "T", "pr_body": "B"})
        title, body = _parse_promotion_response(raw, "mod")
        assert title == "T"

    def test_missing_pr_title_uses_default(self):
        raw = json.dumps({"pr_body": "only body"})
        title, body = _parse_promotion_response(raw, "my_module")
        assert "my_module" in title

    def test_malformed_returns_defaults(self):
        title, body = _parse_promotion_response("garbage", "my_module")
        assert "my_module" in title
        assert "manually" in body

    def test_non_string_returns_defaults(self):
        title, body = _parse_promotion_response([1, 2, 3], "my_module")  # type: ignore
        assert "my_module" in title

    def test_long_title_truncated(self):
        long_title = "chore: " + "x" * 200
        raw = json.dumps({"pr_title": long_title, "pr_body": "B"})
        title, _ = _parse_promotion_response(raw, "mod")
        assert len(title) <= 100
        assert title.endswith("...")


# ---------------------------------------------------------------------------
# save_promotion_draft
# ---------------------------------------------------------------------------

class TestSavePromotionDraft:
    def test_saves_ok_proposal(self, tmp_path):
        proposal = {
            "ok": True,
            "module_name": "foo",
            "workflow_class_name": "FooWorkflow",
            "pr_title": "chore: promote foo",
            "pr_body": "body",
            "python_source": "...",
            "candidate_stats": {"total_runs": 25},
            "drafted_at": 1234567890.0,
        }
        with patch.object(chore_promotion, "_PROMOTION_DRAFTS_DIR", tmp_path / "drafts"):
            result = _run(save_promotion_draft, proposal)
        assert result["ok"] is True
        assert result["path"].endswith(".json")
        path = Path(result["path"])
        assert path.exists()
        loaded = json.loads(path.read_text())
        assert loaded["module_name"] == "foo"
        assert loaded["pr_title"] == "chore: promote foo"

    def test_refuses_non_ok_proposal(self, tmp_path):
        proposal = {"ok": False, "error": "LLM failed", "module_name": "foo"}
        with patch.object(chore_promotion, "_PROMOTION_DRAFTS_DIR", tmp_path / "drafts"):
            result = _run(save_promotion_draft, proposal)
        assert result["ok"] is False
        assert "non-ok" in result["error"]
        # Nothing written
        assert not (tmp_path / "drafts").exists() or not list((tmp_path / "drafts").iterdir())

    def test_creates_drafts_directory(self, tmp_path):
        proposal = {"ok": True, "module_name": "x", "pr_title": "t", "pr_body": "b"}
        drafts_dir = tmp_path / "deep" / "nested" / "drafts"
        with patch.object(chore_promotion, "_PROMOTION_DRAFTS_DIR", drafts_dir):
            result = _run(save_promotion_draft, proposal)
        assert result["ok"] is True
        assert drafts_dir.is_dir()

    def test_unique_filename_per_draft(self, tmp_path):
        proposal = {"ok": True, "module_name": "foo", "pr_title": "t", "pr_body": "b"}
        drafts_dir = tmp_path / "drafts"
        with patch.object(chore_promotion, "_PROMOTION_DRAFTS_DIR", drafts_dir):
            r1 = _run(save_promotion_draft, proposal)
            # Small sleep not needed — timestamp changes between calls
            time.sleep(1.01)
            r2 = _run(save_promotion_draft, proposal)
        assert r1["ok"] and r2["ok"]
        assert r1["path"] != r2["path"]
        assert len(list(drafts_dir.iterdir())) == 2


# ---------------------------------------------------------------------------
# create_github_promotion_pr (S5-3)
# ---------------------------------------------------------------------------

class _FakeResponse:
    """Tiny httpx.Response stand-in for unit tests."""

    def __init__(self, status_code: int, payload=None, text: str = ""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text or (json.dumps(self._payload) if payload else "")

    def json(self):
        return self._payload


class _FakeClient:
    """AsyncContextManager httpx.AsyncClient stand-in.

    Intercepts get/post/put and returns canned responses from a mapping
    of (method, url_suffix) → _FakeResponse. Tracks every call for
    assertion.
    """

    def __init__(self, responses: dict[tuple[str, str], _FakeResponse]):
        self.responses = responses
        self.calls: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def _dispatch(self, method: str, url: str, **kwargs) -> _FakeResponse:
        self.calls.append({"method": method, "url": url, **kwargs})
        for (m, suffix), resp in self.responses.items():
            if m == method and suffix in url:
                return resp
        raise AssertionError(f"unexpected {method} {url}")

    async def get(self, url, **kwargs):
        return await self._dispatch("GET", url, **kwargs)

    async def post(self, url, **kwargs):
        return await self._dispatch("POST", url, **kwargs)

    async def put(self, url, **kwargs):
        return await self._dispatch("PUT", url, **kwargs)


def _good_draft() -> dict:
    return {
        "ok": True,
        "module_name": "test_promotion",
        "workflow_class_name": "TestPromotionWorkflow",
        "pr_title": "chore: promote test_promotion to stdlib",
        "pr_body": "## Why\n\nUseful template.",
        "python_source": _GOOD_TEMPLATE_SOURCE,
        "candidate_stats": {"total_runs": 25},
        "drafted_at": 1234567890.0,
    }


class TestCreateGithubPromotionPRPreconditions:
    def test_non_dict_draft_rejected(self, monkeypatch):
        monkeypatch.setenv("ALFRED_PROMOTION_GITHUB_TOKEN", "test-token")
        result = _run(create_github_promotion_pr, "not a dict")  # type: ignore[arg-type]
        assert result["ok"] is False
        assert result["phase"] == "precondition"

    def test_missing_required_fields_rejected(self, monkeypatch):
        monkeypatch.setenv("ALFRED_PROMOTION_GITHUB_TOKEN", "test-token")
        # Missing pr_title
        draft = _good_draft()
        del draft["pr_title"]
        result = _run(create_github_promotion_pr, draft)
        assert result["ok"] is False
        assert result["phase"] == "precondition"
        assert "missing required fields" in result["error"]

    def test_empty_string_field_rejected(self, monkeypatch):
        monkeypatch.setenv("ALFRED_PROMOTION_GITHUB_TOKEN", "test-token")
        draft = _good_draft()
        draft["python_source"] = ""
        result = _run(create_github_promotion_pr, draft)
        assert result["ok"] is False
        assert result["phase"] == "precondition"

    def test_missing_token_returns_auth_error(self, monkeypatch):
        monkeypatch.delenv("ALFRED_PROMOTION_GITHUB_TOKEN", raising=False)
        result = _run(create_github_promotion_pr, _good_draft())
        assert result["ok"] is False
        assert result["phase"] == "auth"
        assert "not set" in result["error"]


class TestCreateGithubPromotionPRHappyPath:
    def test_full_four_api_calls_happy_path(self, monkeypatch):
        monkeypatch.setenv("ALFRED_PROMOTION_GITHUB_TOKEN", "test-token")
        monkeypatch.setenv("ALFRED_PROMOTION_REPO", "test-owner/test-repo")
        monkeypatch.setenv("ALFRED_PROMOTION_BASE_BRANCH", "main")

        fake_responses = {
            ("GET", "/git/refs/heads/main"): _FakeResponse(
                200, {"object": {"sha": "abc123"}}
            ),
            ("POST", "/git/refs"): _FakeResponse(201, {"ref": "refs/heads/new"}),
            ("PUT", "/contents/"): _FakeResponse(
                201, {"content": {"sha": "def456"}}
            ),
            ("POST", "/pulls"): _FakeResponse(
                201, {"number": 42, "html_url": "https://github.com/test-owner/test-repo/pull/42"}
            ),
            ("POST", "/issues/42/labels"): _FakeResponse(200, []),
        }
        fake_client = _FakeClient(fake_responses)

        with patch("httpx.AsyncClient", return_value=fake_client):
            result = _run(create_github_promotion_pr, _good_draft())

        assert result["ok"] is True
        assert result["phase"] == "done"
        assert result["pr_number"] == 42
        assert result["pr_url"] == "https://github.com/test-owner/test-repo/pull/42"
        assert result["branch"].startswith("chore-promotion/test_promotion-")

        # Verify all four main calls happened
        methods = [(c["method"], c["url"]) for c in fake_client.calls]
        assert any(m == "GET" and "/git/refs/heads/main" in u for m, u in methods)
        assert any(m == "POST" and u.endswith("/git/refs") for m, u in methods)
        assert any(m == "PUT" and "/contents/" in u for m, u in methods)
        assert any(m == "POST" and u.endswith("/pulls") for m, u in methods)

    def test_label_failure_does_not_fail_pr(self, monkeypatch):
        """Label application is best-effort — a 404 on labels must
        not cause the overall PR creation to report ok=False."""
        import httpx as _httpx

        monkeypatch.setenv("ALFRED_PROMOTION_GITHUB_TOKEN", "test-token")
        fake_responses = {
            ("GET", "/git/refs/heads/main"): _FakeResponse(200, {"object": {"sha": "abc"}}),
            ("POST", "/git/refs"): _FakeResponse(201, {}),
            ("PUT", "/contents/"): _FakeResponse(201, {}),
            ("POST", "/pulls"): _FakeResponse(201, {"number": 99, "html_url": "x"}),
        }

        class LabelFailClient(_FakeClient):
            async def post(self, url, **kwargs):
                if "/labels" in url:
                    raise _httpx.ConnectError("label endpoint down")
                return await super().post(url, **kwargs)

        fake_client = LabelFailClient(fake_responses)
        with patch("httpx.AsyncClient", return_value=fake_client):
            result = _run(create_github_promotion_pr, _good_draft())
        assert result["ok"] is True
        assert result["pr_number"] == 99


class TestCreateGithubPromotionPRFailurePaths:
    def test_get_base_failure(self, monkeypatch):
        monkeypatch.setenv("ALFRED_PROMOTION_GITHUB_TOKEN", "test-token")
        fake_client = _FakeClient({
            ("GET", "/git/refs/heads/main"): _FakeResponse(404, text="not found"),
        })
        with patch("httpx.AsyncClient", return_value=fake_client):
            result = _run(create_github_promotion_pr, _good_draft())
        assert result["ok"] is False
        assert result["phase"] == "get_base"
        assert "404" in result["error"]

    def test_create_branch_failure(self, monkeypatch):
        monkeypatch.setenv("ALFRED_PROMOTION_GITHUB_TOKEN", "test-token")
        fake_client = _FakeClient({
            ("GET", "/git/refs/heads/main"): _FakeResponse(200, {"object": {"sha": "x"}}),
            ("POST", "/git/refs"): _FakeResponse(422, text="branch already exists"),
        })
        with patch("httpx.AsyncClient", return_value=fake_client):
            result = _run(create_github_promotion_pr, _good_draft())
        assert result["ok"] is False
        assert result["phase"] == "create_branch"

    def test_create_file_failure(self, monkeypatch):
        monkeypatch.setenv("ALFRED_PROMOTION_GITHUB_TOKEN", "test-token")
        fake_client = _FakeClient({
            ("GET", "/git/refs/heads/main"): _FakeResponse(200, {"object": {"sha": "x"}}),
            ("POST", "/git/refs"): _FakeResponse(201, {}),
            ("PUT", "/contents/"): _FakeResponse(409, text="conflict"),
        })
        with patch("httpx.AsyncClient", return_value=fake_client):
            result = _run(create_github_promotion_pr, _good_draft())
        assert result["ok"] is False
        assert result["phase"] == "create_file"

    def test_create_pr_failure(self, monkeypatch):
        monkeypatch.setenv("ALFRED_PROMOTION_GITHUB_TOKEN", "test-token")
        fake_client = _FakeClient({
            ("GET", "/git/refs/heads/main"): _FakeResponse(200, {"object": {"sha": "x"}}),
            ("POST", "/git/refs"): _FakeResponse(201, {}),
            ("PUT", "/contents/"): _FakeResponse(201, {}),
            ("POST", "/pulls"): _FakeResponse(403, text="forbidden"),
        })
        with patch("httpx.AsyncClient", return_value=fake_client):
            result = _run(create_github_promotion_pr, _good_draft())
        assert result["ok"] is False
        assert result["phase"] == "create_pr"

    def test_network_error_returned_as_structured(self, monkeypatch):
        import httpx as _httpx

        monkeypatch.setenv("ALFRED_PROMOTION_GITHUB_TOKEN", "test-token")

        class NetworkFailClient(_FakeClient):
            async def get(self, url, **kwargs):
                raise _httpx.ConnectError("connection refused")

        fake_client = NetworkFailClient({})
        with patch("httpx.AsyncClient", return_value=fake_client):
            result = _run(create_github_promotion_pr, _good_draft())
        assert result["ok"] is False
        assert result["phase"] == "get_base"
        assert "network error" in result["error"]

    def test_missing_sha_in_base_response(self, monkeypatch):
        monkeypatch.setenv("ALFRED_PROMOTION_GITHUB_TOKEN", "test-token")
        # GitHub returned 200 but without the expected sha field
        fake_client = _FakeClient({
            ("GET", "/git/refs/heads/main"): _FakeResponse(200, {"object": {}}),
        })
        with patch("httpx.AsyncClient", return_value=fake_client):
            result = _run(create_github_promotion_pr, _good_draft())
        assert result["ok"] is False
        assert result["phase"] == "get_base"
        assert "no sha" in result["error"]
