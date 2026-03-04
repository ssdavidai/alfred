"""Tests for validators."""

import pytest

from src.validators.frontmatter import parse_frontmatter, validate_frontmatter
from src.validators.observation import validate_observation_record
from src.validators.instinct import validate_instinct_record, validate_instinct_proposal
from src.validators.schema import ValidationResult


# --- Frontmatter ---

class TestParseFrontmatter:
    def test_valid_frontmatter(self):
        content = "---\ntype: task\nname: Test\n---\n\nBody here"
        fm, body = parse_frontmatter(content)
        assert fm["type"] == "task"
        assert fm["name"] == "Test"
        assert body == "Body here"

    def test_no_frontmatter(self):
        content = "Just some text"
        fm, body = parse_frontmatter(content)
        assert fm == {}
        assert body == "Just some text"

    def test_empty_frontmatter(self):
        content = "---\n---\n\nBody"
        fm, body = parse_frontmatter(content)
        assert fm == {}

    def test_complex_frontmatter(self):
        content = "---\ntype: observation\nname: Test\ntags: [a, b, c]\n---\n\nBody"
        fm, body = parse_frontmatter(content)
        assert fm["type"] == "observation"
        assert fm["tags"] == ["a", "b", "c"]


class TestValidateFrontmatter:
    def test_valid(self):
        content = "---\ntype: task\nname: Test Task\n---\n\nBody"
        result = validate_frontmatter(content)
        assert result.valid
        assert result.errors == []

    def test_missing_delimiters(self):
        result = validate_frontmatter("No frontmatter")
        assert not result.valid
        assert "Missing frontmatter delimiters" in result.errors[0]

    def test_missing_type(self):
        content = "---\nname: Test\n---\n"
        result = validate_frontmatter(content)
        assert not result.valid
        assert any("type" in e for e in result.errors)

    def test_invalid_type(self):
        content = "---\ntype: invalid_type\nname: Test\n---\n"
        result = validate_frontmatter(content)
        assert not result.valid
        assert any("Invalid type" in e for e in result.errors)

    def test_missing_name(self):
        content = "---\ntype: task\n---\n"
        result = validate_frontmatter(content)
        assert not result.valid
        assert any("name" in e for e in result.errors)

    def test_observation_type_valid(self):
        content = "---\ntype: observation\nname: Test Obs\n---\n"
        result = validate_frontmatter(content)
        assert result.valid

    def test_instinct_type_valid(self):
        content = "---\ntype: instinct\nname: Test Instinct\n---\n"
        result = validate_frontmatter(content)
        assert result.valid


# --- Observation Validator ---

class TestValidateObservation:
    def _valid_observation(self):
        return {
            "input_type": "email",
            "input_source": "gmail",
            "input_ref": "stream-event-abc123",
            "routing_decision": "project/client-x",
            "reasoning": "Email from client X about onboarding",
            "signals": {
                "domain_patterns": ["clientx.com"],
                "keyword_patterns": ["onboarding"],
                "input_types": ["email"],
                "attachment_patterns": [],
            },
            "confidence": "human",
            "routed_by": "user",
        }

    def test_valid_observation(self):
        result = validate_observation_record(self._valid_observation())
        assert result.valid

    def test_missing_input_type(self):
        obs = self._valid_observation()
        del obs["input_type"]
        result = validate_observation_record(obs)
        assert not result.valid
        assert any("input_type" in e for e in result.errors)

    def test_missing_routing_decision(self):
        obs = self._valid_observation()
        del obs["routing_decision"]
        result = validate_observation_record(obs)
        assert not result.valid

    def test_missing_reasoning(self):
        obs = self._valid_observation()
        del obs["reasoning"]
        result = validate_observation_record(obs)
        assert not result.valid

    def test_invalid_confidence(self):
        obs = self._valid_observation()
        obs["confidence"] = "very_sure"
        result = validate_observation_record(obs)
        assert not result.valid
        assert any("confidence" in e for e in result.errors)

    def test_invalid_routed_by(self):
        obs = self._valid_observation()
        obs["routed_by"] = "nobody"
        result = validate_observation_record(obs)
        assert not result.valid

    def test_missing_signal_key(self):
        obs = self._valid_observation()
        del obs["signals"]["domain_patterns"]
        result = validate_observation_record(obs)
        assert not result.valid
        assert any("domain_patterns" in e for e in result.errors)

    def test_signal_not_list(self):
        obs = self._valid_observation()
        obs["signals"]["keyword_patterns"] = "not a list"
        result = validate_observation_record(obs)
        assert not result.valid

    def test_missing_signals_entirely(self):
        obs = self._valid_observation()
        del obs["signals"]
        result = validate_observation_record(obs)
        assert not result.valid


# --- Instinct Validator ---

class TestValidateInstinct:
    def _valid_instinct(self):
        return {
            "name": "Client Invoice Processing",
            "status": "active",
            "domain": "finance",
            "observation_count": 12,
            "discretion_threshold": 0.85,
            "signals": {
                "domain_patterns": ["*@clientx.com"],
                "keyword_patterns": ["invoice", "payment"],
                "input_types": ["email"],
                "attachment_patterns": ["*.pdf"],
            },
            "matching_weights": {
                "domain": 0.30,
                "keywords": 0.30,
                "input_type": 0.15,
                "attachment": 0.15,
                "tags": 0.10,
            },
            "routing_destination": "process/invoice-processing",
        }

    def test_valid_instinct(self):
        result = validate_instinct_record(self._valid_instinct())
        assert result.valid

    def test_missing_name(self):
        inst = self._valid_instinct()
        del inst["name"]
        result = validate_instinct_record(inst)
        assert not result.valid

    def test_invalid_status(self):
        inst = self._valid_instinct()
        inst["status"] = "deleted"
        result = validate_instinct_record(inst)
        assert not result.valid

    def test_missing_domain(self):
        inst = self._valid_instinct()
        del inst["domain"]
        result = validate_instinct_record(inst)
        assert not result.valid

    def test_negative_observation_count(self):
        inst = self._valid_instinct()
        inst["observation_count"] = -1
        result = validate_instinct_record(inst)
        assert not result.valid

    def test_threshold_out_of_range(self):
        inst = self._valid_instinct()
        inst["discretion_threshold"] = 1.5
        result = validate_instinct_record(inst)
        assert not result.valid

    def test_weights_dont_sum_to_one(self):
        inst = self._valid_instinct()
        inst["matching_weights"] = {"domain": 0.5, "keywords": 0.5, "input_type": 0.5, "attachment": 0.5, "tags": 0.5}
        result = validate_instinct_record(inst)
        assert not result.valid
        assert any("sum to 1.0" in e for e in result.errors)

    def test_missing_routing_destination(self):
        inst = self._valid_instinct()
        del inst["routing_destination"]
        result = validate_instinct_record(inst)
        assert not result.valid


class TestValidateInstinctProposal:
    def test_invalid_action(self):
        result = validate_instinct_proposal({"action": "destroy"})
        assert not result.valid

    def test_valid_deprecate(self):
        result = validate_instinct_proposal({
            "action": "deprecate",
            "path": "intuition/instincts/old-one",
            "reason": "No longer relevant",
        })
        assert result.valid

    def test_deprecate_missing_reason(self):
        result = validate_instinct_proposal({
            "action": "deprecate",
            "path": "intuition/instincts/old-one",
        })
        assert not result.valid

    def test_update_missing_path(self):
        result = validate_instinct_proposal({
            "action": "update",
            "changes": {"observation_count": 5},
        })
        assert not result.valid
