"""Tests for generate_instinct_pack_opus (Plan B.3)."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities import packs_opus
from src.activities.packs_opus import (
    _build_instinct_prompt,
    _build_rich_instinct_content,
    _validate_instinct,
    generate_instinct_pack_opus,
)


def _run_activity(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_test_wrapper_i")
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
            {"category": "professional", "fact": "Inner circle: Stan, Eszter, Rapali"},
            {"category": "personal", "fact": "Has newborn Hanna"},
        ],
        "patterns": [
            {"name": "stripe-failure-sensitivity",
             "description": "Failed Stripe payments cause real downstream pain"},
            {"name": "newsletter-batch-reads",
             "description": "Reads newsletters in evening batches, never during work hours"},
            {"name": "inner-circle-priority",
             "description": "Replies to inner circle within 1 hour"},
        ],
        "key_identity_facts": [
            {"field": "name", "display": "Full name", "value": "David"},
        ],
        "matters_brief": [{"name": "Stan collaboration"}],
    }


_OPUS_GOOD_INSTINCT_RESPONSE = json.dumps({
    "instincts": [
        {
            "name": "route-stripe-failures-urgent",
            "description": "Surface Stripe payment failures and declined charges immediately as urgent triage.",
            "status": "active",
            "trigger_summary": "An email arrives from stripe.com mentioning 'failed', 'declined', or 'past_due'.",
            "action_summary": "Promote to urgent triage, notify the user immediately.",
            "rationale": (
                "David is in active cash flow management mode — multiple recent emails show "
                "Stripe is the primary revenue source and failed charges have caused real "
                "downstream pain (cards declined, debt collection notices). The pattern "
                "stripe-failure-sensitivity captures this exactly. Speed matters more than "
                "discretion here: a missed failure notification has hours-long blast radius."
            ),
            "examples": [
                "stripe.com: Payment failed for invoice INV-2024-038 — David rebooked it within 30 min last time",
                "stripe.com: Charge declined on subscription #abc123 — caused 2-day outage of paid feature for Design Partner",
            ],
            "input_patterns": {
                "sender_domains": ["stripe.com"],
                "subject_keywords": ["failed", "declined", "past_due", "unpaid"],
                "input_types": ["email"],
            },
            "routing_rule": {
                "destination_type": "triage",
                "destination": "urgent triage queue",
                "process": "urgent-triage",
            },
            "discretion_threshold": 0.92,
            "confidence_score": 0.95,
        },
        {
            "name": "batch-newsletters-evening",
            "description": "Send newsletter senders straight to evening digest, never to inbox during work hours.",
            "status": "active",
            "trigger_summary": "Email arrives from a known newsletter sender domain.",
            "action_summary": "Route to evening digest log, surface as a digest at 7pm CET.",
            "rationale": (
                "Pattern newsletter-batch-reads shows David reads newsletters in the evening "
                "and never during 9-6 CET work hours. Letting them interrupt work blocks is "
                "actively harmful to flow. A daily digest batch matches the actual behavior."
            ),
            "examples": [
                "lumberjack.so weekly digest goes straight to evening batch",
                "stratechery.com posts batched, not surfaced live",
            ],
            "input_patterns": {
                "sender_domains": ["lumberjack.so", "stratechery.com", "every.to"],
                "subject_keywords": [],
                "input_types": ["email"],
            },
            "routing_rule": {
                "destination_type": "digest",
                "destination": "evening newsletter digest",
                "process": "daily-digest",
            },
            "discretion_threshold": 0.85,
            "confidence_score": 0.9,
        },
    ],
})


# ---------------------------------------------------------------------------
# _validate_instinct
# ---------------------------------------------------------------------------

class TestValidateInstinct:
    def _good(self):
        return {
            "name": "test-instinct",
            "description": "A real description.",
            "status": "active",
            "rationale": "A rationale paragraph that has at least sixty characters of real content here.",
            "examples": ["example one"],
            "input_patterns": {"sender_domains": [], "subject_keywords": []},
            "routing_rule": {"destination_type": "triage", "destination": "x", "process": "y"},
            "discretion_threshold": 0.85,
        }

    def test_good_validates(self):
        ok, _ = _validate_instinct(self._good())
        assert ok

    def test_non_dict_rejected(self):
        ok, _ = _validate_instinct("not a dict")  # type: ignore[arg-type]
        assert not ok

    def test_missing_name_rejected(self):
        m = self._good()
        del m["name"]
        ok, _ = _validate_instinct(m)
        assert not ok

    def test_invalid_status_rejected(self):
        m = self._good()
        m["status"] = "wip"
        ok, _ = _validate_instinct(m)
        assert not ok

    def test_short_description_rejected(self):
        m = self._good()
        m["description"] = "x"
        ok, _ = _validate_instinct(m)
        assert not ok

    def test_short_rationale_rejected(self):
        m = self._good()
        m["rationale"] = "tiny"
        ok, _ = _validate_instinct(m)
        assert not ok

    def test_no_examples_rejected(self):
        m = self._good()
        m["examples"] = []
        ok, _ = _validate_instinct(m)
        assert not ok

    def test_examples_not_list_rejected(self):
        m = self._good()
        m["examples"] = "not a list"
        ok, _ = _validate_instinct(m)
        assert not ok

    def test_invalid_routing_destination_rejected(self):
        m = self._good()
        m["routing_rule"]["destination_type"] = "moonbase"
        ok, _ = _validate_instinct(m)
        assert not ok

    def test_threshold_out_of_range_rejected(self):
        m = self._good()
        m["discretion_threshold"] = 2.0
        ok, _ = _validate_instinct(m)
        assert not ok

    def test_threshold_optional(self):
        m = self._good()
        del m["discretion_threshold"]
        ok, _ = _validate_instinct(m)
        assert ok

    def test_input_patterns_not_dict_rejected(self):
        m = self._good()
        m["input_patterns"] = "not a dict"
        ok, _ = _validate_instinct(m)
        assert not ok


# ---------------------------------------------------------------------------
# _build_rich_instinct_content
# ---------------------------------------------------------------------------

class TestBuildRichInstinctContent:
    def _good(self):
        return {
            "name": "route-inner-circle",
            "description": "Surface inner circle messages immediately.",
            "status": "active",
            "trigger_summary": "Email from inner circle",
            "action_summary": "Promote to triage with high priority",
            "rationale": "Inner circle has direct latency impact on the user's relationships.",
            "examples": ["Eszter: any email", "Stan: contract revisions"],
            "input_patterns": {"sender_domains": ["example.com"], "subject_keywords": []},
            "routing_rule": {"destination_type": "triage", "destination": "priority", "process": "urgent-triage"},
            "discretion_threshold": 0.9,
            "confidence_score": 0.95,
        }

    def test_frontmatter_fields(self):
        content = _build_rich_instinct_content(self._good())
        assert "type: instinct" in content
        assert "status: active" in content
        assert "discretion_threshold: 0.9" in content
        assert "generated: true" in content

    def test_input_patterns_serialized_as_json_scalar(self):
        content = _build_rich_instinct_content(self._good())
        assert "input_patterns:" in content
        # The JSON-encoded patterns should be inside single quotes (flat scalar)
        assert "example.com" in content

    def test_routing_rule_serialized_as_json_scalar(self):
        content = _build_rich_instinct_content(self._good())
        assert "routing_rule:" in content
        assert "urgent-triage" in content

    def test_rationale_in_body(self):
        content = _build_rich_instinct_content(self._good())
        assert "## Rationale" in content
        assert "Inner circle has direct latency" in content

    def test_examples_in_body(self):
        content = _build_rich_instinct_content(self._good())
        assert "## Examples" in content
        assert "- Eszter" in content
        assert "- Stan" in content

    def test_routing_summary_in_body(self):
        content = _build_rich_instinct_content(self._good())
        assert "## Routing" in content
        assert "**Destination type:**" in content
        assert "triage" in content

    def test_trigger_action_section_present(self):
        content = _build_rich_instinct_content(self._good())
        assert "## Trigger and action" in content
        assert "**When:**" in content
        assert "**Then:**" in content


# ---------------------------------------------------------------------------
# _build_instinct_prompt
# ---------------------------------------------------------------------------

class TestBuildInstinctPrompt:
    def test_prompt_explains_what_instinct_is(self):
        prompt = _build_instinct_prompt([], [], [], {}, [])
        assert "instinct IS" in prompt or "instinct is" in prompt.lower()
        assert "rules-of-thumb" in prompt.lower() or "rule" in prompt.lower()

    def test_prompt_includes_patterns(self):
        patterns = [{"name": "tuesday-reviews", "description": "weekly check"}]
        prompt = _build_instinct_prompt([], patterns, [], {}, [])
        assert "tuesday-reviews" in prompt
        assert "weekly check" in prompt

    def test_prompt_includes_facts(self):
        facts = [{"category": "personal", "fact": "Has newborn"}]
        prompt = _build_instinct_prompt(facts, [], [], {}, [])
        assert "Has newborn" in prompt

    def test_prompt_output_schema(self):
        prompt = _build_instinct_prompt([], [], [], {}, [])
        assert '"instincts"' in prompt
        assert "rationale" in prompt
        assert "discretion_threshold" in prompt
        assert "input_patterns" in prompt
        assert "routing_rule" in prompt


# ---------------------------------------------------------------------------
# Integration: generate_instinct_pack_opus
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


class TestGenerateInstinctPackOpus:
    def test_env_flag_falls_back(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ALFRED_OPUS_PACKS_ENABLED", "false")
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fallback = AsyncMock(return_value={"created": 4})
        with patch("src.activities.packs.generate_instinct_pack", new=fallback):
            result = _run_activity(lambda: generate_instinct_pack_opus(onboard))

        assert result["source"] == "rule_based_env_flag"
        assert result["created"] == 4

    def test_no_context_falls_back(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, {"profile": {}})

        fallback = AsyncMock(return_value={"created": 2})
        with patch("src.activities.packs.generate_instinct_pack", new=fallback):
            result = _run_activity(lambda: generate_instinct_pack_opus(onboard))
        assert result["source"] == "rule_based_no_context"

    def test_llm_error_falls_back(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fallback = AsyncMock(return_value={"created": 1})
        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(side_effect=RuntimeError("OOM"))), \
             patch("src.activities.packs.generate_instinct_pack", new=fallback):
            result = _run_activity(lambda: generate_instinct_pack_opus(onboard))
        assert result["source"] == "rule_based_llm_error"

    def test_parse_failure_falls_back(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fallback = AsyncMock(return_value={"created": 0})
        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(return_value="not json")), \
             patch("src.activities.packs.generate_instinct_pack", new=fallback):
            result = _run_activity(lambda: generate_instinct_pack_opus(onboard))
        assert result["source"] == "rule_based_parse_error"

    def test_happy_path_writes_instincts(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fake_client = _FakeVaultClient()

        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(return_value=_OPUS_GOOD_INSTINCT_RESPONSE)), \
             patch("src.activities.packs_opus.VaultClient", return_value=fake_client):
            result = _run_activity(lambda: generate_instinct_pack_opus(onboard))

        assert result["source"] == "opus"
        assert result["created"] == 2
        assert len(fake_client.written) == 2
        for (record_type, _, content) in fake_client.written:
            assert record_type == "instinct"
            assert "## Rationale" in content
            assert "## Examples" in content
            assert "type: instinct" in content

    def test_skips_existing(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        fake_client = _FakeVaultClient()
        fake_client.existing_slugs.add("route-stripe-failures-urgent")

        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(return_value=_OPUS_GOOD_INSTINCT_RESPONSE)), \
             patch("src.activities.packs_opus.VaultClient", return_value=fake_client):
            result = _run_activity(lambda: generate_instinct_pack_opus(onboard))

        assert result["created"] == 1
        assert result["skipped_existing"] == 1

    def test_all_invalid_falls_back(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
        onboard = _write_onboard(tmp_path, _sample_onboard())

        bad = json.dumps({"instincts": [{"name": ""}, {"name": "X"}]})
        fake_client = _FakeVaultClient()
        fallback = AsyncMock(return_value={"created": 5})

        with patch("src.activities.packs_opus._call_llm",
                   new=AsyncMock(return_value=bad)), \
             patch("src.activities.packs_opus.VaultClient", return_value=fake_client), \
             patch("src.activities.packs.generate_instinct_pack", new=fallback):
            result = _run_activity(lambda: generate_instinct_pack_opus(onboard))

        assert result["source"] == "rule_based_no_valid_instincts"
        assert fake_client.written == []
