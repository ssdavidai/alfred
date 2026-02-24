"""
Tests for Phase 4 Enterprise features.

Tests:
- QuorumManager: Multi-party approval workflow
- PolicySigner/ImmutablePolicyStore: Policy signing and immutability
- RemotePolicyClient/PolicyServer: Remote policy distribution
- LedgerSynchronizer: Multi-node ledger synchronization
- ComplianceReporter: SOC 2 / ISO 27001 compliance reporting
"""

import pytest
from datetime import datetime, timezone, timedelta
from pathlib import Path
import tempfile
import json

from alfred.bat.quorum import (
    QuorumManager,
    ApprovalRequest,
    ApprovalStatus,
    ApproverIdentity,
    AuthMethod,
)
from alfred.bat.policy_signing import (
    PolicySigner,
    SignedPolicy,
    ImmutablePolicyStore,
    PolicyVersionManager,
    PolicyStatus,
)
from alfred.bat.policy_server import (
    RemotePolicyClient,
    PolicyServer,
    RemotePolicyResponse,
    PolicySource,
)
from alfred.bat.ledger_sync import (
    LedgerSynchronizer,
    NodeInfo,
    SyncEntry,
    SyncStatus,
    ConflictResolution,
)
from alfred.bat.compliance import (
    ComplianceReporter,
    ComplianceFramework,
    ControlStatus,
    EvidenceType,
)
from alfred.bat.proposal import OperationProposal
from alfred.bat.risk import RiskLevel, RiskClassification
from alfred.bat.enforcement import EnforcementDecision, EnforcementMode, Action


# ============================================================================
# Fixtures
# ============================================================================

@pytest.fixture
def temp_dir():
    """Create a temporary directory for tests."""
    with tempfile.TemporaryDirectory() as d:
        yield Path(d)


@pytest.fixture
def signing_key():
    """Test signing key."""
    return b"test-signing-key-32-bytes-long!!"


@pytest.fixture
def sample_proposal():
    """Sample operation proposal."""
    return OperationProposal(
        proposal_id="test-proposal-001",
        agent_id="test-agent",
        operation_type="write_file",
        target="/vault/test.md",
        metadata={"content": "test content"},
        timestamp=datetime.now(timezone.utc),
    )


@pytest.fixture
def sample_decision():
    """Sample enforcement decision."""
    return EnforcementDecision(
        proposal_id="test-proposal-001",
        action=Action.BLOCK,
        policy_version="1.0",
        classification=RiskClassification(
            level=RiskLevel.L3,
            rule_id="high_risk_file_write",
            rationale="High-risk file write operation",
        ),
        timestamp=datetime.now(timezone.utc),
        rationale="High-risk operation requires approval",
    )


# ============================================================================
# QuorumManager Tests
# ============================================================================

