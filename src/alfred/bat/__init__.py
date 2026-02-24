"""
Bat Protocol - Deterministic Governance Layer for Autonomous Agent Systems.

Core Principle: No agent decides its own risk.

This module provides:
- OperationProposal: Canonical representation of agent operations
- RiskEngine: Deterministic risk classification (no LLM calls)
- EnforcementEngine: Policy-driven enforcement with audit logging
- GovernanceLedger: HMAC-signed append-only audit ledger
- SecretBackend: Secure secret storage interface
- BatInterceptor: Main entry point for governance

Phase 2 additions:
- DSL: YAML-based declarative risk rules
- PathHardener: Path security validation
- TemporalRiskAccumulator: Sliding window risk analysis
- BreakGlassManager: Emergency override mechanism
- Profiles: Pre-configured governance profiles

Security Elevation Phase 1 additions:
- IdentityRegistry: Agent identity verification (Ed25519/process attestation)
- DelegationManager: Capability delegation with provenance chains
- PolicyIntegrityGuard: Signed policy manifest verification
- VectorGovernanceStore: Semantic state governance (ZVEC)
- ResourceGovernor: Rate limits, queue depth, safe deserialization

Example:
    >>> from alfred.bat import BatInterceptor, RiskEngine, EnforcementEngine, GovernanceLedger
    >>> from alfred.bat.rules import DEFAULT_RULES
    >>> 
    >>> # Initialize governance components
    >>> risk_engine = RiskEngine(rules=DEFAULT_RULES)
    >>> ledger = GovernanceLedger(path=Path("data/bat-ledger.jsonl"), signing_key=b"secret")
    >>> enforcement = EnforcementEngine(policy=policy, ledger=ledger)
    >>> interceptor = BatInterceptor(risk_engine, enforcement, ledger)
    >>> 
    >>> # Intercept an operation
    >>> result = interceptor.intercept(
    ...     agent_id="curator",
    ...     operation_type="write_file",
    ...     target="~/vault/inbox/note.md"
    ... )
    >>> print(f"Allowed: {result.allowed}, Risk: {result.decision.classification.level}")
"""

__version__ = "1.3.0"
__author__ = "Alfred Security Team"

from .proposal import OperationProposal
from .risk import RiskEngine, RiskLevel, RiskClassification, RiskRule
from .enforcement import (
    EnforcementEngine,
    EnforcementPolicy,
    EnforcementDecision,
    EnforcementMode,
    Action,
)
from .ledger import GovernanceLedger, LedgerEntry, LedgerWriteError
from .secrets import (
    SecretBackend,
    KeyringBackend,
    EnvironmentBackend,
    SecretStorageError,
    get_default_backend,
)
from .interceptor import BatInterceptor, InterceptResult
from .path_security import PathHardener, PathSecurityError
from .temporal import (
    TemporalRiskAccumulator,
    SequenceRule,
    RiskEscalation,
)
from .break_glass import (
    BreakGlassManager,
    BreakGlassOverride,
    BreakGlassSession,
)
from .profiles import (
    BatProfile,
    ProfileName,
    get_profile,
    list_profiles,
    get_default_profile,
    PROFILES,
)

# Security Elevation Phase 1 - Track B: Identity, Delegation, Policy Integrity
from .identity import (
    IdentityRegistry,
    IdentityMode,
    AgentCredential,
    CredentialStatus,
    ProcessAttestation,
    SignedProposal,
    sign_proposal,
    create_identity_registry,
)
from .delegation import (
    DelegationManager,
    DelegationChain,
    DelegationContext,
    Capability,
    CapabilitySet,
    DelegationError,
    DEFAULT_CAPABILITIES,
    create_delegation_manager,
)
from .policy_integrity import (
    PolicyIntegrityGuard,
    PolicyManifest,
    ImmutableRoot,
    StartupGate,
    PolicyIntegrityError,
    create_integrity_guard,
)

# Security Elevation Phase 1 - Track C: Semantic State Governance (ZVEC)
from .zvec import (
    VectorGovernanceStore,
    VectorArtifact,
    IndexMutationEnvelope,
    DriftReport,
    VectorOperation,
    VerificationStrategy,
    DriftSignal,
    create_vector_store,
)

