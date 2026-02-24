"""
Delegation - Provenance chain and capability intersection for agent delegation.

Implements SECURITY ELEVATION Track B:
- Delegation provenance chain
- Capability intersection enforcement
- Confused deputy prevention

Core Principle: Delegation does not elevate privilege.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional, FrozenSet
import hashlib
import json
import logging

logger = logging.getLogger(__name__)


class DelegationError(Exception):
    """Raised when delegation validation fails."""
    pass


class Capability(str, Enum):
    """Standard capabilities that can be delegated.
    
    These represent the types of operations an agent can perform.
    Delegation can only reduce capabilities, never expand them.
    """
    # File operations
    FILE_READ = "file:read"
    FILE_WRITE = "file:write"
    FILE_DELETE = "file:delete"
    
    # Command execution
    EXEC_COMMAND = "exec:command"
    EXEC_SANDBOX = "exec:sandbox"
    
    # Network access
    NETWORK_REQUEST = "network:request"
    NETWORK_INTERNAL = "network:internal"
    
    # Secret access
    SECRET_READ = "secret:read"
    SECRET_WRITE = "secret:write"
    
    # Agent management
    AGENT_SPAWN = "agent:spawn"
    AGENT_DELEGATE = "agent:delegate"
    
    # Governance
    GOVERNANCE_READ = "governance:read"
    GOVERNANCE_ADMIN = "governance:admin"


@dataclass(frozen=True)
class CapabilitySet:
    """Immutable set of capabilities.
    
    This is used to ensure that capability sets cannot be modified
    after creation, preventing privilege escalation.
    """
    capabilities: FrozenSet[str] = frozenset()
    
    def __post_init__(self):
        """Validate capabilities."""
        # Convert to frozenset if needed
        if not isinstance(self.capabilities, frozenset):
            object.__setattr__(self, 'capabilities', frozenset(self.capabilities))
    
    def contains(self, capability: str) -> bool:
        """Check if a capability is in the set."""
        return capability in self.capabilities
    
    def intersect(self, other: "CapabilitySet") -> "CapabilitySet":
        """Compute intersection with another capability set.
        
        This is the core operation for delegation - the delegate
        can only receive capabilities that both parties have.
        """
        return CapabilitySet(self.capabilities & other.capabilities)
    
    def is_subset_of(self, other: "CapabilitySet") -> bool:
        """Check if this set is a subset of another."""
        return self.capabilities <= other.capabilities
    
    def union(self, other: "CapabilitySet") -> "CapabilitySet":
        """Compute union with another capability set."""
        return CapabilitySet(self.capabilities | other.capabilities)
    
    def difference(self, other: "CapabilitySet") -> "CapabilitySet":
        """Compute difference (capabilities in self but not in other)."""
        return CapabilitySet(self.capabilities - other.capabilities)
    
    def to_list(self) -> list[str]:
        """Convert to sorted list."""
        return sorted(self.capabilities)
    
    @classmethod
    def from_list(cls, capabilities: list[str]) -> "CapabilitySet":
        """Create from list."""
        return cls(frozenset(capabilities))
    
    @classmethod
    def all(cls) -> "CapabilitySet":
        """Create a set with all capabilities."""
        return cls(frozenset(c.value for c in Capability))
    
    @classmethod
    def none(cls) -> "CapabilitySet":
        """Create an empty capability set."""
        return cls(frozenset())


# Predefined capability sets for common agent types
DEFAULT_CAPABILITIES = {
    "curator": CapabilitySet.from_list([
        Capability.FILE_READ.value,
        Capability.FILE_WRITE.value,
        Capability.NETWORK_REQUEST.value,
    ]),
    "distiller": CapabilitySet.from_list([
        Capability.FILE_READ.value,
        Capability.FILE_WRITE.value,
    ]),
    "surveyor": CapabilitySet.from_list([
        Capability.FILE_READ.value,
        Capability.NETWORK_REQUEST.value,
    ]),
    "janitor": CapabilitySet.from_list([
        Capability.FILE_READ.value,
        Capability.FILE_DELETE.value,
    ]),
    "admin": CapabilitySet.all(),
    "readonly": CapabilitySet.from_list([
        Capability.FILE_READ.value,
        Capability.GOVERNANCE_READ.value,
    ]),
}


@dataclass
class DelegationChain:
    """Provenance chain for delegated authority.
    
    Tracks the full chain of delegation from the original authority
    to the current agent. This enables:
    1. Auditing who delegated what to whom
    2. Detecting confused deputy attacks
    3. Revoking authority at any level
    
    Attributes:
        chain_id: Unique identifier for this chain
        delegator_id: ID of the delegating agent
        delegate_id: ID of the receiving agent
        capabilities: Capabilities being delegated (intersection)
        timestamp: When the delegation occurred
        parent_chain_id: ID of the parent chain (None for root)
        depth: Depth in the delegation tree
        signature: Cryptographic signature (optional)
    """
    chain_id: str
    delegator_id: str
    delegate_id: str
    capabilities: CapabilitySet
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    parent_chain_id: Optional[str] = None
    depth: int = 0
    signature: str = ""
    
    def compute_hash(self) -> str:
        """Compute deterministic hash of this delegation."""
        data = {
            "chain_id": self.chain_id,
            "delegator_id": self.delegator_id,
            "delegate_id": self.delegate_id,
            "capabilities": sorted(self.capabilities.capabilities),
            "timestamp": self.timestamp.isoformat(),
            "parent_chain_id": self.parent_chain_id,
            "depth": self.depth,
        }
        data_str = json.dumps(data, sort_keys=True)
        return hashlib.sha256(data_str.encode()).hexdigest()
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "chain_id": self.chain_id,
            "delegator_id": self.delegator_id,
            "delegate_id": self.delegate_id,
            "capabilities": self.capabilities.to_list(),
            "timestamp": self.timestamp.isoformat(),
            "parent_chain_id": self.parent_chain_id,
            "depth": self.depth,
            "signature": self.signature,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "DelegationChain":
        """Deserialize from dictionary."""
        return cls(
            chain_id=data["chain_id"],
            delegator_id=data["delegator_id"],
            delegate_id=data["delegate_id"],
            capabilities=CapabilitySet.from_list(data["capabilities"]),
            timestamp=datetime.fromisoformat(data["timestamp"]),
            parent_chain_id=data.get("parent_chain_id"),
            depth=data.get("depth", 0),
            signature=data.get("signature", ""),
        )


@dataclass
class DelegationContext:
    """Full context for a delegated operation.
    
    Contains the complete delegation chain and current capabilities
    for an agent attempting an operation.
    
    Attributes:
        agent_id: The agent's ID
        capabilities: Current effective capabilities
        chain: The delegation chain (None for root agents)
        original_authority: The root authority (None for root agents)
    """
    agent_id: str
    capabilities: CapabilitySet
    chain: Optional[DelegationChain] = None
    original_authority: Optional[str] = None
    
    def can_perform(self, capability: str) -> bool:
        """Check if the agent has a specific capability."""
        return self.capabilities.contains(capability)
    
    def is_root_agent(self) -> bool:
        """Check if this is a root agent (not delegated)."""
        return self.chain is None


class DelegationManager:
    """Manages delegation chains and capability enforcement.
    
    Core Principle: Delegation does not elevate privilege.
    
    This manager ensures:
    1. Delegated capabilities are always a subset of the delegator's
    2. Delegation chains are tracked for auditing
    3. Confused deputy attacks are prevented
    """
    
    MAX_CHAIN_DEPTH = 10  # Prevent infinite delegation chains
    
    def __init__(self):
        """Initialize the delegation manager."""
        self._chains: dict[str, DelegationChain] = {}
        self._agent_contexts: dict[str, DelegationContext] = {}
        self._root_agents: dict[str, CapabilitySet] = {}
    
    def register_root_agent(
        self,
        agent_id: str,
        capabilities: Optional[CapabilitySet] = None,
    ) -> DelegationContext:
        """Register a root agent with initial capabilities.
        
        Root agents are not delegated - they have inherent authority.
        
        Args:
            agent_id: Agent identifier
            capabilities: Initial capabilities (default: from DEFAULT_CAPABILITIES)
        
        Returns:
            The delegation context for the agent
        """
        if capabilities is None:
            capabilities = DEFAULT_CAPABILITIES.get(agent_id, CapabilitySet.none())
        
        self._root_agents[agent_id] = capabilities
        
        context = DelegationContext(
            agent_id=agent_id,
            capabilities=capabilities,
            chain=None,
            original_authority=None,
        )
        self._agent_contexts[agent_id] = context
        
        logger.info(f"Registered root agent: {agent_id} with {len(capabilities.capabilities)} capabilities")
        
        return context
    
    def delegate(
        self,
        delegator_id: str,
        delegate_id: str,
        requested_capabilities: CapabilitySet,
    ) -> DelegationContext:
        """Delegate capabilities from one agent to another.
        
        CRITICAL: The delegate receives the INTERSECTION of:
        1. The delegator's capabilities
        2. The requested capabilities
        
        This ensures delegation never elevates privilege.
        
        Args:
            delegator_id: ID of the delegating agent
            delegate_id: ID of the receiving agent
            requested_capabilities: Capabilities being requested
        
        Returns:
            The delegation context for the delegate
        
        Raises:
            DelegationError: If delegation is invalid
        """
        # Get delegator context
        delegator_context = self._agent_contexts.get(delegator_id)
        if not delegator_context:
            raise DelegationError(f"Unknown delegator: {delegator_id}")
        
        # Check chain depth
        depth = delegator_context.chain.depth + 1 if delegator_context.chain else 1
        if depth > self.MAX_CHAIN_DEPTH:
            raise DelegationError(f"Maximum delegation depth exceeded: {depth}")
        
        # Compute capability intersection (CRITICAL for security)
        effective_capabilities = delegator_context.capabilities.intersect(requested_capabilities)
        
        if len(effective_capabilities.capabilities) == 0:
            raise DelegationError(
                f"Delegation would result in no capabilities. "
                f"Delegator has: {delegator_context.capabilities.to_list()}, "
                f"Requested: {requested_capabilities.to_list()}"
            )
        
        # Check if delegator has delegation capability
        if not delegator_context.can_perform(Capability.AGENT_DELEGATE.value):
            raise DelegationError(f"Delegator {delegator_id} lacks AGENT_DELEGATE capability")
        
        # Create delegation chain
        import uuid
        chain = DelegationChain(
            chain_id=str(uuid.uuid4()),
            delegator_id=delegator_id,
            delegate_id=delegate_id,
            capabilities=effective_capabilities,
            parent_chain_id=delegator_context.chain.chain_id if delegator_context.chain else None,
            depth=depth,
        )
        
        # Determine original authority
        original_authority = delegator_context.original_authority or delegator_id
        
        # Create context
        context = DelegationContext(
            agent_id=delegate_id,
            capabilities=effective_capabilities,
            chain=chain,
            original_authority=original_authority,
        )
        
        # Store
        self._chains[chain.chain_id] = chain
        self._agent_contexts[delegate_id] = context
        
        logger.info(
            f"Delegated {len(effective_capabilities.capabilities)} capabilities "
            f"from {delegator_id} to {delegate_id} (depth={depth})"
        )
        
        return context
    
    def get_context(self, agent_id: str) -> Optional[DelegationContext]:
        """Get the delegation context for an agent."""
        return self._agent_contexts.get(agent_id)
    
    def get_chain(self, chain_id: str) -> Optional[DelegationChain]:
        """Get a delegation chain by ID."""
        return self._chains.get(chain_id)
    
    def get_delegation_history(self, agent_id: str) -> list[DelegationChain]:
        """Get the full delegation history for an agent.
        
        Returns the chain from the root agent to the specified agent.
        """
        context = self._agent_contexts.get(agent_id)
        if not context or not context.chain:
            return []
        
        history = []
        current_chain = context.chain
        
        while current_chain:
            history.append(current_chain)
            if current_chain.parent_chain_id:
                current_chain = self._chains.get(current_chain.parent_chain_id)
            else:
                break
        
        return list(reversed(history))
    
    def revoke_delegation(self, delegate_id: str) -> bool:
        """Revoke a delegation.
        
        This removes the delegate's context but does not affect
        already-issued proposals.
        
        Args:
            delegate_id: ID of the agent to revoke
        
        Returns:
            True if revoked, False if not found
        """
        context = self._agent_contexts.get(delegate_id)
        if not context or not context.chain:
            return False
        
        # Remove from chains and contexts
        if context.chain.chain_id in self._chains:
            del self._chains[context.chain.chain_id]
        del self._agent_contexts[delegate_id]
        
        logger.warning(f"Revoked delegation for agent: {delegate_id}")
        
        return True
    
    def validate_capability(
        self,
        agent_id: str,
        capability: str,
    ) -> tuple[bool, str]:
        """Validate that an agent has a specific capability.
        
        Args:
            agent_id: Agent identifier
            capability: Required capability
        
        Returns:
            Tuple of (is_valid, reason)
        """
        context = self._agent_contexts.get(agent_id)
        if not context:
            return False, f"Unknown agent: {agent_id}"
        
        if context.can_perform(capability):
            return True, "Capability granted"
        else:
            return False, f"Agent {agent_id} lacks capability: {capability}"
    
    def validate_operation(
        self,
        agent_id: str,
        operation_type: str,
    ) -> tuple[bool, str]:
        """Validate that an agent can perform an operation type.
        
        Maps operation types to required capabilities.
        
        Args:
            agent_id: Agent identifier
            operation_type: Type of operation
        
        Returns:
            Tuple of (is_valid, reason)
        """
        # Map operation types to capabilities
        operation_capability_map = {
            "read_file": Capability.FILE_READ.value,
            "write_file": Capability.FILE_WRITE.value,
            "delete_file": Capability.FILE_DELETE.value,
            "move_file": Capability.FILE_WRITE.value,  # Requires write
            "copy_file": Capability.FILE_READ.value,  # Read is sufficient for source
            "exec_command": Capability.EXEC_COMMAND.value,
            "network_request": Capability.NETWORK_REQUEST.value,
            "secret_access": Capability.SECRET_READ.value,
            "agent_spawn": Capability.AGENT_SPAWN.value,
        }
        
        required_capability = operation_capability_map.get(operation_type)
        if not required_capability:
            # Unknown operations require admin
            required_capability = Capability.GOVERNANCE_ADMIN.value
        
        return self.validate_capability(agent_id, required_capability)
    
    def audit_delegation_chain(self, agent_id: str) -> dict:
        """Generate an audit report for an agent's delegation chain.
        
        Args:
            agent_id: Agent identifier
        
        Returns:
            Audit report dictionary
        """
        context = self._agent_contexts.get(agent_id)
        if not context:
            return {"error": f"Unknown agent: {agent_id}"}
        
        history = self.get_delegation_history(agent_id)
        
        return {
            "agent_id": agent_id,
            "is_root": context.is_root_agent(),
            "original_authority": context.original_authority,
            "current_capabilities": context.capabilities.to_list(),
            "chain_depth": len(history),
            "chain": [chain.to_dict() for chain in history],
        }


def create_delegation_manager() -> DelegationManager:
    """Factory function to create a delegation manager."""
    return DelegationManager()
