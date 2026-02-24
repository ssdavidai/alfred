# Bat Protocol: Phase 4 — Enterprise

> **Document Status:** CANONICAL  
> **Version:** 1.0.0  
> **Created:** 2026-02-24  
> **Edit Policy:** APPEND ONLY — Do not modify existing content. Add new sections via amendments.

---

## Phase Overview

**Duration:** Weeks 13+  
**Goal:** Advanced governance features for organizational deployment.

**Prerequisites:** Phase 3 complete

**Success State:** Organizations can require multiple approvers for high-risk operations, policies cannot be modified without detection, governance scales to multi-node deployments, and compliance requirements are documented and reportable.

---

## Deliverables Checklist

- [ ] Quorum approval workflow (multi-party authorization)
- [ ] Policy signing (cryptographic policy integrity)
- [ ] Policy immutability (tamper-evident policy storage)
- [ ] Remote policy distribution (central policy server)
- [ ] Multi-node ledger synchronization (distributed audit trail)
- [ ] Compliance reports (SOC 2 / ISO 27001 mapping)
- [ ] Compliance documentation (control mapping docs)

---

## Component Specifications

### 1. Quorum Approval Workflow

**Location:** `src/alfred/bat/quorum.py`

```python
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
import hashlib
import json
from typing import Optional
import uuid

from .proposal import OperationProposal
from .enforcement import EnforcementDecision, Action
from .risk import RiskLevel

class ApprovalStatus(Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"
    EXECUTED = "executed"

@dataclass
class ApprovalRequest:
    """Request for quorum approval of a high-risk operation."""
    request_id: str
    proposal: OperationProposal
    decision: EnforcementDecision
    required_approvers: int
    current_approvals: list[str] = field(default_factory=list)
    rejections: list[str] = field(default_factory=list)
    status: ApprovalStatus = ApprovalStatus.PENDING
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc) + timedelta(hours=24))
    executed_at: Optional[datetime] = None
    executed_by: Optional[str] = None

    def is_approved(self) -> bool:
        return len(self.current_approvals) >= self.required_approvers

    def is_rejected(self) -> bool:
        # Rejected if more rejections than remaining possible approvals
        remaining = self.required_approvers - len(self.current_approvals)
        return len(self.rejections) > remaining

    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) > self.expires_at

@dataclass
class ApproverIdentity:
    """Identity of an approver with authentication proof."""
    approver_id: str
    name: str
    role: str
    authenticated_at: datetime
    auth_method: str  # "password", "mfa", "sso", "api_key"
    signature: str = ""

class QuorumManager:
    """Manage multi-party approval for high-risk operations.

    Quorum requirements are configured per risk level:
    - L1: No approval required
    - L2: 1 approver (single confirmation)
    - L3: 2+ approvers (full quorum)
    """

    def __init__(
        self,
        approval_store_path: Path,
        signing_key: bytes,
        quorum_config: dict[RiskLevel, int] = None
    ):
        self._store_path = approval_store_path
        self._signing_key = signing_key
        self._quorum_config = quorum_config or {
            RiskLevel.L1: 0,  # No approval
            RiskLevel.L2: 1,  # Single approver
            RiskLevel.L3: 2,  # Quorum of 2
        }
        self._store_path.parent.mkdir(parents=True, exist_ok=True)

    def create_request(
        self,
        proposal: OperationProposal,
        decision: EnforcementDecision
    ) -> ApprovalRequest:
        """Create an approval request for a high-risk operation."""
        required = self._quorum_config.get(decision.classification.level, 2)

        request = ApprovalRequest(
            request_id=str(uuid.uuid4()),
            proposal=proposal,
            decision=decision,
            required_approvers=required
        )

        self._store_request(request)
        self._notify_approvers(request)

        return request

    def add_approval(
        self,
        request_id: str,
        approver: ApproverIdentity
    ) -> ApprovalRequest:
        """Add an approval to a pending request."""
        request = self._load_request(request_id)

        if request.status != ApprovalStatus.PENDING:
            raise ValueError(f"Request is not pending: {request.status}")

        if request.is_expired():
            request.status = ApprovalStatus.EXPIRED
            self._store_request(request)
            raise ValueError("Request has expired")

        # Verify approver identity
        if not self._verify_approver(approver):
            raise ValueError("Approver identity verification failed")

        # Check for duplicate approval
        if approver.approver_id in request.current_approvals:
            raise ValueError("Approver has already approved")

        # Add approval
        request.current_approvals.append(approver.approver_id)

        # Update status
        if request.is_approved():
            request.status = ApprovalStatus.APPROVED
        elif request.is_rejected():
            request.status = ApprovalStatus.REJECTED

        self._store_request(request)
        self._log_approval(request, approver)

        return request

    def add_rejection(
        self,
        request_id: str,
        approver: ApproverIdentity,
        reason: str
    ) -> ApprovalRequest:
        """Add a rejection to a pending request."""
        request = self._load_request(request_id)

        if request.status != ApprovalStatus.PENDING:
            raise ValueError(f"Request is not pending: {request.status}")

        request.rejections.append(approver.approver_id)

        if request.is_rejected():
            request.status = ApprovalStatus.REJECTED

        self._store_request(request)
        self._log_rejection(request, approver, reason)

        return request

    def execute_approved(
        self,
        request_id: str,
        executed_by: str
    ) -> ApprovalRequest:
        """Mark an approved request as executed."""
        request = self._load_request(request_id)

        if request.status != ApprovalStatus.APPROVED:
            raise ValueError(f"Request is not approved: {request.status}")

        request.status = ApprovalStatus.EXECUTED
        request.executed_at = datetime.now(timezone.utc)
        request.executed_by = executed_by

        self._store_request(request)
        self._log_execution(request)

        return request

    def get_pending_requests(self) -> list[ApprovalRequest]:
        """Get all pending approval requests."""
        requests = []
        for file in self._store_path.glob("*.json"):
            try:
                request = self._load_request(file.stem)
                if request.status == ApprovalStatus.PENDING:
                    requests.append(request)
            except Exception:
                continue
        return requests

    def _store_request(self, request: ApprovalRequest) -> None:
        """Store a request to disk."""
        data = {
            "request_id": request.request_id,
            "proposal": request.proposal.__dict__ if hasattr(request.proposal, '__dict__') else request.proposal,
            "decision": request.decision.__dict__ if hasattr(request.decision, '__dict__') else request.decision,
            "required_approvers": request.required_approvers,
            "current_approvals": request.current_approvals,
            "rejections": request.rejections,
            "status": request.status.value,
            "created_at": request.created_at.isoformat(),
            "expires_at": request.expires_at.isoformat(),
            "executed_at": request.executed_at.isoformat() if request.executed_at else None,
            "executed_by": request.executed_by,
        }

        path = self._store_path / f"{request.request_id}.json"
        path.write_text(json.dumps(data, indent=2))

    def _load_request(self, request_id: str) -> ApprovalRequest:
        """Load a request from disk."""
        path = self._store_path / f"{request_id}.json"
        if not path.exists():
            raise ValueError(f"Request not found: {request_id}")

        data = json.loads(path.read_text())

        return ApprovalRequest(
            request_id=data["request_id"],
            proposal=data["proposal"],
            decision=data["decision"],
            required_approvers=data["required_approvers"],
            current_approvals=data["current_approvals"],
            rejections=data["rejections"],
            status=ApprovalStatus(data["status"]),
            created_at=datetime.fromisoformat(data["created_at"]),
            expires_at=datetime.fromisoformat(data["expires_at"]),
            executed_at=datetime.fromisoformat(data["executed_at"]) if data.get("executed_at") else None,
            executed_by=data.get("executed_by"),
        )

    def _verify_approver(self, approver: ApproverIdentity) -> bool:
        """Verify an approver's identity and signature."""
        # In production: verify against identity provider
        # For now, just check signature
        expected_sig = self._sign_approver(approver)
        return approver.signature == expected_sig

    def _sign_approver(self, approver: ApproverIdentity) -> str:
        """Sign an approver identity."""
        data = f"{approver.approver_id}:{approver.authenticated_at.isoformat()}"
        import hmac
        return hmac.new(self._signing_key, data.encode(), hashlib.sha256).hexdigest()

    def _notify_approvers(self, request: ApprovalRequest) -> None:
        """Notify eligible approvers of a new request."""
        # In production: send email, Slack, etc.
        import structlog
        log = structlog.get_logger()
        log.info(
            "quorum.request_created",
            request_id=request.request_id,
            required_approvers=request.required_approvers,
            risk_level=request.decision.classification.level.value
        )

    def _log_approval(self, request: ApprovalRequest, approver: ApproverIdentity) -> None:
        """Log an approval."""
        import structlog
        log = structlog.get_logger()
        log.info(
            "quorum.approval_added",
            request_id=request.request_id,
            approver_id=approver.approver_id,
            current_count=len(request.current_approvals),
            required=request.required_approvers
        )

    def _log_rejection(self, request: ApprovalRequest, approver: ApproverIdentity, reason: str) -> None:
        """Log a rejection."""
        import structlog
        log = structlog.get_logger()
        log.warning(
            "quorum.rejection_added",
            request_id=request.request_id,
            approver_id=approver.approver_id,
            reason=reason
        )

    def _log_execution(self, request: ApprovalRequest) -> None:
        """Log execution of an approved request."""
        import structlog
        log = structlog.get_logger()
        log.info(
            "quorum.executed",
            request_id=request.request_id,
            executed_by=request.executed_by
        )
```