# Security Elevation Phase 1 - Track D: Platform/Operational Security
from .resource_governor import (
    ResourceGovernor,
    ResourceLimits,
    RateLimiter,
    MetadataValidator,
    QueueDepthMonitor,
    LedgerRotator,
    SafeDeserializer,
    ResourceLimitExceeded,
    DeserializationError,
    create_resource_governor,
)

# Security Elevation Phase 2 - Governance Daemon
from .daemon import (
    GovernanceDaemon,
    DaemonClient,
    DaemonMode,
    DaemonCommand,
    DaemonMessage,
    DaemonResponse,
    create_daemon,
)

# Security Elevation Phase 2 - Ledger Encryption
from .encryption import (
    LedgerEncryption,
    EncryptedBlock,
    EncryptedLedgerWriter,
    EncryptionError,
    create_encryption,
)

__all__ = [
    # Proposal
    "OperationProposal",
    # Risk
    "RiskEngine",
    "RiskLevel",
    "RiskClassification",
    "RiskRule",
    # Enforcement
    "EnforcementEngine",
    "EnforcementPolicy",
    "EnforcementDecision",
    "EnforcementMode",
    "Action",
    # Ledger
    "GovernanceLedger",
    "LedgerEntry",
    "LedgerWriteError",
    # Secrets
    "SecretBackend",
    "KeyringBackend",
    "EnvironmentBackend",
    "SecretStorageError",
    "get_default_backend",
    # Interceptor
    "BatInterceptor",
    "InterceptResult",
    # Path Security (Phase 2)
    "PathHardener",
    "PathSecurityError",
    # Temporal Analysis (Phase 2)
    "TemporalRiskAccumulator",
    "SequenceRule",
    "RiskEscalation",
    # Break-Glass (Phase 2)
    "BreakGlassManager",
    "BreakGlassOverride",
    "BreakGlassSession",
    # Profiles (Phase 2)
    "BatProfile",
    "ProfileName",
    "get_profile",
    "list_profiles",
    "get_default_profile",
    "PROFILES",
    # Identity (Security Elevation Phase 1 - Track B)
    "IdentityRegistry",
    "IdentityMode",
    "AgentCredential",
    "CredentialStatus",
    "ProcessAttestation",
    "SignedProposal",
    "sign_proposal",
    "create_identity_registry",
    # Delegation (Security Elevation Phase 1 - Track B)
    "DelegationManager",
    "DelegationChain",
    "DelegationContext",
    "Capability",
    "CapabilitySet",
    "DelegationError",
    "DEFAULT_CAPABILITIES",
    "create_delegation_manager",
    # Policy Integrity (Security Elevation Phase 1 - Track B)
    "PolicyIntegrityGuard",
    "PolicyManifest",
    "ImmutableRoot",
    "StartupGate",
    "PolicyIntegrityError",
    "create_integrity_guard",
    # ZVEC (Security Elevation Phase 1 - Track C)
    "VectorGovernanceStore",
    "VectorArtifact",
    "IndexMutationEnvelope",
    "DriftReport",
    "VectorOperation",
    "VerificationStrategy",
    "DriftSignal",
    "create_vector_store",
    # Resource Governor (Security Elevation Phase 1 - Track D)
    "ResourceGovernor",
    "ResourceLimits",
    "RateLimiter",
    "MetadataValidator",
    "QueueDepthMonitor",
    "LedgerRotator",
    "SafeDeserializer",
    "ResourceLimitExceeded",
    "DeserializationError",
    "create_resource_governor",
    # Governance Daemon (Security Elevation Phase 2)
    "GovernanceDaemon",
    "DaemonClient",
    "DaemonMode",
    "DaemonCommand",
    "DaemonMessage",
    "DaemonResponse",
    "create_daemon",
    # Ledger Encryption (Security Elevation Phase 2)
    "LedgerEncryption",
    "EncryptedBlock",
    "EncryptedLedgerWriter",
    "EncryptionError",
    "create_encryption",
]
