"""
Wire Protocol Extensions for Vector Governance Events.

Implements SECURITY ELEVATION Phase 3:
- Structured message format for inter-process vector governance
- Versioned protocol with backward compatibility
- Cryptographic message authentication
- Anomaly event propagation

Core Principle: All vector governance events are first-class audit artifacts.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional, Any, Union
import hashlib
import hmac
import json
import logging
import struct
import uuid

logger = logging.getLogger(__name__)

# Protocol version for backward compatibility
PROTOCOL_VERSION = "1.0.0"
PROTOCOL_MAGIC = b"ZVEC"  # Magic bytes for protocol identification


class MessageType(str, Enum):
    """Types of wire protocol messages."""
    # Vector operations
    VECTOR_INSERT = "vector_insert"
    VECTOR_UPDATE = "vector_update"
    VECTOR_DELETE = "vector_delete"
    VECTOR_QUERY = "vector_query"
    
    # Index operations
    INDEX_REBUILD_START = "index_rebuild_start"
    INDEX_REBUILD_PROGRESS = "index_rebuild_progress"
    INDEX_REBUILD_COMPLETE = "index_rebuild_complete"
    INDEX_REBUILD_FAILED = "index_rebuild_failed"
    
    # Anomaly events
    ANOMALY_DETECTED = "anomaly_detected"
    ANOMALY_QUARANTINED = "anomaly_quarantined"
    ANOMALY_RESOLVED = "anomaly_resolved"
    
    # Drift events
    DRIFT_SIGNAL = "drift_signal"
    DRIFT_THRESHOLD_BREACH = "drift_threshold_breach"
    
    # Model operations
    MODEL_UPGRADE_START = "model_upgrade_start"
    MODEL_UPGRADE_COMMIT = "model_upgrade_commit"
    MODEL_UPGRADE_ROLLBACK = "model_upgrade_rollback"
    
    # Governance
    GOVERNANCE_DECISION = "governance_decision"
    GOVERNANCE_OVERRIDE = "governance_override"
    
    # Heartbeat
    HEARTBEAT = "heartbeat"
    HEARTBEAT_ACK = "heartbeat_ack"


class MessagePriority(str, Enum):
    """Message priority levels."""
    LOW = "low"          # Normal operations
    NORMAL = "normal"    # Standard priority
    HIGH = "high"        # Time-sensitive operations
    CRITICAL = "critical"  # Governance triggers, anomalies


class AnomalyType(str, Enum):
    """Types of anomalies that can be detected."""
    EMBEDDING_MISMATCH = "embedding_mismatch"
    CONTENT_HASH_MISMATCH = "content_hash_mismatch"
    INDEX_CORRUPTION = "index_corruption"
    MODEL_DRIFT = "model_drift"
    RAPID_CHURN = "rapid_churn"
    DIMENSION_MISMATCH = "dimension_mismatch"
    ORPHAN_VECTOR = "orphan_vector"
    DUPLICATE_ARTIFACT = "duplicate_artifact"
    QUARANTINE_ESCAPE_ATTEMPT = "quarantine_escape_attempt"


class QuarantineStatus(str, Enum):
    """Status of quarantined artifacts."""
    QUARANTINED = "quarantined"
    UNDER_REVIEW = "under_review"
    RESOLVED = "resolved"
    PURGED = "purged"
    RESTORED = "restored"


@dataclass
class ProtocolHeader:
    """Wire protocol message header.
    
    Attributes:
        magic: Protocol magic bytes (ZVEC)
        version: Protocol version string
        message_id: Unique message identifier
        message_type: Type of message
        priority: Message priority
        timestamp: Message timestamp
        source_id: Source process/agent identifier
        target_id: Target process identifier (empty for broadcast)
        payload_length: Length of payload in bytes
        flags: Message flags (bitmask)
    """
    magic: bytes = b"ZVEC"
    version: str = PROTOCOL_VERSION
    message_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    message_type: MessageType = MessageType.HEARTBEAT
    priority: MessagePriority = MessagePriority.NORMAL
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    source_id: str = ""
    target_id: str = ""
    payload_length: int = 0
    flags: int = field(default=0)  # Mutable field
    
    # Flag constants
    FLAG_COMPRESSED = 0x01
    FLAG_ENCRYPTED = 0x02
    FLAG_SIGNED = 0x04
    FLAG_REQUIRES_ACK = 0x08
    FLAG_IS_ACK = 0x10
    
    def serialize(self) -> bytes:
        """Serialize header to binary format.
        
        Format:
        - magic: 4 bytes
        - version: 8 bytes (padded)
        - message_id: 36 bytes (UUID string)
        - message_type: 32 bytes (padded)
        - priority: 8 bytes (padded)
        - timestamp: 8 bytes (Unix timestamp with microseconds)
        - source_id: 64 bytes (padded)
        - target_id: 64 bytes (padded)
        - payload_length: 4 bytes (unsigned int)
        - flags: 4 bytes (unsigned int)
        Total: 232 bytes
        """
        version_bytes = self.version.encode().ljust(8, b'\x00')[:8]
        message_type_bytes = self.message_type.value.encode().ljust(32, b'\x00')[:32]
        priority_bytes = self.priority.value.encode().ljust(8, b'\x00')[:8]
        source_bytes = self.source_id.encode().ljust(64, b'\x00')[:64]
        target_bytes = self.target_id.encode().ljust(64, b'\x00')[:64]
        
        # Timestamp as Unix timestamp with microseconds
        ts = self.timestamp.timestamp()
        ts_bytes = struct.pack(">d", ts)
        
        return (
            self.magic +
            version_bytes +
            self.message_id.encode().ljust(36, b'\x00')[:36] +
            message_type_bytes +
            priority_bytes +
            ts_bytes +
            source_bytes +
            target_bytes +
            struct.pack(">I", self.payload_length) +
            struct.pack(">I", self.flags)
        )
    
    @classmethod
    def deserialize(cls, data: bytes) -> "ProtocolHeader":
        """Deserialize header from binary format.
        
        Args:
            data: Binary data (at least 232 bytes)
        
        Returns:
            Deserialized ProtocolHeader
        
        Raises:
            ValueError: If data is invalid
        """
        if len(data) < 232:
            raise ValueError(f"Header too short: {len(data)} < 232")
        
        magic = data[0:4]
        if magic != PROTOCOL_MAGIC:
            raise ValueError(f"Invalid magic bytes: {magic}")
        
        version = data[4:12].rstrip(b'\x00').decode()
        message_id = data[12:48].rstrip(b'\x00').decode()
        message_type = MessageType(data[48:80].rstrip(b'\x00').decode())
        priority = MessagePriority(data[80:88].rstrip(b'\x00').decode())
        
        ts_bytes = data[88:96]
        ts = struct.unpack(">d", ts_bytes)[0]
        timestamp = datetime.fromtimestamp(ts, tz=timezone.utc)
        
        source_id = data[96:160].rstrip(b'\x00').decode()
        target_id = data[160:224].rstrip(b'\x00').decode()
        
        payload_length = struct.unpack(">I", data[224:228])[0]
        flags = struct.unpack(">I", data[228:232])[0]
        
        # Create new instance and set flags directly
        header = cls(
            magic=magic,
            version=version,
            message_id=message_id,
            message_type=message_type,
            priority=priority,
            timestamp=timestamp,
            source_id=source_id,
            target_id=target_id,
            payload_length=payload_length,
        )
        header.flags = flags  # Set flags after creation
        return header


@dataclass
class VectorPayload:
    """Payload for vector operation messages."""
    artifact_id: str
    content_hash: str
    embedding_hash: str
    model_id: str
    dimensions: int
    source_path: str = ""
    proposal_id: str = ""
    agent_id: str = ""
    
    def to_dict(self) -> dict:
        return {
            "artifact_id": self.artifact_id,
            "content_hash": self.content_hash,
            "embedding_hash": self.embedding_hash,
            "model_id": self.model_id,
            "dimensions": self.dimensions,
            "source_path": self.source_path,
            "proposal_id": self.proposal_id,
            "agent_id": self.agent_id,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "VectorPayload":
        return cls(
            artifact_id=data["artifact_id"],
            content_hash=data["content_hash"],
            embedding_hash=data["embedding_hash"],
            model_id=data["model_id"],
            dimensions=data["dimensions"],
            source_path=data.get("source_path", ""),
            proposal_id=data.get("proposal_id", ""),
            agent_id=data.get("agent_id", ""),
        )


@dataclass
class AnomalyPayload:
    """Payload for anomaly event messages.
    
    Attributes:
        anomaly_id: Unique identifier for this anomaly
        anomaly_type: Type of anomaly detected
        artifact_id: Affected artifact (if applicable)
        severity: Severity level (0.0 to 1.0)
        description: Human-readable description
        quarantine_status: Current quarantine status
        evidence: Supporting evidence (hashes, metrics, etc.)
        proposed_action: Suggested remediation action
    """
    anomaly_id: str
    anomaly_type: AnomalyType
    artifact_id: str = ""
    severity: float = 0.5
    description: str = ""
    quarantine_status: QuarantineStatus = QuarantineStatus.QUARANTINED
    evidence: dict = field(default_factory=dict)
    proposed_action: str = ""
    
    def to_dict(self) -> dict:
        return {
            "anomaly_id": self.anomaly_id,
            "anomaly_type": self.anomaly_type.value,
            "artifact_id": self.artifact_id,
            "severity": self.severity,
            "description": self.description,
            "quarantine_status": self.quarantine_status.value,
            "evidence": self.evidence,
            "proposed_action": self.proposed_action,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "AnomalyPayload":
        return cls(
            anomaly_id=data["anomaly_id"],
            anomaly_type=AnomalyType(data["anomaly_type"]),
            artifact_id=data.get("artifact_id", ""),
            severity=data.get("severity", 0.5),
            description=data.get("description", ""),
            quarantine_status=QuarantineStatus(data.get("quarantine_status", "quarantined")),
            evidence=data.get("evidence", {}),
            proposed_action=data.get("proposed_action", ""),
        )


@dataclass
class DriftPayload:
    """Payload for drift event messages.
    
    Attributes:
        drift_id: Unique identifier for this drift event
        signal_type: Type of drift signal
        metric_value: The measured metric value
        threshold: The threshold that was crossed
        affected_count: Number of affected vectors
        is_governance_trigger: Whether this triggers governance action
    """
    drift_id: str
    signal_type: str
    metric_value: float
    threshold: float
    affected_count: int = 0
    is_governance_trigger: bool = False
    
    def to_dict(self) -> dict:
        return {
            "drift_id": self.drift_id,
            "signal_type": self.signal_type,
            "metric_value": self.metric_value,
            "threshold": self.threshold,
            "affected_count": self.affected_count,
            "is_governance_trigger": self.is_governance_trigger,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "DriftPayload":
        return cls(
            drift_id=data["drift_id"],
            signal_type=data["signal_type"],
            metric_value=data["metric_value"],
            threshold=data["threshold"],
            affected_count=data.get("affected_count", 0),
            is_governance_trigger=data.get("is_governance_trigger", False),
        )


@dataclass
class IndexRebuildPayload:
    """Payload for index rebuild messages.
    
    Attributes:
        rebuild_id: Unique identifier for this rebuild
        model_id: Target model ID
        total_vectors: Total vectors to rebuild
        processed_vectors: Vectors processed so far
        failed_vectors: Vectors that failed
        quarantine_count: Vectors quarantined during rebuild
        status: Current status
        error_message: Error message if failed
    """
    rebuild_id: str
    model_id: str
    total_vectors: int = 0
    processed_vectors: int = 0
    failed_vectors: int = 0
    quarantine_count: int = 0
    status: str = "pending"
    error_message: str = ""
    
    def to_dict(self) -> dict:
        return {
            "rebuild_id": self.rebuild_id,
            "model_id": self.model_id,
            "total_vectors": self.total_vectors,
            "processed_vectors": self.processed_vectors,
            "failed_vectors": self.failed_vectors,
            "quarantine_count": self.quarantine_count,
            "status": self.status,
            "error_message": self.error_message,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "IndexRebuildPayload":
        return cls(
            rebuild_id=data["rebuild_id"],
            model_id=data["model_id"],
            total_vectors=data.get("total_vectors", 0),
            processed_vectors=data.get("processed_vectors", 0),
            failed_vectors=data.get("failed_vectors", 0),
            quarantine_count=data.get("quarantine_count", 0),
            status=data.get("status", "pending"),
            error_message=data.get("error_message", ""),
        )


@dataclass
class WireMessage:
    """Complete wire protocol message with header, payload, and authentication.
    
    Attributes:
        header: Protocol header
        payload: Message payload (type depends on message_type)
        signature: HMAC signature for message authentication
    """
    header: ProtocolHeader
    payload: Union[VectorPayload, AnomalyPayload, DriftPayload, IndexRebuildPayload, dict]
    signature: bytes = b""
    
    def __post_init__(self):
        """Compute payload length after initialization."""
        payload_bytes = self._serialize_payload()
        self.header.payload_length = len(payload_bytes)
    
    def _serialize_payload(self) -> bytes:
        """Serialize payload to JSON bytes."""
        if isinstance(self.payload, dict):
            data = self.payload
        else:
            data = self.payload.to_dict()
        return json.dumps(data, separators=(',', ':')).encode()
    
    def serialize(self, signing_key: Optional[bytes] = None) -> bytes:
        """Serialize complete message to binary format.
        
        Args:
            signing_key: Optional HMAC signing key
        
        Returns:
            Binary message data
        """
        payload_bytes = self._serialize_payload()
        
        # Set signature flag before serializing header
        if signing_key:
            self.header.flags |= ProtocolHeader.FLAG_SIGNED
        
        # Now serialize header with correct flags
        header_bytes = self.header.serialize()
        
        # Compute signature if key provided
        if signing_key:
            self.signature = hmac.new(
                signing_key,
                header_bytes + payload_bytes,
                hashlib.sha256
            ).digest()
        
        return header_bytes + payload_bytes + self.signature
    
    @classmethod
    def deserialize(
        cls,
        data: bytes,
        verification_key: Optional[bytes] = None,
    ) -> "WireMessage":
        """Deserialize message from binary format.
        
        Args:
            data: Binary message data
            verification_key: Optional HMAC verification key
        
        Returns:
            Deserialized WireMessage
        
        Raises:
            ValueError: If data is invalid or signature verification fails
        """
        header = ProtocolHeader.deserialize(data)
        
        payload_start = 232
        payload_end = payload_start + header.payload_length
        
        if len(data) < payload_end:
            raise ValueError(
                f"Message too short: {len(data)} < {payload_end}"
            )
        
        payload_bytes = data[payload_start:payload_end]
        signature = data[payload_end:payload_end + 32]
        
        # Verify signature if present
        if header.flags & ProtocolHeader.FLAG_SIGNED:
            if not verification_key:
                raise ValueError("Message is signed but no verification key provided")
            
            expected_sig = hmac.new(
                verification_key,
                data[:payload_end],
                hashlib.sha256
            ).digest()
            
            if not hmac.compare_digest(signature, expected_sig):
                raise ValueError("Signature verification failed")
        
        # Parse payload based on message type
        payload_data = json.loads(payload_bytes)
        payload = cls._parse_payload(header.message_type, payload_data)
        
        message = cls(
            header=header,
            payload=payload,
            signature=signature,
        )
        
        return message
    
    @classmethod
    def _parse_payload(
        cls,
        message_type: MessageType,
        data: dict,
    ) -> Union[VectorPayload, AnomalyPayload, DriftPayload, IndexRebuildPayload, dict]:
        """Parse payload based on message type."""
        vector_types = {
            MessageType.VECTOR_INSERT,
            MessageType.VECTOR_UPDATE,
            MessageType.VECTOR_DELETE,
            MessageType.VECTOR_QUERY,
        }
        
        anomaly_types = {
            MessageType.ANOMALY_DETECTED,
            MessageType.ANOMALY_QUARANTINED,
            MessageType.ANOMALY_RESOLVED,
        }
        
        drift_types = {
            MessageType.DRIFT_SIGNAL,
            MessageType.DRIFT_THRESHOLD_BREACH,
        }
        
        rebuild_types = {
            MessageType.INDEX_REBUILD_START,
            MessageType.INDEX_REBUILD_PROGRESS,
            MessageType.INDEX_REBUILD_COMPLETE,
            MessageType.INDEX_REBUILD_FAILED,
        }
        
        if message_type in vector_types:
            return VectorPayload.from_dict(data)
        elif message_type in anomaly_types:
            return AnomalyPayload.from_dict(data)
        elif message_type in drift_types:
            return DriftPayload.from_dict(data)
        elif message_type in rebuild_types:
            return IndexRebuildPayload.from_dict(data)
        else:
            return data


class WireProtocolHandler:
    """Handler for wire protocol communication.
    
    Provides high-level interface for creating and processing
    wire protocol messages.
    """
    
    def __init__(
        self,
        source_id: str,
        signing_key: Optional[bytes] = None,
        verification_key: Optional[bytes] = None,
    ):
        """Initialize the protocol handler.
        
        Args:
            source_id: Identifier for this process/agent
            signing_key: Key for signing outgoing messages
            verification_key: Key for verifying incoming messages
        """
        self._source_id = source_id
        self._signing_key = signing_key
        self._verification_key = verification_key
        self._message_handlers: dict[MessageType, callable] = {}
    
    def register_handler(
        self,
        message_type: MessageType,
        handler: callable,
    ) -> None:
        """Register a handler for a message type.
        
        Args:
            message_type: Type of message to handle
            handler: Handler function (takes WireMessage, returns optional response)
        """
        self._message_handlers[message_type] = handler
    
    def create_message(
        self,
        message_type: MessageType,
        payload: Union[VectorPayload, AnomalyPayload, DriftPayload, IndexRebuildPayload, dict],
        priority: MessagePriority = MessagePriority.NORMAL,
        target_id: str = "",
        requires_ack: bool = False,
    ) -> WireMessage:
        """Create a new wire protocol message.
        
        Args:
            message_type: Type of message
            payload: Message payload
            priority: Message priority
            target_id: Target process identifier
            requires_ack: Whether to request acknowledgment
        
        Returns:
            WireMessage ready for serialization
        """
        flags = 0
        if requires_ack:
            flags |= ProtocolHeader.FLAG_REQUIRES_ACK
        
        header = ProtocolHeader(
            message_type=message_type,
            priority=priority,
            source_id=self._source_id,
            target_id=target_id,
            flags=flags,
        )
        
        return WireMessage(header=header, payload=payload)
    
    def create_heartbeat(self, target_id: str = "") -> WireMessage:
        """Create a heartbeat message.
        
        Args:
            target_id: Target process identifier
        
        Returns:
            Heartbeat WireMessage
        """
        return self.create_message(
            message_type=MessageType.HEARTBEAT,
            payload={"status": "alive"},
            priority=MessagePriority.LOW,
            target_id=target_id,
        )
    
    def create_anomaly_message(
        self,
        anomaly_type: AnomalyType,
        artifact_id: str,
        severity: float,
        description: str,
        evidence: Optional[dict] = None,
    ) -> WireMessage:
        """Create an anomaly detection message.
        
        Args:
            anomaly_type: Type of anomaly
            artifact_id: Affected artifact
            severity: Severity level (0.0 to 1.0)
            description: Human-readable description
            evidence: Supporting evidence
        
        Returns:
            Anomaly WireMessage
        """
        payload = AnomalyPayload(
            anomaly_id=str(uuid.uuid4()),
            anomaly_type=anomaly_type,
            artifact_id=artifact_id,
            severity=severity,
            description=description,
            evidence=evidence or {},
        )
        
        # High severity anomalies get CRITICAL priority
        priority = MessagePriority.CRITICAL if severity >= 0.7 else MessagePriority.HIGH
        
        return self.create_message(
            message_type=MessageType.ANOMALY_DETECTED,
            payload=payload,
            priority=priority,
        )
    
    def serialize_message(self, message: WireMessage) -> bytes:
        """Serialize a message with signing.
        
        Args:
            message: Message to serialize
        
        Returns:
            Binary message data
        """
        return message.serialize(signing_key=self._signing_key)
    
    def process_message(self, data: bytes) -> Optional[WireMessage]:
        """Process incoming message data.
        
        Args:
            data: Binary message data
        
        Returns:
            Optional response message
        
        Raises:
            ValueError: If message is invalid
        """
        message = WireMessage.deserialize(data, self._verification_key)
        
        # Check if we're the target
        if message.header.target_id and message.header.target_id != self._source_id:
            logger.debug(
                f"Ignoring message for {message.header.target_id} "
                f"(we are {self._source_id})"
            )
            return None
        
        # Send ACK if requested
        if message.header.flags & ProtocolHeader.FLAG_REQUIRES_ACK:
            ack = self._create_ack(message)
            # In a real implementation, this would be sent back
            logger.debug(f"ACK prepared for {message.header.message_id}")
        
        # Call registered handler if any
        handler = self._message_handlers.get(message.header.message_type)
        if handler:
            return handler(message)
        
        return None
    
    def _create_ack(self, original: WireMessage) -> WireMessage:
        """Create acknowledgment for a message."""
        header = ProtocolHeader(
            message_type=MessageType.HEARTBEAT_ACK,
            priority=MessagePriority.HIGH,
            source_id=self._source_id,
            target_id=original.header.source_id,
            flags=ProtocolHeader.FLAG_IS_ACK,
        )
        
        return WireMessage(
            header=header,
            payload={"ack_for": original.header.message_id},
        )


def create_protocol_handler(
    source_id: str,
    signing_key: Optional[bytes] = None,
    verification_key: Optional[bytes] = None,
) -> WireProtocolHandler:
    """Factory function to create a wire protocol handler.
    
    Args:
        source_id: Identifier for this process/agent
        signing_key: Key for signing outgoing messages
        verification_key: Key for verifying incoming messages
    
    Returns:
        Configured WireProtocolHandler instance
    """
    return WireProtocolHandler(
        source_id=source_id,
        signing_key=signing_key,
        verification_key=verification_key,
    )
