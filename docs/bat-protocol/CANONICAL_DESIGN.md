# Bat Protocol: Canonical Architectural Design Document

> **Document Status:** CANONICAL  
> **Version:** 1.0.0  
> **Created:** 2026-02-24  
> **Edit Policy:** APPEND ONLY — Do not modify existing content. Add new sections via amendments.

---

## Document Index

| Document         | Path                                               | Purpose                                     |
| ---------------- | -------------------------------------------------- | ------------------------------------------- |
| Canonical Design | `docs/bat-protocol/CANONICAL_DESIGN.md`            | This document — authoritative specification |
| Project Plan     | `docs/bat-protocol/PROJECT_PLAN.md`                | Implementation roadmap and milestones       |
| Phase 1 Spec     | `docs/bat-protocol/phases/PHASE_1_FOUNDATION.md`   | Foundation implementation details           |
| Phase 2 Spec     | `docs/bat-protocol/phases/PHASE_2_HARDENING.md`    | Hardening implementation details            |
| Phase 3 Spec     | `docs/bat-protocol/phases/PHASE_3_UNIVERSALITY.md` | Universality implementation details         |
| Phase 4 Spec     | `docs/bat-protocol/phases/PHASE_4_ENTERPRISE.md`   | Enterprise implementation details           |

---

## Part I: Core Principles

### The Foundational Invariant

```
NO AGENT DECIDES ITS OWN RISK.
```

This is the load-bearing architectural constraint. The moment an agent evaluates its own risk, the system becomes vulnerable to:

- Prompt injection
- Context manipulation
- Adversarial input reclassification

**Governance must be structurally separated from agency.**

The agent proposes. A distinct, deterministic engine classifies. A distinct engine enforces. These concerns never merge.

### Deterministic Over Probabilistic

The governance layer contains **no LLM calls**. Classification is a pure function:

```
(operation, context) → RiskLevel
```

This means:

- Governance is formally analyzable
- Tests can prove specific operations always map to specific risk levels
- No hallucination, context sensitivity, or adversarial manipulation in the governance path

### Proposal Abstraction

```
AGENTS NO LONGER DIRECTLY MUTATE. THEY PROPOSE.
```

The `OperationProposal` pattern converts arbitrary side effects into inspectable, classifiable, deniable data structures.

**Benefits:**

- **Inspectability** — before execution
- **Deniability** — proposals can be rejected
- **Replayability** — proposals can be re-evaluated under different policies
- **Auditability** — proposals can be logged regardless of outcome

---

## Part II: Architecture

### Component Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    BAT PROTOCOL CORE                     │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Operation   │  │    Risk      │  │  Enforcement   │  │
│  │  Contract    │──│    Engine    │──│    Engine       │  │
│  │  Schema      │  │  (Rules)     │  │  (Policy)      │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
│         │                │                   │           │
│  ┌──────┴────────────────┴───────────────────┴────────┐  │
│  │              Governance Ledger                      │  │
│  └─────────────────────────────────────────────────────┘  │
│         │                                    │           │
│  ┌──────┴──────────┐          ┌──────────────┴────────┐  │
│  │  Secret Backend │          │  Temporal Accumulator  │  │
│  └─────────────────┘          └───────────────────────┘  │
└──────────────────────────────────────────────────────────┘
         ↑                                     ↑
    ┌────┴─────┐                         ┌─────┴────┐
    │ Adapter  │                         │ Adapter  │
    │ LangChain│                         │ AutoGen  │
    └──────────┘                         └──────────┘
         ↑                                     ↑
    ┌────┴─────┐                         ┌─────┴────┐
    │  Agent   │                         │  Agent   │
    └──────────┘                         └──────────┘
