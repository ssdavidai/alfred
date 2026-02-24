# Bat Protocol: Phase 3 — Universality

> **Document Status:** CANONICAL  
> **Version:** 1.0.0  
> **Created:** 2026-02-24  
> **Edit Policy:** APPEND ONLY — Do not modify existing content. Add new sections via amendments.

---

## Phase Overview

**Duration:** Weeks 9-12  
**Goal:** Cross-framework and cross-language support for "any agent environment" claim.

**Prerequisites:** Phase 2 complete

**Success State:** Non-Python systems can implement Bat Protocol, at least one external framework is wrapped with governance, ledger integrity can be verified independently, and governance is observable in production metrics.

---

## Deliverables Checklist

- [ ] Protocol buffer schema (language-agnostic wire format)
- [ ] JSON Schema export (alternative wire format)
- [ ] Framework adapter interface (protocol for wrapping frameworks)
- [ ] Reference adapter (at least one external framework)
- [ ] Standalone package (`bat-protocol` pip-installable)
- [ ] Cross-language specification document
- [ ] Ledger verification tool (`bat verify-ledger`)
- [ ] Observability metrics (OpenTelemetry/Prometheus emission)
- [ ] Policy composition documentation (precedence and composition rules)

---

## Component Specifications

### 1. Protocol Buffer Schema

**Location:** `proto/bat_protocol.proto`

```protobuf
syntax = "proto3";

package bat_protocol;

// =============================================================================
// Core Messages
// =============================================================================

message OperationProposal {
  // Unique identifier for this proposal
  string proposal_id = 1;

  // Identity of the agent proposing the operation
  string agent_id = 2;

  // Operation type from standard taxonomy
  string operation_type = 3;

  // Target of the operation (path, URL, resource identifier)
  string target = 4;

  // Operation-specific metadata
  map<string, string> metadata = 5;

  // Hash of content to be written/modified (if applicable)
  string content_hash = 6;

  // Timestamp in Unix milliseconds
  int64 timestamp_unix_ms = 7;

  // Agent manifest hash (for capability verification)
  string manifest_hash = 8;
}

message RiskClassification {
  // ID of the proposal being classified
  string proposal_id = 1;

  // Risk level assigned
  RiskLevel level = 2;

  // ID of the rule that matched
  string rule_id = 3;

  // Human-readable explanation
  string rationale = 4;

  // Timestamp of classification
  int64 timestamp_unix_ms = 5;
}

enum RiskLevel {
  RISK_LEVEL_UNSPECIFIED = 0;
  RISK_LEVEL_L1 = 1;  // Low risk
  RISK_LEVEL_L2 = 2;  // Medium risk
  RISK_LEVEL_L3 = 3;  // High risk
}

message EnforcementDecision {
  // ID of the proposal being decided
  string proposal_id = 1;

  // Action to take
  Action action = 2;

  // Version of the policy that was applied
  string policy_version = 3;

  // Human-readable explanation
  string rationale = 4;

  // The classification that led to this decision
  RiskClassification classification = 5;

  // Timestamp of decision
  int64 timestamp_unix_ms = 6;
}

enum Action {
  ACTION_UNSPECIFIED = 0;
  ACTION_ALLOW = 1;
  ACTION_LOG = 2;
  ACTION_REQUIRE_CONFIRMATION = 3;
  ACTION_BLOCK = 4;
  ACTION_QUARANTINE = 5;
}

// =============================================================================
// Ledger Messages
// =============================================================================

message LedgerEntry {
  // Unique entry ID
  string entry_id = 1;

  // Timestamp
  int64 timestamp_unix_ms = 2;

  // The proposal that was evaluated
  OperationProposal proposal = 3;

  // The decision that was made
  EnforcementDecision decision = 4;

  // Hash of previous entry (chain)
  string previous_hash = 5;

  // Hash of this entry
  string hash = 6;

  // HMAC signature
  string signature = 7;
}

// =============================================================================
// Service Definitions (for remote governance)
// =============================================================================

service BatGovernance {
  // Classify a proposal
  rpc Classify(OperationProposal) returns (RiskClassification);

  // Evaluate and decide on a proposal
  rpc Evaluate(OperationProposal) returns (EnforcementDecision);

  // Verify ledger integrity
  rpc VerifyLedger(VerifyRequest) returns (VerifyResponse);
}

message VerifyRequest {
  string ledger_path = 1;
}

message VerifyResponse {
  bool valid = 1;
  repeated string errors = 2;
  int64 entries_checked = 3;
}
```

