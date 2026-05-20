"""Tests for generate_errand_pack_opus (Plan B.2)."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities import packs_opus
from src.activities.packs_opus import (
    _build_errand_prompt,
    _build_rich_errand_content,
    _validate_errand,
    generate_errand_pack_opus,
)


def _run_activity(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_test_wrapper_e")
    async def _wrapper() -> dict:
        return await coro_factory()

    return asyncio.run(env.run(_wrapper))


def _write_onboard(tmp_path: Path, data: dict) -> str:
    path = tmp_path / "onboard.json"
    path.write_text(json.dumps(data))
    return str(path)


def _sample_onboard() -> dict:
    return {
        "facts": [
            {"category": "professional", "fact": "Pat sent contract revision Tuesday", "confidence": "high"},
            {"category": "personal", "fact": "Robin's 9-month checkup is due", "confidence": "high"},
            {"category": "financial", "fact": "Two Polar.sh subscriptions active", "confidence": "medium"},
        ],
        "patterns": [
            {"name": "tuesday-contract-reviews", "description": "Reviews contracts on Tuesdays"},
        ],
        "key_identity_facts": [
            {"field": "name", "display": "Full name", "value": "Sir"},
        ],
        "matters_brief": [{"name": "Pat collaboration"}, {"name": "Robin logistics"}],
        "brief": "I'll watch your subscriptions and remind you about pickups.",
    }


_OPUS_GOOD_ERRAND_RESPONSE = json.dumps({
    "errands": [
        {
            "name": "Reply to Pat's contract revision",
            "status": "todo",
            "owner": "human",
            "urgency": "high",
            "due_hint": "by Friday",
            "related_matter": "Pat collaboration",
            "context": (
                "Pat sent over a revised contract on Tuesday with new payment terms. "
                "It's been sitting in your inbox for two days. He flagged it as needing "
                "a response before Friday's call so they can finalize numbers."
            ),
            "why_it_matters": "Friday's call gets postponed if you don't respond first.",
            "dependencies": ["Read the contract", "Confirm Example Co cash flow with Sam Lee"],
            "first_action": "Open the email thread and read sections 4 and 5 only.",
        },
        {
            "name": "Cancel one of the duplicate Polar.sh subscriptions",
            "status": "todo",
            "owner": "human",
            "urgency": "normal",
            "due_hint": "before next billing cycle",
            "related_matter": "",
            "context": (
                "You have two active Polar.sh subscriptions billing the same project. "
                "One was set up during a tools experiment and was never cancelled. "
                "Polar's UI shows both as active."
            ),
            "why_it_matters": "$30/mo bleeding for no reason.",
            "dependencies": [],
            "first_action": "Log into Polar.sh dashboard and check which one has the older creation date.",
        },
    ],
})


# ---------------------------------------------------------------------------
# _validate_errand
# ---------------------------------------------------------------------------

class TestValidateErrand:
    def _good(self):
        return {
            "name": "Test errand",
            "status": "todo",
            "owner": "human",
            "urgency": "normal",
            "context": "A real context paragraph at least thirty characters long.",
            "why_it_matters": "It matters because.",
            "first_action": "Do the first thing.",
            "dependencies": [],
        }

    def test_good_validates(self):
        ok, _ = _validate_errand(self._good())
        assert ok

    def test_non_dict_rejected(self):
        ok, _ = _validate_errand("not a dict")  # type: ignore[arg-type]
        assert not ok

    def test_missing_name_rejected(self):
        m = self._good()
        del m["name"]
        ok, _ = _validate_errand(m)
        assert not ok

    def test_invalid_status_rejected(self):
        m = self._good()
        m["status"] = "wip"
        ok, reason = _validate_errand(m)
        assert not ok
        assert "status" in reason

    def test_invalid_owner_rejected(self):
        m = self._good()
        m["owner"] = "robot"
        ok, reason = _validate_errand(m)
        assert not ok
        assert "owner" in reason

    def test_invalid_urgency_rejected(self):
        m = self._good()
        m["urgency"] = "kinda"
        ok, _ = _validate_errand(m)
        assert not ok

    def test_short_context_rejected(self):
        m = self._good()
        m["context"] = "tiny"
        ok, _ = _validate_errand(m)
        assert not ok

    def test_short_why_rejected(self):
        m = self._good()
        m["why_it_matters"] = "x"
        ok, _ = _validate_errand(m)
        assert not ok

    def test_short_first_action_rejected(self):
        m = self._good()
        m["first_action"] = "x"
        ok, _ = _validate_errand(m)
        assert not ok

    def test_non_list_dependencies_rejected(self):
        m = self._good()
        m["dependencies"] = "not a list"
        ok, _ = _validate_errand(m)
        assert not ok


# ---------------------------------------------------------------------------
# _build_rich_errand_content
# ---------------------------------------------------------------------------

class TestBuildRichErrandContent:
    def _good(self):
        return {
            "name": "Reply to Pat",
            "status": "todo",
            "owner": "human",
            "urgency": "high",
            "due_hint": "by Friday",
            "related_matter": "Pat collaboration",
            "context": "Real context paragraph that has enough characters to pass validation.",
            "why_it_matters": "Otherwise the call slips.",
            "first_action": "Open the thread and skim it.",
            "dependencies": ["Confirm with Sam Lee"],
        }

    def test_frontmatter_fields_present(self):
        content = _build_rich_errand_content(self._good())
        assert "type: task" in content
        assert "status: todo" in content
        assert "owner: human" in content
        assert "urgency: high" in content
        assert "generated: true" in content

    def test_due_hint_in_frontmatter_when_present(self):
        content = _build_rich_errand_content(self._good())
        assert "due_hint:" in content
        assert "by Friday" in content

    def test_due_hint_omitted_when_empty(self):
        m = self._good()
        m["due_hint"] = ""
        content = _build_rich_errand_content(m)
        assert "due_hint:" not in content

    def test_related_matter_in_frontmatter(self):
        content = _build_rich_errand_content(self._good())
        assert "related_matter:" in content

    def test_body_sections_present(self):
        content = _build_rich_errand_content(self._good())
        assert "## Context" in content
        assert "## Why it matters" in content
        assert "## First action" in content
        assert "## Dependencies" in content

    def test_dependencies_section_omitted_when_empty(self):
        m = self._good()
        m["dependencies"] = []
        content = _build_rich_errand_content(m)
        assert "## Dependencies" not in content
        assert "## Context" in content  # other sections still there


# ---------------------------------------------------------------------------
# _build_errand_prompt
# ---------------------------------------------------------------------------

class TestBuildErrandPrompt:
    def test_prompt_explains_what_errand_is(self):
        prompt = _build_errand_prompt([], [], [], {}, "", [])
        assert "errand IS" in prompt or "errand is" in prompt.lower()
        assert "matter" in prompt.lower()  # contrast section

    def test_prompt_includes_matters(self):
        prompt = _build_errand_prompt([], [], [], {}, "", [{"name": "Pat project"}])
        assert "Pat project" in prompt

    def test_prompt_includes_facts(self):
        facts = [{"category": "personal", "fact": "Robin pickup tomorrow"}]
        prompt = _build_errand_prompt(facts, [], [], {}, "", [])
        assert "Robin pickup tomorrow" in prompt

    def test_prompt_output_schema(self):
        prompt = _build_errand_prompt([], [], [], {}, "", [])
        assert '"errands"' in prompt
        assert "first_action" in prompt
        assert "why_it_matters" in prompt
        assert "due_hint" in prompt


# ---------------------------------------------------------------------------
# Integration: generate_errand_pack_opus
# ---------------------------------------------------------------------------

class _FakeVaultClient:
    def __init__(self):
        self.written: list[tuple[str, str, str]] = []
        self.existing_slugs: set[str] = set()

    async def search_records(self, slug: str, record_type: str = ""):
        return [slug] if slug in self.existing_slugs else []

    async def write_record(self, record_type: str, slug: str, content: str):
        self.written.append((record_type, slug, content))

    async def close(self):
        pass


class TestGenerateErrandPackOpus:
    def test_env_flag_falls_back(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ALFRED_OPUS_PACKS_ENABLED", "false")
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fallback = AsyncMock(return_value={"created": 2})
        with patch("src.activities.packs.generate_errand_pack", new=fallback):
            result = _run_activity(lambda: generate_errand_pack_opus(onboard))

        assert result["source"] == "rule_based_env_flag"
        assert result["created"] == 2

    def test_no_context_falls_back(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, {"profile": {}})

        fallback = AsyncMock(return_value={"created": 1})
        with patch("src.activities.packs.generate_errand_pack", new=fallback):
            result = _run_activity(lambda: generate_errand_pack_opus(onboard))
        assert result["source"] == "rule_based_no_context"

    def test_llm_error_falls_back(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fallback = AsyncMock(return_value={"created": 1})
        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(side_effect=RuntimeError("network down"))), \
             patch("src.activities.packs.generate_errand_pack", new=fallback):
            result = _run_activity(lambda: generate_errand_pack_opus(onboard))
        assert result["source"] == "rule_based_llm_error"
        assert "network" in result["llm_error"]

    def test_parse_failure_falls_back(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fallback = AsyncMock(return_value={"created": 0})
        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(return_value="garbage prose no json")), \
             patch("src.activities.packs.generate_errand_pack", new=fallback):
            result = _run_activity(lambda: generate_errand_pack_opus(onboard))
        assert result["source"] == "rule_based_parse_error"

    def test_happy_path_writes_errands(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fake_client = _FakeVaultClient()

        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(return_value=_OPUS_GOOD_ERRAND_RESPONSE)), \
             patch("src.activities.packs_opus.VaultClient", return_value=fake_client):
            result = _run_activity(lambda: generate_errand_pack_opus(onboard))

        assert result["source"] == "opus"
        assert result["created"] == 2
        assert len(fake_client.written) == 2
        # Verify the records were written as type=task
        for (record_type, _, _) in fake_client.written:
            assert record_type == "task"
        # Verify rich body content
        for (_, _, content) in fake_client.written:
            assert "## Context" in content
            assert "## Why it matters" in content
            assert "## First action" in content

    def test_skips_existing_slugs(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fake_client = _FakeVaultClient()
        fake_client.existing_slugs.add("reply-to-pats-contract-revision")

        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(return_value=_OPUS_GOOD_ERRAND_RESPONSE)), \
             patch("src.activities.packs_opus.VaultClient", return_value=fake_client):
            result = _run_activity(lambda: generate_errand_pack_opus(onboard))

        assert result["created"] == 1
        assert result["skipped_existing"] == 1

    def test_all_invalid_falls_back(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        bad = json.dumps({"errands": [{"name": ""}, {"name": "X"}]})
        fake_client = _FakeVaultClient()
        fallback = AsyncMock(return_value={"created": 3})

        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(return_value=bad)), \
             patch("src.activities.packs_opus.VaultClient", return_value=fake_client), \
             patch("src.activities.packs.generate_errand_pack", new=fallback):
            result = _run_activity(lambda: generate_errand_pack_opus(onboard))

        assert result["source"] == "rule_based_no_valid_errands"
        assert fake_client.written == []
