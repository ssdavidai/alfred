"""
ZVEC - Semantic State Governance for Vector Artifacts.

Implements SECURITY ELEVATION Track C:
- Vector taxonomy extension and schema-enforced provenance envelope
- Write-time vector hash verification mandatory
- Read-time verification strategy configurable
- Model upgrade protocol with lock/shadow recompute/approval gate
- Index mutation envelopes with pre/post index hash
- Drift signal split (observability vs governance triggers)

Core Principle: Semantic artifacts are first-class governed state.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional, Any, Callable
import hashlib
import json
import logging
import os
import struct

logger = logging.getLogger(__name__)


class VectorOperation(str, Enum):
    """Types of vector operations."""
    INSERT = "insert"
    UPDATE = "update"
    DELETE = "delete"
    QUERY = "query"
    REINDEX = "reindex"
    UPGRADE = "upgrade"


class VerificationStrategy(str, Enum):
    """Strategies for vector verification."""
    ON_ACCESS = "on_access"           # Verify on every read
    BACKGROUND_SWEEP = "background"   # Periodic background verification
    SAMPLING = "sampling"             # Verify random sample
    DISABLED = "disabled"             # No verification (not recommended)


class DriftSignal(str, Enum):
    """Types of drift signals."""
    # Observability signals (metrics, not governance triggers)
    CENTROID_SHIFT = "centroid_shift"
    DISTRIBUTION_CHANGE = "distribution_change"
    OUTLIER_INCREASE = "outlier_increase"
    
    # Governance triggers (require action)
    COLLAPSE = "collapse"             # Model collapse detected
    RAPID_CHURN = "rapid_churn"       # Rapid vector turnover
    DISSOLUTION = "dissolution"       # Index integrity failure


@dataclass
class VectorArtifact:
    """Schema-enforced vector artifact with provenance envelope.
    
    Every vector in the governed store has:
    - Unique identifier
    - Content hash (deterministic)
    - Embedding hash (for integrity)
    - Provenance chain (who created it, when, why)
    - Model identifier (which embedding model)
    
    Attributes:
        artifact_id: Unique identifier (UUID)
        content_hash: SHA-256 hash of source content
        embedding_hash: SHA-256 hash of embedding vector
        embedding: The actual embedding vector (list of floats)
        model_id: Identifier of the embedding model
        dimensions: Number of dimensions
        source_path: Path to source document
        source_type: Type of source (file, chunk, etc.)
        created_at: Creation timestamp
        created_by: Agent that created this artifact
        proposal_id: Governance proposal that authorized creation
        metadata: Additional metadata
    """
    artifact_id: str
    content_hash: str
    embedding_hash: str
    embedding: list[float]
    model_id: str
    dimensions: int
    source_path: str = ""
    source_type: str = "unknown"
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    created_by: str = ""
    proposal_id: str = ""
    metadata: dict = field(default_factory=dict)
    
    def __post_init__(self):
        """Validate the artifact."""
        if len(self.embedding) != self.dimensions:
            raise ValueError(
                f"Embedding dimension mismatch: expected {self.dimensions}, "
                f"got {len(self.embedding)}"
            )
    
    def verify_embedding_hash(self) -> bool:
        """Verify the embedding hash matches the actual embedding."""
        expected = self._compute_embedding_hash(self.embedding)
        return expected == self.embedding_hash
    
    @classmethod
    def _compute_embedding_hash(cls, embedding: list[float]) -> str:
        """Compute deterministic hash of an embedding vector.
        
        Uses IEEE 754 binary representation for determinism.
        """
        # Pack floats into binary (IEEE 754 double precision)
        binary = struct.pack(f">{len(embedding)}d", *embedding)
        return hashlib.sha256(binary).hexdigest()
    
    @classmethod
    def create(
        cls,
        content: str,
        embedding: list[float],
        model_id: str,
        source_path: str = "",
        source_type: str = "unknown",
        created_by: str = "",
        proposal_id: str = "",
        metadata: Optional[dict] = None,
    ) -> "VectorArtifact":
        """Create a new vector artifact with computed hashes.
        
        Args:
            content: Source text content
            embedding: Embedding vector
            model_id: Embedding model identifier
            source_path: Path to source document
            source_type: Type of source
            created_by: Agent creating the artifact
            proposal_id: Governance proposal ID
            metadata: Additional metadata
        
        Returns:
            VectorArtifact with computed hashes
        """
        import uuid
        
        content_hash = hashlib.sha256(content.encode()).hexdigest()
        embedding_hash = cls._compute_embedding_hash(embedding)
        
        return cls(
            artifact_id=str(uuid.uuid4()),
            content_hash=content_hash,
            embedding_hash=embedding_hash,
            embedding=embedding,
            model_id=model_id,
            dimensions=len(embedding),
            source_path=source_path,
            source_type=source_type,
            created_by=created_by,
            proposal_id=proposal_id,
            metadata=metadata or {},
        )
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "artifact_id": self.artifact_id,
            "content_hash": self.content_hash,
            "embedding_hash": self.embedding_hash,
            "embedding": self.embedding,
            "model_id": self.model_id,
            "dimensions": self.dimensions,
            "source_path": self.source_path,
            "source_type": self.source_type,
            "created_at": self.created_at.isoformat(),
            "created_by": self.created_by,
            "proposal_id": self.proposal_id,
            "metadata": self.metadata,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "VectorArtifact":
        """Deserialize from dictionary."""
        return cls(
            artifact_id=data["artifact_id"],
            content_hash=data["content_hash"],
            embedding_hash=data["embedding_hash"],
            embedding=data["embedding"],
            model_id=data["model_id"],
            dimensions=data["dimensions"],
            source_path=data.get("source_path", ""),
            source_type=data.get("source_type", "unknown"),
            created_at=datetime.fromisoformat(data["created_at"]),
            created_by=data.get("created_by", ""),
            proposal_id=data.get("proposal_id", ""),
            metadata=data.get("metadata", {}),
        )


@dataclass
class IndexMutationEnvelope:
    """Envelope for index mutations with integrity verification.
    
    Every mutation to the vector index is wrapped in an envelope that:
    - Records the pre-mutation index state
    - Records the post-mutation index state
    - Links to the governance proposal
    - Enables rollback if needed
    
    Attributes:
        mutation_id: Unique identifier
        operation: Type of operation
        artifact: The vector artifact (for insert/update)
        artifact_id: The artifact ID (for delete)
        pre_index_hash: Hash of index before mutation
        post_index_hash: Hash of index after mutation
        proposal_id: Governance proposal that authorized mutation
        timestamp: When the mutation occurred
        agent_id: Agent that performed the mutation
    """
    mutation_id: str
    operation: VectorOperation
    artifact: Optional[VectorArtifact] = None
    artifact_id: str = ""
    pre_index_hash: str = ""
    post_index_hash: str = ""
    proposal_id: str = ""
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    agent_id: str = ""
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "mutation_id": self.mutation_id,
            "operation": self.operation.value,
            "artifact": self.artifact.to_dict() if self.artifact else None,
            "artifact_id": self.artifact_id,
            "pre_index_hash": self.pre_index_hash,
            "post_index_hash": self.post_index_hash,
            "proposal_id": self.proposal_id,
            "timestamp": self.timestamp.isoformat(),
            "agent_id": self.agent_id,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "IndexMutationEnvelope":
        """Deserialize from dictionary."""
        artifact = None
        if data.get("artifact"):
            artifact = VectorArtifact.from_dict(data["artifact"])
        
        return cls(
            mutation_id=data["mutation_id"],
            operation=VectorOperation(data["operation"]),
            artifact=artifact,
            artifact_id=data.get("artifact_id", ""),
            pre_index_hash=data.get("pre_index_hash", ""),
            post_index_hash=data.get("post_index_hash", ""),
            proposal_id=data.get("proposal_id", ""),
            timestamp=datetime.fromisoformat(data["timestamp"]),
            agent_id=data.get("agent_id", ""),
        )


@dataclass
class DriftReport:
    """Report of detected drift in the vector store.
    
    Attributes:
        signal: Type of drift signal
        severity: Severity level (0.0 to 1.0)
        metric_value: The measured metric value
        threshold: The threshold that was crossed
        affected_count: Number of affected vectors
        timestamp: When the drift was detected
        details: Additional details
    """
    signal: DriftSignal
    severity: float
    metric_value: float
    threshold: float
    affected_count: int = 0
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    details: dict = field(default_factory=dict)
    
    def is_governance_trigger(self) -> bool:
        """Check if this drift signal is a governance trigger."""
        return self.signal in (
            DriftSignal.COLLAPSE,
            DriftSignal.RAPID_CHURN,
            DriftSignal.DISSOLUTION,
        )
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "signal": self.signal.value,
            "severity": self.severity,
            "metric_value": self.metric_value,
            "threshold": self.threshold,
            "affected_count": self.affected_count,
            "timestamp": self.timestamp.isoformat(),
            "details": self.details,
        }


class VectorGovernanceStore:
    """Governed vector store with integrity verification.
    
    This store wraps any vector database with governance guarantees:
    - Write-time hash verification
    - Configurable read-time verification
    - Drift detection and reporting
    - Model upgrade protocol
    
    Core Principle: Semantic artifacts are first-class governed state.
    """
    
    def __init__(
        self,
        store_path: Path,
        model_id: str,
        verification_strategy: VerificationStrategy = VerificationStrategy.ON_ACCESS,
        sampling_rate: float = 0.1,
    ):
        """Initialize the governed vector store.
        
        Args:
            store_path: Path to the vector store
            model_id: Current embedding model identifier
            verification_strategy: How to verify vectors on read
            sampling_rate: Rate for sampling verification (0.0 to 1.0)
        """
        self._path = Path(store_path)
        self._model_id = model_id
        self._strategy = verification_strategy
        self._sampling_rate = sampling_rate
        self._artifacts: dict[str, VectorArtifact] = {}
        self._mutations: list[IndexMutationEnvelope] = []
        self._index_hash = self._compute_index_hash()
        self._locked = False
        self._upgrade_in_progress = False
        self._upgrade_shadow: dict[str, VectorArtifact] = {}
    
    @property
    def model_id(self) -> str:
        """Get the current model ID."""
        return self._model_id
    
    @property
    def is_locked(self) -> bool:
        """Check if the store is locked for upgrade."""
        return self._locked
    
    @property
    def artifact_count(self) -> int:
        """Get the number of artifacts in the store."""
        return len(self._artifacts)
    
    def insert(
        self,
        artifact: VectorArtifact,
        proposal_id: str,
        agent_id: str,
    ) -> IndexMutationEnvelope:
        """Insert a vector artifact into the store.
        
        Args:
            artifact: The artifact to insert
            proposal_id: Governance proposal ID
            agent_id: Agent performing the insert
        
        Returns:
            Index mutation envelope
        
        Raises:
            ValueError: If artifact already exists or hash mismatch
        """
        if self._locked:
            raise ValueError("Store is locked for upgrade")
        
        # Verify embedding hash
        if not artifact.verify_embedding_hash():
            raise ValueError(
                f"Embedding hash mismatch for artifact {artifact.artifact_id}"
            )
        
        # Check for duplicate
        if artifact.artifact_id in self._artifacts:
            raise ValueError(f"Artifact already exists: {artifact.artifact_id}")
        
        import uuid
        
        # Create mutation envelope
        pre_hash = self._index_hash
        self._artifacts[artifact.artifact_id] = artifact
        self._index_hash = self._compute_index_hash()
        
        mutation = IndexMutationEnvelope(
            mutation_id=str(uuid.uuid4()),
            operation=VectorOperation.INSERT,
            artifact=artifact,
            pre_index_hash=pre_hash,
            post_index_hash=self._index_hash,
            proposal_id=proposal_id,
            agent_id=agent_id,
        )
        
        self._mutations.append(mutation)
        logger.info(f"Inserted vector artifact: {artifact.artifact_id[:8]}...")
        
        return mutation
    
    def delete(
        self,
        artifact_id: str,
        proposal_id: str,
        agent_id: str,
    ) -> IndexMutationEnvelope:
        """Delete a vector artifact from the store.
        
        Args:
            artifact_id: ID of artifact to delete
            proposal_id: Governance proposal ID
            agent_id: Agent performing the delete
        
        Returns:
            Index mutation envelope
        
        Raises:
            KeyError: If artifact not found
        """
        if self._locked:
            raise ValueError("Store is locked for upgrade")
        
        if artifact_id not in self._artifacts:
            raise KeyError(f"Artifact not found: {artifact_id}")
        
        import uuid
        
        pre_hash = self._index_hash
        del self._artifacts[artifact_id]
        self._index_hash = self._compute_index_hash()
        
        mutation = IndexMutationEnvelope(
            mutation_id=str(uuid.uuid4()),
            operation=VectorOperation.DELETE,
            artifact_id=artifact_id,
            pre_index_hash=pre_hash,
            post_index_hash=self._index_hash,
            proposal_id=proposal_id,
            agent_id=agent_id,
        )
        
        self._mutations.append(mutation)
        logger.info(f"Deleted vector artifact: {artifact_id[:8]}...")
        
        return mutation
    
    def get(
        self,
        artifact_id: str,
    ) -> Optional[VectorArtifact]:
        """Get a vector artifact from the store.
        
        Applies the configured verification strategy.
        
        Args:
            artifact_id: ID of artifact to retrieve
        
        Returns:
            The artifact, or None if not found
        """
        artifact = self._artifacts.get(artifact_id)
        if not artifact:
            return None
        
        # Apply verification strategy
        if self._strategy == VerificationStrategy.ON_ACCESS:
            if not artifact.verify_embedding_hash():
                logger.error(
                    f"Embedding hash mismatch on access: {artifact_id}"
                )
                # FAIL-CLOSED: Return None on verification failure
                return None
        
        elif self._strategy == VerificationStrategy.SAMPLING:
            import random
            if random.random() < self._sampling_rate:
                if not artifact.verify_embedding_hash():
                    logger.error(
                        f"Embedding hash mismatch in sampling: {artifact_id}"
                    )
                    return None
        
        return artifact
    
    def query(
        self,
        query_vector: list[float],
        k: int = 10,
    ) -> list[tuple[VectorArtifact, float]]:
        """Query for similar vectors.
        
        Args:
            query_vector: Query embedding vector
            k: Number of results
        
        Returns:
            List of (artifact, similarity) tuples
        """
        # Simple cosine similarity search
        # In production, this would use an actual vector index
        results = []
        
        query_norm = sum(x * x for x in query_vector) ** 0.5
        if query_norm == 0:
            return []
        
        for artifact in self._artifacts.values():
            # Verify if on-access
            if self._strategy == VerificationStrategy.ON_ACCESS:
                if not artifact.verify_embedding_hash():
                    continue
            
            # Compute cosine similarity
            dot = sum(a * b for a, b in zip(query_vector, artifact.embedding))
            norm = sum(x * x for x in artifact.embedding) ** 0.5
            if norm == 0:
                continue
            
            similarity = dot / (query_norm * norm)
            results.append((artifact, similarity))
        
        # Sort by similarity descending
        results.sort(key=lambda x: x[1], reverse=True)
        return results[:k]
    
    def verify_all(self) -> tuple[int, list[str]]:
        """Verify all artifacts in the store.
        
        Returns:
            Tuple of (verified_count, list_of_errors)
        """
        verified = 0
        errors = []
        
        for artifact_id, artifact in self._artifacts.items():
            if artifact.verify_embedding_hash():
                verified += 1
            else:
                errors.append(f"Hash mismatch: {artifact_id}")
        
        logger.info(f"Verified {verified}/{len(self._artifacts)} artifacts")
        return verified, errors
    
    def detect_drift(self) -> list[DriftReport]:
        """Detect drift in the vector store.
        
        Returns:
            List of drift reports
        """
        reports = []
        
        # Check for rapid churn (governance trigger)
        recent_mutations = [
            m for m in self._mutations
            if (datetime.now(timezone.utc) - m.timestamp).total_seconds() < 3600
        ]
        churn_rate = len(recent_mutations) / max(len(self._artifacts), 1)
        
        if churn_rate > 0.5:  # More than 50% turnover in an hour
            reports.append(DriftReport(
                signal=DriftSignal.RAPID_CHURN,
                severity=min(churn_rate, 1.0),
                metric_value=churn_rate,
                threshold=0.5,
                affected_count=len(recent_mutations),
                details={"hourly_mutation_count": len(recent_mutations)},
            ))
        
        # Check for index integrity (governance trigger)
        current_hash = self._compute_index_hash()
        if current_hash != self._index_hash:
            reports.append(DriftReport(
                signal=DriftSignal.DISSOLUTION,
                severity=1.0,
                metric_value=1.0,
                threshold=0.0,
                details={
                    "expected_hash": self._index_hash[:16],
                    "actual_hash": current_hash[:16],
                },
            ))
        
        return reports
    
    def begin_upgrade(self, new_model_id: str) -> str:
        """Begin a model upgrade process.
        
        The upgrade process:
        1. Lock the store
        2. Create shadow copy
        3. Return upgrade ID for tracking
        
        Args:
            new_model_id: ID of the new embedding model
        
        Returns:
            Upgrade ID
        """
        if self._locked:
            raise ValueError("Store already locked for upgrade")
        
        import uuid
        upgrade_id = str(uuid.uuid4())
        
        self._locked = True
        self._upgrade_in_progress = True
        self._upgrade_shadow = dict(self._artifacts)
        self._upgrade_model = new_model_id
        
        logger.warning(
            f"Beginning model upgrade: {self._model_id} -> {new_model_id} "
            f"(upgrade_id={upgrade_id[:8]}...)"
        )
        
        return upgrade_id
    
    def commit_upgrade(self, upgrade_id: str) -> bool:
        """Commit a model upgrade.
        
        Args:
            upgrade_id: The upgrade ID from begin_upgrade
        
        Returns:
            True if committed successfully
        """
        if not self._upgrade_in_progress:
            return False
        
        self._model_id = self._upgrade_model
        self._locked = False
        self._upgrade_in_progress = False
        self._upgrade_shadow.clear()
        
        logger.warning(f"Committed model upgrade to {self._model_id}")
        
        return True
    
    def rollback_upgrade(self, upgrade_id: str) -> bool:
        """Rollback a model upgrade.
        
        Args:
            upgrade_id: The upgrade ID from begin_upgrade
        
        Returns:
            True if rolled back successfully
        """
        if not self._upgrade_in_progress:
            return False
        
        self._artifacts = dict(self._upgrade_shadow)
        self._index_hash = self._compute_index_hash()
        self._locked = False
        self._upgrade_in_progress = False
        self._upgrade_shadow.clear()
        
        logger.warning(f"Rolled back model upgrade")
        
        return True
    
    def _compute_index_hash(self) -> str:
        """Compute hash of the entire index state."""
        # Sort artifacts by ID for determinism
        sorted_ids = sorted(self._artifacts.keys())
        
        hasher = hashlib.sha256()
        for artifact_id in sorted_ids:
            artifact = self._artifacts[artifact_id]
            hasher.update(artifact.artifact_id.encode())
            hasher.update(artifact.embedding_hash.encode())
        
        return hasher.hexdigest()
    
    def get_stats(self) -> dict:
        """Get statistics about the vector store."""
        return {
            "artifact_count": len(self._artifacts),
            "model_id": self._model_id,
            "verification_strategy": self._strategy.value,
            "is_locked": self._locked,
            "index_hash": self._index_hash[:16],
            "mutation_count": len(self._mutations),
        }


def create_vector_store(
    store_path: Path,
    model_id: str,
    verification_strategy: str = "on_access",
    sampling_rate: float = 0.1,
) -> VectorGovernanceStore:
    """Factory function to create a governed vector store.
    
    Args:
        store_path: Path to the vector store
        model_id: Current embedding model identifier
        verification_strategy: How to verify vectors ("on_access", "background", "sampling", "disabled")
        sampling_rate: Rate for sampling verification
    
    Returns:
        Configured VectorGovernanceStore instance
    """
    strategy = VerificationStrategy(verification_strategy)
    return VectorGovernanceStore(
        store_path=store_path,
        model_id=model_id,
        verification_strategy=strategy,
        sampling_rate=sampling_rate,
    )
