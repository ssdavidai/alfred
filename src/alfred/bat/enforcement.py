"""
Enforcement Engine - Policy-driven enforcement with audit logging.

Maps risk levels to actions based on enforcement mode.
Supports passive (log-only) and enforce (block L3) modes.

Core Principle: Governance is structurally separated from agency.
"""

from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Optional
import logging

from .proposal import OperationProposal
from .risk import RiskClassification, RiskLevel


logger = logging.getLogger(__name__)


class Action(Enum):
    """Enforcement actions.

    ALLOW: Operation proceeds normally
    LOG: Operation proceeds but is logged
    REQUIRE_CONFIRMATION: Operation requires user confirmation
    BLOCK: Operation is blocked
    QUARANTINE: Operation is quarantined for later review
    """

    ALLOW = "allow"
    LOG = "log"
    REQUIRE_CONFIRMATION = "require_confirmation"
    BLOCK = "block"
    QUARANTINE = "quarantine"

    def __str__(self) -> str:
        return self.value

    @property
    def is_allowed(self) -> bool:
        """Check if this action allows the operation to proceed."""
        return self in (Action.ALLOW, Action.LOG)


class EnforcementMode(Enum):
    """Enforcement modes.

    PASSIVE: Log all operations, block nothing (for testing/monitoring)
    ENFORCE: Block L3 operations, require confirmation for L2
    """

    PASSIVE = "passive"
    ENFORCE = "enforce"

    def __str__(self) -> str:
        return self.value


@dataclass
class EnforcementDecision:
    """Result of enforcement evaluation.

    Attributes:
        proposal_id: ID of the proposal being evaluated
        action: The enforcement action taken
        policy_version: Version of the enforcement policy
        classification: The risk classification that informed this decision
        timestamp: When the decision was made
        rationale: Human-readable explanation
        confirmation_token: Token for confirmation flow (if required)
    """

    proposal_id: str
    action: Action
    policy_version: str
    classification: RiskClassification
    timestamp: datetime
    rationale: str = ""
    confirmation_token: Optional[str] = None

    def __post_init__(self):
        """Ensure timestamp is timezone-aware."""
        if self.timestamp.tzinfo is None:
            self.timestamp = self.timestamp.replace(tzinfo=timezone.utc)

    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return {
            "proposal_id": self.proposal_id,
            "action": self.action.value,
            "policy_version": self.policy_version,
            "classification": {
                "level": self.classification.level.value,
                "rule_id": self.classification.rule_id,
                "rationale": self.classification.rationale,
            },
            "timestamp": self.timestamp.isoformat(),
            "rationale": self.rationale,
            "confirmation_token": self.confirmation_token,
        }


@dataclass
class EnforcementPolicy:
    """Maps risk levels to actions based on mode.

    Attributes:
        version: Policy version string
        mode: Enforcement mode (passive/enforce)
        l1_action: Action for L1 operations (default: ALLOW)
        l2_action: Action for L2 operations (default: REQUIRE_CONFIRMATION)
        l3_action: Action for L3 operations (default: BLOCK)
    """

    version: str
    mode: EnforcementMode
    l1_action: Action = Action.ALLOW
    l2_action: Action = Action.REQUIRE_CONFIRMATION
    l3_action: Action = Action.BLOCK

    def resolve_action(self, level: RiskLevel) -> Action:
        """Resolve a risk level to an enforcement action.

        Args:
            level: The risk level to resolve

        Returns:
            The enforcement action for this risk level

        Example:
            >>> policy = EnforcementPolicy(version="1.0", mode=EnforcementMode.ENFORCE)
            >>> policy.resolve_action(RiskLevel.L1)
            <Action.ALLOW: 'allow'>
            >>> policy.resolve_action(RiskLevel.L3)
            <Action.BLOCK: 'block'>
        """
        # In passive mode, log everything
        if self.mode == EnforcementMode.PASSIVE:
            return Action.LOG

        # In enforce mode, use configured actions
        if level == RiskLevel.L1:
            return self.l1_action
        elif level == RiskLevel.L2:
            return self.l2_action
        else:  # L3
            return self.l3_action

    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return {
            "version": self.version,
            "mode": self.mode.value,
            "l1_action": self.l1_action.value,
            "l2_action": self.l2_action.value,
            "l3_action": self.l3_action.value,
        }

    @classmethod
    def passive(cls, version: str = "1.0") -> "EnforcementPolicy":
        """Create a passive policy (log-only).

        Args:
            version: Policy version string

        Returns:
            EnforcementPolicy configured for passive mode
        """
        return cls(version=version, mode=EnforcementMode.PASSIVE)

    @classmethod
    def enforce(cls, version: str = "1.0") -> "EnforcementPolicy":
        """Create an enforce policy (block L3).

        Args:
            version: Policy version string

        Returns:
            EnforcementPolicy configured for enforce mode
        """
        return cls(version=version, mode=EnforcementMode.ENFORCE)