```

### Core Components

#### 1. Operation Contract Schema

All agent operations are normalized to a standard proposal format:

```python
@dataclass
class OperationProposal:
    """Canonical representation of an agent's intended operation."""
    proposal_id: str           # UUID
    agent_id: str              # Which agent is proposing
    operation_type: str        # From standard taxonomy
    target: str                # What the operation affects
    metadata: dict[str, Any]   # Operation-specific details
    content_hash: str          # Hash of content to be written/modified
    timestamp: datetime        # When proposed
    previous_hash: str | None  # For modification tracking
```

#### 2. Risk Engine

Deterministic classification engine with composable predicate rules:

```python
@dataclass
class RiskRule:
    predicate: Callable[[OperationProposal], bool]
    level: RiskLevel
    rationale: str
    priority: int  # Higher priority rules override lower

class RiskEngine:
    def __init__(self, rules: list[RiskRule]):
        self._rules = sorted(rules, key=lambda r: r.priority, reverse=True)

    def classify(self, proposal: OperationProposal) -> RiskClassification:
        for rule in self._rules:
            if rule.predicate(proposal):
                return RiskClassification(
                    level=rule.level,
                    rule_id=rule.id,
                    rationale=rule.rationale
                )
        # DEFAULT DENY — no matching rule means highest risk
        return RiskClassification(level=RiskLevel.L3, rationale="no matching rule; default deny")
```

#### 3. Enforcement Engine

Policy-driven action determination:

```python
class EnforcementEngine:
    def __init__(self, policy: EnforcementPolicy, ledger: GovernanceLedger):
        self._policy = policy
        self._ledger = ledger

    def evaluate(self, proposal: OperationProposal, classification: RiskClassification) -> EnforcementDecision:
        action = self._policy.resolve_action(classification.level)
        decision = EnforcementDecision(
            proposal_id=proposal.proposal_id,
            action=action,
            policy_version=self._policy.version,
            classification=classification,
            timestamp=datetime.now(timezone.utc)
        )
        self._ledger.append(decision)
        return decision
```

#### 4. Governance Ledger

HMAC-signed append-only audit log:

```python
class GovernanceLedger:
    def __init__(self, path: Path, signing_key: bytes):
        self._path = path
        self._key = signing_key
        self._last_hash = self._read_last_hash()

    def append(self, event: LedgerEvent) -> None:
        event.previous_hash = self._last_hash
        event.hash = self._compute_hash(event)
        event.signature = hmac.new(
            self._key,
            event.hash.encode(),
            hashlib.sha256
        ).hexdigest()

        # Atomic write
        with tempfile.NamedTemporaryFile(
            dir=self._path.parent,
            delete=False,
            mode='a'
        ) as tmp:
            tmp.write(json.dumps(asdict(event)) + '\n')
            tmp.flush()
            os.fsync(tmp.fileno())

        os.replace(tmp.name, self._path)
        self._last_hash = event.hash
```

---

## Part III: Risk Classification System

### Risk Levels

| Level | Name   | Description                                   | Default Action              |
| ----- | ------ | --------------------------------------------- | --------------------------- |
| L1    | Low    | Routine operations within declared scope      | Allow + Log                 |
| L2    | Medium | Operations requiring awareness                | Log + Optional confirmation |
| L3    | High   | Sensitive or potentially dangerous operations | Block in enforce mode       |

### Contextual Classification

Risk is determined by **operation type + target context**, not type alone:

| Operation      | Context                  | Risk |
| -------------- | ------------------------ | ---- |
| `write_file`   | `~/inbox/note.md`        | L1   |
| `write_file`   | `/etc/crontab`           | L3   |
| `write_file`   | `~/.ssh/authorized_keys` | L3   |
| `exec_command` | `echo "hello"`           | L1   |
| `exec_command` | `curl ... \| bash`       | L3   |
| `exec_command` | `rm -rf /`               | L3   |

### Policy Conflict Resolution

```
Resolution order (highest authority first):
1. Explicit block rules (always win)
2. Operation-specific rules (most specific)
3. Path-based rules
4. Agent manifest constraints
5. Profile defaults
6. System defaults (L3 / deny)