class TestQuorumManager:
    """Tests for QuorumManager."""
    
    def test_create_request(self, temp_dir, signing_key, sample_proposal, sample_decision):
        """Test creating an approval request."""
        manager = QuorumManager(
            approval_store_path=temp_dir / "approvals",
            signing_key=signing_key,
        )
        
        request = manager.create_request(sample_proposal, sample_decision)
        
        assert request.request_id
        assert request.status == ApprovalStatus.PENDING
        assert request.required_approvers == 2  # L3 default
        assert request.risk_level == "L3"
    
    def test_l1_no_approval_required(self, temp_dir, signing_key, sample_proposal):
        """Test that L1 operations don't require approval."""
        manager = QuorumManager(
            approval_store_path=temp_dir / "approvals",
            signing_key=signing_key,
        )
        
        decision = EnforcementDecision(
            proposal_id="test-proposal-002",
            action=Action.ALLOW,
            policy_version="1.0",
            classification=RiskClassification(
                level=RiskLevel.L1,
                rule_id="low_risk_operation",
                rationale="Low-risk operation",
            ),
            timestamp=datetime.now(timezone.utc),
            rationale="Low-risk operation allowed",
        )
        
        request = manager.create_request(sample_proposal, decision)
        
        assert request.status == ApprovalStatus.APPROVED
        assert request.required_approvers == 0
    
    def test_add_approval(self, temp_dir, signing_key, sample_proposal, sample_decision):
        """Test adding approvals."""
        manager = QuorumManager(
            approval_store_path=temp_dir / "approvals",
            signing_key=signing_key,
        )
        
        request = manager.create_request(sample_proposal, sample_decision)
        
        # Create approver identity
        approver = manager.create_approver_identity(
            approver_id="approver-1",
            name="Test Approver",
            role="admin",
            auth_method=AuthMethod.MFA,
        )
        
        # Add approval
        updated = manager.add_approval(request.request_id, approver)
        
        assert len(updated.current_approvals) == 1
        assert "approver-1" in updated.current_approvals
        assert updated.status == ApprovalStatus.PENDING  # Need 2 approvers
    
    def test_quorum_approval(self, temp_dir, signing_key, sample_proposal, sample_decision):
        """Test reaching quorum approval."""
        manager = QuorumManager(
            approval_store_path=temp_dir / "approvals",
            signing_key=signing_key,
        )
        
        request = manager.create_request(sample_proposal, sample_decision)
        
        # Add first approver
        approver1 = manager.create_approver_identity(
            approver_id="approver-1",
            name="Approver 1",
            role="admin",
        )
        manager.add_approval(request.request_id, approver1)
        
        # Add second approver
        approver2 = manager.create_approver_identity(
            approver_id="approver-2",
            name="Approver 2",
            role="admin",
        )
        updated = manager.add_approval(request.request_id, approver2)
        
        assert updated.status == ApprovalStatus.APPROVED
    
    def test_rejection(self, temp_dir, signing_key, sample_proposal, sample_decision):
        """Test rejecting a request."""
        manager = QuorumManager(
            approval_store_path=temp_dir / "approvals",
            signing_key=signing_key,
        )
        
        request = manager.create_request(sample_proposal, sample_decision)
        
        # Add rejection
        approver = manager.create_approver_identity(
            approver_id="approver-1",
            name="Approver 1",
            role="admin",
        )
        updated = manager.add_rejection(
            request.request_id, approver, "Risk too high"
        )
        
        assert len(updated.rejections) == 1
        assert "approver-1" in updated.rejections
    
    def test_execute_approved(self, temp_dir, signing_key, sample_proposal, sample_decision):
        """Test executing an approved request."""
        manager = QuorumManager(
            approval_store_path=temp_dir / "approvals",
            signing_key=signing_key,
        )
        
        request = manager.create_request(sample_proposal, sample_decision)
        
        # Approve with 2 approvers
        for i in range(2):
            approver = manager.create_approver_identity(
                approver_id=f"approver-{i}",
                name=f"Approver {i}",
                role="admin",
            )
            manager.add_approval(request.request_id, approver)
        
        # Execute
        executed = manager.execute_approved(request.request_id, "executor-1")
        
        assert executed.status == ApprovalStatus.EXECUTED
        assert executed.executed_by == "executor-1"
        assert executed.executed_at is not None
    
    def test_get_pending_requests(self, temp_dir, signing_key, sample_proposal, sample_decision):
        """Test getting pending requests."""
        manager = QuorumManager(
            approval_store_path=temp_dir / "approvals",
            signing_key=signing_key,
        )
        
        # Create multiple requests
        manager.create_request(sample_proposal, sample_decision)
        
        pending = manager.get_pending_requests()
        assert len(pending) == 1


# ============================================================================
# Policy Signing Tests
# ============================================================================

class TestPolicySigner:
    """Tests for PolicySigner."""
    
    def test_sign_policy(self, signing_key):
        """Test signing a policy."""
        signer = PolicySigner(signing_key)
        
        policy_content = "rules:\n  - pattern: 'test'\n    level: L1"
        signed = signer.sign_policy(policy_content, "admin", "1.0.0")
        
        assert signed.policy_hash
        assert signed.signature
        assert signed.version == "1.0.0"
        assert signed.signed_by == "admin"
    
    def test_verify_policy(self, signing_key):
        """Test verifying a signed policy."""
        signer = PolicySigner(signing_key)
        
        policy_content = "rules:\n  - pattern: 'test'\n    level: L1"
        signed = signer.sign_policy(policy_content, "admin", "1.0.0")
        
        assert signer.verify_policy(signed)
    
    def test_detect_tampering(self, signing_key):
        """Test detecting tampered policy."""
        signer = PolicySigner(signing_key)
        
        policy_content = "rules:\n  - pattern: 'test'\n    level: L1"
        signed = signer.sign_policy(policy_content, "admin", "1.0.0")
        
        # Tamper with content
        signed.policy_content = "rules:\n  - pattern: 'malicious'\n    level: L1"
        
        assert not signer.verify_policy(signed)