### 2. JSON Schema Export

**Location:** `schemas/bat_protocol.json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://alfred.ai/schemas/bat_protocol.json",
  "title": "Bat Protocol",
  "description": "JSON Schema for Bat Protocol messages",
  "definitions": {
    "OperationProposal": {
      "type": "object",
      "required": [
        "proposal_id",
        "agent_id",
        "operation_type",
        "target",
        "timestamp_unix_ms"
      ],
      "properties": {
        "proposal_id": {
          "type": "string",
          "format": "uuid",
          "description": "Unique identifier for this proposal"
        },
        "agent_id": {
          "type": "string",
          "description": "Identity of the agent proposing the operation"
        },
        "operation_type": {
          "type": "string",
          "enum": [
            "read_file",
            "write_file",
            "delete_file",
            "modify_permissions",
            "create_directory",
            "exec_command",
            "spawn_process",
            "kill_process",
            "modify_environment",
            "http_request",
            "open_socket",
            "dns_lookup",
            "download_file",
            "read_secret",
            "write_secret",
            "delete_secret",
            "list_secrets",
            "read_state",
            "write_state",
            "delete_state",
            "modify_schema",
            "spawn_agent",
            "message_agent",
            "terminate_agent",
            "modify_agent_config",
            "api_call",
            "database_query",
            "database_mutate",
            "send_email",
            "webhook_trigger"
          ],
          "description": "Operation type from standard taxonomy"
        },
        "target": {
          "type": "string",
          "description": "Target of the operation"
        },
        "metadata": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          },
          "description": "Operation-specific metadata"
        },
        "content_hash": {
          "type": "string",
          "pattern": "^[a-fA-F0-9]{64}$",
          "description": "SHA-256 hash of content"
        },
        "timestamp_unix_ms": {
          "type": "integer",
          "minimum": 0,
          "description": "Timestamp in Unix milliseconds"
        },
        "manifest_hash": {
          "type": "string",
          "pattern": "^[a-fA-F0-9]{64}$",
          "description": "Agent manifest hash"
        }
      }
    },
    "RiskLevel": {
      "type": "string",
      "enum": ["L1", "L2", "L3"],
      "description": "Risk level classification"
    },
    "RiskClassification": {
      "type": "object",
      "required": ["proposal_id", "level", "rule_id", "rationale"],
      "properties": {
        "proposal_id": {
          "type": "string",
          "format": "uuid"
        },
        "level": {
          "$ref": "#/definitions/RiskLevel"
        },
        "rule_id": {
          "type": "string",
          "description": "ID of the rule that matched"
        },
        "rationale": {
          "type": "string",
          "description": "Human-readable explanation"
        },
        "timestamp_unix_ms": {
          "type": "integer",
          "minimum": 0
        }
      }
    },
    "Action": {
      "type": "string",
      "enum": ["allow", "log", "require_confirmation", "block", "quarantine"],
      "description": "Enforcement action"
    },
    "EnforcementDecision": {
      "type": "object",
      "required": ["proposal_id", "action", "policy_version"],
      "properties": {
        "proposal_id": {
          "type": "string",
          "format": "uuid"
        },
        "action": {
          "$ref": "#/definitions/Action"
        },
        "policy_version": {
          "type": "string",
          "description": "Version of the policy applied"
        },
        "rationale": {
          "type": "string"
        },
        "classification": {
          "$ref": "#/definitions/RiskClassification"
        },
        "timestamp_unix_ms": {
          "type": "integer",
          "minimum": 0
        }
      }
    },
    "LedgerEntry": {
      "type": "object",
      "required": [
        "entry_id",
        "timestamp_unix_ms",
        "proposal",
        "decision",
        "previous_hash",
        "hash",
        "signature"
      ],
      "properties": {
        "entry_id": {
          "type": "string",
          "format": "uuid"
        },
        "timestamp_unix_ms": {
          "type": "integer",
          "minimum": 0
        },
        "proposal": {
          "$ref": "#/definitions/OperationProposal"
        },
        "decision": {
          "$ref": "#/definitions/EnforcementDecision"
        },
        "previous_hash": {
          "type": "string",
          "pattern": "^[a-fA-F0-9]{64}$"
        },
        "hash": {
          "type": "string",
          "pattern": "^[a-fA-F0-9]{64}$"
        },
        "signature": {
          "type": "string",
          "pattern": "^[a-fA-F0-9]{64}$"
        }
      }
    }
  }
}
```

