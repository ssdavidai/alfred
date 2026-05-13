"""Shared schema definitions for validation."""

from __future__ import annotations

from dataclasses import dataclass, field

# Valid vault record types produced by classification
VALID_CLASSIFICATION_TYPES = frozenset({
    "triage", "task", "event", "note", "conversation", "braindump", "noise",
})

# Valid vault record types overall
VALID_VAULT_TYPES = frozenset({
    "triage", "task", "skill", "event", "note", "conversation", "braindump",
    "session", "person", "org", "place",
    "observation", "instinct", "reflection", "index",
    "input", "matter", "ledger_entry",
    "chore",
})

# Valid observation statuses
VALID_OBSERVATION_STATUSES = frozenset({"unprocessed", "processed", "invalid"})

# Valid instinct statuses
VALID_INSTINCT_STATUSES = frozenset({"active", "proposed", "deprecated", "merged"})

# Valid pattern_proposal statuses (OBS-3..OBS-5 lifecycle).
# Must stay in sync with ctrl-api STATUS_BY_TYPE.pattern_proposal in
# packages/ctrl/src/api/routes/vault.ts.
VALID_PATTERN_PROPOSAL_STATUSES = frozenset({
    "proposed", "adopted", "rejected", "deferred", "superseded",
})

# Minimum number of observation_refs required to write a new pattern
# proposal. Mirrors the "instincts require 3 observations" rule in
# validate_instinct_proposal — three points of evidence is the
# smallest pattern that can survive a single coincidence.
MIN_PATTERN_PROPOSAL_EVIDENCE = 3

# Valid routing destination types (for instinct routing_rule)
VALID_ROUTING_DESTINATION_TYPES = frozenset({"project", "person", "process", "hold"})

# Valid confidence values
VALID_CONFIDENCE_VALUES = frozenset({"human", "machine", "mixed"})

# Valid routed_by values
VALID_ROUTED_BY_VALUES = frozenset({"user", "alfred", "system"})

# Valid observation source values (provenance)
# F.2: chore_run + system added so the LearningWorkflow can seed observations
# from chore-run-history.jsonl and other internal signals.
VALID_OBSERVATION_SOURCES = frozenset({"chat", "alfred_instructions", "dashboard", "manual", "media", "braindump", "chore_run", "system"})

# Required signal keys
SIGNAL_KEYS = frozenset({"domain_patterns", "keyword_patterns", "input_types", "attachment_patterns"})

# Default matching weights
DEFAULT_MATCHING_WEIGHTS = {
    "domain": 0.30,
    "keywords": 0.30,
    "input_type": 0.15,
    "attachment": 0.15,
    "tags": 0.10,
}


@dataclass
class ValidationResult:
    valid: bool
    errors: list[str] = field(default_factory=list)

    def add_error(self, msg: str) -> None:
        self.errors.append(msg)
        self.valid = False
