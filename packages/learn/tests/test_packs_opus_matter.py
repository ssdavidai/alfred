"""Tests for generate_matter_pack_opus (Plan B.1).

The underlying rule-based generate_matter_pack is exercised by existing
tests. These tests focus on:

- Env flag fallback
- No-context fallback
- LLM error fallback
- Parse error fallback
- Validation rejection
- Happy-path write
- Markdown body rendering quality
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities import packs_opus
from src.activities.packs_opus import (
    _build_matter_prompt,
    _build_rich_matter_content,
    _escape_yaml_scalar,
    _format_yaml_list,
    _trim,
    _validate_matter,
    generate_matter_pack_opus,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_activity(coro_factory):
    """Run a coroutine inside a Temporal ActivityEnvironment so
    activity.heartbeat() calls don't raise 'Not in activity context'.
    """
    env = ActivityEnvironment()

    @activity.defn(name="_test_wrapper")
    async def _wrapper() -> dict:
        return await coro_factory()

    return asyncio.run(env.run(_wrapper))


def _write_onboard(tmp_path: Path, data: dict) -> str:
    path = tmp_path / "onboard.json"
    path.write_text(json.dumps(data))
    return str(path)


def _sample_onboard() -> dict:
    return {
        "profile": {
            "summary": {
                "inner_circle": ["eszter@example.com", "stan@firstbase.io"],
                "communication_style": "selective",
                "work_hours": "9am-6pm CET",
                "top_subscriptions": ["stripe.com", "polar.sh"],
                "key_patterns": ["deep work blocks 9-12", "evenings with family"],
            },
        },
        "facts": [
            {"category": "professional", "fact": "Runs Ugly Code LLC", "confidence": "high"},
            {"category": "professional", "fact": "Building Alfred Black", "confidence": "high"},
            {"category": "personal", "fact": "Partner is Eszter", "confidence": "high"},
            {"category": "personal", "fact": "Daughter Hanna, 6 months old", "confidence": "high"},
            {"category": "financial", "fact": "Monthly Stripe revenue ~$4k", "confidence": "medium"},
        ],
        "patterns": [
            {"name": "tuesday-stripe-reviews", "description": "Reviews Stripe stats every Tuesday"},
            {"name": "friday-weekly-brief", "description": "Writes a weekly brief each Friday"},
        ],
        "key_identity_facts": [
            {"field": "name", "display": "Full name", "value": "David Szabo-Stuban"},
            {"field": "location", "display": "Location", "value": "Törökbálint, Hungary"},
        ],
        "brief": "Welcome — I'll watch your Stripe billing each Tuesday and remind you about Hanna's nursery pickups.",
    }


_OPUS_GOOD_RESPONSE = json.dumps({
    "matters": [
        {
            "name": "Alfred Black product vision",
            "category": "work",
            "status": "active",
            "description": "Core product direction for the Alfred Black personal-agent platform.",
            "context": (
                "Alfred Black is David's main project — a personal AI butler platform "
                "he's building through Ugly Code LLC. Active tenants include david@ "
                "(dogfood) and early adopters. The product is still pre-launch; the "
                "current push is around the generated chore system and the Intelligence "
                "dashboard rework."
            ),
            "key_people": ["Stan (advisor)", "Eszter (partner)"],
            "related_patterns": ["tuesday-stripe-reviews"],
            "open_questions": [
                "When is the first real external user going to be onboarded?",
                "Should the chore generator fall back to rule-based templates at all?",
                "What's the right default for ALFRED_CHORE_MAX_GENERATED?",
            ],
            "suggested_next_actions": [
                "Finish the Chores tab UI so users can see what their chores do",
                "Run a real generated-chore end-to-end on david",
            ],
        },
        {
            "name": "Hanna nursery logistics",
            "category": "logistics",
            "status": "active",
            "description": "Ongoing daily logistics around daughter Hanna's nursery and care.",
            "context": (
                "David and Eszter coordinate daily care for Hanna (6 months old). "
                "Nursery pickups and morning dropoffs are a recurring coordination "
                "point that appears in their email and calendar."
            ),
            "key_people": ["Eszter"],
            "related_patterns": [],
            "open_questions": [
                "Who does pickup on Fridays?",
                "What's the nursery's emergency contact protocol?",
            ],
            "suggested_next_actions": [
                "Create a weekly logistics digest on Sundays",
            ],
        },
    ],
})


# ---------------------------------------------------------------------------
# Unit tests: helpers
# ---------------------------------------------------------------------------

class TestHelpers:
    def test_escape_yaml_scalar_basic(self):
        assert _escape_yaml_scalar("hello") == "'hello'"

    def test_escape_yaml_scalar_embedded_quote(self):
        assert _escape_yaml_scalar("it's") == "'it''s'"

    def test_format_yaml_list_plain(self):
        assert _format_yaml_list(["a", "b", "c"]) == "[a, b, c]"

    def test_format_yaml_list_quotes_structural(self):
        result = _format_yaml_list(["simple", "has, comma", "has:colon"])
        assert "simple" in result
        assert "'has, comma'" in result
        assert "'has:colon'" in result

    def test_format_yaml_list_empty(self):
        assert _format_yaml_list([]) == "[]"

    def test_trim_under_limit(self):
        assert _trim("short", 20) == "short"

    def test_trim_over_limit(self):
        out = _trim("a" * 100, 20)
        assert len(out) == 20
        assert out.endswith("...")

    def test_trim_non_string(self):
        assert _trim(None, 10) == ""  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Unit tests: _validate_matter
# ---------------------------------------------------------------------------

class TestValidateMatter:
    def _good(self):
        return {
            "name": "Test matter",
            "category": "work",
            "status": "active",
            "description": "A real description with enough characters.",
            "context": "Real paragraph here, definitely longer than sixty characters total.",
            "key_people": [],
            "related_patterns": [],
            "open_questions": ["q"],
            "suggested_next_actions": [],
        }

    def test_good_matter_validates(self):
        ok, reason = _validate_matter(self._good())
        assert ok, reason

    def test_non_dict_rejected(self):
        ok, reason = _validate_matter("not a dict")  # type: ignore[arg-type]
        assert not ok
        assert "dict" in reason

    def test_missing_name_rejected(self):
        m = self._good()
        del m["name"]
        ok, _ = _validate_matter(m)
        assert not ok

    def test_empty_name_rejected(self):
        m = self._good()
        m["name"] = "   "
        ok, _ = _validate_matter(m)
        assert not ok

    def test_name_too_long_rejected(self):
        m = self._good()
        m["name"] = "x" * 200
        ok, _ = _validate_matter(m)
        assert not ok

    def test_invalid_category_rejected(self):
        m = self._good()
        m["category"] = "nonsense"
        ok, reason = _validate_matter(m)
        assert not ok
        assert "category" in reason

    def test_empty_category_allowed(self):
        """Empty category should fall through — we default to 'personal'."""
        m = self._good()
        m["category"] = ""
        ok, _ = _validate_matter(m)
        assert ok

    def test_invalid_status_rejected(self):
        m = self._good()
        m["status"] = "wip"
        ok, reason = _validate_matter(m)
        assert not ok
        assert "status" in reason

    def test_short_description_rejected(self):
        m = self._good()
        m["description"] = "tiny"
        ok, reason = _validate_matter(m)
        assert not ok
        assert "description" in reason

    def test_short_context_rejected(self):
        m = self._good()
        m["context"] = "one line"
        ok, reason = _validate_matter(m)
        assert not ok
        assert "context" in reason

    def test_non_list_key_people_rejected(self):
        m = self._good()
        m["key_people"] = "not a list"
        ok, reason = _validate_matter(m)
        assert not ok


# ---------------------------------------------------------------------------
# Unit tests: _build_rich_matter_content
# ---------------------------------------------------------------------------

class TestBuildRichMatterContent:
    def _good(self):
        return {
            "name": "Alfred Black product vision",
            "category": "work",
            "status": "active",
            "description": "Core direction for the agent platform.",
            "context": "Multi-paragraph context. It runs for several sentences " * 3,
            "key_people": ["Stan", "Eszter"],
            "related_patterns": ["tuesday-stripe-reviews"],
            "open_questions": ["Q1?", "Q2?", "Q3?"],
            "suggested_next_actions": ["Do X", "Do Y"],
        }

    def test_frontmatter_contains_required_fields(self):
        content = _build_rich_matter_content(self._good())
        assert content.startswith("---\n")
        assert "type: matter" in content
        assert "status: active" in content
        assert "category: work" in content
        assert "generated: true" in content
        assert "created_by: onboarding_pipeline" in content

    def test_body_sections_present(self):
        content = _build_rich_matter_content(self._good())
        assert "## Context" in content
        assert "## Key people" in content
        assert "## Related patterns" in content
        assert "## Open questions" in content
        assert "## Suggested next actions" in content

    def test_body_lists_rendered(self):
        content = _build_rich_matter_content(self._good())
        assert "- Stan" in content
        assert "- Eszter" in content
        assert "- Q1?" in content
        assert "- Do X" in content

    def test_empty_lists_omit_sections(self):
        m = self._good()
        m["key_people"] = []
        m["related_patterns"] = []
        content = _build_rich_matter_content(m)
        assert "## Key people" not in content
        assert "## Related patterns" not in content
        # But other sections with content still appear
        assert "## Context" in content
        assert "## Open questions" in content

    def test_title_and_description_rendered_at_top(self):
        content = _build_rich_matter_content(self._good())
        # Title after frontmatter
        lines = content.split("\n")
        header_idx = next(i for i, l in enumerate(lines) if l.startswith("# "))
        assert "Alfred Black product vision" in lines[header_idx]
        # Description as blockquote
        assert any("> Core direction" in l for l in lines)


# ---------------------------------------------------------------------------
# Unit tests: _build_matter_prompt
# ---------------------------------------------------------------------------

class TestBuildMatterPrompt:
    def test_prompt_contains_facts(self):
        facts = [{"category": "work", "fact": "Runs Ugly Code LLC"}]
        prompt = _build_matter_prompt(facts, [], [], {}, "")
        assert "Runs Ugly Code LLC" in prompt

    def test_prompt_contains_patterns(self):
        patterns = [{"name": "tuesday-reviews", "description": "weekly check"}]
        prompt = _build_matter_prompt([], patterns, [], {}, "")
        assert "tuesday-reviews" in prompt

    def test_prompt_contains_identity(self):
        identity = [{"field": "name", "display": "Full name", "value": "David"}]
        prompt = _build_matter_prompt([], [], identity, {}, "")
        assert "David" in prompt

    def test_prompt_contains_brief(self):
        prompt = _build_matter_prompt([], [], [], {}, "Welcome — I'll watch Stripe")
        assert "Welcome — I'll watch Stripe" in prompt

    def test_prompt_explains_what_matter_is(self):
        prompt = _build_matter_prompt([], [], [], {}, "")
        assert "domain" in prompt.lower()  # anti-examples section
        assert "matter IS" in prompt or "ongoing" in prompt.lower()

    def test_prompt_includes_output_format(self):
        prompt = _build_matter_prompt([], [], [], {}, "")
        assert '"matters"' in prompt
        assert "context" in prompt
        assert "open_questions" in prompt
        assert "suggested_next_actions" in prompt

    def test_empty_inputs_dont_raise(self):
        prompt = _build_matter_prompt([], [], [], {}, "")
        assert len(prompt) > 500  # still has the structural part


# ---------------------------------------------------------------------------
# Integration tests: generate_matter_pack_opus (mocked LLM + vault client)
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


class TestGenerateMatterPackOpus:
    def test_env_flag_off_falls_back(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ALFRED_OPUS_PACKS_ENABLED", "false")
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fallback_mock = AsyncMock(return_value={"created": 3, "skipped_existing": 0})
        with patch("src.activities.packs.generate_matter_pack", new=fallback_mock):
            result = _run_activity(lambda: generate_matter_pack_opus(onboard))

        assert result["source"] == "rule_based_env_flag"
        assert result["created"] == 3
        fallback_mock.assert_called_once_with(onboard)

    def test_no_context_falls_back(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, {"profile": {}})  # no facts, no patterns

        fallback_mock = AsyncMock(return_value={"created": 2, "skipped_existing": 0})
        with patch("src.activities.packs.generate_matter_pack", new=fallback_mock):
            result = _run_activity(lambda: generate_matter_pack_opus(onboard))

        assert result["source"] == "rule_based_no_context"
        fallback_mock.assert_called_once()

    def test_llm_exception_falls_back(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fallback_mock = AsyncMock(return_value={"created": 1, "skipped_existing": 0})
        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(side_effect=RuntimeError("openrouter 503"))), \
             patch("src.activities.packs.generate_matter_pack", new=fallback_mock):
            result = _run_activity(lambda: generate_matter_pack_opus(onboard))

        assert result["source"] == "rule_based_llm_error"
        assert "503" in result["llm_error"]
        fallback_mock.assert_called_once()

    def test_parse_failure_falls_back(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fallback_mock = AsyncMock(return_value={"created": 1, "skipped_existing": 0})
        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(return_value="I don't know how to respond")), \
             patch("src.activities.packs.generate_matter_pack", new=fallback_mock):
            result = _run_activity(lambda: generate_matter_pack_opus(onboard))

        assert result["source"] == "rule_based_parse_error"
        fallback_mock.assert_called_once()

    def test_happy_path_writes_matters(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fake_client = _FakeVaultClient()

        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(return_value=_OPUS_GOOD_RESPONSE)), \
             patch("src.activities.packs_opus.VaultClient", return_value=fake_client):
            result = _run_activity(lambda: generate_matter_pack_opus(onboard))

        assert result["source"] == "opus", result
        assert result["created"] == 2
        assert len(fake_client.written) == 2
        # Verify the two matters got written with expected slugs
        slugs = [slug for (_, slug, _) in fake_client.written]
        assert "alfred-black-product-vision" in slugs
        assert "hanna-nursery-logistics" in slugs
        # Verify the written content has real sections
        for (_, _, content) in fake_client.written:
            assert "## Context" in content
            assert "generated: true" in content

    def test_happy_path_skips_existing_slugs(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fake_client = _FakeVaultClient()
        fake_client.existing_slugs.add("alfred-black-product-vision")

        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(return_value=_OPUS_GOOD_RESPONSE)), \
             patch("src.activities.packs_opus.VaultClient", return_value=fake_client):
            result = _run_activity(lambda: generate_matter_pack_opus(onboard))

        assert result["source"] == "opus"
        assert result["created"] == 1
        assert result["skipped_existing"] == 1

    def test_all_invalid_falls_back(self, tmp_path, monkeypatch):
        """If every matter returned by Opus fails validation, fall back."""
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        bad_response = json.dumps({
            "matters": [
                {"name": "", "category": "work"},  # empty name
                {"name": "Foo"},  # missing required fields
            ],
        })

        fake_client = _FakeVaultClient()
        fallback_mock = AsyncMock(return_value={"created": 4, "skipped_existing": 0})

        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(return_value=bad_response)), \
             patch("src.activities.packs_opus.VaultClient", return_value=fake_client), \
             patch("src.activities.packs.generate_matter_pack", new=fallback_mock):
            result = _run_activity(lambda: generate_matter_pack_opus(onboard))

        assert result["source"] == "rule_based_no_valid_matters"
        assert result["created"] == 4
        assert fake_client.written == []
        fallback_mock.assert_called_once()

    def test_partial_invalid_keeps_valid(self, tmp_path, monkeypatch):
        """Mixed response: some valid, some invalid → keep valid, skip invalid."""
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        mixed_response = json.dumps({
            "matters": [
                json.loads(_OPUS_GOOD_RESPONSE)["matters"][0],  # valid
                {"name": "Junk", "category": "work"},  # invalid
                json.loads(_OPUS_GOOD_RESPONSE)["matters"][1],  # valid
            ],
        })

        fake_client = _FakeVaultClient()

        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(return_value=mixed_response)), \
             patch("src.activities.packs_opus.VaultClient", return_value=fake_client):
            result = _run_activity(lambda: generate_matter_pack_opus(onboard))

        assert result["source"] == "opus"
        assert result["created"] == 2
        assert result["skipped_invalid"] == 1