### 2. Policy Signing and Immutability

**Location:** `src/alfred/bat/policy_integrity.py`

```python
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
from typing import Optional
import yaml

@dataclass
class SignedPolicy:
    """A cryptographically signed policy file."""
    policy_hash: str
    policy_content: str
    signature: str
    signed_at: datetime
    signed_by: str
    version: str
    previous_hash: Optional[str] = None

class PolicySigner:
    """Sign policy files for integrity verification."""

    def __init__(self, signing_key: bytes):
        self._key = signing_key

    def sign_policy(
        self,
        policy_path: Path,
        signed_by: str,
        version: str,
        previous_hash: Optional[str] = None
    ) -> SignedPolicy:
        """Sign a policy file."""
        content = policy_path.read_text(encoding="utf-8")
        policy_hash = hashlib.sha256(content.encode()).hexdigest()

        # Create signature
        sig_data = f"{policy_hash}:{version}:{signed_by}"
        import hmac
        signature = hmac.new(self._key, sig_data.encode(), hashlib.sha256).hexdigest()

        return SignedPolicy(
            policy_hash=policy_hash,
            policy_content=content,
            signature=signature,
            signed_at=datetime.now(timezone.utc),
            signed_by=signed_by,
            version=version,
            previous_hash=previous_hash
        )

    def verify_policy(self, signed: SignedPolicy) -> bool:
        """Verify a signed policy."""
        # Verify hash
        expected_hash = hashlib.sha256(signed.policy_content.encode()).hexdigest()
        if signed.policy_hash != expected_hash:
            return False

        # Verify signature
        sig_data = f"{signed.policy_hash}:{signed.version}:{signed.signed_by}"
        import hmac
        expected_sig = hmac.new(self._key, sig_data.encode(), hashlib.sha256).hexdigest()
        if signed.signature != expected_sig:
            return False

        return True

class ImmutablePolicyStore:
    """Store policies with immutability guarantees.

    Policies are stored in an append-only format with hash chaining,
    similar to the governance ledger.
    """

    def __init__(self, store_path: Path, signing_key: bytes):
        self._path = store_path
        self._signer = PolicySigner(signing_key)
        self._path.mkdir(parents=True, exist_ok=True)

    def store_policy(
        self,
        policy_path: Path,
        signed_by: str,
        version: str
    ) -> SignedPolicy:
        """Store a new policy version."""
        # Get previous hash
        previous = self._get_latest()
        previous_hash = previous.policy_hash if previous else None

        # Sign
        signed = self._signer.sign_policy(policy_path, signed_by, version, previous_hash)

        # Store
        entry_path = self._path / f"{version}.json"
        entry_path.write_text(json.dumps({
            "policy_hash": signed.policy_hash,
            "policy_content": signed.policy_content,
            "signature": signed.signature,
            "signed_at": signed.signed_at.isoformat(),
            "signed_by": signed.signed_by,
            "version": signed.version,
            "previous_hash": signed.previous_hash,
        }, indent=2))

        return signed

    def get_policy(self, version: str) -> Optional[SignedPolicy]:
        """Get a specific policy version."""
        entry_path = self._path / f"{version}.json"
        if not entry_path.exists():
            return None

        data = json.loads(entry_path.read_text())
        return SignedPolicy(
            policy_hash=data["policy_hash"],
            policy_content=data["policy_content"],
            signature=data["signature"],
            signed_at=datetime.fromisoformat(data["signed_at"]),
            signed_by=data["signed_by"],
            version=data["version"],
            previous_hash=data.get("previous_hash"),
        )

    def get_current(self) -> Optional[SignedPolicy]:
        """Get the current (latest) policy."""
        return self._get_latest()

    def _get_latest(self) -> Optional[SignedPolicy]:
        """Get the latest policy version."""
        versions = sorted(self._path.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not versions:
            return None

        data = json.loads(versions[0].read_text())
        return SignedPolicy(
            policy_hash=data["policy_hash"],
            policy_content=data["policy_content"],
            signature=data["signature"],
            signed_at=datetime.fromisoformat(data["signed_at"]),
            signed_by=data["signed_by"],
            version=data["version"],
            previous_hash=data.get("previous_hash"),
        )

    def verify_chain(self) -> tuple[bool, list[str]]:
        """Verify the integrity of the policy chain."""
        errors = []
        versions = sorted(self._path.glob("*.json"), key=lambda p: p.stat().st_mtime)

        previous_hash = None
        for entry_path in versions:
            data = json.loads(entry_path.read_text())

            # Verify signature
            signed = SignedPolicy(
                policy_hash=data["policy_hash"],
                policy_content=data["policy_content"],
                signature=data["signature"],
                signed_at=datetime.fromisoformat(data["signed_at"]),
                signed_by=data["signed_by"],
                version=data["version"],
                previous_hash=data.get("previous_hash"),
            )

            if not self._signer.verify_policy(signed):
                errors.append(f"{entry_path.name}: Invalid signature")

            # Verify chain
            if data.get("previous_hash") != previous_hash:
                errors.append(f"{entry_path.name}: Chain broken")

            previous_hash = data["policy_hash"]

        return len(errors) == 0, errors
```