class TestImmutablePolicyStore:
    """Tests for ImmutablePolicyStore."""
    
    def test_store_policy(self, temp_dir, signing_key):
        """Test storing a policy."""
        store = ImmutablePolicyStore(temp_dir, signing_key)
        
        policy_content = "rules:\n  - pattern: 'test'\n    level: L1"
        signed = store.store_policy(policy_content, "admin", "1.0.0")
        
        assert signed.version == "1.0.0"
    
    def test_chain_integrity(self, temp_dir, signing_key):
        """Test policy chain integrity."""
        store = ImmutablePolicyStore(temp_dir, signing_key)
        
        # Store multiple versions
        store.store_policy("rules:\n  v: 1", "admin", "1.0.0")
        store.store_policy("rules:\n  v: 2", "admin", "1.1.0")
        store.store_policy("rules:\n  v: 3", "admin", "1.2.0")
        
        # Verify chain
        is_valid, errors = store.verify_chain()
        
        assert is_valid
        assert len(errors) == 0
    
    def test_get_current(self, temp_dir, signing_key):
        """Test getting current policy."""
        store = ImmutablePolicyStore(temp_dir, signing_key)
        
        store.store_policy("rules:\n  v: 1", "admin", "1.0.0")
        store.store_policy("rules:\n  v: 2", "admin", "1.1.0")
        
        current = store.get_current()
        
        assert current.version == "1.1.0"
    
    def test_deprecate_version(self, temp_dir, signing_key):
        """Test deprecating a policy version."""
        store = ImmutablePolicyStore(temp_dir, signing_key)
        
        store.store_policy("rules:\n  v: 1", "admin", "1.0.0")
        
        deprecated = store.deprecate_version("1.0.0", "Security issue")
        
        assert deprecated.status == PolicyStatus.DEPRECATED
        assert "deprecated_at" in deprecated.metadata


# ============================================================================
# Remote Policy Distribution Tests
# ============================================================================

class TestPolicyServer:
    """Tests for PolicyServer."""
    
    def test_get_policy(self, temp_dir, signing_key):
        """Test getting a policy from server."""
        # Create policy file
        policy_file = temp_dir / "default.yaml"
        policy_file.write_text("rules:\n  - pattern: 'test'\n    level: L1")
        
        server = PolicyServer(
            policy_store_path=temp_dir,
            signing_key=signing_key,
            server_id="test-server",
        )
        
        response = server.get_policy("default")
        
        assert response is not None
        assert "rules:" in response["policy_content"]
        assert response["signature"]
    
    def test_list_policies(self, temp_dir, signing_key):
        """Test listing policies."""
        # Create policy files
        (temp_dir / "default.yaml").write_text("rules:\n  - pattern: 'test'")
        (temp_dir / "strict.yaml").write_text("rules:\n  - pattern: 'test2'")
        
        server = PolicyServer(
            policy_store_path=temp_dir,
            signing_key=signing_key,
            server_id="test-server",
        )
        
        result = server.list_policies()
        
        assert len(result["policies"]) == 2


class TestRemotePolicyClient:
    """Tests for RemotePolicyClient."""
    
    def test_fallback_policy(self, temp_dir, signing_key):
        """Test fallback to local policy."""
        # Create fallback policy
        fallback_dir = temp_dir / "fallback"
        fallback_dir.mkdir()
        (fallback_dir / "default.yaml").write_text("rules:\n  - pattern: 'fallback'")
        
        client = RemotePolicyClient(
            server_url="http://nonexistent:9999",
            verification_key=signing_key,
            cache_path=temp_dir / "cache",
            local_fallback_path=fallback_dir,
        )
        
        content, source = client.get_policy("default")
        
        assert "fallback" in content
        assert source == PolicySource.FALLBACK


