"""
DSL Parser - Parse YAML rules into executable RiskRules.

Converts declarative YAML rules into Python callable predicates.
"""

import re
import yaml
from dataclasses import dataclass
from fnmatch import fnmatch
from pathlib import Path
from typing import Any, Callable, Optional
import logging

from ..proposal import OperationProposal
from ..risk import RiskRule, RiskLevel


logger = logging.getLogger(__name__)


class DSLError(Exception):
    """Raised when DSL parsing fails."""
    pass


@dataclass
class DSLRule:
    """Intermediate representation of a DSL rule before conversion."""
    id: str
    description: str
    priority: int
    when: dict
    then: dict
    enabled: bool = True


class DSLParser:
    """Parse YAML DSL rules into executable RiskRules.

    The DSL supports:
    - operation_type matching
    - target path matching (glob patterns, contains, regex)
    - metadata field matching (regex, allowlists)
    - Priority-based rule ordering

    Example:
        >>> parser = DSLParser()
        >>> rules = parser.parse_file(Path("rules.yaml"))
        >>> engine = RiskEngine(rules)
    """

    def __init__(self, allowlists: Optional[dict[str, list[str]]] = None):
        """Initialize the parser.

        Args:
            allowlists: Pre-defined allowlists for rule conditions
        """
        self._allowlists = allowlists or {}
        self._metadata: dict[str, Any] = {}

    @property
    def metadata(self) -> dict[str, Any]:
        """Get the metadata from the last parsed file."""
        return self._metadata

    @property
    def allowlists(self) -> dict[str, list[str]]:
        """Get the allowlists from the last parsed file."""
        return self._allowlists

    def parse_file(self, path: Path) -> list[RiskRule]:
        """Parse a YAML rules file.

        Args:
            path: Path to the YAML file

        Returns:
            List of RiskRule instances

        Raises:
            DSLError: If parsing fails
        """
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
        except yaml.YAMLError as e:
            raise DSLError(f"Invalid YAML in {path}: {e}")
        except OSError as e:
            raise DSLError(f"Cannot read {path}: {e}")

        return self.parse(data)

    def parse(self, data: dict) -> list[RiskRule]:
        """Parse a rules dictionary.

        Args:
            data: Dictionary with 'metadata', 'rules', and optionally 'allowlists'

        Returns:
            List of RiskRule instances

        Raises:
            DSLError: If parsing fails
        """
        if not isinstance(data, dict):
            raise DSLError("Rules file must be a dictionary")

        # Extract metadata
        self._metadata = data.get("metadata", {})

        # Extract allowlists
        if "allowlists" in data:
            self._allowlists = data["allowlists"]

        # Parse rules
        rules_data = data.get("rules", [])
        if not isinstance(rules_data, list):
            raise DSLError("'rules' must be a list")

        rules = []
        for i, rule_data in enumerate(rules_data):
            try:
                dsl_rule = self._parse_rule(rule_data)
                risk_rule = self._convert_rule(dsl_rule)
                rules.append(risk_rule)
            except Exception as e:
                raise DSLError(f"Error parsing rule {i}: {e}")

        logger.info(f"Parsed {len(rules)} rules from DSL")
        return rules

    def _parse_rule(self, data: dict) -> DSLRule:
        """Parse a single rule dictionary."""
        if "id" not in data:
            raise DSLError("Rule missing 'id' field")
        if "when" not in data:
            raise DSLError(f"Rule '{data.get('id')}' missing 'when' field")
        if "then" not in data:
            raise DSLError(f"Rule '{data.get('id')}' missing 'then' field")

        return DSLRule(
            id=data["id"],
            description=data.get("description", ""),
            priority=data.get("priority", 0),
            when=data["when"],
            then=data["then"],
            enabled=data.get("enabled", True),
        )

    def _convert_rule(self, dsl: DSLRule) -> RiskRule:
        """Convert a DSL rule to an executable RiskRule."""
        predicate = self._build_predicate(dsl.when)

        # Parse risk level
        risk_str = dsl.then.get("risk", "L3")
        level_map = {
            "L1": RiskLevel.L1,
            "L2": RiskLevel.L2,
            "L3": RiskLevel.L3,
        }
        if risk_str not in level_map:
            raise DSLError(f"Invalid risk level: {risk_str}")

        return RiskRule(
            id=dsl.id,
            predicate=predicate,
            level=level_map[risk_str],
            rationale=dsl.then.get("rationale", ""),
            priority=dsl.priority,
            enabled=dsl.enabled,
        )

    def _build_predicate(self, when: dict) -> Callable[[OperationProposal], bool]:
        """Build a predicate function from when conditions.

        All conditions must match (AND logic).
        """
        conditions = []

        for key, value in when.items():
            condition = self._build_condition(key, value)
            conditions.append(condition)

        def predicate(proposal: OperationProposal) -> bool:
            return all(cond(proposal) for cond in conditions)

        return predicate

    def _build_condition(
        self, key: str, value: Any
    ) -> Callable[[OperationProposal], bool]:
        """Build a single condition checker.

        Supports:
        - operation_type: exact match
        - target: path matching (matches_any, contains, matches_regex)
        - metadata.X: metadata field matching
        - agent_id: agent ID matching
        """
        if key == "operation_type":
            if isinstance(value, list):
                return lambda p: p.operation_type in value
            return lambda p: p.operation_type == value

        if key == "agent_id":
            if isinstance(value, list):
                return lambda p: p.agent_id in value
            return lambda p: p.agent_id == value

        if key == "target":
            return self._build_target_condition(value)

        if key.startswith("metadata."):
            meta_key = key[9:]  # Strip "metadata."
            return self._build_metadata_condition(meta_key, value)

        # Unknown condition - fail safe (always false)
        logger.warning(f"Unknown condition key: {key}")
        return lambda p: False

    def _build_target_condition(
        self, value: Any
    ) -> Callable[[OperationProposal], bool]:
        """Build target path condition.

        Supports:
        - matches_any: list of glob patterns
        - contains: substring match
        - matches_regex: regex pattern
        - equals: exact match
        """
        if isinstance(value, str):
            # Simple equality check
            return lambda p: p.target == value

        if not isinstance(value, dict):
            return lambda p: False

        if "matches_any" in value:
            patterns = value["matches_any"]
            return lambda p: any(
                self._match_pattern(p.target, pat) for pat in patterns
            )

        if "contains" in value:
            substr = value["contains"]
            case_sensitive = value.get("case_sensitive", False)
            if case_sensitive:
                return lambda p: substr in p.target
            return lambda p: substr.lower() in p.target.lower()

        if "matches_regex" in value:
            flags = 0
            if not value.get("case_sensitive", False):
                flags |= re.IGNORECASE
            regex = re.compile(value["matches_regex"], flags)
            return lambda p: bool(regex.search(p.target))

        if "equals" in value:
            return lambda p: p.target == value["equals"]

        if "starts_with" in value:
            prefix = value["starts_with"]
            return lambda p: p.target.startswith(prefix)

        if "ends_with" in value:
            suffix = value["ends_with"]
            return lambda p: p.target.endswith(suffix)

        return lambda p: False

    def _build_metadata_condition(
        self, key: str, value: Any
    ) -> Callable[[OperationProposal], bool]:
        """Build metadata field condition.

        Supports:
        - matches_regex: regex pattern
        - in_allowlist: reference to named allowlist
        - equals: exact match
        - contains: substring match
        - greater_than / less_than: numeric comparison
        """
        if isinstance(value, str):
            # Simple equality
            return lambda p, k=key, v=value: str(p.metadata.get(k, "")) == v

        if isinstance(value, (int, float)):
            # Numeric equality
            return lambda p, k=key, v=value: p.metadata.get(k) == v

        if isinstance(value, bool):
            # Boolean check
            return lambda p, k=key, v=value: p.metadata.get(k) == v

        if isinstance(value, list):
            # List membership
            return lambda p, k=key, v=value: p.metadata.get(k) in v

        if not isinstance(value, dict):
            return lambda p: False

        if "matches_regex" in value:
            flags = 0
            if not value.get("case_sensitive", False):
                flags |= re.IGNORECASE
            regex = re.compile(value["matches_regex"], flags)
            return lambda p, k=key, r=regex: bool(r.search(str(p.metadata.get(k, ""))))

        if "in_allowlist" in value:
            allowlist_name = value["in_allowlist"]
            patterns = self._allowlists.get(allowlist_name, [])
            return lambda p, k=key, pats=patterns: any(
                fnmatch(str(p.metadata.get(k, "")), pat)
                for pat in pats
            )

        if "equals" in value:
            return lambda p, k=key, v=value["equals"]: p.metadata.get(k) == v

        if "contains" in value:
            substr = value["contains"]
            return lambda p, k=key, s=substr: s in str(p.metadata.get(k, ""))

        if "greater_than" in value:
            threshold = value["greater_than"]
            return lambda p, k=key, t=threshold: p.metadata.get(k, 0) > t

        if "less_than" in value:
            threshold = value["less_than"]
            return lambda p, k=key, t=threshold: p.metadata.get(k, 0) < t

        return lambda p: False

    def _match_pattern(self, path: str, pattern: str) -> bool:
        """Match a path against a glob-like pattern.

        Supports:
        - Standard glob patterns (*, ?)
        - ** for recursive directory matching
        - ~ expansion
        """
        # Expand user home directory
        expanded = str(Path(path).expanduser())
        pattern_expanded = str(Path(pattern).expanduser())

        # Handle ** patterns
        if "**" in pattern_expanded:
            # Convert ** to a more flexible match
            parts = pattern_expanded.split("**")
            if len(parts) == 2:
                prefix, suffix = parts
                if prefix and not expanded.startswith(prefix.rstrip("/")):
                    return False
                if suffix and not expanded.endswith(suffix.lstrip("/")):
                    # Check if any part of the path matches the suffix
                    if suffix.lstrip("/") not in expanded:
                        return False
                return True

        # Standard fnmatch
        return fnmatch(expanded, pattern_expanded) or fnmatch(
            expanded.lower(), pattern_expanded.lower()
        )