### 3. Remote Policy Distribution

**Location:** `src/alfred/bat/policy_server.py`

```python
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import hmac
import json
from typing import Optional
import httpx

@dataclass
class PolicyServerConfig:
    """Configuration for remote policy server."""
    url: str
    api_key: str
    cache_dir: Path
    cache_ttl_seconds: int = 300  # 5 minutes
    verify_tls: bool = True

class RemotePolicyClient:
    """Client for fetching policies from a central server.

    Features:
    - Caching with TTL
    - Signature verification
    - Fallback to cached version on failure
    """

    def __init__(self, config: PolicyServerConfig, verification_key: bytes):
        self._config = config
        self._verification_key = verification_key
        self._config.cache_dir.mkdir(parents=True, exist_ok=True)
        self._client = httpx.Client(
            timeout=30.0,
            verify=config.verify_tls
        )

    def fetch_policy(self, policy_name: str = "default") -> dict:
        """Fetch a policy from the server."""
        # Check cache
        cached = self._get_cached(policy_name)
        if cached and not self._is_cache_expired(cached):
            return cached["policy"]

        # Fetch from server
        try:
            response = self._client.get(
                f"{self._config.url}/policies/{policy_name}",
                headers={"Authorization": f"Bearer {self._config.api_key}"}
            )
            response.raise_for_status()

            data = response.json()

            # Verify signature
            if not self._verify_server_response(data):
                raise ValueError("Server response signature invalid")

            # Cache
            self._cache_policy(policy_name, data["policy"])

            return data["policy"]

        except httpx.HTTPError as e:
            # Fallback to cached version
            if cached:
                import structlog
                log = structlog.get_logger()
                log.warning("policy_server_fallback", error=str(e))
                return cached["policy"]
            raise

    def _verify_server_response(self, data: dict) -> bool:
        """Verify the server's response signature."""
        if "signature" not in data or "policy" not in data:
            return False

        # Compute expected signature
        policy_json = json.dumps(data["policy"], sort_keys=True)
        expected_sig = hmac.new(
            self._verification_key,
            policy_json.encode(),
            hashlib.sha256
        ).hexdigest()

        return hmac.compare_digest(data["signature"], expected_sig)

    def _get_cached(self, policy_name: str) -> Optional[dict]:
        """Get cached policy."""
        cache_path = self._config.cache_dir / f"{policy_name}.json"
        if not cache_path.exists():
            return None

        try:
            return json.loads(cache_path.read_text())
        except (json.JSONDecodeError, OSError):
            return None

    def _cache_policy(self, policy_name: str, policy: dict) -> None:
        """Cache a policy."""
        cache_path = self._config.cache_dir / f"{policy_name}.json"
        cache_data = {
            "policy": policy,
            "cached_at": datetime.now(timezone.utc).isoformat(),
        }
        cache_path.write_text(json.dumps(cache_data))

    def _is_cache_expired(self, cached: dict) -> bool:
        """Check if cached policy is expired."""
        cached_at = datetime.fromisoformat(cached["cached_at"])
        age = (datetime.now(timezone.utc) - cached_at).total_seconds()
        return age > self._config.cache_ttl_seconds

class PolicyServer:
    """Simple policy server for central distribution.

    In production, this would be a separate service with:
    - Authentication
    - Rate limiting
    - Audit logging
    - High availability
    """

    def __init__(self, policies_dir: Path, signing_key: bytes):
        self._policies_dir = policies_dir
        self._signing_key = signing_key

    def get_policy(self, policy_name: str) -> dict:
        """Get a policy by name."""
        policy_path = self._policies_dir / f"{policy_name}.yaml"
        if not policy_path.exists():
            raise ValueError(f"Policy not found: {policy_name}")

        import yaml
        policy = yaml.safe_load(policy_path.read_text())

        # Sign
        policy_json = json.dumps(policy, sort_keys=True)
        signature = hmac.new(
            self._signing_key,
            policy_json.encode(),
            hashlib.sha256
        ).hexdigest()

        return {
            "policy": policy,
            "signature": signature,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
```