# ============================================================================
# Ledger Synchronization Tests
# ============================================================================

class TestLedgerSynchronizer:
    """Tests for LedgerSynchronizer."""
    
    def test_add_peer(self, temp_dir, signing_key):
        """Test adding a peer."""
        sync = LedgerSynchronizer(
            node_id="node-1",
            ledger_path=temp_dir / "ledger",
            signing_key=signing_key,
        )
        
        sync.add_peer("peer-1:8080")
        
        peers = sync.get_peers()
        assert len(peers) == 1
        assert peers[0].address == "peer-1:8080"
    
    def test_receive_entry(self, temp_dir, signing_key):
        """Test receiving an entry."""
        sync = LedgerSynchronizer(
            node_id="node-1",
            ledger_path=temp_dir / "ledger",
            signing_key=signing_key,
        )
        
        # Compute correct hash for content
        import hashlib
        content = {"test": "data"}
        content_hash = hashlib.sha256(
            json.dumps(content, sort_keys=True).encode()
        ).hexdigest()
        
        entry = SyncEntry(
            entry_id="entry-001",
            sequence=1,
            timestamp=datetime.now(timezone.utc),
            node_id="node-2",
            entry_hash=content_hash,
            prev_hash=None,
            content=content,
        )
        
        accepted = sync.receive_entry(entry)
        
        assert accepted
    
    def test_get_missing_entries(self, temp_dir, signing_key):
        """Test getting missing entries."""
        ledger_path = temp_dir / "ledger"
        ledger_path.mkdir(parents=True, exist_ok=True)
        
        # Create some entries
        for i in range(1, 4):
            entry = SyncEntry(
                entry_id=f"entry-{i:03d}",
                sequence=i,
                timestamp=datetime.now(timezone.utc),
                node_id="node-1",
                entry_hash=f"hash-{i}",
                prev_hash=f"hash-{i-1}" if i > 1 else None,
                content={"seq": i},
            )
            (ledger_path / f"entry-{i:03d}.json").write_text(json.dumps(entry.to_dict()))
        
        sync = LedgerSynchronizer(
            node_id="node-1",
            ledger_path=ledger_path,
            signing_key=signing_key,
        )
        
        missing = sync.get_missing_entries(1)
        
        assert len(missing) == 2  # Entries 2 and 3


# ============================================================================
# Compliance Reporting Tests
# ============================================================================

class TestComplianceReporter:
    """Tests for ComplianceReporter."""
    
    def test_collect_evidence(self, temp_dir):
        """Test collecting evidence."""
        reporter = ComplianceReporter(
            evidence_store_path=temp_dir,
            frameworks=[ComplianceFramework.SOC2],
        )
        
        evidence = reporter.collect_evidence(
            control_id="CC6.1",
            evidence_type=EvidenceType.LOG_ENTRY,
            description="Access log showing authorized access",
            source="system_logs",
            data={"user": "admin", "action": "read"},
        )
        
        assert evidence.evidence_id
        assert evidence.control_id == "CC6.1"
        assert evidence.hash
    
    def test_assess_control(self, temp_dir):
        """Test assessing a control."""
        reporter = ComplianceReporter(
            evidence_store_path=temp_dir,
            frameworks=[ComplianceFramework.SOC2],
        )
        
        # Collect evidence first
        evidence = reporter.collect_evidence(
            control_id="CC6.1",
            evidence_type=EvidenceType.POLICY_DOCUMENT,
            description="Access control policy",
            source="policies/access.md",
            data={},
        )
        
        # Assess control
        assessment = reporter.assess_control(
            control_id="CC6.1",
            status=ControlStatus.COMPLIANT,
            evidence_ids=[evidence.evidence_id],
            notes="Access control properly implemented",
        )
        
        assert assessment.status == ControlStatus.COMPLIANT
        assert evidence.evidence_id in assessment.evidence_ids
    
    def test_generate_report(self, temp_dir):
        """Test generating a compliance report."""
        reporter = ComplianceReporter(
            evidence_store_path=temp_dir,
            frameworks=[ComplianceFramework.SOC2],
        )
        
        # Assess some controls
        reporter.assess_control("CC6.1", ControlStatus.COMPLIANT)
        reporter.assess_control("CC6.2", ControlStatus.COMPLIANT)
        reporter.assess_control("CC6.3", ControlStatus.NON_COMPLIANT)
        
        report = reporter.generate_report(ComplianceFramework.SOC2)
        
        assert report["framework"] == "soc2"
        assert report["summary"]["total_controls"] > 0
        assert report["summary"]["compliant"] >= 2
        assert report["summary"]["non_compliant"] >= 1
    
    def test_gap_analysis(self, temp_dir):
        """Test generating a gap analysis."""
        reporter = ComplianceReporter(
            evidence_store_path=temp_dir,
            frameworks=[ComplianceFramework.SOC2],
        )
        
        # Create a gap
        reporter.assess_control(
            "CC6.1",
            ControlStatus.NON_COMPLIANT,
            notes="Access control not fully implemented",
            gaps=["Missing MFA"],
            remediation=["Implement MFA"],
        )
        
        gaps = reporter.generate_gap_analysis(ComplianceFramework.SOC2)
        
        assert gaps["total_gaps"] >= 1
        assert any(g["control_id"] == "CC6.1" for g in gaps["gaps"])
    
    def test_get_mapped_controls(self, temp_dir):
        """Test getting mapped controls."""
        reporter = ComplianceReporter(
            evidence_store_path=temp_dir,
            frameworks=[ComplianceFramework.SOC2, ComplianceFramework.ISO27001],
        )
        
        mapped = reporter.get_mapped_controls("CC6.1", ComplianceFramework.SOC2)
        
        assert len(mapped) > 0
        assert any(c.control_id == "A.9.1.1" for c in mapped)


