"""Tests for the instinct scorer."""

import pytest

from src.matching.scorer import (
    score_instinct,
    score_all_instincts,
    _score_patterns,
    _score_keyword_overlap,
    _score_type_match,
)


class TestScorePatterns:
    def test_exact_match(self):
        assert _score_patterns(["clientx.com"], ["clientx.com"]) == 1.0

    def test_glob_match(self):
        assert _score_patterns(["invoice.pdf"], ["*.pdf"]) == 1.0

    def test_no_match(self):
        assert _score_patterns(["photo.jpg"], ["*.pdf"]) == 0.0

    def test_partial_match(self):
        score = _score_patterns(["a.pdf", "b.jpg"], ["*.pdf"])
        assert score == 0.5

    def test_empty_patterns(self):
        assert _score_patterns(["anything"], []) == 0.0

    def test_empty_inputs(self):
        assert _score_patterns([], ["*.pdf"]) == 0.0

    def test_case_insensitive(self):
        assert _score_patterns(["INVOICE.PDF"], ["*.pdf"]) == 1.0

    def test_wildcard_domain(self):
        assert _score_patterns(["user@clientx.com"], ["*@clientx.com"]) == 1.0


class TestKeywordOverlap:
    def test_full_overlap(self):
        assert _score_keyword_overlap(["invoice", "payment"], ["invoice", "payment"]) == 1.0

    def test_partial_overlap(self):
        score = _score_keyword_overlap(["invoice", "other"], ["invoice", "payment"])
        assert score == 0.5

    def test_no_overlap(self):
        assert _score_keyword_overlap(["hello"], ["invoice", "payment"]) == 0.0

    def test_empty_patterns(self):
        assert _score_keyword_overlap(["invoice"], []) == 0.0

    def test_case_insensitive(self):
        assert _score_keyword_overlap(["Invoice"], ["invoice"]) == 1.0


class TestTypeMatch:
    def test_match(self):
        assert _score_type_match("email", ["email", "webhook"]) == 1.0

    def test_no_match(self):
        assert _score_type_match("voice", ["email", "webhook"]) == 0.0

    def test_empty(self):
        assert _score_type_match("email", []) == 0.0

    def test_case_insensitive(self):
        assert _score_type_match("Email", ["email"]) == 1.0


class TestScoreInstinct:
    def _instinct(self):
        return {
            "name": "Invoice Processing",
            "signals": {
                "domain_patterns": ["*@vendor.com"],
                "keyword_patterns": ["invoice", "payment", "due date"],
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
        }

    def test_perfect_match(self):
        metadata = {
            "domains": ["billing@vendor.com"],
            "keywords": ["invoice", "payment", "due date"],
            "input_type": "email",
            "attachment_patterns": ["contract.pdf"],
            "tags": ["invoice"],
        }
        result = score_instinct(metadata, self._instinct())
        assert result.score > 0.8

    def test_no_match(self):
        metadata = {
            "domains": ["friend@example.com"],
            "keywords": ["birthday", "party"],
            "input_type": "message",
            "attachment_patterns": ["photo.jpg"],
            "tags": ["social"],
        }
        result = score_instinct(metadata, self._instinct())
        assert result.score < 0.2

    def test_partial_match(self):
        metadata = {
            "domains": [],
            "keywords": ["invoice"],
            "input_type": "email",
            "attachment_patterns": [],
            "tags": [],
        }
        result = score_instinct(metadata, self._instinct())
        assert 0.15 < result.score < 0.6

    def test_breakdown_has_all_keys(self):
        metadata = {
            "domains": [],
            "keywords": [],
            "input_type": "",
            "attachment_patterns": [],
            "tags": [],
        }
        result = score_instinct(metadata, self._instinct())
        assert set(result.breakdown.keys()) == {"domain", "keywords", "input_type", "attachment", "tags"}


class TestScoreAllInstincts:
    def test_sorted_by_score_desc(self):
        good_instinct = {
            "name": "Good Match",
            "signals": {
                "domain_patterns": [],
                "keyword_patterns": ["invoice"],
                "input_types": ["email"],
                "attachment_patterns": [],
            },
            "matching_weights": {
                "domain": 0.30, "keywords": 0.30,
                "input_type": 0.15, "attachment": 0.15, "tags": 0.10,
            },
        }
        bad_instinct = {
            "name": "Bad Match",
            "signals": {
                "domain_patterns": [],
                "keyword_patterns": ["unrelated"],
                "input_types": ["voice"],
                "attachment_patterns": [],
            },
            "matching_weights": {
                "domain": 0.30, "keywords": 0.30,
                "input_type": 0.15, "attachment": 0.15, "tags": 0.10,
            },
        }
        metadata = {
            "domains": [],
            "keywords": ["invoice"],
            "input_type": "email",
            "attachment_patterns": [],
            "tags": [],
        }
        results = score_all_instincts(metadata, [bad_instinct, good_instinct])
        assert results[0].instinct["name"] == "Good Match"
        assert results[0].score > results[1].score