### 3. Framework Adapter Interface

**Location:** `src/alfred/bat/adapters/base.py`

```python
from abc import ABC, abstractmethod
from typing import Any, Optional
from dataclasses import dataclass

from ..proposal import OperationProposal
from ..enforcement import EnforcementDecision, Action

@dataclass
class AdapterConfig:
    """Configuration for a framework adapter."""
    agent_id: str
    intercept_operations: list[str]
    passthrough_operations: list[str]
    on_block: str = "raise"  # "raise" | "return_none" | "log"

class AgentFrameworkAdapter(ABC):
    """Abstract base class for wrapping agent frameworks with Bat governance.

    Implement this interface to add Bat Protocol governance to any agent framework.
    """

    def __init__(self, config: AdapterConfig, interceptor):
        self._config = config
        self._interceptor = interceptor

    @abstractmethod
    def intercept_operation(self, raw_operation: Any) -> OperationProposal:
        """Convert a framework-specific operation to a Bat proposal.

        This method must:
        1. Extract the operation type from the framework's representation
        2. Identify the target
        3. Extract relevant metadata
        4. Return a standardized OperationProposal

        Args:
            raw_operation: The framework's native operation representation

        Returns:
            OperationProposal ready for governance evaluation
        """
        ...

    @abstractmethod
    def apply_decision(self, decision: EnforcementDecision, raw_operation: Any) -> Any:
        """Apply a governance decision to a framework operation.

        This method must:
        1. Check the decision action
        2. Either allow, modify, or block the operation
        3. Return the result (or raise if blocked)

        Args:
            decision: The governance decision
            raw_operation: The original framework operation

        Returns:
            The result of applying the decision (may be None for blocked)
        """
        ...

    @abstractmethod
    def extract_agent_identity(self, context: Any) -> str:
        """Extract the agent identity from execution context.

        Args:
            context: Framework-specific execution context

        Returns:
            Agent identifier string
        """
        ...

    def should_intercept(self, operation_type: str) -> bool:
        """Check if an operation type should be intercepted."""
        if operation_type in self._config.passthrough_operations:
            return False
        if self._config.intercept_operations:
            return operation_type in self._config.intercept_operations
        return True  # Intercept all by default

    def wrap(self, func: callable) -> callable:
        """Wrap a function with governance interception.

        This is a convenience method for simple function wrapping.
        """
        def wrapped(*args, **kwargs):
            # Extract operation from function call
            operation = self._extract_operation_from_call(func, args, kwargs)

            if not self.should_intercept(operation.get("type", "")):
                return func(*args, **kwargs)

            # Create proposal
            proposal = self.intercept_operation(operation)

            # Evaluate through governance
            result = self._interceptor.intercept(
                agent_id=self._config.agent_id,
                operation_type=proposal.operation_type,
                target=proposal.target,
                metadata=proposal.metadata
            )

            # Apply decision
            return self.apply_decision(result.decision, operation)

        return wrapped

    @abstractmethod
    def _extract_operation_from_call(self, func: callable, args: tuple, kwargs: dict) -> dict:
        """Extract operation details from a function call."""
        ...
```

### 4. Reference Adapter: LangChain

**Location:** `src/alfred/bat/adapters/langchain.py`

