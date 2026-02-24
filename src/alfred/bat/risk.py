"""
Risk Engine - Deterministic risk classification for agent operations.

CRITICAL: NO LLM CALLS. Classification is a pure function.
Default is L3 (deny) when no rule matches.

Core Principle: No agent decides its own risk.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Callable, Optional
import logging

from .proposal import OperationProposal


logger = logging.getLogger(__name__)


class RiskLevel(Enum):
    """Risk classification levels.

    L1 (Low): Routine operations that are always safe.
    L2 (Medium): Operations that require awareness but are generally safe.
    L3 (High): Sensitive operations that require explicit approval or are blocked.

    The default is L3 (deny) when no rule matches.
    """

    L1 = "L1"  # Low risk - routine operations
    L2 = "L2"  # Medium risk - requires awareness
    L3 = "L3"  # High risk - sensitive operations

    def __str__(self) -> str:
        return self.value

    def __lt__(self, other: "RiskLevel") -> bool:
        """Compare risk levels. L1 < L2 < L3."""
        order = {RiskLevel.L1: 1, RiskLevel.L2: 2, RiskLevel.L3: 3}
        return order[self] < order[other]

    def __le__(self, other: "RiskLevel") -> bool:
        return self == other or self < other

    def __gt__(self, other: "RiskLevel") -> bool:
        return not self <= other

    def __ge__(self, other: "RiskLevel") -> bool:
        return not self < other


@dataclass
class RiskClassification:
    """Result of risk classification.

    Attributes:
        level: The risk level assigned to the operation
        rule_id: ID of the rule that matched (or "default-deny")
        rationale: Human-readable explanation of the classification
    """

    level: RiskLevel
    rule_id: str
    rationale: str

    def __str__(self) -> str:
        return f"RiskClassification({self.level.value}, rule={self.rule_id})"


@dataclass
class RiskRule:
    """A single risk classification rule.

    Rules are evaluated in priority order (highest first).
    The first matching rule determines the classification.

    Attributes:
        id: Unique identifier for this rule
        predicate: Function that returns True if the rule matches
        level: Risk level to assign if the rule matches
        rationale: Human-readable explanation
        priority: Higher priority rules are evaluated first (default: 0)
        enabled: Whether the rule is active (default: True)
    """

    id: str
    predicate: Callable[[OperationProposal], bool]
    level: RiskLevel
    rationale: str
    priority: int = 0
    enabled: bool = True

    def matches(self, proposal: OperationProposal) -> Optional[RiskClassification]:
        """Check if this rule matches the proposal.

        Args:
            proposal: The operation proposal to evaluate

        Returns:
            RiskClassification if rule matches, None otherwise
        """
        if not self.enabled:
            return None

        try:
            if self.predicate(proposal):
                return RiskClassification(
                    level=self.level,
                    rule_id=self.id,
                    rationale=self.rationale,
                )
        except Exception as e:
            # Rule evaluation failure - log and continue
            logger.warning(
                f"Rule '{self.id}' evaluation failed: {e}. "
                "Continuing to next rule."
            )
            return None

        return None


class RiskEngine:
    """Deterministic risk classification engine.

    NO LLM CALLS. Classification is a pure function.
    Default is L3 (deny) when no rule matches.

    The engine evaluates rules in priority order (highest first).
    The first matching rule determines the classification.
    If no rule matches, the default is L3 (deny).

    Example:
        >>> from alfred.bat.risk import RiskEngine, RiskRule, RiskLevel
        >>> from alfred.bat.proposal import OperationProposal
        >>>
        >>> rules = [
        ...     RiskRule(
        ...         id="allow-read",
        ...         predicate=lambda p: p.operation_type == "read_file",
        ...         level=RiskLevel.L1,
        ...         rationale="Read operations are safe",
        ...         priority=10
        ...     )
        ... ]
        >>> engine = RiskEngine(rules=rules)
        >>> proposal = OperationProposal(agent_id="test", operation_type="read_file", target="/tmp/file")
        >>> result = engine.classify(proposal)
        >>> result.level
        <RiskLevel.L1: 'L1'>
    """

    # Default classification when no rule matches
    DEFAULT_CLASSIFICATION = RiskClassification(
        level=RiskLevel.L3,
        rule_id="default-deny",
        rationale="No matching rule; default deny",
    )

    def __init__(self, rules: list[RiskRule]):
        """Initialize the risk engine with rules.

        Rules are sorted by priority (highest first) on initialization.

        Args:
            rules: List of risk classification rules
        """
        # Sort by priority descending (highest priority first)
        self._rules = sorted(rules, key=lambda r: r.priority, reverse=True)
        self._rule_index = {rule.id: rule for rule in rules}

    @property
    def rules(self) -> list[RiskRule]:
        """Get the list of rules (sorted by priority)."""
        return self._rules.copy()

    def get_rule(self, rule_id: str) -> Optional[RiskRule]:
        """Get a rule by ID.

        Args:
            rule_id: The rule identifier

        Returns:
            The rule if found, None otherwise
        """
        return self._rule_index.get(rule_id)

    def add_rule(self, rule: RiskRule) -> None:
        """Add a rule to the engine.

        Args:
            rule: The rule to add
        """
        self._rules.append(rule)
        self._rules.sort(key=lambda r: r.priority, reverse=True)
        self._rule_index[rule.id] = rule

    def remove_rule(self, rule_id: str) -> bool:
        """Remove a rule from the engine.

        Args:
            rule_id: The ID of the rule to remove

        Returns:
            True if the rule was removed, False if not found
        """
        if rule_id not in self._rule_index:
            return False

        del self._rule_index[rule_id]
        self._rules = [r for r in self._rules if r.id != rule_id]
        return True

    def classify(self, proposal: OperationProposal) -> RiskClassification:
        """Classify a proposal.

        Evaluates rules in priority order. The first matching rule
        determines the classification. If no rule matches, returns L3.

        Args:
            proposal: The operation proposal to classify

        Returns:
            RiskClassification with level, rule_id, and rationale

        Example:
            >>> engine = RiskEngine(rules=[])
            >>> proposal = OperationProposal(agent_id="test", operation_type="unknown", target="test")
            >>> result = engine.classify(proposal)
            >>> result.level
            <RiskLevel.L3: 'L3'>
            >>> result.rule_id
            'default-deny'
        """
        for rule in self._rules:
            classification = rule.matches(proposal)
            if classification is not None:
                logger.debug(
                    f"Proposal {proposal.proposal_id[:8]}... "
                    f"matched rule '{rule.id}' → {classification.level.value}"
                )
                return classification

        # DEFAULT DENY - no matching rule means highest risk
        logger.info(
            f"Proposal {proposal.proposal_id[:8]}... "
            f"matched no rules → default deny (L3)"
        )
        return self.DEFAULT_CLASSIFICATION

    def classify_batch(
        self, proposals: list[OperationProposal]
    ) -> list[RiskClassification]:
        """Classify multiple proposals.

        Args:
            proposals: List of operation proposals

        Returns:
            List of risk classifications (same order as input)
        """
        return [self.classify(p) for p in proposals]

    def explain(self, proposal: OperationProposal) -> dict:
        """Explain why a proposal would be classified the way it would.

        This is useful for debugging and policy testing.

        Args:
            proposal: The operation proposal to explain

        Returns:
            Dictionary with classification and rule evaluation details
        """
        evaluations = []

        for rule in self._rules:
            if not rule.enabled:
                evaluations.append({
                    "rule_id": rule.id,
                    "priority": rule.priority,
                    "matched": False,
                    "reason": "disabled",
                })
                continue

            try:
                matched = rule.predicate(proposal)
                evaluations.append({
                    "rule_id": rule.id,
                    "priority": rule.priority,
                    "matched": matched,
                    "level": rule.level.value if matched else None,
                    "rationale": rule.rationale if matched else None,
                })
            except Exception as e:
                evaluations.append({
                    "rule_id": rule.id,
                    "priority": rule.priority,
                    "matched": False,
                    "reason": f"error: {e}",
                })

        classification = self.classify(proposal)

        return {
            "proposal_id": proposal.proposal_id,
            "operation_type": proposal.operation_type,
            "target": proposal.target,
            "classification": {
                "level": classification.level.value,
                "rule_id": classification.rule_id,
                "rationale": classification.rationale,
            },
            "rule_evaluations": evaluations,
            "total_rules": len(self._rules),
            "enabled_rules": sum(1 for r in self._rules if r.enabled),
        }