class EnforcementEngine:
    """Policy-driven enforcement with audit logging.

    The enforcement engine evaluates proposals against the policy
    and records all decisions to the governance ledger.

    Example:
        >>> from alfred.bat.enforcement import EnforcementEngine, EnforcementPolicy, EnforcementMode
        >>> from alfred.bat.ledger import GovernanceLedger
        >>> from pathlib import Path
        >>>
        >>> policy = EnforcementPolicy(version="1.0", mode=EnforcementMode.ENFORCE)
        >>> ledger = GovernanceLedger(Path("/tmp/ledger.jsonl"), b"secret")
        >>> engine = EnforcementEngine(policy, ledger)
        >>> decision = engine.evaluate(proposal, classification)
    """

    def __init__(self, policy: EnforcementPolicy, ledger: "GovernanceLedger"):
        """Initialize the enforcement engine.

        Args:
            policy: The enforcement policy to use
            ledger: The governance ledger for audit logging
        """
        self._policy = policy
        self._ledger = ledger

    @property
    def policy(self) -> EnforcementPolicy:
        """Get the current enforcement policy."""
        return self._policy

    def set_policy(self, policy: EnforcementPolicy) -> None:
        """Set a new enforcement policy.

        Args:
            policy: The new policy to use
        """
        self._policy = policy
        logger.info(f"Enforcement policy updated to version {policy.version} ({policy.mode})")

    def evaluate(
        self,
        proposal: OperationProposal,
        classification: RiskClassification,
    ) -> EnforcementDecision:
        """Evaluate a proposal and record the decision.

        This is the main entry point for enforcement. It:
        1. Resolves the risk level to an action
        2. Creates an enforcement decision
        3. Records the decision to the ledger
        4. Returns the decision

        Args:
            proposal: The operation proposal to evaluate
            classification: The risk classification for the proposal

        Returns:
            EnforcementDecision with action and rationale

        Example:
            >>> decision = engine.evaluate(proposal, classification)
            >>> decision.action
            <Action.BLOCK: 'block'>
        """
        action = self._policy.resolve_action(classification.level)

        decision = EnforcementDecision(
            proposal_id=proposal.proposal_id,
            action=action,
            policy_version=self._policy.version,
            classification=classification,
            timestamp=datetime.now(timezone.utc),
            rationale=classification.rationale,
        )

        # Log the decision
        logger.info(
            f"Enforcement decision: proposal={proposal.proposal_id[:8]}... "
            f"level={classification.level.value} action={action.value}"
        )

        # Record to ledger
        try:
            self._ledger.append(decision, proposal)
        except Exception as e:
            # FAIL-CLOSED: Ledger write failure is critical
            logger.error(f"Ledger write failed: {e}")
            raise

        return decision

    def evaluate_batch(
        self,
        proposals: list[OperationProposal],
        classifications: list[RiskClassification],
    ) -> list[EnforcementDecision]:
        """Evaluate multiple proposals.

        Args:
            proposals: List of operation proposals
            classifications: List of risk classifications (same order)

        Returns:
            List of enforcement decisions (same order)
        """
        if len(proposals) != len(classifications):
            raise ValueError(
                f"Mismatched lengths: {len(proposals)} proposals, "
                f"{len(classifications)} classifications"
            )

        return [
            self.evaluate(p, c) for p, c in zip(proposals, classifications)
        ]

    def is_allowed(self, decision: EnforcementDecision) -> bool:
        """Check if a decision allows the operation to proceed.

        Args:
            decision: The enforcement decision

        Returns:
            True if the operation is allowed, False otherwise
        """
        return decision.action.is_allowed

    def get_status(self) -> dict:
        """Get the current status of the enforcement engine.

        Returns:
            Dictionary with policy and ledger status
        """
        return {
            "policy": self._policy.to_dict(),
            "mode": self._policy.mode.value,
            "version": self._policy.version,
        }