```python
from typing import Any, Optional
import re

from .base import AgentFrameworkAdapter, AdapterConfig
from ..proposal import OperationProposal
from ..enforcement import EnforcementDecision, Action

class LangChainAdapter(AgentFrameworkAdapter):
    """Bat Protocol adapter for LangChain agents.

    Wraps LangChain tools and chains with governance interception.
    """

    # Map LangChain tool names to Bat operation types
    TOOL_MAPPING = {
        "bash": "exec_command",
        "python_repl": "exec_command",
        "file_read": "read_file",
        "file_write": "write_file",
        "requests": "http_request",
        "web_search": "http_request",
    }

    def intercept_operation(self, raw_operation: Any) -> OperationProposal:
        """Convert a LangChain tool invocation to a Bat proposal."""

        # Handle different LangChain operation types
        if hasattr(raw_operation, "tool"):
            # Tool invocation
            tool_name = raw_operation.tool
            tool_input = raw_operation.tool_input

            operation_type = self._map_tool_to_operation(tool_name)
            target = self._extract_target(tool_name, tool_input)
            metadata = {"tool": tool_name, "input": str(tool_input)[:500]}

        elif isinstance(raw_operation, dict):
            # Dict-based operation
            operation_type = raw_operation.get("type", "unknown")
            target = raw_operation.get("target", "")
            metadata = raw_operation.get("metadata", {})

        else:
            # Unknown format - default to L3
            operation_type = "unknown"
            target = str(raw_operation)[:100]
            metadata = {"raw_type": type(raw_operation).__name__}

        return OperationProposal(
            agent_id=self._config.agent_id,
            operation_type=operation_type,
            target=target,
            metadata=metadata
        )

    def apply_decision(self, decision: EnforcementDecision, raw_operation: Any) -> Any:
        """Apply governance decision to LangChain operation."""

        if decision.action == Action.ALLOW:
            # Execute the operation
            return raw_operation

        elif decision.action == Action.LOG:
            # Log but allow
            return raw_operation

        elif decision.action == Action.REQUIRE_CONFIRMATION:
            # In LangChain, we can't easily prompt for confirmation
            # So we treat this as a block with a clear message
            raise PermissionError(
                f"Operation requires confirmation: {decision.rationale}"
            )

        elif decision.action == Action.BLOCK:
            if self._config.on_block == "raise":
                raise PermissionError(f"Operation blocked: {decision.rationale}")
            elif self._config.on_block == "return_none":
                return None
            else:
                # Log and return None
                return None

        elif decision.action == Action.QUARANTINE:
            # Quarantine the operation for later review
            self._quarantine_operation(raw_operation, decision)
            raise PermissionError(f"Operation quarantined: {decision.rationale}")

        return raw_operation

    def extract_agent_identity(self, context: Any) -> str:
        """Extract agent identity from LangChain context."""
        if hasattr(context, "agent_name"):
            return context.agent_name
        if isinstance(context, dict):
            return context.get("agent_name", "langchain-agent")
        return "langchain-agent"

    def _map_tool_to_operation(self, tool_name: str) -> str:
        """Map LangChain tool name to Bat operation type."""
        normalized = tool_name.lower().replace("-", "_").replace(" ", "_")
        return self.TOOL_MAPPING.get(normalized, "api_call")

    def _extract_target(self, tool_name: str, tool_input: Any) -> str:
        """Extract target from tool input."""
        if isinstance(tool_input, str):
            # For bash commands, extract the command
            if tool_name.lower() in ("bash", "python_repl"):
                return f"shell:{tool_input[:100]}"
            return tool_input[:100]

        if isinstance(tool_input, dict):
            # Look for common target fields
            for key in ["path", "file_path", "url", "command", "query"]:
                if key in tool_input:
                    return str(tool_input[key])[:100]

        return str(tool_input)[:100]

    def _extract_operation_from_call(self, func: callable, args: tuple, kwargs: dict) -> dict:
        """Extract operation from LangChain function call."""
        # This is a simplified extraction - real implementation would
        # need to handle specific LangChain tool types
        return {
            "type": "api_call",
            "target": func.__name__,
            "metadata": {"args": str(args)[:200], "kwargs": str(kwargs)[:200]}
        }

    def _quarantine_operation(self, operation: Any, decision: EnforcementDecision) -> None:
        """Quarantine an operation for later review."""
        import json
        from datetime import datetime, timezone
        from pathlib import Path

        quarantine_dir = Path("./data/quarantine")
        quarantine_dir.mkdir(parents=True, exist_ok=True)

        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "operation": str(operation)[:1000],
            "decision": decision.rationale,
            "proposal_id": decision.proposal_id
        }

        quarantine_file = quarantine_dir / f"{decision.proposal_id}.json"
        quarantine_file.write_text(json.dumps(entry, indent=2))
```

### 5. Observability Metrics

**Location:** `src/alfred/bat/metrics.py`

