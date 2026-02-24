"""
Bat Interceptor - Main entry point for governance.

This is the primary interface between agents and governance.
All agent operations should flow through this interceptor.

Core Principle: Agents propose; they do not act unilaterally.
"""

from dataclasses import dataclass
from typing import Any, Optional, Callable
from pathlib import Path
import hashlib
import logging

from .proposal import OperationProposal
from .risk import RiskEngine, RiskClassification, RiskLevel
from .enforcement import (
    EnforcementEngine,
    EnforcementDecision,
    EnforcementPolicy,
    EnforcementMode,
    Action,
)
from .ledger import GovernanceLedger


logger = logging.getLogger(__name__)


@dataclass
class InterceptResult:
    """Result of intercepting an operation.

    Attributes:
        allowed: Whether the operation is allowed to proceed
        decision: The enforcement decision
        proposal: The operation proposal
        error: Error message if interception failed
    """

    allowed: bool
    decision: EnforcementDecision
    proposal: OperationProposal
    error: Optional[str] = None

    def __bool__(self) -> bool:
        """Allow using InterceptResult in boolean context."""
        return self.allowed

    def raise_if_blocked(self) -> None:
        """Raise PermissionError if the operation is blocked.

        Raises:
            PermissionError: If the operation is not allowed
        """
        if not self.allowed:
            raise PermissionError(
                f"Operation blocked by Bat Protocol: {self.decision.rationale}"
            )