def validate_rules_file(path: Path) -> tuple[bool, list[str]]:
    """Validate a rules file without loading it.

    Args:
        path: Path to the YAML file

    Returns:
        Tuple of (is_valid, list_of_errors)
    """
    errors = []

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
    except yaml.YAMLError as e:
        return False, [f"Invalid YAML: {e}"]
    except OSError as e:
        return False, [f"Cannot read file: {e}"]

    if not isinstance(data, dict):
        return False, ["File must be a dictionary"]

    # Check metadata
    if "metadata" in data:
        metadata = data["metadata"]
        if not isinstance(metadata, dict):
            errors.append("'metadata' must be a dictionary")

    # Check rules
    if "rules" not in data:
        errors.append("Missing 'rules' key")
    elif not isinstance(data["rules"], list):
        errors.append("'rules' must be a list")
    else:
        for i, rule in enumerate(data["rules"]):
            if not isinstance(rule, dict):
                errors.append(f"Rule {i} must be a dictionary")
                continue

            if "id" not in rule:
                errors.append(f"Rule {i} missing 'id'")
            if "when" not in rule:
                errors.append(f"Rule {i} missing 'when'")
            if "then" not in rule:
                errors.append(f"Rule {i} missing 'then'")

            # Check risk level
            if "then" in rule and isinstance(rule["then"], dict):
                risk = rule["then"].get("risk", "")
                if risk not in ("L1", "L2", "L3"):
                    errors.append(f"Rule {i} has invalid risk level: {risk}")

    # Check allowlists
    if "allowlists" in data:
        if not isinstance(data["allowlists"], dict):
            errors.append("'allowlists' must be a dictionary")

    return len(errors) == 0, errors