```python
from dataclasses import dataclass
from typing import Optional
import time
import structlog

# Optional: OpenTelemetry support
try:
    from opentelemetry import metrics
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import ConsoleMetricsExporter
    HAS_OTEL = True
except ImportError:
    HAS_OTEL = False

# Optional: Prometheus support
try:
    from prometheus_client import Counter, Histogram, Gauge, Info
    HAS_PROMETHEUS = True
except ImportError:
    HAS_PROMETHEUS = False

@dataclass
class BatMetrics:
    """Metrics for Bat Protocol governance.

    Supports multiple backends:
    - Structured logging (always available)
    - OpenTelemetry (if installed)
    - Prometheus (if installed)
    """

    # Configuration
    service_name: str = "bat-protocol"
    enable_otel: bool = True
    enable_prometheus: bool = True
    enable_logging: bool = True

    def __post_init__(self):
        self._log = structlog.get_logger()

        # Initialize OpenTelemetry
        if self.enable_otel and HAS_OTEL:
            self._init_otel()

        # Initialize Prometheus
        if self.enable_prometheus and HAS_PROMETHEUS:
            self._init_prometheus()

    def _init_otel(self):
        """Initialize OpenTelemetry metrics."""
        provider = MeterProvider()
        metrics.set_meter_provider(provider)
        self._meter = metrics.get_meter(self.service_name)

        # Create instruments
        self._otel_proposals = self._meter.create_counter(
            "bat.proposals.total",
            description="Total number of operation proposals"
        )
        self._otel_by_risk = self._meter.create_counter(
            "bat.proposals.by_risk",
            description="Proposals by risk level"
        )
        self._otel_decisions = self._meter.create_counter(
            "bat.decisions.total",
            description="Total enforcement decisions"
        )
        self._otel_classification_latency = self._meter.create_histogram(
            "bat.classification.latency_ms",
            description="Classification latency in milliseconds"
        )

    def _init_prometheus(self):
        """Initialize Prometheus metrics."""
        self._prom_proposals = Counter(
            "bat_proposals_total",
            "Total operation proposals",
            ["agent_id", "operation_type"]
        )
        self._prom_by_risk = Counter(
            "bat_proposals_by_risk_total",
            "Proposals by risk level",
            ["level"]
        )
        self._prom_decisions = Counter(
            "bat_decisions_total",
            "Enforcement decisions",
            ["action"]
        )
        self._prom_classification_latency = Histogram(
            "bat_classification_latency_seconds",
            "Classification latency"
        )
        self._prom_ledger_size = Gauge(
            "bat_ledger_size_bytes",
            "Ledger file size in bytes"
        )
        self._prom_policy_version = Info(
            "bat_policy",
            "Current policy information"
        )
        self._prom_break_glass = Counter(
            "bat_break_glass_events_total",
            "Break-glass override events"
        )

    def record_proposal(self, agent_id: str, operation_type: str):
        """Record a new operation proposal."""
        if self.enable_logging:
            self._log.debug("metrics.proposal", agent_id=agent_id, operation_type=operation_type)

        if self.enable_otel and HAS_OTEL:
            self._otel_proposals.add(1, {"agent_id": agent_id, "operation_type": operation_type})

        if self.enable_prometheus and HAS_PROMETHEUS:
            self._prom_proposals.labels(agent_id=agent_id, operation_type=operation_type).inc()

    def record_classification(self, level: str, latency_ms: float):
        """Record a risk classification."""
        if self.enable_logging:
            self._log.debug("metrics.classification", level=level, latency_ms=latency_ms)

        if self.enable_otel and HAS_OTEL:
            self._otel_by_risk.add(1, {"level": level})
            self._otel_classification_latency.record(latency_ms)

        if self.enable_prometheus and HAS_PROMETHEUS:
            self._prom_by_risk.labels(level=level).inc()
            self._prom_classification_latency.observe(latency_ms / 1000)

    def record_decision(self, action: str):
        """Record an enforcement decision."""
        if self.enable_logging:
            self._log.debug("metrics.decision", action=action)

        if self.enable_otel and HAS_OTEL:
            self._otel_decisions.add(1, {"action": action})

        if self.enable_prometheus and HAS_PROMETHEUS:
            self._prom_decisions.labels(action=action).inc()

    def record_break_glass(self):
        """Record a break-glass event."""
        if self.enable_logging:
            self._log.warning("metrics.break_glass")

        if self.enable_prometheus and HAS_PROMETHEUS:
            self._prom_break_glass.inc()

    def update_ledger_size(self, size_bytes: int):
        """Update ledger size gauge."""
        if self.enable_prometheus and HAS_PROMETHEUS:
            self._prom_ledger_size.set(size_bytes)

    def set_policy_version(self, version: str, profile: str):
        """Set policy version info."""
        if self.enable_prometheus and HAS_PROMETHEUS:
            self._prom_policy_version.info({"version": version, "profile": profile})


class MetricsContext:
    """Context manager for timing operations."""

    def __init__(self, metrics: BatMetrics, operation: str):
        self._metrics = metrics
        self._operation = operation
        self._start = None

    def __enter__(self):
        self._start = time.perf_counter()
        return self

    def __exit__(self, *args):
        elapsed_ms = (time.perf_counter() - self._start) * 1000
        # Could log timing here
```

