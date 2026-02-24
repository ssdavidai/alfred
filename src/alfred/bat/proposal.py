"""
OperationProposal Schema - Canonical representation of agent operations.

All agent operations MUST be converted to this format before execution.
The governance layer inspects proposals, not raw operations.

Core Principle: Agents propose; they do not act unilaterally.
"""

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any
import uuid
import hashlib
import json


# JSON Schema for OperationProposal validation
OPERATION_PROPOSAL_SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "OperationProposal",
    "description": "Canonical representation of an agent's intended operation",
    "type": "object",
    "required": [
        "proposal_id",
        "agent_id",
        "operation_type",
        "target",
        "timestamp",
    ],
    "properties": {
        "proposal_id": {
            "type": "string",
            "format": "uuid",
            "description": "Unique identifier for this proposal",
        },
        "agent_id": {
            "type": "string",
            "description": "Identifier of the agent proposing the operation",
        },
        "operation_type": {
            "type": "string",
            "description": "Type of operation from standard taxonomy",
            "enum": [
                "read_file",
                "write_file",
                "delete_file",
                "move_file",
                "copy_file",
                "exec_command",
                "network_request",
                "secret_access",
                "state_change",
                "agent_spawn",
                "external_api",
            ],
        },
        "target": {
            "type": "string",
            "description": "What the operation affects (path, URL, resource ID)",
        },
        "metadata": {
            "type": "object",
            "description": "Additional context about the operation",
            "additionalProperties": True,
        },
        "content_hash": {
            "type": "string",
            "description": "SHA-256 hash of content (for write operations)",
        },
        "timestamp": {
            "type": "string",
            "format": "date-time",
            "description": "When the proposal was created",
        },
    },
    "additionalProperties": False,
}


@dataclass
class OperationProposal:
    """Canonical representation of an agent's intended operation.

    All agent operations MUST be converted to this format before execution.
    The governance layer inspects proposals, not raw operations.

    Attributes:
        proposal_id: Unique identifier for this proposal (UUID v4)
        agent_id: Identifier of the agent proposing the operation
        operation_type: Type of operation from standard taxonomy
        target: What the operation affects (path, URL, resource ID)
        metadata: Additional context about the operation
        content_hash: SHA-256 hash of content (for write operations)
        timestamp: When the proposal was created (UTC)

    Example:
        >>> proposal = OperationProposal(
        ...     agent_id="curator",
        ...     operation_type="write_file",
        ...     target="~/vault/inbox/note.md",
        ...     metadata={"mode": "write"},
        ...     content="Content to write"
        ... )
        >>> proposal.operation_type
        'write_file'
        >>> proposal.compute_hash()[:8]
        'a1b2c3d4'
    """

    proposal_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str = ""
    operation_type: str = ""  # From standard taxonomy
    target: str = ""  # What the operation affects
    metadata: dict[str, Any] = field(default_factory=dict)
    content_hash: str = ""
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def __post_init__(self):
        """Validate proposal after initialization."""
        # Ensure timestamp is timezone-aware
        if self.timestamp.tzinfo is None:
            self.timestamp = self.timestamp.replace(tzinfo=timezone.utc)

    def compute_hash(self) -> str:
        """Compute deterministic SHA-256 hash for this proposal.

        The hash is computed over the JSON serialization of the proposal,
        ensuring consistent ordering of keys.

        Returns:
            Hexadecimal SHA-256 hash string

        Example:
            >>> proposal = OperationProposal(agent_id="test", operation_type="read_file", target="/tmp/file")
            >>> len(proposal.compute_hash())
            64
        """
        data = json.dumps(asdict(self), sort_keys=True, default=str)
        return hashlib.sha256(data.encode()).hexdigest()

    def to_json(self) -> str:
        """Serialize to JSON for wire transmission.

        Returns:
            JSON string representation

        Example:
            >>> proposal = OperationProposal(agent_id="test", operation_type="read_file", target="/tmp/file")
            >>> json_str = proposal.to_json()
            >>> '"agent_id": "test"' in json_str
            True
        """
        return json.dumps(asdict(self), default=str)

    @classmethod
    def from_json(cls, json_str: str) -> "OperationProposal":
        """Deserialize from JSON.

        Args:
            json_str: JSON string representation of a proposal

        Returns:
            OperationProposal instance

        Raises:
            json.JSONDecodeError: If JSON is invalid
            ValueError: If required fields are missing

        Example:
            >>> proposal = OperationProposal(agent_id="test", operation_type="read_file", target="/tmp/file")
            >>> json_str = proposal.to_json()
            >>> restored = OperationProposal.from_json(json_str)
            >>> restored.agent_id == proposal.agent_id
            True
        """
        data = json.loads(json_str)

        # Parse timestamp
        if "timestamp" in data:
            data["timestamp"] = datetime.fromisoformat(data["timestamp"])

        return cls(**data)

    def validate(self) -> tuple[bool, list[str]]:
        """Validate the proposal against the schema.

        Returns:
            Tuple of (is_valid, list_of_errors)

        Example:
            >>> proposal = OperationProposal(agent_id="test", operation_type="read_file", target="/tmp/file")
            >>> valid, errors = proposal.validate()
            >>> valid
            True
        """
        errors = []

        # Check required fields
        if not self.proposal_id:
            errors.append("proposal_id is required")
        if not self.agent_id:
            errors.append("agent_id is required")
        if not self.operation_type:
            errors.append("operation_type is required")
        if not self.target:
            errors.append("target is required")

        # Validate operation_type against taxonomy
        valid_operations = OPERATION_PROPOSAL_SCHEMA["properties"]["operation_type"]["enum"]
        if self.operation_type and self.operation_type not in valid_operations:
            errors.append(
                f"Invalid operation_type '{self.operation_type}'. "
                f"Must be one of: {', '.join(valid_operations)}"
            )

        # Validate UUID format
        if self.proposal_id:
            try:
                uuid.UUID(self.proposal_id)
            except ValueError:
                errors.append(f"Invalid UUID format for proposal_id: {self.proposal_id}")

        return len(errors) == 0, errors

    def __str__(self) -> str:
        """Human-readable representation."""
        return (
            f"OperationProposal("
            f"id={self.proposal_id[:8]}..., "
            f"agent={self.agent_id}, "
            f"op={self.operation_type}, "
            f"target={self.target})"
        )

    __repr__ = __str__