Conflict strategy: MOST RESTRICTIVE WINS
If any applicable rule yields L3, classification is L3.
```

---

## Part IV: Failure Semantics

**The system MUST NOT silently degrade to unprotected execution.**

| Failure Mode           | Response                                        |
| ---------------------- | ----------------------------------------------- |
| Risk engine exception  | Classify as L3 (fail-closed)                    |
| Enforcement failure    | Block execution (fail-closed)                   |
| Ledger write failure   | Block in enforce mode; warn in passive          |
| Config parse failure   | Refuse to start                                 |
| Secret backend failure | Refuse operation; do not fall back to plaintext |

---

## Part V: Operation Taxonomy

Standard operation categories for cross-framework compatibility:

```yaml
categories:
  filesystem:
    - read_file
    - write_file
    - delete_file
    - modify_permissions
    - create_directory

  process:
    - exec_command
    - spawn_process
    - kill_process
    - modify_environment

  network:
    - http_request
    - open_socket
    - dns_lookup
    - download_file

  secrets:
    - read_secret
    - write_secret
    - delete_secret
    - list_secrets

  state:
    - read_state
    - write_state
    - delete_state
    - modify_schema

  agent:
    - spawn_agent
    - message_agent
    - terminate_agent
    - modify_agent_config

  external:
    - api_call
    - database_query
    - database_mutate
    - send_email
    - webhook_trigger
```

---

## Part VI: Secret Management

### Storage Resolution Order

1. **Environment-provided secret manager** (Vault, AWS Secrets Manager, etc.)
   - Via pluggable backend interface
2. **OS keyring** (keyring library)
   - With explicit backend detection and fallback
3. **Encrypted file store**
   - AES-256-GCM, key derived from user passphrase via Argon2id
   - Key file permissions enforced (0600)
4. **Plaintext .env**
   - ONLY with explicit flag: `bat.secrets.allow_plaintext = true`
   - Warning emitted on every access
   - Logged as L3 event

### Backend Interface

```python
class SecretBackend(Protocol):
    def get(self, key: str) -> str: ...
    def set(self, key: str, value: str) -> None: ...
    def delete(self, key: str) -> None: ...
    def list_keys(self) -> list[str]: ...
```

---

## Part VII: Break-Glass Mechanism

Emergency override capability for legitimate administrator bypass:

```python
@dataclass
class BreakGlassOverride:
    operator: str
    justification: str
    timestamp: datetime
    original_decision: Decision
    override_decision: Decision
    expiry: datetime  # Override is time-bounded
    signature: str    # Cryptographic proof of operator identity
```

**Requirements:**

- Logged to **separate** ledger (cannot be hidden in normal operation logs)
- Generates alerts
- Time-bounded (auto-expire)
- Requires stronger authentication than normal operations

---

## Part VIII: Temporal Risk Analysis

Individual operations may be safe; sequences may be dangerous:

```python
class TemporalRiskAccumulator:
    """Sliding window risk analysis."""

    def __init__(self, window: timedelta, escalation_rules: list[SequenceRule]):
        self._window = window
        self._rules = escalation_rules
        self._history: deque[OperationProposal] = deque()

    def evaluate_sequence(self, new_proposal: OperationProposal) -> Optional[RiskEscalation]:
        self._history.append(new_proposal)
        self._prune_expired()
        for rule in self._rules:
            if rule.matches(self._history):
                return RiskEscalation(
                    triggered_rule=rule,
                    escalated_level=rule.escalated_level,
                    contributing_operations=list(self._history)
                )
        return None
```

---

## Part IX: Framework Adapters

### Adapter Interface

```python
class AgentFrameworkAdapter(Protocol):
    """Implement this to wrap any agent framework with Bat governance."""

    def intercept_operation(self, raw_operation: Any) -> OperationProposal:
        """Convert framework-specific operation to Bat proposal."""
        ...

    def apply_decision(self, decision: EnforcementDecision, raw_operation: Any) -> Any:
        """Apply Bat decision to framework-specific execution."""
        ...

    def extract_agent_identity(self, context: Any) -> str:
        """Identify which agent is proposing."""
        ...