### 6. Policy Composition Documentation

**Location:** `docs/bat-protocol/POLICY_COMPOSITION.md`

```markdown
# Policy Composition and Precedence

## Rule Sources

Bat Protocol supports multiple sources of governance rules:

1. **System defaults** — Built-in rules for common attack patterns
2. **Agent manifests** — Declared capabilities per agent
3. **Path rules** — Directory/file-specific rules
4. **Operation rules** — Operation-type-specific rules
5. **Profile defaults** — Profile-based defaults
6. **Custom rules** — User-defined rules

## Precedence Order

Rules are evaluated in strict precedence order (highest authority first):
```

1. Explicit block rules (priority 100+)
2. Operation-specific rules (priority 50-99)
3. Path-based rules (priority 20-49)
4. Agent manifest rules (priority 10-19)
5. Profile defaults (priority 1-9)
6. System defaults (priority 0)

```

## Conflict Resolution

**MOST RESTRICTIVE WINS**

If any applicable rule yields L3, the final classification is L3.

```

Rule A says: L1
Rule B says: L2
Rule C says: L3
→ Final: L3

````

## Composition Algebra

### Union (OR)

Combine multiple rule sets — any rule can match:

```yaml
compose:
  - rules: system_defaults.yaml
  - rules: custom_rules.yaml
  mode: union
````

### Intersection (AND)

All rule sets must agree for lower risk:

```yaml
compose:
  - rules: team_a_rules.yaml
  - rules: team_b_rules.yaml
  mode: intersection
  # L1 only if BOTH say L1
  # L3 if EITHER says L3
```

### Override

Later rules override earlier:

```yaml
compose:
  - rules: base_rules.yaml
  - rules: override_rules.yaml
  mode: override
```

## Example: Multi-Source Policy

```yaml
# config.yaml
bat:
  policy:
    sources:
      - type: file
        path: rules/system.yaml
        priority: 0

      - type: file
        path: rules/custom.yaml
        priority: 50

      - type: manifest
        agent_id: curator
        priority: 10

      - type: profile
        name: secure
        priority: 5

    conflict_resolution: most_restrictive
    default_level: L3
```

````

---

## Test Specifications

### Wire Format Tests

```python
# tests/bat/test_wire_format.py

def test_protobuf_roundtrip():
    """Protobuf messages must roundtrip correctly."""
    from bat_protocol import OperationProposal as ProtoProposal

    original = ProtoProposal(
        proposal_id="test-123",
        agent_id="curator",
        operation_type="write_file",
        target="note/test.md",
        metadata={"key": "value"},
        content_hash="abc123",
        timestamp_unix_ms=1234567890000
    )

    # Serialize
    serialized = original.SerializeToString()

    # Deserialize
    restored = ProtoProposal()
    restored.ParseFromString(serialized)

    assert restored.proposal_id == original.proposal_id
    assert restored.agent_id == original.agent_id
    assert restored.operation_type == original.operation_type

def test_json_schema_validation():
    """JSON messages must validate against schema."""
    import jsonschema

    proposal = {
        "proposal_id": "test-123",
        "agent_id": "curator",
        "operation_type": "write_file",
        "target": "note/test.md",
        "timestamp_unix_ms": 1234567890000
    }

    # Load schema
    schema = json.load(open("schemas/bat_protocol.json"))

    # Validate
    jsonschema.validate(proposal, schema["definitions"]["OperationProposal"])
````

### Adapter Tests

```python
# tests/bat/test_adapters.py

def test_langchain_bash_interception():
    """LangChain bash tool must be intercepted."""
    adapter = LangChainAdapter(config, interceptor)

    operation = MockToolInvocation(tool="bash", tool_input="ls -la")
    proposal = adapter.intercept_operation(operation)

    assert proposal.operation_type == "exec_command"
    assert "ls" in proposal.target

def test_langchain_file_write_interception():
    """LangChain file write must be intercepted."""
    adapter = LangChainAdapter(config, interceptor)

    operation = MockToolInvocation(
        tool="file_write",
        tool_input={"file_path": "/etc/passwd", "content": "malicious"}
    )
    proposal = adapter.intercept_operation(operation)

    assert proposal.operation_type == "write_file"
    assert proposal.target == "/etc/passwd"
```

---

## Amendment History

| Date       | Version | Amendment                     | Author          |
| ---------- | ------- | ----------------------------- | --------------- |
| 2026-02-24 | 1.0.0   | Initial Phase 3 specification | Security Review |