class BatInterceptor:
    """Main interception point for all agent operations.

    This is the primary interface between agents and governance.
    All agent operations MUST flow through this interceptor.

    The interceptor:
    1. Creates an OperationProposal from the operation
    2. Classifies the risk using the RiskEngine
    3. Evaluates enforcement using the EnforcementEngine
    4. Records the decision to the GovernanceLedger
    5. Returns an InterceptResult

    Example:
        >>> from alfred.bat import BatInterceptor, RiskEngine, EnforcementEngine, GovernanceLedger
        >>> from alfred.bat.rules.default import DEFAULT_RULES
        >>> from pathlib import Path
        >>>
        >>> # Initialize
        >>> risk_engine = RiskEngine(rules=DEFAULT_RULES)
        >>> ledger = GovernanceLedger(Path("data/ledger.jsonl"), b"secret")
        >>> policy = EnforcementPolicy(version="1.0", mode=EnforcementMode.ENFORCE)
        >>> enforcement = EnforcementEngine(policy, ledger)
        >>> interceptor = BatInterceptor(risk_engine, enforcement, ledger)
        >>>
        >>> # Intercept an operation
        >>> result = interceptor.intercept(
        ...     agent_id="curator",
        ...     operation_type="write_file",
        ...     target="~/vault/inbox/note.md"
        ... )
        >>> if result.allowed:
        ...     print("Operation allowed")
        ... else:
        ...     print(f"Blocked: {result.decision.rationale}")
    """

    def __init__(
        self,
        risk_engine: RiskEngine,
        enforcement_engine: EnforcementEngine,
        ledger: GovernanceLedger,
    ):
        """Initialize the Bat Interceptor.

        Args:
            risk_engine: The risk classification engine
            enforcement_engine: The enforcement engine
            ledger: The governance ledger
        """
        self._risk = risk_engine
        self._enforcement = enforcement_engine
        self._ledger = ledger

    def intercept(
        self,
        agent_id: str,
        operation_type: str,
        target: str,
        metadata: Optional[dict] = None,
        content: str = "",
    ) -> InterceptResult:
        """Intercept an operation and determine if it should proceed.

        This is the main entry point for governance. All agent operations
        should flow through this method.

        Args:
            agent_id: Identifier of the agent proposing the operation
            operation_type: Type of operation from standard taxonomy
            target: What the operation affects (path, URL, etc.)
            metadata: Additional context about the operation
            content: Content for write operations (will be hashed)

        Returns:
            InterceptResult with allowed status and decision details

        Example:
            >>> result = interceptor.intercept(
            ...     agent_id="curator",
            ...     operation_type="write_file",
            ...     target="~/vault/inbox/note.md",
            ...     content="# My Note\\nContent here"
            ... )
            >>> result.allowed
            True
        """
        # Create proposal
        proposal = OperationProposal(
            agent_id=agent_id,
            operation_type=operation_type,
            target=target,
            metadata=metadata or {},
            content_hash=hashlib.sha256(content.encode()).hexdigest() if content else "",
        )

        # Classify risk
        try:
            classification = self._risk.classify(proposal)
        except Exception as e:
            # FAIL-CLOSED: Classification failure → L3
            logger.error(f"Risk classification failed: {e}")
            classification = RiskClassification(
                level=RiskLevel.L3,
                rule_id="classification-error",
                rationale=f"Classification failed: {e}",
            )

        # Evaluate enforcement
        try:
            decision = self._enforcement.evaluate(proposal, classification)
        except Exception as e:
            # FAIL-CLOSED: Enforcement failure → block
            logger.error(f"Enforcement evaluation failed: {e}")
            return InterceptResult(
                allowed=False,
                decision=EnforcementDecision(
                    proposal_id=proposal.proposal_id,
                    action=Action.BLOCK,
                    policy_version="error",
                    classification=classification,
                    timestamp=proposal.timestamp,
                    rationale=f"Enforcement failed: {e}",
                ),
                proposal=proposal,
                error=str(e),
            )

        # Determine if allowed
        allowed = decision.action.is_allowed

        logger.info(
            f"Intercept: agent={agent_id} op={operation_type} "
            f"target={target[:30]}... → {decision.action.value}"
        )

        return InterceptResult(
            allowed=allowed,
            decision=decision,
            proposal=proposal,
        )

    def intercept_file_read(
        self,
        agent_id: str,
        file_path: str,
    ) -> InterceptResult:
        """Convenience method for file read operations.

        Args:
            agent_id: Identifier of the agent
            file_path: Path to the file being read

        Returns:
            InterceptResult
        """
        return self.intercept(
            agent_id=agent_id,
            operation_type="read_file",
            target=file_path,
        )

    def intercept_file_write(
        self,
        agent_id: str,
        file_path: str,
        content: str = "",
        mode: str = "write",
    ) -> InterceptResult:
        """Convenience method for file write operations.

        Args:
            agent_id: Identifier of the agent
            file_path: Path to the file being written
            content: Content being written
            mode: Write mode ("write", "append", "create")

        Returns:
            InterceptResult
        """
        return self.intercept(
            agent_id=agent_id,
            operation_type="write_file",
            target=file_path,
            metadata={"mode": mode},
            content=content,
        )

    def intercept_file_delete(
        self,
        agent_id: str,
        file_path: str,
    ) -> InterceptResult:
        """Convenience method for file delete operations.

        Args:
            agent_id: Identifier of the agent
            file_path: Path to the file being deleted

        Returns:
            InterceptResult
        """
        return self.intercept(
            agent_id=agent_id,
            operation_type="delete_file",
            target=file_path,
        )

    def intercept_command(
        self,
        agent_id: str,
        command: str,
        shell: bool = False,
    ) -> InterceptResult:
        """Convenience method for command execution operations.

        Args:
            agent_id: Identifier of the agent
            command: The command to execute
            shell: Whether to use shell execution

        Returns:
            InterceptResult
        """
        return self.intercept(
            agent_id=agent_id,
            operation_type="exec_command",
            target="subprocess",
            metadata={"command": command, "shell": shell},
        )

    def intercept_network_request(
        self,
        agent_id: str,
        url: str,
        method: str = "GET",
    ) -> InterceptResult:
        """Convenience method for network request operations.

        Args:
            agent_id: Identifier of the agent
            url: The URL being requested
            method: HTTP method

        Returns:
            InterceptResult
        """
        return self.intercept(
            agent_id=agent_id,
            operation_type="network_request",
            target=url,
            metadata={"method": method},
        )

    def intercept_secret_access(
        self,
        agent_id: str,
        secret_key: str,
        operation: str = "read",
    ) -> InterceptResult:
        """Convenience method for secret access operations.

        Args:
            agent_id: Identifier of the agent
            secret_key: The secret key being accessed
            operation: "read" or "write"

        Returns:
            InterceptResult
        """
        return self.intercept(
            agent_id=agent_id,
            operation_type="secret_access",
            target=secret_key,
            metadata={"operation": operation},
        )

    def check_allowed(
        self,
        agent_id: str,
        operation_type: str,
        target: str,
        metadata: Optional[dict] = None,
    ) -> bool:
        """Quick check if an operation would be allowed.

        This is a convenience method that returns only the boolean
        result without full decision details.

        Args:
            agent_id: Identifier of the agent
            operation_type: Type of operation
            target: What the operation affects
            metadata: Additional context

        Returns:
            True if allowed, False otherwise
        """
        result = self.intercept(
            agent_id=agent_id,
            operation_type=operation_type,
            target=target,
            metadata=metadata,
        )
        return result.allowed

    def get_status(self) -> dict:
        """Get the current status of the interceptor.

        Returns:
            Dictionary with status information
        """
        return {
            "risk_engine": {
                "rules_count": len(self._risk.rules),
            },
            "enforcement": self._enforcement.get_status(),
            "ledger": {
                "path": str(self._ledger.path),
                "entries": self._ledger.count(),
            },
        }


def create_interceptor(
    rules: list,
    ledger_path: Path,
    signing_key: bytes,
    mode: EnforcementMode = EnforcementMode.ENFORCE,
    policy_version: str = "1.0",
) -> BatInterceptor:
    """Factory function to create a fully configured interceptor.

    Args:
        rules: List of risk classification rules
        ledger_path: Path to the governance ledger
        signing_key: Secret key for ledger signing
        mode: Enforcement mode (passive/enforce)
        policy_version: Policy version string

    Returns:
        Configured BatInterceptor instance

    Example:
        >>> from alfred.bat.rules.default import DEFAULT_RULES
        >>> interceptor = create_interceptor(
        ...     rules=DEFAULT_RULES,
        ...     ledger_path=Path("data/ledger.jsonl"),
        ...     signing_key=b"my-secret-key",
        ...     mode=EnforcementMode.ENFORCE,
        ... )
    """
    risk_engine = RiskEngine(rules=rules)
    ledger = GovernanceLedger(path=ledger_path, signing_key=signing_key)
    policy = EnforcementPolicy(version=policy_version, mode=mode)
    enforcement = EnforcementEngine(policy=policy, ledger=ledger)

    return BatInterceptor(
        risk_engine=risk_engine,
        enforcement_engine=enforcement,
        ledger=ledger,
    )