### 4. Compliance Reporting

**Location:** `src/alfred/bat/compliance.py`

```python
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
from typing import Optional
from enum import Enum

class ComplianceFramework(Enum):
    SOC2 = "soc2"
    ISO27001 = "iso27001"
    GDPR = "gdpr"
    HIPAA = "hipaa"

@dataclass
class ComplianceControl:
    """A compliance control mapping."""
    control_id: str
    framework: ComplianceFramework
    description: str
    implementation: str
    evidence_location: str

# Pre-defined control mappings
CONTROL_MAPPINGS = {
    # SOC 2 Controls
    "CC6.1": ComplianceControl(
        control_id="CC6.1",
        framework=ComplianceFramework.SOC2,
        description="Logical and physical access controls",
        implementation="Bat Protocol enforces access controls through risk classification and enforcement",
        evidence_location="data/governance_ledger.jsonl"
    ),
    "CC6.6": ComplianceControl(
        control_id="CC6.6",
        framework=ComplianceFramework.SOC2,
        description="Security of transmission and storage",
        implementation="All governance decisions are logged with HMAC signatures",
        evidence_location="data/governance_ledger.jsonl"
    ),
    "CC7.1": ComplianceControl(
        control_id="CC7.1",
        framework=ComplianceFramework.SOC2,
        description="Protection against malware",
        implementation="Remote code execution patterns are blocked by default (L3)",
        evidence_location="data/governance_ledger.jsonl"
    ),
    "CC7.2": ComplianceControl(
        control_id="CC7.2",
        framework=ComplianceFramework.SOC2,
        description="Monitoring and logging",
        implementation="All operations are logged to append-only ledger with integrity verification",
        evidence_location="data/governance_ledger.jsonl"
    ),

    # ISO 27001 Controls
    "A.9.1.1": ComplianceControl(
        control_id="A.9.1.1",
        framework=ComplianceFramework.ISO27001,
        description="Access control policy",
        implementation="Risk-based access control through Bat Protocol classification",
        evidence_location="config/bat_rules.yaml"
    ),
    "A.9.2.1": ComplianceControl(
        control_id="A.9.2.1",
        framework=ComplianceFramework.ISO27001,
        description="User access provisioning",
        implementation="Agent manifests declare capabilities; governance enforces",
        evidence_location="data/agent_manifests/"
    ),
    "A.12.4.1": ComplianceControl(
        control_id="A.12.4.1",
        framework=ComplianceFramework.ISO27001,
        description="Event logging",
        implementation="All governance events logged to immutable ledger",
        evidence_location="data/governance_ledger.jsonl"
    ),
}

class ComplianceReporter:
    """Generate compliance reports from governance data."""

    def __init__(self, ledger_path: Path, output_dir: Path):
        self._ledger_path = ledger_path
        self._output_dir = output_dir
        self._output_dir.mkdir(parents=True, exist_ok=True)

    def generate_report(
        self,
        framework: ComplianceFramework,
        start_date: datetime,
        end_date: datetime
    ) -> dict:
        """Generate a compliance report for a time period."""

        # Load ledger entries
        entries = self._load_entries(start_date, end_date)

        # Get applicable controls
        controls = [
            c for c in CONTROL_MAPPINGS.values()
            if c.framework == framework
        ]

        # Build report
        report = {
            "report_id": f"compliance-{framework.value}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
            "framework": framework.value,
            "period": {
                "start": start_date.isoformat(),
                "end": end_date.isoformat(),
            },
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "summary": {
                "total_operations": len(entries),
                "blocked_operations": sum(1 for e in entries if e.get("decision", {}).get("action") == "block"),
                "l3_classifications": sum(1 for e in entries if "L3" in str(e.get("decision", {}).get("classification", {}))),
                "break_glass_events": self._count_break_glass_events(start_date, end_date),
            },
            "controls": [],
        }

        for control in controls:
            control_report = {
                "control_id": control.control_id,
                "description": control.description,
                "implementation": control.implementation,
                "evidence": self._collect_evidence(control, entries),
                "status": "implemented",
            }
            report["controls"].append(control_report)

        # Save report
        report_path = self._output_dir / f"{report['report_id']}.json"
        report_path.write_text(json.dumps(report, indent=2))

        return report

    def _load_entries(self, start_date: datetime, end_date: datetime) -> list[dict]:
        """Load ledger entries for the time period."""
        entries = []

        if not self._ledger_path.exists():
            return entries

        with open(self._ledger_path, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    entry_time = datetime.fromisoformat(entry.get("timestamp", "1970-01-01"))
                    if start_date <= entry_time <= end_date:
                        entries.append(entry)
                except (json.JSONDecodeError, ValueError):
                    continue

        return entries

    def _count_break_glass_events(self, start_date: datetime, end_date: datetime) -> int:
        """Count break-glass events in the period."""
        break_glass_path = self._ledger_path.parent / "break_glass.log"
        if not break_glass_path.exists():
            return 0

        count = 0
        with open(break_glass_path, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    entry_time = datetime.fromisoformat(entry.get("timestamp", "1970-01-01"))
                    if start_date <= entry_time <= end_date:
                        count += 1
                except (json.JSONDecodeError, ValueError):
                    continue

        return count

    def _collect_evidence(self, control: ComplianceControl, entries: list[dict]) -> dict:
        """Collect evidence for a control."""
        return {
            "evidence_location": control.evidence_location,
            "sample_entries": entries[:5],  # First 5 entries as samples
            "total_relevant_entries": len(entries),
        }

    def generate_soc2_report(self, days: int = 30) -> dict:
        """Generate a SOC 2 report for the last N days."""
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=days)
        return self.generate_report(ComplianceFramework.SOC2, start_date, end_date)

    def generate_iso27001_report(self, days: int = 30) -> dict:
        """Generate an ISO 27001 report for the last N days."""
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=days)
        return self.generate_report(ComplianceFramework.ISO27001, start_date, end_date)
```

