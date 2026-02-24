"""
Quorum Approval Workflow for Multi-Party Authorization.

Implements Phase 4 Enterprise:
- Multi-party approval for high-risk operations
- Configurable quorum requirements per risk level
- Approval request lifecycle management
- Cryptographic approver identity verification

Core Principle: High-risk operations require multiple approvers.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from enum import Enum
from pathlib import Path
from typing import Optional
import hashlib
import hmac
import json
import logging
import threading
import uuid

from .proposal import OperationProposal
from .enforcement import EnforcementDecision
from .risk import RiskLevel

logger = logging.getLogger(__name__)


class ApprovalStatus(str, Enum):
    """Status of an approval request."""
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"
    EXECUTED = "executed"
    CANCELLED = "cancelled"


class AuthMethod(str, Enum):
    """Authentication methods for approvers."""
    PASSWORD = "password"
    MFA = "mfa"
    SSO = "sso"
    API_KEY = "api_key"
    CERTIFICATE = "certificate"


@dataclass
class ApproverIdentity:
    """Identity of an approver with authentication proof.
    
    Attributes:
        approver_id: Unique identifier for the approver
        name: Human-readable name
        role: Organizational role
        authenticated_at: When the approver was authenticated
        auth_method: How the approver was authenticated
        signature: Cryptographic signature proving identity
        session_id: Session identifier for the authentication
    """
    approver_id: str
    name: str
    role: str
    authenticated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    auth_method: AuthMethod = AuthMethod.PASSWORD
    signature: str = ""
    session_id: str = ""
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "approver_id": self.approver_id,
            "name": self.name,
            "role": self.role,
            "authenticated_at": self.authenticated_at.isoformat(),
            "auth_method": self.auth_method.value,
            "signature": self.signature,
            "session_id": self.session_id,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "ApproverIdentity":
        """Deserialize from dictionary."""
        return cls(
            approver_id=data["approver_id"],
            name=data["name"],
            role=data["role"],
            authenticated_at=datetime.fromisoformat(data["authenticated_at"]),
            auth_method=AuthMethod(data.get("auth_method", "password")),
            signature=data.get("signature", ""),
            session_id=data.get("session_id", ""),
        )


@dataclass
class ApprovalRequest:
    """Request for quorum approval of a high-risk operation.
    
    Attributes:
        request_id: Unique identifier for this request
        proposal: The operation proposal requiring approval
        decision: The enforcement decision that triggered this
        required_approvers: Number of approvers required
        current_approvals: List of approver IDs who have approved
        rejections: List of approver IDs who have rejected
        approval_records: Full records of each approval
        rejection_records: Full records of each rejection with reasons
        status: Current status of the request
        created_at: When the request was created
        expires_at: When the request expires
        executed_at: When the approved operation was executed
        executed_by: Who executed the approved operation
        metadata: Additional metadata
    """
    request_id: str
    proposal: dict  # Serialized OperationProposal
    decision: dict   # Serialized EnforcementDecision
    risk_level: str
    required_approvers: int
    current_approvals: list[str] = field(default_factory=list)
    rejections: list[str] = field(default_factory=list)
    approval_records: list[dict] = field(default_factory=list)
    rejection_records: list[dict] = field(default_factory=list)
    status: ApprovalStatus = ApprovalStatus.PENDING
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc) + timedelta(hours=24))
    executed_at: Optional[datetime] = None
    executed_by: Optional[str] = None
    metadata: dict = field(default_factory=dict)
    
    def is_approved(self) -> bool:
        """Check if the request has enough approvals."""
        return len(self.current_approvals) >= self.required_approvers
    
    def is_rejected(self) -> bool:
        """Check if the request has been rejected.
        
        Rejected if more rejections than remaining possible approvals.
        """
        remaining = self.required_approvers - len(self.current_approvals)
        return len(self.rejections) > remaining
    
    def is_expired(self) -> bool:
        """Check if the request has expired."""
        return datetime.now(timezone.utc) > self.expires_at
    
    def can_approve(self, approver_id: str) -> bool:
        """Check if an approver can still approve.
        
        Args:
            approver_id: ID of the approver
        
        Returns:
            True if the approver can approve
        """
        if self.status != ApprovalStatus.PENDING:
            return False
        if self.is_expired():
            return False
        if approver_id in self.current_approvals:
            return False
        if approver_id in self.rejections:
            return False
        return True
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "request_id": self.request_id,
            "proposal": self.proposal,
            "decision": self.decision,
            "risk_level": self.risk_level,
            "required_approvers": self.required_approvers,
            "current_approvals": self.current_approvals,
            "rejections": self.rejections,
            "approval_records": self.approval_records,
            "rejection_records": self.rejection_records,
            "status": self.status.value,
            "created_at": self.created_at.isoformat(),
            "expires_at": self.expires_at.isoformat(),
            "executed_at": self.executed_at.isoformat() if self.executed_at else None,
            "executed_by": self.executed_by,
            "metadata": self.metadata,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "ApprovalRequest":
        """Deserialize from dictionary."""
        executed_at = None
        if data.get("executed_at"):
            executed_at = datetime.fromisoformat(data["executed_at"])
        
        return cls(
            request_id=data["request_id"],
            proposal=data["proposal"],
            decision=data["decision"],
            risk_level=data.get("risk_level", "L3"),
            required_approvers=data["required_approvers"],
            current_approvals=data.get("current_approvals", []),
            rejections=data.get("rejections", []),
            approval_records=data.get("approval_records", []),
            rejection_records=data.get("rejection_records", []),
            status=ApprovalStatus(data.get("status", "pending")),
            created_at=datetime.fromisoformat(data["created_at"]),
            expires_at=datetime.fromisoformat(data["expires_at"]),
            executed_at=executed_at,
            executed_by=data.get("executed_by"),
            metadata=data.get("metadata", {}),
        )


class QuorumManager:
    """Manage multi-party approval for high-risk operations.
    
    Quorum requirements are configured per risk level:
    - L1: No approval required
    - L2: 1 approver (single confirmation)
    - L3: 2+ approvers (full quorum)
    
    Core Principle: High-risk operations require multiple independent approvers.
    """
    
    DEFAULT_QUORUM_CONFIG = {
        RiskLevel.L1: 0,  # No approval
        RiskLevel.L2: 1,  # Single approver
        RiskLevel.L3: 2,  # Quorum of 2
    }
    
    def __init__(
        self,
        approval_store_path: Path,
        signing_key: bytes,
        quorum_config: Optional[dict[RiskLevel, int]] = None,
        default_expiry_hours: int = 24,
    ):
        """Initialize the quorum manager.
        
        Args:
            approval_store_path: Path to store approval requests
            signing_key: Key for signing approver identities
            quorum_config: Override default quorum requirements
            default_expiry_hours: Hours until requests expire
        """
        self._store_path = Path(approval_store_path)
        self._signing_key = signing_key
        self._quorum_config = quorum_config or self.DEFAULT_QUORUM_CONFIG.copy()
        self._default_expiry = timedelta(hours=default_expiry_hours)
        self._lock = threading.RLock()
        
        self._store_path.mkdir(parents=True, exist_ok=True)
    
    def create_request(
        self,
        proposal: OperationProposal,
        decision: EnforcementDecision,
        expiry_hours: Optional[int] = None,
        metadata: Optional[dict] = None,
    ) -> ApprovalRequest:
        """Create an approval request for a high-risk operation.
        
        Args:
            proposal: The operation proposal
            decision: The enforcement decision
            expiry_hours: Override default expiry time
            metadata: Additional metadata
        
        Returns:
            Created ApprovalRequest
        """
        with self._lock:
            risk_level = decision.classification.level
            required = self._quorum_config.get(risk_level, 2)
            
            # If no approval required, return immediately approved
            if required == 0:
                request = ApprovalRequest(
                    request_id=str(uuid.uuid4()),
                    proposal=proposal.to_dict() if hasattr(proposal, 'to_dict') else proposal,
                    decision=decision.to_dict() if hasattr(decision, 'to_dict') else decision,
                    risk_level=risk_level.value,
                    required_approvers=0,
                    status=ApprovalStatus.APPROVED,
                    metadata=metadata or {},
                )
                self._store_request(request)
                return request
            
            expiry = timedelta(hours=expiry_hours) if expiry_hours else self._default_expiry
            
            request = ApprovalRequest(
                request_id=str(uuid.uuid4()),
                proposal=proposal.to_dict() if hasattr(proposal, 'to_dict') else proposal,
                decision=decision.to_dict() if hasattr(decision, 'to_dict') else decision,
                risk_level=risk_level.value,
                required_approvers=required,
                expires_at=datetime.now(timezone.utc) + expiry,
                metadata=metadata or {},
            )
            
            self._store_request(request)
            self._notify_approvers(request)
            
            logger.info(
                f"Created approval request {request.request_id[:8]}... "
                f"(risk={risk_level.value}, required={required})"
            )
            
            return request
    
    def add_approval(
        self,
        request_id: str,
        approver: ApproverIdentity,
    ) -> ApprovalRequest:
        """Add an approval to a pending request.
        
        Args:
            request_id: ID of the request
            approver: Identity of the approver
        
        Returns:
            Updated ApprovalRequest
        
        Raises:
            ValueError: If request is not pending, expired, or approver invalid
        """
        with self._lock:
            request = self._load_request(request_id)
            
            if request.status != ApprovalStatus.PENDING:
                raise ValueError(f"Request is not pending: {request.status.value}")
            
            if request.is_expired():
                request.status = ApprovalStatus.EXPIRED
                self._store_request(request)
                raise ValueError("Request has expired")
            
            # Verify approver identity
            if not self._verify_approver(approver):
                raise ValueError("Approver identity verification failed")
            
            # Check for duplicate approval
            if approver.approver_id in request.current_approvals:
                raise ValueError("Approver has already approved")
            
            if approver.approver_id in request.rejections:
                raise ValueError("Approver has already rejected")
            
            # Add approval
            request.current_approvals.append(approver.approver_id)
            request.approval_records.append({
                "approver": approver.to_dict(),
                "approved_at": datetime.now(timezone.utc).isoformat(),
            })
            
            # Update status
            if request.is_approved():
                request.status = ApprovalStatus.APPROVED
                logger.info(
                    f"Request {request_id[:8]}... APPROVED "
                    f"({len(request.current_approvals)}/{request.required_approvers})"
                )
            elif request.is_rejected():
                request.status = ApprovalStatus.REJECTED
                logger.warning(
                    f"Request {request_id[:8]}... REJECTED "
                    f"({len(request.rejections)} rejections)"
                )
            
            self._store_request(request)
            self._log_approval(request, approver)
            
            return request
    
    def add_rejection(
        self,
        request_id: str,
        approver: ApproverIdentity,
        reason: str,
    ) -> ApprovalRequest:
        """Add a rejection to a pending request.
        
        Args:
            request_id: ID of the request
            approver: Identity of the approver
            reason: Reason for rejection
        
        Returns:
            Updated ApprovalRequest
        
        Raises:
            ValueError: If request is not pending or approver invalid
        """
        with self._lock:
            request = self._load_request(request_id)
            
            if request.status != ApprovalStatus.PENDING:
                raise ValueError(f"Request is not pending: {request.status.value}")
            
            # Verify approver identity
            if not self._verify_approver(approver):
                raise ValueError("Approver identity verification failed")
            
            # Check for duplicate
            if approver.approver_id in request.rejections:
                raise ValueError("Approver has already rejected")
            
            if approver.approver_id in request.current_approvals:
                raise ValueError("Approver has already approved")
            
            # Add rejection
            request.rejections.append(approver.approver_id)
            request.rejection_records.append({
                "approver": approver.to_dict(),
                "rejected_at": datetime.now(timezone.utc).isoformat(),
                "reason": reason,
            })
            
            # Update status
            if request.is_rejected():
                request.status = ApprovalStatus.REJECTED
                logger.warning(
                    f"Request {request_id[:8]}... REJECTED "
                    f"({len(request.rejections)} rejections)"
                )
            
            self._store_request(request)
            self._log_rejection(request, approver, reason)
            
            return request
    
    def cancel_request(
        self,
        request_id: str,
        cancelled_by: str,
        reason: str,
    ) -> ApprovalRequest:
        """Cancel a pending request.
        
        Args:
            request_id: ID of the request
            cancelled_by: Who cancelled the request
            reason: Reason for cancellation
        
        Returns:
            Updated ApprovalRequest
        """
        with self._lock:
            request = self._load_request(request_id)
            
            if request.status not in (ApprovalStatus.PENDING, ApprovalStatus.APPROVED):
                raise ValueError(f"Cannot cancel request in state: {request.status.value}")
            
            request.status = ApprovalStatus.CANCELLED
            request.metadata["cancelled_by"] = cancelled_by
            request.metadata["cancellation_reason"] = reason
            request.metadata["cancelled_at"] = datetime.now(timezone.utc).isoformat()
            
            self._store_request(request)
            
            logger.info(
                f"Request {request_id[:8]}... CANCELLED by {cancelled_by}: {reason}"
            )
            
            return request
    
    def execute_approved(
        self,
        request_id: str,
        executed_by: str,
    ) -> ApprovalRequest:
        """Mark an approved request as executed.
        
        Args:
            request_id: ID of the request
            executed_by: Who executed the approved operation
        
        Returns:
            Updated ApprovalRequest
        
        Raises:
            ValueError: If request is not approved
        """
        with self._lock:
            request = self._load_request(request_id)
            
            if request.status != ApprovalStatus.APPROVED:
                raise ValueError(f"Request is not approved: {request.status.value}")
            
            request.status = ApprovalStatus.EXECUTED
            request.executed_at = datetime.now(timezone.utc)
            request.executed_by = executed_by
            
            self._store_request(request)
            self._log_execution(request)
            
            logger.info(
                f"Request {request_id[:8]}... EXECUTED by {executed_by}"
            )
            
            return request
    
    def get_request(self, request_id: str) -> Optional[ApprovalRequest]:
        """Get a request by ID."""
        return self._load_request(request_id)
    
    def get_pending_requests(self) -> list[ApprovalRequest]:
        """Get all pending approval requests."""
        requests = []
        for file in self._store_path.glob("*.json"):
            try:
                request = self._load_request(file.stem)
                if request.status == ApprovalStatus.PENDING:
                    requests.append(request)
            except Exception:
                continue
        return requests
    
    def get_requests_by_status(self, status: ApprovalStatus) -> list[ApprovalRequest]:
        """Get all requests with a specific status."""
        requests = []
        for file in self._store_path.glob("*.json"):
            try:
                request = self._load_request(file.stem)
                if request.status == status:
                    requests.append(request)
            except Exception:
                continue
        return requests
    
    def get_stats(self) -> dict:
        """Get quorum manager statistics."""
        all_requests = []
        for file in self._store_path.glob("*.json"):
            try:
                all_requests.append(self._load_request(file.stem))
            except Exception:
                continue
        
        by_status: dict[str, int] = {}
        for r in all_requests:
            by_status[r.status.value] = by_status.get(r.status.value, 0) + 1
        
        return {
            "total_requests": len(all_requests),
            "by_status": by_status,
            "quorum_config": {k.value: v for k, v in self._quorum_config.items()},
        }
    
    def create_approver_identity(
        self,
        approver_id: str,
        name: str,
        role: str,
        auth_method: AuthMethod = AuthMethod.PASSWORD,
    ) -> ApproverIdentity:
        """Create an approver identity with signature.
        
        Args:
            approver_id: Unique identifier
            name: Human-readable name
            role: Organizational role
            auth_method: Authentication method
        
        Returns:
            ApproverIdentity with signature
        """
        approver = ApproverIdentity(
            approver_id=approver_id,
            name=name,
            role=role,
            authenticated_at=datetime.now(timezone.utc),
            auth_method=auth_method,
            session_id=str(uuid.uuid4()),
        )
        
        # Sign the identity
        approver.signature = self._sign_approver(approver)
        
        return approver
    
    def _store_request(self, request: ApprovalRequest) -> None:
        """Store a request to disk."""
        path = self._store_path / f"{request.request_id}.json"
        path.write_text(json.dumps(request.to_dict(), indent=2))
    
    def _load_request(self, request_id: str) -> ApprovalRequest:
        """Load a request from disk."""
        path = self._store_path / f"{request_id}.json"
        if not path.exists():
            raise ValueError(f"Request not found: {request_id}")
        
        data = json.loads(path.read_text())
        return ApprovalRequest.from_dict(data)
    
    def _verify_approver(self, approver: ApproverIdentity) -> bool:
        """Verify an approver's identity and signature."""
        expected_sig = self._sign_approver(approver)
        return hmac.compare_digest(approver.signature, expected_sig)
    
    def _sign_approver(self, approver: ApproverIdentity) -> str:
        """Sign an approver identity."""
        data = f"{approver.approver_id}:{approver.authenticated_at.isoformat()}:{approver.session_id}"
        return hmac.new(self._signing_key, data.encode(), hashlib.sha256).hexdigest()
    
    def _notify_approvers(self, request: ApprovalRequest) -> None:
        """Notify eligible approvers of a new request."""
        # In production: send email, Slack, etc.
        logger.info(
            f"Notification: New approval request {request.request_id[:8]}... "
            f"requires {request.required_approvers} approvers"
        )
    
    def _log_approval(self, request: ApprovalRequest, approver: ApproverIdentity) -> None:
        """Log an approval."""
        logger.info(
            f"Approval added to {request.request_id[:8]}... "
            f"by {approver.approver_id} ({approver.name}) "
            f"[{len(request.current_approvals)}/{request.required_approvers}]"
        )
    
    def _log_rejection(self, request: ApprovalRequest, approver: ApproverIdentity, reason: str) -> None:
        """Log a rejection."""
        logger.warning(
            f"Rejection added to {request.request_id[:8]}... "
            f"by {approver.approver_id} ({approver.name}): {reason}"
        )
    
    def _log_execution(self, request: ApprovalRequest) -> None:
        """Log execution of an approved request."""
        logger.info(
            f"Request {request.request_id[:8]}... executed by {request.executed_by}"
        )


def create_quorum_manager(
    store_path: Path,
    signing_key: bytes,
    quorum_config: Optional[dict[RiskLevel, int]] = None,
) -> QuorumManager:
    """Factory function to create a quorum manager.
    
    Args:
        store_path: Path to store approval requests
        signing_key: Key for signing approver identities
        quorum_config: Override default quorum requirements
    
    Returns:
        Configured QuorumManager instance
    """
    return QuorumManager(
        approval_store_path=store_path,
        signing_key=signing_key,
        quorum_config=quorum_config,
    )