```

### Wire Format (Protocol Buffers)

```protobuf
syntax = "proto3";

message OperationProposal {
  string proposal_id = 1;
  string agent_id = 2;
  string operation_type = 3;
  string target = 4;
  map<string, string> metadata = 5;
  string content_hash = 6;
  int64 timestamp_unix_ms = 7;
}

message RiskClassification {
  string proposal_id = 1;
  RiskLevel level = 2;
  string rule_id = 3;
  string rationale = 4;
}

enum RiskLevel {
  L1 = 0;
  L2 = 1;
  L3 = 2;
}

message EnforcementDecision {
  string proposal_id = 1;
  Action action = 2;
  string policy_version = 3;
  string rationale = 4;
}

enum Action {
  ALLOW = 0;
  LOG = 1;
  REQUIRE_CONFIRMATION = 2;
  BLOCK = 3;
  QUARANTINE = 4;
}
```

---

## Part X: Observability

### Required Metrics

```python
class BatMetrics:
    proposals_total: Counter          # by agent, operation_type
    proposals_by_risk: Counter        # by level
    decisions_total: Counter          # by action (allow/block/etc)
    classification_latency: Histogram # must stay < 1ms p99
    enforcement_latency: Histogram
    ledger_write_latency: Histogram
    ledger_size_bytes: Gauge
    policy_version: Info
    break_glass_events: Counter       # should be near zero
```

### Alerts

- `break_glass_events > 0`
- `classification_latency p99 > 5ms`
- `ledger_write_failures > 0`
- `unknown_operation_types > threshold`

---

## Part XI: Comparative Assessment

| Approach         | Deterministic | Framework-Agnostic | Auditable | Fail-Closed | Agent-Aware |
| ---------------- | ------------- | ------------------ | --------- | ----------- | ----------- |
| No governance    | —             | —                  | —         | —           | —           |
| LLM-as-judge     | ✗             | ✗                  | Partially | ✗           | ✗           |
| RBAC             | ✓             | ✓                  | ✓         | ✓           | ✗           |
| ABAC (XACML)     | ✓             | ✓                  | ✓         | ✓           | ✗           |
| Capability-based | ✓             | Partially          | Partially | ✓           | ✗           |
| **Bat Protocol** | **✓**         | **✓**              | **✓**     | **✓**       | **✓**       |

**Differentiator:** Bat Protocol is agent-native. It understands that the entity proposing operations is autonomous, potentially adversarial, and must not self-govern.

---

## Part XII: Design Rationale

### Why This Architecture Is Correct

1. **The proposal abstraction** converts side effects into inspectable data. Most governance systems gate access; Bat Protocol gates _intent_.

2. **Deterministic classification** means governance is testable, provable, and immune to prompt injection.

3. **The agent manifest** creates a declared capability surface that can be audited before runtime.

4. **Risk proportionality** avoids the binary permit/deny model. L1/L2/L3 tiering with mode-dependent enforcement is more practical than access control lists.

5. **The interceptor pattern** means adoption cost is near zero.

### The Core Truth

```
THE PROTOCOL GOVERNS. THE AGENTS COMPUTE. THESE CONCERNS NEVER MERGE.
```

---

## Amendment History

| Date       | Version | Amendment                  | Author          |
| ---------- | ------- | -------------------------- | --------------- |
| 2026-02-24 | 1.0.0   | Initial canonical document | Security Review |

---

## Document Integrity

This document is the authoritative specification for Bat Protocol. All implementation must conform to this specification. Any deviations must be documented as explicit exceptions with rationale.

**Next:** See [`PROJECT_PLAN.md`](PROJECT_PLAN.md) for implementation roadmap.
