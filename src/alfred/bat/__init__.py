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

Security Elevation Phase 2 additions:
- GovernanceDaemon: Multi-process governance consistency
- LedgerEncryption: AES-256-GCM encryption at rest

Security Elevation Phase 3 additions:
- WireProtocolHandler: Structured message format for vector governance events
- IndexRebuildGovernor: Governed index rebuild with anomaly quarantine
- DriftGovernor: Advanced drift detection and governance triggers
- SandboxManager: OS-level sandbox integrations for untrusted execution

Phase 4 Enterprise additions:
- QuorumManager: Multi-party authorization for high-risk operations
- PolicySigner: Cryptographic policy signing
- ImmutablePolicyStore: Policy version management with hash chaining
- RemotePolicyClient: Remote policy distribution with caching
- LedgerSynchronizer: Multi-node ledger synchronization
- ComplianceReporter: SOC 2 / ISO 27001 compliance reporting

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

__version__ = "1.5.0"
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

# Security Elevation Phase 3 - Wire Protocol
from .wire_protocol import (
    WireProtocolHandler,
    WireMessage,
    ProtocolHeader,
    MessageType,
    MessagePriority,
    VectorPayload,
    AnomalyPayload,
    AnomalyType,
    DriftPayload,
    IndexRebuildPayload,
    QuarantineStatus,
    create_protocol_handler,
)

# Security Elevation Phase 3 - Index Rebuild Governance
from .index_governance import (
    IndexRebuildGovernor,
    AnomalyQuarantine,
    QuarantinedArtifact,
    QuarantineReason,
    RebuildRequest,
    RebuildProgress,
    RebuildStatus,
    RebuildApprovalStatus,
    create_rebuild_governor,
)

# Security Elevation Phase 3 - Drift Analytics
from .drift_analytics import (
    DriftGovernor,
    DriftDetector,
    AnomalyAnalyzer,
    DriftType,
    AnomalyScore,
    TriggerAction,
    DriftTrigger,
    DriftMetrics,
    VectorStatistics,
    create_drift_governor,
)

# Security Elevation Phase 3 - Sandbox
from .sandbox import (
    SandboxManager,
    SandboxBase,
    ProcessSandbox,
    PlatformSandbox,
    SandboxConfig,
    SandboxResources,
    SandboxStatus,
    SandboxType,
    IsolationLevel,
    ExecutionResult,
    create_sandbox_manager,
)

# Phase 4 Enterprise - Quorum Approval
from .quorum import (
    QuorumManager,
    ApprovalRequest,
    ApprovalStatus,
    ApproverIdentity,
    AuthMethod,
    create_quorum_manager,
)

# Phase 4 Enterprise - Policy Signing
from .policy_signing import (
    PolicySigner,
    SignedPolicy,
    ImmutablePolicyStore,
    PolicyVersionManager,
    PolicyStatus,
    create_policy_store,
)

# Phase 4 Enterprise - Remote Policy Distribution
from .policy_server import (
    RemotePolicyClient,
    PolicyServer,
    RemotePolicyResponse,
    CachedPolicy,
    PolicySource,
    create_remote_client,
    create_policy_server,
)

# Phase 4 Enterprise - Ledger Synchronization
from .ledger_sync import (
    LedgerSynchronizer,
    NodeInfo,
    SyncEntry,
    SyncState,
    SyncStatus,
    ConflictResolution,
    create_ledger_synchronizer,
)

# Phase 4 Enterprise - Compliance Reporting
from .compliance import (
    ComplianceReporter,
    ComplianceFramework,
    ComplianceControl,
    ControlStatus,
    Evidence,
    EvidenceType,
    ControlAssessment,
    SOC2_CONTROLS,
    ISO27001_CONTROLS,
    create_compliance_reporter,
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
    # Wire Protocol (Security Elevation Phase 3)
    "WireProtocolHandler",
    "WireMessage",
    "ProtocolHeader",
    "MessageType",
    "MessagePriority",
    "VectorPayload",
    "AnomalyPayload",
    "AnomalyType",
    "DriftPayload",
    "IndexRebuildPayload",
    "QuarantineStatus",
    "create_protocol_handler",
    # Index Rebuild Governance (Security Elevation Phase 3)
    "IndexRebuildGovernor",
    "AnomalyQuarantine",
    "QuarantinedArtifact",
    "QuarantineReason",
    "RebuildRequest",
    "RebuildProgress",
    "RebuildStatus",
    "RebuildApprovalStatus",
    "create_rebuild_governor",
    # Drift Analytics (Security Elevation Phase 3)
    "DriftGovernor",
    "DriftDetector",
    "AnomalyAnalyzer",
    "DriftType",
    "AnomalyScore",
    "TriggerAction",
    "DriftTrigger",
    "DriftMetrics",
    "VectorStatistics",
    "create_drift_governor",
    # Sandbox (Security Elevation Phase 3)
    "SandboxManager",
    "SandboxBase",
    "ProcessSandbox",
    "PlatformSandbox",
    "SandboxConfig",
    "SandboxResources",
    "SandboxStatus",
    "SandboxType",
    "IsolationLevel",
    "ExecutionResult",
    "create_sandbox_manager",
    # Quorum Approval (Phase 4 Enterprise)
    "QuorumManager",
    "ApprovalRequest",
    "ApprovalStatus",
    "ApproverIdentity",
    "AuthMethod",
    "create_quorum_manager",
    # Policy Signing (Phase 4 Enterprise)
    "PolicySigner",
    "SignedPolicy",
    "ImmutablePolicyStore",
    "PolicyVersionManager",
    "PolicyStatus",
    "create_policy_store",
    # Remote Policy Distribution (Phase 4 Enterprise)
    "RemotePolicyClient",
    "PolicyServer",
    "RemotePolicyResponse",
    "CachedPolicy",
    "PolicySource",
    "create_remote_client",
    "create_policy_server",
    # Ledger Synchronization (Phase 4 Enterprise)
    "LedgerSynchronizer",
    "NodeInfo",
    "SyncEntry",
    "SyncState",
    "SyncStatus",
    "ConflictResolution",
    "create_ledger_synchronizer",
    # Compliance Reporting (Phase 4 Enterprise)
    "ComplianceReporter",
    "ComplianceFramework",
    "ComplianceControl",
    "ControlStatus",
    "Evidence",
    "EvidenceType",
    "ControlAssessment",
    "SOC2_CONTROLS",
    "ISO27001_CONTROLS",
    "create_compliance_reporter",
]
