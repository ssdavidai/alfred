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

__version__ = "1.1.0"
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
]