# ============================================================================
# Integration Tests
# ============================================================================

class TestPhase4Integration:
    """Integration tests for Phase 4 components."""
    
    def test_quorum_to_compliance_flow(self, temp_dir, signing_key, sample_proposal, sample_decision):
        """Test flow from quorum approval to compliance evidence."""
        # Setup quorum manager
        quorum = QuorumManager(
            approval_store_path=temp_dir / "approvals",
            signing_key=signing_key,
        )
        
        # Create and approve request
        request = quorum.create_request(sample_proposal, sample_decision)
        
        for i in range(2):
            approver = quorum.create_approver_identity(
                approver_id=f"approver-{i}",
                name=f"Approver {i}",
                role="admin",
            )
            quorum.add_approval(request.request_id, approver)
        
        # Execute
        quorum.execute_approved(request.request_id, "system")
        
        # Collect compliance evidence
        reporter = ComplianceReporter(
            evidence_store_path=temp_dir / "compliance",
            frameworks=[ComplianceFramework.SOC2],
        )
        
        evidence = reporter.collect_evidence(
            control_id="CC6.2",
            evidence_type=EvidenceType.AUDIT_TRAIL,
            description="Quorum approval for high-risk operation",
            source="bat_quorum",
            data={
                "request_id": request.request_id,
                "approvers": request.current_approvals,
            },
        )
        
        assert evidence.evidence_id
        
        # Assess control
        assessment = reporter.assess_control(
            control_id="CC6.2",
            status=ControlStatus.COMPLIANT,
            evidence_ids=[evidence.evidence_id],
            notes="High-risk operations require quorum approval",
        )
        
        assert assessment.status == ControlStatus.COMPLIANT
    
    def test_policy_lifecycle(self, temp_dir, signing_key):
        """Test policy lifecycle from signing to distribution."""
        # Sign policy
        store = ImmutablePolicyStore(temp_dir / "policies", signing_key)
        
        policy_v1 = store.store_policy(
            "rules:\n  - pattern: 'test'\n    level: L1",
            "admin",
            "1.0.0",
        )
        
        policy_v2 = store.store_policy(
            "rules:\n  - pattern: 'test'\n    level: L2",
            "admin",
            "1.1.0",
        )
        
        # Verify chain
        is_valid, errors = store.verify_chain()
        assert is_valid
        
        # Deprecate old version
        store.deprecate_version("1.0.0", "Replaced by 1.1.0")
        
        # Check current
        current = store.get_current()
        assert current.version == "1.1.0"
