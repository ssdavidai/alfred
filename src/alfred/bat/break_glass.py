"""
Break-Glass Mechanism - Emergency governance override.

Break-glass events are:
- Logged to a SEPARATE ledger (cannot be hidden)
- Time-bounded (auto-expire)
- Require justification
- Generate alerts

This provides a safety valve for legitimate emergencies while
maintaining full audit trail.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
import hashlib
import hmac
import json
import uuid
import logging

from .enforcement import EnforcementDecision, Action
from .proposal import OperationProposal


logger = logging.getLogger(__name__)


class BreakGlassError(Exception):
    """Raised when break-glass operation fails."""
    pass


@dataclass
class BreakGlassOverride:
    """Emergency override of a governance decision.

    Attributes:
        override_id: Unique identifier for this override
        operator: Who initiated the override
        justification: Why the override was needed
        timestamp: When the override was created
        original_decision: The decision being overridden
        override_action: The action to take instead
        expiry: When this override expires
        signature: Cryptographic signature
    """

    override_id: str
    operator: str
    justification: str
    timestamp: datetime
    original_decision: EnforcementDecision
    override_action: Action
    expiry: datetime
    signature: str = ""

    def is_expired(self) -> bool:
        """Check if this override has expired."""
        return datetime.now(timezone.utc) > self.expiry

    def is_valid_for(self, proposal_id: str) -> bool:
        """Check if this override is valid for a specific proposal."""
        return (
            not self.is_expired()
            and self.original_decision.proposal_id == proposal_id
        )

    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return {
            "override_id": self.override_id,
            "operator": self.operator,
            "justification": self.justification,
            "timestamp": self.timestamp.isoformat(),
            "original_decision": self.original_decision.to_dict(),
            "override_action": self.override_action.value,
            "expiry": self.expiry.isoformat(),
            "signature": self.signature,
        }


@dataclass
class BreakGlassSession:
    """A session of elevated privileges.

    Allows multiple operations within a time window.
    """
    session_id: str
    operator: str
    justification: str
    started_at: datetime
    expiry: datetime
    allowed_operations: list[str]  # Operation types allowed
    used_count: int = 0
    signature: str = ""

    def is_expired(self) -> bool:
        """Check if this session has expired."""
        return datetime.now(timezone.utc) > self.expiry

    def allows_operation(self, operation_type: str) -> bool:
        """Check if this session allows a specific operation type."""
        return (
            not self.is_expired()
            and (not self.allowed_operations or operation_type in self.allowed_operations)
        )


class BreakGlassManager:
    """Manage emergency governance overrides.

    Break-glass events are:
    - Logged to a SEPARATE ledger (cannot be hidden)
    - Time-bounded (auto-expire)
    - Require justification
    - Generate alerts

    Example:
        >>> manager = BreakGlassManager(
        ...     override_ledger_path=Path("data/break_glass.log"),
        ...     signing_key=b"secret-key"
        ... )
        >>> override = manager.create_override(
        ...     operator="admin",
        ...     justification="Emergency deployment fix",
        ...     original_decision=decision,
        ...     override_action=Action.ALLOW
        ... )
    """

    DEFAULT_EXPIRY = timedelta(hours=1)
    MAX_SESSION_EXPIRY = timedelta(hours=24)

    def __init__(
        self,
        override_ledger_path: Path,
        signing_key: bytes,
        expiry: Optional[timedelta] = None,
        alert_handlers: Optional[list[callable]] = None,
    ):
        """Initialize the break-glass manager.

        Args:
            override_ledger_path: Path to the override ledger
            signing_key: Secret key for signing overrides
            expiry: Default override expiry time
            alert_handlers: List of alert handler functions
        """
        self._ledger_path = Path(override_ledger_path)
        self._signing_key = signing_key
        self._expiry = expiry or self.DEFAULT_EXPIRY
        self._alert_handlers = alert_handlers or []
        self._active_sessions: dict[str, BreakGlassSession] = {}

        # Ensure ledger directory exists
        self._ledger_path.parent.mkdir(parents=True, exist_ok=True)

    def create_override(
        self,
        operator: str,
        justification: str,
        original_decision: EnforcementDecision,
        override_action: Action,
        expiry: Optional[timedelta] = None,
    ) -> BreakGlassOverride:
        """Create a break-glass override.

        Args:
            operator: Who is requesting the override
            justification: Why the override is needed
            original_decision: The decision being overridden
            override_action: The action to take instead
            expiry: Override expiry time (default: use manager default)

        Returns:
            The created override

        Raises:
            BreakGlassError: If creation fails
        """
        if not operator:
            raise BreakGlassError("Operator is required")
        if not justification:
            raise BreakGlassError("Justification is required")
        if len(justification) < 10:
            raise BreakGlassError("Justification must be at least 10 characters")

        override = BreakGlassOverride(
            override_id=str(uuid.uuid4()),
            operator=operator,
            justification=justification,
            timestamp=datetime.now(timezone.utc),
            original_decision=original_decision,
            override_action=override_action,
            expiry=datetime.now(timezone.utc) + (expiry or self._expiry),
        )

        # Sign the override
        override.signature = self._sign(override)

        # Log to separate ledger
        self._log_override(override)

        # Generate alert
        self._alert(override)

        logger.warning(
            f"Break-glass override created: id={override.override_id[:8]}... "
            f"operator={operator} action={override_action.value}"
        )

        return override

    def create_session(
        self,
        operator: str,
        justification: str,
        allowed_operations: Optional[list[str]] = None,
        expiry: Optional[timedelta] = None,
    ) -> BreakGlassSession:
        """Create a break-glass session for multiple operations.

        Args:
            operator: Who is requesting the session
            justification: Why the session is needed
            allowed_operations: Operation types allowed (empty = all)
            expiry: Session expiry time

        Returns:
            The created session
        """
        if not operator:
            raise BreakGlassError("Operator is required")
        if not justification:
            raise BreakGlassError("Justification is required")

        expiry = expiry or self._expiry
        if expiry > self.MAX_SESSION_EXPIRY:
            expiry = self.MAX_SESSION_EXPIRY

        session = BreakGlassSession(
            session_id=str(uuid.uuid4()),
            operator=operator,
            justification=justification,
            started_at=datetime.now(timezone.utc),
            expiry=datetime.now(timezone.utc) + expiry,
            allowed_operations=allowed_operations or [],
        )

        # Sign the session
        session.signature = self._sign_session(session)

        # Store
        self._active_sessions[session.session_id] = session

        # Log session creation
        self._log_session(session)

        # Alert
        self._alert_session(session)

        logger.warning(
            f"Break-glass session created: id={session.session_id[:8]}... "
            f"operator={operator} expiry={expiry}"
        )

        return session

    def validate_override(self, override: BreakGlassOverride) -> bool:
        """Validate a break-glass override.

        Args:
            override: The override to validate

        Returns:
            True if valid, False otherwise
        """
        # Check expiry
        if override.is_expired():
            logger.warning(f"Override {override.override_id[:8]}... has expired")
            return False

        # Check signature
        expected_sig = self._sign(override)
        if not hmac.compare_digest(override.signature, expected_sig):
            logger.warning(f"Override {override.override_id[:8]}... has invalid signature")
            return False

        return True

    def validate_session(self, session_id: str, operation_type: str) -> bool:
        """Validate a session for an operation.

        Args:
            session_id: The session ID
            operation_type: The operation type to check

        Returns:
            True if session is valid for this operation
        """
        session = self._active_sessions.get(session_id)
        if not session:
            return False

        if session.is_expired():
            del self._active_sessions[session_id]
            return False

        if not session.allows_operation(operation_type):
            return False

        # Increment usage
        session.used_count += 1
        return True

    def get_session(self, session_id: str) -> Optional[BreakGlassSession]:
        """Get an active session by ID.

        Args:
            session_id: The session ID

        Returns:
            The session if active, None otherwise
        """
        session = self._active_sessions.get(session_id)
        if session and session.is_expired():
            del self._active_sessions[session_id]
            return None
        return session

    def end_session(self, session_id: str) -> bool:
        """End an active session.

        Args:
            session_id: The session ID

        Returns:
            True if session was ended, False if not found
        """
        if session_id in self._active_sessions:
            session = self._active_sessions.pop(session_id)
            logger.info(
                f"Break-glass session ended: id={session_id[:8]}... "
                f"operations={session.used_count}"
            )
            return True
        return False

    def _sign(self, override: BreakGlassOverride) -> str:
        """Sign an override."""
        data = json.dumps({
            "override_id": override.override_id,
            "operator": override.operator,
            "timestamp": override.timestamp.isoformat(),
            "expiry": override.expiry.isoformat(),
            "original_proposal_id": override.original_decision.proposal_id,
            "override_action": override.override_action.value,
        }, sort_keys=True)
        return hmac.new(self._signing_key, data.encode(), hashlib.sha256).hexdigest()

    def _sign_session(self, session: BreakGlassSession) -> str:
        """Sign a session."""
        data = json.dumps({
            "session_id": session.session_id,
            "operator": session.operator,
            "started_at": session.started_at.isoformat(),
            "expiry": session.expiry.isoformat(),
            "allowed_operations": session.allowed_operations,
        }, sort_keys=True)
        return hmac.new(self._signing_key, data.encode(), hashlib.sha256).hexdigest()

    def _log_override(self, override: BreakGlassOverride) -> None:
        """Log override to separate ledger."""
        entry = override.to_dict()

        with open(self._ledger_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

    def _log_session(self, session: BreakGlassSession) -> None:
        """Log session creation."""
        entry = {
            "type": "session_start",
            "session_id": session.session_id,
            "operator": session.operator,
            "justification": session.justification,
            "started_at": session.started_at.isoformat(),
            "expiry": session.expiry.isoformat(),
            "allowed_operations": session.allowed_operations,
            "signature": session.signature,
        }

        with open(self._ledger_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

    def _alert(self, override: BreakGlassOverride) -> None:
        """Generate alert for break-glass event."""
        alert_data = {
            "type": "break_glass_override",
            "override_id": override.override_id,
            "operator": override.operator,
            "justification": override.justification,
            "original_action": override.original_decision.action.value,
            "override_action": override.override_action.value,
            "expiry": override.expiry.isoformat(),
        }

        for handler in self._alert_handlers:
            try:
                handler(alert_data)
            except Exception as e:
                logger.error(f"Alert handler failed: {e}")

        # Always log
        logger.warning(
            "break_glass_activated",
            extra=alert_data
        )

    def _alert_session(self, session: BreakGlassSession) -> None:
        """Generate alert for session creation."""
        alert_data = {
            "type": "break_glass_session",
            "session_id": session.session_id,
            "operator": session.operator,
            "justification": session.justification,
            "expiry": session.expiry.isoformat(),
        }

        for handler in self._alert_handlers:
            try:
                handler(alert_data)
            except Exception as e:
                logger.error(f"Alert handler failed: {e}")

        logger.warning("break_glass_session_started", extra=alert_data)

    def get_stats(self) -> dict:
        """Get break-glass statistics.

        Returns:
            Dictionary with statistics
        """
        # Count overrides from ledger
        override_count = 0
        if self._ledger_path.exists():
            with open(self._ledger_path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        override_count += 1

        return {
            "total_overrides": override_count,
            "active_sessions": len(self._active_sessions),
            "default_expiry_hours": self._expiry.total_seconds() / 3600,
        }

    def get_active_sessions(self) -> list[BreakGlassSession]:
        """Get all active sessions.

        Returns:
            List of active sessions
        """
        # Clean up expired
        expired = [
            sid for sid, s in self._active_sessions.items()
            if s.is_expired()
        ]
        for sid in expired:
            del self._active_sessions[sid]

        return list(self._active_sessions.values())


def log_alert_handler(alert_data: dict) -> None:
    """Default alert handler that logs to structlog."""
    logger.warning(
        f"BREAK-GLASS ALERT: {alert_data.get('type')}",
        extra=alert_data
    )