---

## Test Specifications

### Quorum Tests

```python
# tests/bat/test_quorum.py

def test_quorum_requires_two_approvers():
    """L3 operations should require 2 approvers."""
    manager = QuorumManager(
        approval_store_path=Path(tempfile.mkdtemp()),
        signing_key=b"test-key",
        quorum_config={RiskLevel.L3: 2}
    )

    request = manager.create_request(proposal, l3_decision)
    assert request.required_approvers == 2
    assert not request.is_approved()

def test_quorum_approval_flow():
    """Full approval flow should work."""
    manager = QuorumManager(...)

    request = manager.create_request(proposal, l3_decision)

    # First approval
    request = manager.add_approval(request.request_id, approver1)
    assert not request.is_approved()  # Still need one more

    # Second approval
    request = manager.add_approval(request.request_id, approver2)
    assert request.is_approved()
    assert request.status == ApprovalStatus.APPROVED

def test_quorum_rejection():
    """Rejection should block approval."""
    manager = QuorumManager(...)

    request = manager.create_request(proposal, l3_decision)

    # First approval
    request = manager.add_approval(request.request_id, approver1)

    # Rejection
    request = manager.add_rejection(request.request_id, approver2, "Too risky")

    # Should be rejected (can't get 2 approvals with 1 rejection)
    assert request.is_rejected()
```

### Policy Integrity Tests

```python
# tests/bat/test_policy_integrity.py

def test_policy_signing():
    """Policy signing should be verifiable."""
    signer = PolicySigner(b"test-key")

    signed = signer.sign_policy(
        policy_path=Path("test_policy.yaml"),
        signed_by="admin@example.com",
        version="1.0.0"
    )

    assert signer.verify_policy(signed)

def test_policy_tamper_detection():
    """Tampered policy should fail verification."""
    signer = PolicySigner(b"test-key")

    signed = signer.sign_policy(...)

    # Tamper
    signed.policy_content = signed.policy_content.replace("L1", "L3")

    assert not signer.verify_policy(signed)

def test_policy_chain_verification():
    """Policy chain should be verifiable."""
    store = ImmutablePolicyStore(...)

    # Store multiple versions
    store.store_policy(..., version="1.0.0")
    store.store_policy(..., version="1.1.0")
    store.store_policy(..., version="1.2.0")

    valid, errors = store.verify_chain()
    assert valid
```

---

## Amendment History

| Date       | Version | Amendment                     | Author          |
| ---------- | ------- | ----------------------------- | --------------- |
| 2026-02-24 | 1.0.0   | Initial Phase 4 specification | Security Review |
