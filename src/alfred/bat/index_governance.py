"""
Index Rebuild Governance with Anomaly Quarantine.

Implements SECURITY ELEVATION Phase 3:
- Governed index rebuild operations
- Anomaly quarantine with isolation
- Rebuild approval gates
- Progress tracking and failure recovery

Core Principle: Index mutations are first-class governed operations.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional, Callable, Any
from collections.abc import Iterator
import hashlib
import json
import logging
import os
import threading
import uuid

logger = logging.getLogger(__name__)


class RebuildStatus(str, Enum):
    """Status of an index rebuild operation."""
    PENDING = "pending"
    APPROVED = "approved"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"
    CANCELLED = "cancelled"


class QuarantineReason(str, Enum):
    """Reasons for quarantining an artifact."""
    EMBEDDING_MISMATCH = "embedding_mismatch"
    CONTENT_HASH_MISMATCH = "content_hash_mismatch"
    DIMENSION_MISMATCH = "dimension_mismatch"
    MODEL_INCOMPATIBILITY = "model_incompatibility"
    CORRUPTION_DETECTED = "corruption_detected"
    MANUAL_QUARANTINE = "manual_quarantine"
    REBUILD_FAILURE = "rebuild_failure"
    ANOMALY_DETECTED = "anomaly_detected"


class RebuildApprovalStatus(str, Enum):
    """Approval status for rebuild operations."""
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"


@dataclass
class QuarantinedArtifact:
    """An artifact that has been quarantined.
    
    Attributes:
        quarantine_id: Unique identifier for this quarantine record
        artifact_id: ID of the quarantined artifact
        reason: Reason for quarantine
        quarantined_at: When the artifact was quarantined
        quarantined_by: Agent that initiated quarantine
        original_data: Original artifact data (for potential restoration)
        evidence: Evidence supporting the quarantine decision
        review_notes: Notes from manual review
        resolution: How the quarantine was resolved
        resolved_at: When the quarantine was resolved
    """
    quarantine_id: str
    artifact_id: str
    reason: QuarantineReason
    quarantined_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    quarantined_by: str = ""
    original_data: dict = field(default_factory=dict)
    evidence: dict = field(default_factory=dict)
    review_notes: str = ""
    resolution: str = ""
    resolved_at: Optional[datetime] = None
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "quarantine_id": self.quarantine_id,
            "artifact_id": self.artifact_id,
            "reason": self.reason.value,
            "quarantined_at": self.quarantined_at.isoformat(),
            "quarantined_by": self.quarantined_by,
            "original_data": self.original_data,
            "evidence": self.evidence,
            "review_notes": self.review_notes,
            "resolution": self.resolution,
            "resolved_at": self.resolved_at.isoformat() if self.resolved_at else None,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "QuarantinedArtifact":
        """Deserialize from dictionary."""
        resolved_at = None
        if data.get("resolved_at"):
            resolved_at = datetime.fromisoformat(data["resolved_at"])
        
        return cls(
            quarantine_id=data["quarantine_id"],
            artifact_id=data["artifact_id"],
            reason=QuarantineReason(data["reason"]),
            quarantined_at=datetime.fromisoformat(data["quarantined_at"]),
            quarantined_by=data.get("quarantined_by", ""),
            original_data=data.get("original_data", {}),
            evidence=data.get("evidence", {}),
            review_notes=data.get("review_notes", ""),
            resolution=data.get("resolution", ""),
            resolved_at=resolved_at,
        )


@dataclass
class RebuildRequest:
    """Request to rebuild the vector index.
    
    Attributes:
        request_id: Unique identifier for this request
        source_model_id: Current model ID
        target_model_id: Target model ID for rebuild
        total_vectors: Total vectors to rebuild
        justification: Reason for the rebuild
        requested_by: Agent requesting the rebuild
        requested_at: When the request was made
        approval_status: Current approval status
        approved_by: Agent that approved (if any)
        approved_at: When approved (if applicable)
        expires_at: When this request expires
    """
    request_id: str
    source_model_id: str
    target_model_id: str
    total_vectors: int = 0
    justification: str = ""
    requested_by: str = ""
    requested_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    approval_status: RebuildApprovalStatus = RebuildApprovalStatus.PENDING
    approved_by: str = ""
    approved_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    
    def __post_init__(self):
        """Set default expiration if not provided."""
        if not self.expires_at:
            # Default 24-hour expiration
            from datetime import timedelta
            self.expires_at = self.requested_at + timedelta(hours=24)
    
    def is_expired(self) -> bool:
        """Check if this request has expired."""
        if not self.expires_at:
            return False
        return datetime.now(timezone.utc) > self.expires_at
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "request_id": self.request_id,
            "source_model_id": self.source_model_id,
            "target_model_id": self.target_model_id,
            "total_vectors": self.total_vectors,
            "justification": self.justification,
            "requested_by": self.requested_by,
            "requested_at": self.requested_at.isoformat(),
            "approval_status": self.approval_status.value,
            "approved_by": self.approved_by,
            "approved_at": self.approved_at.isoformat() if self.approved_at else None,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "RebuildRequest":
        """Deserialize from dictionary."""
        approved_at = None
        if data.get("approved_at"):
            approved_at = datetime.fromisoformat(data["approved_at"])
        
        expires_at = None
        if data.get("expires_at"):
            expires_at = datetime.fromisoformat(data["expires_at"])
        
        return cls(
            request_id=data["request_id"],
            source_model_id=data["source_model_id"],
            target_model_id=data["target_model_id"],
            total_vectors=data.get("total_vectors", 0),
            justification=data.get("justification", ""),
            requested_by=data.get("requested_by", ""),
            requested_at=datetime.fromisoformat(data["requested_at"]),
            approval_status=RebuildApprovalStatus(data.get("approval_status", "pending")),
            approved_by=data.get("approved_by", ""),
            approved_at=approved_at,
            expires_at=expires_at,
        )


@dataclass
class RebuildProgress:
    """Progress tracking for an index rebuild.
    
    Attributes:
        rebuild_id: Unique identifier for this rebuild
        request_id: ID of the original request
        status: Current status
        started_at: When the rebuild started
        completed_at: When the rebuild completed
        total_vectors: Total vectors to process
        processed_vectors: Vectors processed so far
        successful_vectors: Vectors successfully rebuilt
        failed_vectors: Vectors that failed
        quarantined_vectors: Vectors sent to quarantine
        current_batch: Current batch number
        total_batches: Total batches
        error_message: Error message if failed
        pre_rebuild_hash: Index hash before rebuild
        post_rebuild_hash: Index hash after rebuild
    """
    rebuild_id: str
    request_id: str
    status: RebuildStatus = RebuildStatus.PENDING
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    total_vectors: int = 0
    processed_vectors: int = 0
    successful_vectors: int = 0
    failed_vectors: int = 0
    quarantined_vectors: int = 0
    current_batch: int = 0
    total_batches: int = 0
    error_message: str = ""
    pre_rebuild_hash: str = ""
    post_rebuild_hash: str = ""
    
    @property
    def progress_percent(self) -> float:
        """Calculate progress percentage."""
        if self.total_vectors == 0:
            return 0.0
        return (self.processed_vectors / self.total_vectors) * 100
    
    @property
    def success_rate(self) -> float:
        """Calculate success rate."""
        if self.processed_vectors == 0:
            return 1.0
        return self.successful_vectors / self.processed_vectors
    
    @property
    def quarantine_rate(self) -> float:
        """Calculate quarantine rate."""
        if self.processed_vectors == 0:
            return 0.0
        return self.quarantined_vectors / self.processed_vectors
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "rebuild_id": self.rebuild_id,
            "request_id": self.request_id,
            "status": self.status.value,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "total_vectors": self.total_vectors,
            "processed_vectors": self.processed_vectors,
            "successful_vectors": self.successful_vectors,
            "failed_vectors": self.failed_vectors,
            "quarantined_vectors": self.quarantined_vectors,
            "current_batch": self.current_batch,
            "total_batches": self.total_batches,
            "progress_percent": self.progress_percent,
            "success_rate": self.success_rate,
            "quarantine_rate": self.quarantine_rate,
            "error_message": self.error_message,
            "pre_rebuild_hash": self.pre_rebuild_hash,
            "post_rebuild_hash": self.post_rebuild_hash,
        }


class AnomalyQuarantine:
    """Quarantine zone for anomalous artifacts.
    
    Provides isolation for artifacts that fail validation
    during index rebuilds or normal operations.
    
    Core Principle: Quarantine is fail-safe; artifacts are
    isolated until explicitly reviewed and approved.
    """
    
    def __init__(self, quarantine_path: Optional[Path] = None):
        """Initialize the quarantine zone.
        
        Args:
            quarantine_path: Path to store quarantine data
        """
        self._path = quarantine_path
        self._quarantined: dict[str, QuarantinedArtifact] = {}
        self._lock = threading.RLock()
        
        if self._path:
            self._load_quarantine()
    
    def _load_quarantine(self) -> None:
        """Load quarantine data from disk."""
        if not self._path or not self._path.exists():
            return
        
        try:
            data_file = self._path / "quarantine.json"
            if data_file.exists():
                with open(data_file, 'r') as f:
                    data = json.load(f)
                
                for item in data.get("quarantined", []):
                    artifact = QuarantinedArtifact.from_dict(item)
                    self._quarantined[artifact.quarantine_id] = artifact
                
                logger.info(f"Loaded {len(self._quarantined)} quarantined artifacts")
        except Exception as e:
            logger.error(f"Failed to load quarantine data: {e}")
    
    def _save_quarantine(self) -> None:
        """Save quarantine data to disk."""
        if not self._path:
            return
        
        try:
            self._path.mkdir(parents=True, exist_ok=True)
            data_file = self._path / "quarantine.json"
            
            data = {
                "version": "1.0",
                "quarantined": [a.to_dict() for a in self._quarantined.values()],
            }
            
            with open(data_file, 'w') as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save quarantine data: {e}")
    
    def quarantine(
        self,
        artifact_id: str,
        reason: QuarantineReason,
        original_data: dict,
        evidence: Optional[dict] = None,
        quarantined_by: str = "",
    ) -> QuarantinedArtifact:
        """Quarantine an artifact.
        
        Args:
            artifact_id: ID of the artifact to quarantine
            reason: Reason for quarantine
            original_data: Original artifact data
            evidence: Evidence supporting quarantine
            quarantined_by: Agent that initiated quarantine
        
        Returns:
            QuarantinedArtifact record
        """
        with self._lock:
            quarantine_id = str(uuid.uuid4())
            
            quarantined = QuarantinedArtifact(
                quarantine_id=quarantine_id,
                artifact_id=artifact_id,
                reason=reason,
                original_data=original_data,
                evidence=evidence or {},
                quarantined_by=quarantined_by,
            )
            
            self._quarantined[quarantine_id] = quarantined
            self._save_quarantine()
            
            logger.warning(
                f"Quarantined artifact {artifact_id[:8]}... "
                f"(reason={reason.value}, quarantine_id={quarantine_id[:8]}...)"
            )
            
            return quarantined
    
    def release(
        self,
        quarantine_id: str,
        resolution: str,
    ) -> Optional[QuarantinedArtifact]:
        """Release an artifact from quarantine.
        
        Args:
            quarantine_id: ID of the quarantine record
            resolution: Resolution description
        
        Returns:
            Updated QuarantinedArtifact, or None if not found
        """
        with self._lock:
            if quarantine_id not in self._quarantined:
                return None
            
            artifact = self._quarantined[quarantine_id]
            artifact.resolution = resolution
            artifact.resolved_at = datetime.now(timezone.utc)
            
            self._save_quarantine()
            
            logger.info(
                f"Released artifact {artifact.artifact_id[:8]}... from quarantine "
                f"(resolution={resolution})"
            )
            
            return artifact
    
    def purge(
        self,
        quarantine_id: str,
        purged_by: str = "",
    ) -> bool:
        """Purge a quarantined artifact permanently.
        
        Args:
            quarantine_id: ID of the quarantine record
            purged_by: Agent performing the purge
        
        Returns:
            True if purged, False if not found
        """
        with self._lock:
            if quarantine_id not in self._quarantined:
                return False
            
            artifact = self._quarantined[quarantine_id]
            artifact.resolution = f"Purged by {purged_by}"
            artifact.resolved_at = datetime.now(timezone.utc)
            
            # Remove from active quarantine
            del self._quarantined[quarantine_id]
            self._save_quarantine()
            
            logger.warning(
                f"Purged quarantined artifact {artifact.artifact_id[:8]}... "
                f"(quarantine_id={quarantine_id[:8]}...)"
            )
            
            return True
    
    def get(self, quarantine_id: str) -> Optional[QuarantinedArtifact]:
        """Get a quarantined artifact by ID."""
        return self._quarantined.get(quarantine_id)
    
    def get_by_artifact(self, artifact_id: str) -> list[QuarantinedArtifact]:
        """Get all quarantine records for an artifact."""
        return [
            a for a in self._quarantined.values()
            if a.artifact_id == artifact_id and not a.resolved_at
        ]
    
    def list_active(self) -> list[QuarantinedArtifact]:
        """List all active (unresolved) quarantined artifacts."""
        return [a for a in self._quarantined.values() if not a.resolved_at]
    
    def get_stats(self) -> dict:
        """Get quarantine statistics."""
        active = [a for a in self._quarantined.values() if not a.resolved_at]
        resolved = [a for a in self._quarantined.values() if a.resolved_at]
        
        by_reason: dict[str, int] = {}
        for a in active:
            by_reason[a.reason.value] = by_reason.get(a.reason.value, 0) + 1
        
        return {
            "total_quarantined": len(self._quarantined),
            "active_count": len(active),
            "resolved_count": len(resolved),
            "by_reason": by_reason,
        }


class IndexRebuildGovernor:
    """Governor for index rebuild operations.
    
    Provides governed rebuild process with:
    - Approval gates
    - Progress tracking
    - Anomaly quarantine
    - Rollback capability
    
    Core Principle: Index rebuilds are governed mutations
    requiring explicit approval and full audit trail.
    """
    
    def __init__(
        self,
        quarantine: AnomalyQuarantine,
        approval_timeout_hours: int = 24,
        max_quarantine_rate: float = 0.1,
        min_success_rate: float = 0.95,
    ):
        """Initialize the rebuild governor.
        
        Args:
            quarantine: Anomaly quarantine instance
            approval_timeout_hours: Hours before approval expires
            max_quarantine_rate: Maximum allowed quarantine rate
            min_success_rate: Minimum required success rate
        """
        self._quarantine = quarantine
        self._approval_timeout = approval_timeout_hours
        self._max_quarantine_rate = max_quarantine_rate
        self._min_success_rate = min_success_rate
        self._requests: dict[str, RebuildRequest] = {}
        self._progress: dict[str, RebuildProgress] = {}
        self._lock = threading.RLock()
    
    def create_request(
        self,
        source_model_id: str,
        target_model_id: str,
        total_vectors: int,
        justification: str,
        requested_by: str,
    ) -> RebuildRequest:
        """Create a rebuild request.
        
        Args:
            source_model_id: Current model ID
            target_model_id: Target model ID
            total_vectors: Total vectors to rebuild
            justification: Reason for rebuild
            requested_by: Agent requesting rebuild
        
        Returns:
            RebuildRequest awaiting approval
        """
        with self._lock:
            from datetime import timedelta
            
            request = RebuildRequest(
                request_id=str(uuid.uuid4()),
                source_model_id=source_model_id,
                target_model_id=target_model_id,
                total_vectors=total_vectors,
                justification=justification,
                requested_by=requested_by,
                expires_at=datetime.now(timezone.utc) + timedelta(hours=self._approval_timeout),
            )
            
            self._requests[request.request_id] = request
            
            logger.info(
                f"Created rebuild request {request.request_id[:8]}... "
                f"({source_model_id} -> {target_model_id}, {total_vectors} vectors)"
            )
            
            return request
    
    def approve_request(
        self,
        request_id: str,
        approved_by: str,
    ) -> Optional[RebuildRequest]:
        """Approve a rebuild request.
        
        Args:
            request_id: ID of the request
            approved_by: Agent approving the request
        
        Returns:
            Approved RebuildRequest, or None if not found/expired
        """
        with self._lock:
            request = self._requests.get(request_id)
            if not request:
                return None
            
            if request.is_expired():
                request.approval_status = RebuildApprovalStatus.EXPIRED
                return None
            
            request.approval_status = RebuildApprovalStatus.APPROVED
            request.approved_by = approved_by
            request.approved_at = datetime.now(timezone.utc)
            
            logger.info(
                f"Approved rebuild request {request_id[:8]}... "
                f"(approved_by={approved_by})"
            )
            
            return request
    
    def reject_request(
        self,
        request_id: str,
        rejected_by: str,
        reason: str = "",
    ) -> Optional[RebuildRequest]:
        """Reject a rebuild request.
        
        Args:
            request_id: ID of the request
            rejected_by: Agent rejecting the request
            reason: Reason for rejection
        
        Returns:
            Rejected RebuildRequest, or None if not found
        """
        with self._lock:
            request = self._requests.get(request_id)
            if not request:
                return None
            
            request.approval_status = RebuildApprovalStatus.REJECTED
            
            logger.info(
                f"Rejected rebuild request {request_id[:8]}... "
                f"(rejected_by={rejected_by}, reason={reason})"
            )
            
            return request
    
    def start_rebuild(
        self,
        request_id: str,
        pre_rebuild_hash: str,
        batch_size: int = 100,
    ) -> Optional[RebuildProgress]:
        """Start a rebuild operation.
        
        Args:
            request_id: ID of the approved request
            pre_rebuild_hash: Hash of index before rebuild
            batch_size: Number of vectors per batch
        
        Returns:
            RebuildProgress tracker, or None if not approved
        """
        with self._lock:
            request = self._requests.get(request_id)
            if not request:
                return None
            
            if request.approval_status != RebuildApprovalStatus.APPROVED:
                return None
            
            if request.is_expired():
                request.approval_status = RebuildApprovalStatus.EXPIRED
                return None
            
            rebuild_id = str(uuid.uuid4())
            total_batches = (request.total_vectors + batch_size - 1) // batch_size
            
            progress = RebuildProgress(
                rebuild_id=rebuild_id,
                request_id=request_id,
                status=RebuildStatus.IN_PROGRESS,
                started_at=datetime.now(timezone.utc),
                total_vectors=request.total_vectors,
                total_batches=total_batches,
                pre_rebuild_hash=pre_rebuild_hash,
            )
            
            self._progress[rebuild_id] = progress
            
            logger.info(
                f"Started rebuild {rebuild_id[:8]}... "
                f"({request.total_vectors} vectors in {total_batches} batches)"
            )
            
            return progress
    
    def update_progress(
        self,
        rebuild_id: str,
        processed: int,
        successful: int,
        failed: int,
        quarantined: int,
    ) -> Optional[RebuildProgress]:
        """Update rebuild progress.
        
        Args:
            rebuild_id: ID of the rebuild
            processed: Total vectors processed
            successful: Successfully rebuilt vectors
            failed: Failed vectors
            quarantined: Vectors sent to quarantine
        
        Returns:
            Updated RebuildProgress, or None if not found
        """
        with self._lock:
            progress = self._progress.get(rebuild_id)
            if not progress:
                return None
            
            progress.processed_vectors = processed
            progress.successful_vectors = successful
            progress.failed_vectors = failed
            progress.quarantined_vectors = quarantined
            
            # Check for failure conditions
            if progress.quarantine_rate > self._max_quarantine_rate:
                logger.error(
                    f"Rebuild {rebuild_id[:8]}... exceeded max quarantine rate "
                    f"({progress.quarantine_rate:.2%} > {self._max_quarantine_rate:.2%})"
                )
                # Don't auto-fail; let the caller decide
            
            if progress.success_rate < self._min_success_rate:
                logger.error(
                    f"Rebuild {rebuild_id[:8]}... below min success rate "
                    f"({progress.success_rate:.2%} < {self._min_success_rate:.2%})"
                )
            
            return progress
    
    def complete_rebuild(
        self,
        rebuild_id: str,
        post_rebuild_hash: str,
    ) -> Optional[RebuildProgress]:
        """Mark a rebuild as completed.
        
        Args:
            rebuild_id: ID of the rebuild
            post_rebuild_hash: Hash of index after rebuild
        
        Returns:
            Completed RebuildProgress, or None if not found
        """
        with self._lock:
            progress = self._progress.get(rebuild_id)
            if not progress:
                return None
            
            # Validate success criteria
            if progress.quarantine_rate > self._max_quarantine_rate:
                progress.status = RebuildStatus.FAILED
                progress.error_message = (
                    f"Quarantine rate {progress.quarantine_rate:.2%} exceeds "
                    f"maximum {self._max_quarantine_rate:.2%}"
                )
            elif progress.success_rate < self._min_success_rate:
                progress.status = RebuildStatus.FAILED
                progress.error_message = (
                    f"Success rate {progress.success_rate:.2%} below "
                    f"minimum {self._min_success_rate:.2%}"
                )
            else:
                progress.status = RebuildStatus.COMPLETED
            
            progress.completed_at = datetime.now(timezone.utc)
            progress.post_rebuild_hash = post_rebuild_hash
            
            logger.info(
                f"Completed rebuild {rebuild_id[:8]}... "
                f"(status={progress.status.value}, "
                f"success_rate={progress.success_rate:.2%}, "
                f"quarantine_rate={progress.quarantine_rate:.2%})"
            )
            
            return progress
    
    def fail_rebuild(
        self,
        rebuild_id: str,
        error_message: str,
    ) -> Optional[RebuildProgress]:
        """Mark a rebuild as failed.
        
        Args:
            rebuild_id: ID of the rebuild
            error_message: Error description
        
        Returns:
            Failed RebuildProgress, or None if not found
        """
        with self._lock:
            progress = self._progress.get(rebuild_id)
            if not progress:
                return None
            
            progress.status = RebuildStatus.FAILED
            progress.error_message = error_message
            progress.completed_at = datetime.now(timezone.utc)
            
            logger.error(
                f"Failed rebuild {rebuild_id[:8]}...: {error_message}"
            )
            
            return progress
    
    def get_progress(self, rebuild_id: str) -> Optional[RebuildProgress]:
        """Get rebuild progress by ID."""
        return self._progress.get(rebuild_id)
    
    def get_request(self, request_id: str) -> Optional[RebuildRequest]:
        """Get rebuild request by ID."""
        return self._requests.get(request_id)
    
    def list_pending_requests(self) -> list[RebuildRequest]:
        """List all pending rebuild requests."""
        return [
            r for r in self._requests.values()
            if r.approval_status == RebuildApprovalStatus.PENDING
        ]
    
    def list_active_rebuilds(self) -> list[RebuildProgress]:
        """List all active rebuild operations."""
        return [
            p for p in self._progress.values()
            if p.status == RebuildStatus.IN_PROGRESS
        ]
    
    def get_stats(self) -> dict:
        """Get governor statistics."""
        pending = len(self.list_pending_requests())
        active = len(self.list_active_rebuilds())
        
        completed = [
            p for p in self._progress.values()
            if p.status == RebuildStatus.COMPLETED
        ]
        failed = [
            p for p in self._progress.values()
            if p.status == RebuildStatus.FAILED
        ]
        
        return {
            "pending_requests": pending,
            "active_rebuilds": active,
            "completed_rebuilds": len(completed),
            "failed_rebuilds": len(failed),
            "quarantine_stats": self._quarantine.get_stats(),
        }


def create_rebuild_governor(
    quarantine_path: Optional[Path] = None,
    approval_timeout_hours: int = 24,
    max_quarantine_rate: float = 0.1,
    min_success_rate: float = 0.95,
) -> tuple[AnomalyQuarantine, IndexRebuildGovernor]:
    """Factory function to create a rebuild governor with quarantine.
    
    Args:
        quarantine_path: Path to store quarantine data
        approval_timeout_hours: Hours before approval expires
        max_quarantine_rate: Maximum allowed quarantine rate
        min_success_rate: Minimum required success rate
    
    Returns:
        Tuple of (AnomalyQuarantine, IndexRebuildGovernor)
    """
    quarantine = AnomalyQuarantine(quarantine_path)
    governor = IndexRebuildGovernor(
        quarantine=quarantine,
        approval_timeout_hours=approval_timeout_hours,
        max_quarantine_rate=max_quarantine_rate,
        min_success_rate=min_success_rate,
    )
    
    return quarantine, governor
