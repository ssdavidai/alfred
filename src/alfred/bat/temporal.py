"""
Temporal Risk Accumulator - Sliding window risk analysis.

Individual operations may be safe; sequences may be dangerous.
This module detects compound attack patterns over time.
"""

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional
import logging

from .proposal import OperationProposal
from .risk import RiskLevel


logger = logging.getLogger(__name__)


@dataclass
class SequenceRule:
    """Rule for detecting dangerous operation sequences.

    Attributes:
        id: Unique identifier for this rule
        description: Human-readable description
        pattern: List of operation types that form the pattern
        window: Time window for the pattern
        escalated_level: Risk level to escalate to
        min_occurrences: Minimum occurrences to trigger
        enabled: Whether the rule is active
    """

    id: str
    description: str
    pattern: list[str]  # Operation types in sequence
    window: timedelta
    escalated_level: RiskLevel
    min_occurrences: int = 2
    enabled: bool = True


@dataclass
class RiskEscalation:
    """Result of a risk escalation detection.

    Attributes:
        triggered_rule: The rule that was triggered
        escalated_level: The escalated risk level
        contributing_operations: Operations that contributed
        timestamp: When the escalation was detected
    """

    triggered_rule: SequenceRule
    escalated_level: RiskLevel
    contributing_operations: list[OperationProposal]
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class TemporalRiskAccumulator:
    """Sliding window risk analysis for detecting compound attacks.

    Individual operations may be safe; sequences may be dangerous.
    This module tracks operations over time and detects patterns.

    Example patterns:
    - Credential exfiltration: read_file → read_file → network_request
    - Rapid writes: 50+ write_file in 60 seconds
    - Reconnaissance: 10+ read_file in 10 minutes

    Example:
        >>> accumulator = TemporalRiskAccumulator()
        >>> for i in range(60):
        ...     proposal = OperationProposal(
        ...         agent_id="test",
        ...         operation_type="write_file",
        ...         target=f"file_{i}.md"
        ...     )
        ...     escalation = accumulator.evaluate(proposal)
        ...     if escalation:
        ...         print(f"Escalation detected: {escalation.triggered_rule.id}")
    """

    DEFAULT_RULES = [
        SequenceRule(
            id="credential-exfiltration",
            description="Potential credential exfiltration pattern",
            pattern=["read_file", "read_file", "network_request"],
            window=timedelta(minutes=5),
            escalated_level=RiskLevel.L3,
            min_occurrences=3,
        ),
        SequenceRule(
            id="rapid-writes",
            description="Abnormally high write frequency",
            pattern=["write_file"],
            window=timedelta(seconds=60),
            escalated_level=RiskLevel.L3,
            min_occurrences=50,
        ),
        SequenceRule(
            id="rapid-deletes",
            description="Abnormally high delete frequency",
            pattern=["delete_file"],
            window=timedelta(seconds=30),
            escalated_level=RiskLevel.L3,
            min_occurrences=20,
        ),
        SequenceRule(
            id="reconnaissance",
            description="Potential reconnaissance pattern",
            pattern=["read_file"],
            window=timedelta(minutes=10),
            escalated_level=RiskLevel.L2,
            min_occurrences=100,
        ),
        SequenceRule(
            id="command-burst",
            description="Rapid command execution",
            pattern=["exec_command"],
            window=timedelta(seconds=60),
            escalated_level=RiskLevel.L2,
            min_occurrences=30,
        ),
        SequenceRule(
            id="sensitive-access-pattern",
            description="Multiple sensitive file accesses",
            pattern=["secret_access"],
            window=timedelta(minutes=5),
            escalated_level=RiskLevel.L3,
            min_occurrences=5,
        ),
    ]

    def __init__(
        self,
        window: timedelta = timedelta(minutes=30),
        rules: Optional[list[SequenceRule]] = None,
        max_history: int = 10000,
    ):
        """Initialize the temporal risk accumulator.

        Args:
            window: Maximum time window to track
            rules: Sequence rules to use (default: DEFAULT_RULES)
            max_history: Maximum number of operations to track
        """
        self._window = window
        self._rules = rules or self.DEFAULT_RULES.copy()
        self._max_history = max_history
        self._history: deque[OperationProposal] = deque(maxlen=max_history)

    @property
    def rules(self) -> list[SequenceRule]:
        """Get the current rules."""
        return self._rules.copy()

    def add_rule(self, rule: SequenceRule) -> None:
        """Add a sequence rule.

        Args:
            rule: The rule to add
        """
        self._rules.append(rule)

    def remove_rule(self, rule_id: str) -> bool:
        """Remove a sequence rule.

        Args:
            rule_id: ID of the rule to remove

        Returns:
            True if removed, False if not found
        """
        for i, rule in enumerate(self._rules):
            if rule.id == rule_id:
                self._rules.pop(i)
                return True
        return False

    def record(self, proposal: OperationProposal) -> None:
        """Record an operation proposal.

        Args:
            proposal: The proposal to record
        """
        self._history.append(proposal)
        self._prune_expired()

    def _prune_expired(self) -> None:
        """Remove entries outside the window."""
        cutoff = datetime.now(timezone.utc) - self._window
        while self._history and self._history[0].timestamp < cutoff:
            self._history.popleft()

    def evaluate(self, new_proposal: OperationProposal) -> Optional[RiskEscalation]:
        """Evaluate if the new proposal triggers a sequence rule.

        Args:
            new_proposal: The new proposal to evaluate

        Returns:
            RiskEscalation if triggered, None otherwise
        """
        self.record(new_proposal)

        for rule in self._rules:
            if not rule.enabled:
                continue

            if self._check_rule(rule):
                logger.warning(
                    f"Temporal risk escalation: rule={rule.id} "
                    f"level={rule.escalated_level.value}"
                )
                return RiskEscalation(
                    triggered_rule=rule,
                    escalated_level=rule.escalated_level,
                    contributing_operations=list(self._history),
                )

        return None

    def _check_rule(self, rule: SequenceRule) -> bool:
        """Check if a sequence rule is triggered.

        Args:
            rule: The rule to check

        Returns:
            True if triggered, False otherwise
        """
        # Filter to window for this rule
        cutoff = datetime.now(timezone.utc) - rule.window
        relevant = [p for p in self._history if p.timestamp >= cutoff]

        if len(relevant) < rule.min_occurrences:
            return False

        # Check for pattern match
        if len(rule.pattern) == 1:
            # Simple count-based rule
            count = sum(1 for p in relevant if p.operation_type in rule.pattern)
            return count >= rule.min_occurrences

        # Sequence-based rule
        return self._match_sequence(relevant, rule.pattern, rule.min_occurrences)

    def _match_sequence(
        self,
        operations: list[OperationProposal],
        pattern: list[str],
        min_occurrences: int,
    ) -> bool:
        """Check if operations contain the pattern sequence.

        Args:
            operations: List of operations to check
            pattern: Pattern to match
            min_occurrences: Minimum number of pattern matches

        Returns:
            True if pattern matched enough times
        """
        op_types = [p.operation_type for p in operations]

        # Simple subsequence check
        pattern_idx = 0
        matches = 0

        for op_type in op_types:
            if op_type == pattern[pattern_idx]:
                pattern_idx += 1
                if pattern_idx >= len(pattern):
                    matches += 1
                    pattern_idx = 0
                    if matches >= min_occurrences:
                        return True

        return False

    def get_stats(self) -> dict:
        """Get accumulator statistics.

        Returns:
            Dictionary with statistics
        """
        cutoff = datetime.now(timezone.utc) - self._window
        recent = [p for p in self._history if p.timestamp >= cutoff]

        # Count by operation type
        by_type: dict[str, int] = {}
        for p in recent:
            by_type[p.operation_type] = by_type.get(p.operation_type, 0) + 1

        # Count by agent
        by_agent: dict[str, int] = {}
        for p in recent:
            by_agent[p.agent_id] = by_agent.get(p.agent_id, 0) + 1

        return {
            "total_tracked": len(self._history),
            "window_minutes": self._window.total_seconds() / 60,
            "recent_operations": len(recent),
            "by_type": by_type,
            "by_agent": by_agent,
            "rules_count": len(self._rules),
            "rules_enabled": sum(1 for r in self._rules if r.enabled),
        }

    def clear(self) -> None:
        """Clear the history."""
        self._history.clear()

    def get_recent_operations(
        self,
        window: Optional[timedelta] = None,
        operation_type: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> list[OperationProposal]:
        """Get recent operations with optional filtering.

        Args:
            window: Time window (default: use accumulator's window)
            operation_type: Filter by operation type
            agent_id: Filter by agent ID

        Returns:
            List of matching operations
        """
        window = window or self._window
        cutoff = datetime.now(timezone.utc) - window

        result = []
        for p in self._history:
            if p.timestamp < cutoff:
                continue
            if operation_type and p.operation_type != operation_type:
                continue
            if agent_id and p.agent_id != agent_id:
                continue
            result.append(p)

        return result


def create_temporal_interceptor(
    accumulator: TemporalRiskAccumulator,
    base_interceptor,  # BatInterceptor
) -> callable:
    """Create an interceptor wrapper that adds temporal analysis.

    Args:
        accumulator: The temporal risk accumulator
        base_interceptor: The base BatInterceptor

    Returns:
        Wrapped intercept function
    """
    original_intercept = base_interceptor.intercept

    def intercept_with_temporal(*args, **kwargs):
        # First, do the base interception
        result = original_intercept(*args, **kwargs)

        # Then, check for temporal escalation
        escalation = accumulator.evaluate(result.proposal)

        if escalation:
            # Escalate the risk level
            from .risk import RiskClassification

            result.decision.classification = RiskClassification(
                level=escalation.escalated_level,
                rule_id=f"temporal:{escalation.triggered_rule.id}",
                rationale=f"Temporal escalation: {escalation.triggered_rule.description}",
            )

            # Re-evaluate action based on new level
            from .enforcement import Action

            if escalation.escalated_level == RiskLevel.L3:
                result.decision.action = Action.BLOCK
                result.allowed = False
            elif escalation.escalated_level == RiskLevel.L2:
                result.decision.action = Action.REQUIRE_CONFIRMATION
                result.allowed = False

        return result

    return intercept_with_temporal
