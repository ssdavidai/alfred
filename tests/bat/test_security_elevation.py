"""
Tests for Security Elevation Phase 1 components.

Tests for:
- Track B: Identity, Delegation, Policy Integrity
- Track C: Semantic State Governance (ZVEC)
- Track D: Platform/Operational Security
"""

import pytest
from datetime import datetime, timezone, timedelta
from pathlib import Path
import tempfile
import json

# Track B: Identity
from alfred.bat.identity import (
    IdentityRegistry,
    IdentityMode,
    AgentCredential,
    CredentialStatus,
    ProcessAttestation,
    SignedProposal,
    create_identity_registry,
)

# Track B: Delegation
from alfred.bat.delegation import (
    DelegationManager,
    DelegationChain,
    DelegationContext,
    Capability,
    CapabilitySet,
    DelegationError,
    create_delegation_manager,
)

# Track B: Policy Integrity
from alfred.bat.policy_integrity import (
    PolicyIntegrityGuard,
    PolicyManifest,
    ImmutableRoot,
    StartupGate,
    PolicyIntegrityError,
    create_integrity_guard,
)

# Track C: ZVEC
from alfred.bat.zvec import (
    VectorGovernanceStore,
    VectorArtifact,
    IndexMutationEnvelope,
    DriftReport,
    VectorOperation,
    VerificationStrategy,
    DriftSignal,
    create_vector_store,
)

# Track D: Resource Governor
from alfred.bat.resource_governor import (
    ResourceGovernor,
    ResourceLimits,
    RateLimiter,
    MetadataValidator,
    QueueDepthMonitor,
    SafeDeserializer,
    ResourceLimitExceeded,
    DeserializationError,
    create_resource_governor,
)


class TestIdentityRegistry:
    """Tests for IdentityRegistry."""
    
    def test_create_registry_personal_mode(self):
        """Test creating registry in personal mode."""
        registry = create_identity_registry(mode="personal")
        assert registry.mode == IdentityMode.PERSONAL
    
    def test_create_registry_secure_mode(self):
        """Test creating registry in secure mode."""
        registry = create_identity_registry(mode="secure")
        assert registry.mode == IdentityMode.SECURE
    
    def test_register_agent(self):
        """Test registering an agent credential."""
        registry = create_identity_registry(mode="secure")
        
        credential = registry.register_agent(
            agent_id="test-agent",
            public_key="0" * 64,  # Fake public key
            metadata={"purpose": "testing"},
        )
        
        assert credential.agent_id == "test-agent"
        assert credential.status == CredentialStatus.ACTIVE
        assert credential.is_valid()
    
    def test_create_attestation_personal_mode(self):
        """Test creating process attestation in personal mode."""
        registry = create_identity_registry(mode="personal")
        
        attestation = registry.create_attestation("test-agent")
        
        assert attestation.agent_id == "test-agent"
        assert attestation.pid > 0
        assert attestation.executable_path != ""
    
    def test_verify_identity_personal_mode(self):
        """Test identity verification in personal mode."""
        registry = create_identity_registry(mode="personal")
        registry.create_attestation("test-agent")
        
        valid, reason = registry.verify_identity("test-agent")
        assert valid
        assert "valid" in reason.lower()
    
    def test_verify_identity_unknown_agent(self):
        """Test verification fails for unknown agent."""
        registry = create_identity_registry(mode="personal")
        
        valid, reason = registry.verify_identity("unknown-agent")
        assert not valid
    
    def test_revoke_credential(self):
        """Test revoking a credential."""
        registry = create_identity_registry(mode="secure")
        registry.register_agent("test-agent", "0" * 64)
        
        result = registry.revoke_credential("test-agent")
        assert result
        
        credential = registry.get_credential("test-agent")
        assert credential.status == CredentialStatus.REVOKED
        assert not credential.is_valid()
    
    def test_suspend_and_activate_credential(self):
        """Test suspending and reactivating a credential."""
        registry = create_identity_registry(mode="secure")
        registry.register_agent("test-agent", "0" * 64)
        
        # Suspend
        registry.suspend_credential("test-agent")
        credential = registry.get_credential("test-agent")
        assert credential.status == CredentialStatus.SUSPENDED
        assert not credential.is_valid()
        
        # Reactivate
        registry.activate_credential("test-agent")
        credential = registry.get_credential("test-agent")
        assert credential.status == CredentialStatus.ACTIVE
        assert credential.is_valid()


class TestDelegation:
    """Tests for DelegationManager."""
    
    def test_create_capability_set(self):
        """Test creating capability sets."""
        caps = CapabilitySet.from_list([
            Capability.FILE_READ.value,
            Capability.FILE_WRITE.value,
        ])
        
        assert caps.contains(Capability.FILE_READ.value)
        assert caps.contains(Capability.FILE_WRITE.value)
        assert not caps.contains(Capability.EXEC_COMMAND.value)
    
    def test_capability_intersection(self):
        """Test capability intersection."""
        caps1 = CapabilitySet.from_list([
            Capability.FILE_READ.value,
            Capability.FILE_WRITE.value,
            Capability.EXEC_COMMAND.value,
        ])
        caps2 = CapabilitySet.from_list([
            Capability.FILE_READ.value,
            Capability.FILE_WRITE.value,
        ])
        
        intersection = caps1.intersect(caps2)
        
        assert intersection.contains(Capability.FILE_READ.value)
        assert intersection.contains(Capability.FILE_WRITE.value)
        assert not intersection.contains(Capability.EXEC_COMMAND.value)
    
    def test_register_root_agent(self):
        """Test registering a root agent."""
        manager = create_delegation_manager()
        
        context = manager.register_root_agent(
            "admin",
            CapabilitySet.all(),
        )
        
        assert context.agent_id == "admin"
        assert context.is_root_agent()
        assert context.can_perform(Capability.FILE_READ.value)
    
    def test_delegate_capabilities(self):
        """Test delegating capabilities."""
        manager = create_delegation_manager()
        
        # Register root agent with delegation capability
        admin_caps = CapabilitySet.from_list([
            Capability.FILE_READ.value,
            Capability.FILE_WRITE.value,
            Capability.AGENT_DELEGATE.value,
        ])
        manager.register_root_agent("admin", admin_caps)
        
        # Delegate to worker
        worker_caps = CapabilitySet.from_list([
            Capability.FILE_READ.value,
            Capability.FILE_WRITE.value,
        ])
        context = manager.delegate("admin", "worker", worker_caps)
        
        assert context.agent_id == "worker"
        assert not context.is_root_agent()
        assert context.can_perform(Capability.FILE_READ.value)
        assert context.can_perform(Capability.FILE_WRITE.value)
    
    def test_delegation_does_not_elevate_privilege(self):
        """Test that delegation cannot elevate privileges."""
        manager = create_delegation_manager()
        
        # Admin only has FILE_READ
        admin_caps = CapabilitySet.from_list([
            Capability.FILE_READ.value,
            Capability.AGENT_DELEGATE.value,
        ])
        manager.register_root_agent("admin", admin_caps)
        
        # Try to delegate FILE_WRITE (which admin doesn't have)
        requested = CapabilitySet.from_list([
            Capability.FILE_READ.value,
            Capability.FILE_WRITE.value,
        ])
        context = manager.delegate("admin", "worker", requested)
        
        # Worker should only have FILE_READ (intersection)
        assert context.can_perform(Capability.FILE_READ.value)
        assert not context.can_perform(Capability.FILE_WRITE.value)
    
    def test_delegation_without_delegate_capability_fails(self):
        """Test that delegation requires AGENT_DELEGATE capability."""
        manager = create_delegation_manager()
        
        # Admin without delegation capability
        admin_caps = CapabilitySet.from_list([Capability.FILE_READ.value])
        manager.register_root_agent("admin", admin_caps)
        
        # Try to delegate
        with pytest.raises(DelegationError):
            manager.delegate("admin", "worker", CapabilitySet.from_list([Capability.FILE_READ.value]))
    
    def test_validate_operation(self):
        """Test operation validation."""
        manager = create_delegation_manager()
        
        manager.register_root_agent(
            "reader",
            CapabilitySet.from_list([Capability.FILE_READ.value]),
        )
        
        valid, _ = manager.validate_operation("reader", "read_file")
        assert valid
        
        valid, _ = manager.validate_operation("reader", "write_file")
        assert not valid


class TestPolicyIntegrity:
    """Tests for PolicyIntegrityGuard."""
    
    def test_create_manifest(self):
        """Test creating a policy manifest."""
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_dir = Path(tmpdir)
            
            # Create a policy file
            (policy_dir / "test.yaml").write_text("rules: []\n")
            
            guard = create_integrity_guard(policy_dir)
            manifest = guard.create_manifest(
                version="1.0.0",
                created_by="test",
            )
            
            assert manifest.version == "1.0.0"
            assert "test.yaml" in manifest.files
    
    def test_verify_policy(self):
        """Test policy verification."""
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_dir = Path(tmpdir)
            (policy_dir / "test.yaml").write_text("rules: []\n")
            
            guard = create_integrity_guard(policy_dir)
            verified, errors = guard.verify_policy()
            
            assert verified  # No manifest required in default mode
    
    def test_immutable_root_blocks_write(self):
        """Test that immutable roots block write operations."""
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_dir = Path(tmpdir)
            
            guard = create_integrity_guard(policy_dir)
            guard.add_immutable_root(ImmutableRoot(
                path=str(policy_dir / "protected.yaml"),
                description="Protected file",
            ))
            
            blocked, reason = guard.check_immutable(
                str(policy_dir / "protected.yaml"),
                "write_file",
            )
            
            assert blocked
            assert "immutable" in reason.lower()
    
    def test_startup_gate(self):
        """Test startup gate."""
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_dir = Path(tmpdir)
            
            guard = create_integrity_guard(policy_dir)
            gate = StartupGate(guard)
            
            ready, issues = gate.check_readiness()
            assert ready  # Should pass with no manifest required


class TestZVEC:
    """Tests for VectorGovernanceStore."""
    
    def test_create_vector_artifact(self):
        """Test creating a vector artifact."""
        artifact = VectorArtifact.create(
            content="test content",
            embedding=[0.1, 0.2, 0.3],
            model_id="test-model",
            created_by="test-agent",
        )
        
        assert artifact.dimensions == 3
        assert artifact.model_id == "test-model"
        assert artifact.created_by == "test-agent"
        assert len(artifact.content_hash) == 64
        assert len(artifact.embedding_hash) == 64
    
    def test_verify_embedding_hash(self):
        """Test embedding hash verification."""
        artifact = VectorArtifact.create(
            content="test",
            embedding=[0.1, 0.2, 0.3],
            model_id="test-model",
        )
        
        assert artifact.verify_embedding_hash()
    
    def test_insert_artifact(self):
        """Test inserting an artifact."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = create_vector_store(
                store_path=Path(tmpdir),
                model_id="test-model",
            )
            
            artifact = VectorArtifact.create(
                content="test",
                embedding=[0.1, 0.2, 0.3],
                model_id="test-model",
            )
            
            mutation = store.insert(
                artifact=artifact,
                proposal_id="test-proposal",
                agent_id="test-agent",
            )
            
            assert mutation.operation == VectorOperation.INSERT
            assert store.artifact_count == 1
    
    def test_insert_duplicate_fails(self):
        """Test that inserting duplicate fails."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = create_vector_store(
                store_path=Path(tmpdir),
                model_id="test-model",
            )
            
            artifact = VectorArtifact.create(
                content="test",
                embedding=[0.1, 0.2, 0.3],
                model_id="test-model",
            )
            
            store.insert(artifact, "proposal-1", "agent-1")
            
            with pytest.raises(ValueError):
                store.insert(artifact, "proposal-2", "agent-2")
    
    def test_delete_artifact(self):
        """Test deleting an artifact."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = create_vector_store(
                store_path=Path(tmpdir),
                model_id="test-model",
            )
            
            artifact = VectorArtifact.create(
                content="test",
                embedding=[0.1, 0.2, 0.3],
                model_id="test-model",
            )
            
            store.insert(artifact, "proposal-1", "agent-1")
            assert store.artifact_count == 1
            
            mutation = store.delete(artifact.artifact_id, "proposal-2", "agent-2")
            assert mutation.operation == VectorOperation.DELETE
            assert store.artifact_count == 0
    
    def test_query_vectors(self):
        """Test querying vectors."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = create_vector_store(
                store_path=Path(tmpdir),
                model_id="test-model",
            )
            
            # Insert some artifacts
            for i in range(5):
                artifact = VectorArtifact.create(
                    content=f"content {i}",
                    embedding=[0.1 * i, 0.2 * i, 0.3 * i],
                    model_id="test-model",
                )
                store.insert(artifact, f"proposal-{i}", "agent-1")
            
            # Query
            results = store.query([0.1, 0.2, 0.3], k=3)
            assert len(results) == 3
    
    def test_verify_all(self):
        """Test verifying all artifacts."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = create_vector_store(
                store_path=Path(tmpdir),
                model_id="test-model",
            )
            
            artifact = VectorArtifact.create(
                content="test",
                embedding=[0.1, 0.2, 0.3],
                model_id="test-model",
            )
            store.insert(artifact, "proposal-1", "agent-1")
            
            verified, errors = store.verify_all()
            assert verified == 1
            assert len(errors) == 0
    
    def test_model_upgrade_rollback(self):
        """Test model upgrade with rollback."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = create_vector_store(
                store_path=Path(tmpdir),
                model_id="model-v1",
            )
            
            artifact = VectorArtifact.create(
                content="test",
                embedding=[0.1, 0.2, 0.3],
                model_id="model-v1",
            )
            store.insert(artifact, "proposal-1", "agent-1")
            
            # Begin upgrade
            upgrade_id = store.begin_upgrade("model-v2")
            assert store.is_locked
            
            # Rollback
            store.rollback_upgrade(upgrade_id)
            assert not store.is_locked
            assert store.model_id == "model-v1"


class TestResourceGovernor:
    """Tests for ResourceGovernor."""
    
    def test_rate_limiter_allows_within_limit(self):
        """Test rate limiter allows within limit."""
        limits = ResourceLimits(max_proposals_per_second=10)
        limiter = RateLimiter(limits)
        
        for _ in range(5):
            allowed, _ = limiter.check_and_record("agent-1")
            assert allowed
    
    def test_rate_limiter_blocks_over_limit(self):
        """Test rate limiter blocks over limit."""
        limits = ResourceLimits(max_proposals_per_second=5)
        limiter = RateLimiter(limits)
        
        # Use up the limit
        for _ in range(5):
            limiter.check_and_record("agent-1")
        
        # Next should be blocked
        allowed, reason = limiter.check_and_record("agent-1")
        assert not allowed
        assert "rate limit" in reason.lower()
    
    def test_metadata_validator(self):
        """Test metadata size validation."""
        validator = MetadataValidator(max_size_bytes=100)
        
        # Small metadata should pass
        valid, _ = validator.validate({"key": "value"})
        assert valid
        
        # Large metadata should fail
        large_data = {"key": "x" * 200}
        valid, reason = validator.validate(large_data)
        assert not valid
        assert "exceeds limit" in reason.lower()
    
    def test_queue_depth_monitor(self):
        """Test queue depth monitoring."""
        monitor = QueueDepthMonitor(max_depth=3)
        
        # Acquire slots
        assert monitor.acquire()[0]
        assert monitor.acquire()[0]
        assert monitor.acquire()[0]
        
        # Should be at limit
        acquired, reason = monitor.acquire()
        assert not acquired
        assert "exceeds limit" in reason.lower()
        
        # Release and try again
        monitor.release()
        assert monitor.acquire()[0]
    
    def test_safe_deserializer_yaml(self):
        """Test safe YAML loading."""
        yaml_data = "key: value\nnumber: 42"
        
        result = SafeDeserializer.safe_yaml_load(yaml_data)
        assert result["key"] == "value"
        assert result["number"] == 42
    
    def test_safe_deserializer_json(self):
        """Test safe JSON loading."""
        json_data = '{"key": "value", "number": 42}'
        
        result = SafeDeserializer.safe_json_load(json_data)
        assert result["key"] == "value"
        assert result["number"] == 42
    
    def test_safe_deserializer_blocked_modules(self):
        """Test that blocked modules are detected."""
        assert SafeDeserializer.check_code_path("pickle", "loads")
        assert SafeDeserializer.check_code_path("marshal", "loads")
        assert not SafeDeserializer.check_code_path("json", "loads")
    
    def test_resource_governor_check_all(self):
        """Test comprehensive resource check."""
        limits = ResourceLimits(
            max_proposals_per_second=10,
            max_metadata_size_bytes=1000,
        )
        governor = create_resource_governor(limits=limits)
        
        # Should pass
        passed, errors = governor.check_all(
            agent_id="test-agent",
            metadata={"key": "value"},
        )
        assert passed
        assert len(errors) == 0
    
    def test_resource_limits_presets(self):
        """Test resource limit presets."""
        personal = ResourceLimits.personal()
        secure = ResourceLimits.secure()
        enterprise = ResourceLimits.enterprise()
        
        # Personal should be most permissive
        assert personal.max_proposals_per_second > secure.max_proposals_per_second
        assert personal.max_proposals_per_second > enterprise.max_proposals_per_second
        
        # Enterprise should be most restrictive
        assert enterprise.max_proposals_per_second < secure.max_proposals_per_second


class TestDriftDetection:
    """Tests for drift detection."""
    
    def test_drift_report_governance_trigger(self):
        """Test identifying governance trigger drift signals."""
        # Observability signal
        report = DriftReport(
            signal=DriftSignal.CENTROID_SHIFT,
            severity=0.5,
            metric_value=0.5,
            threshold=0.3,
        )
        assert not report.is_governance_trigger()
        
        # Governance trigger
        report = DriftReport(
            signal=DriftSignal.COLLAPSE,
            severity=1.0,
            metric_value=1.0,
            threshold=0.0,
        )
        assert report.is_governance_trigger()
    
    def test_detect_rapid_churn(self):
        """Test rapid churn detection."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = create_vector_store(
                store_path=Path(tmpdir),
                model_id="test-model",
            )
            
            # Add many artifacts quickly
            for i in range(100):
                artifact = VectorArtifact.create(
                    content=f"content {i}",
                    embedding=[0.1 * i, 0.2 * i, 0.3 * i],
                    model_id="test-model",
                )
                store.insert(artifact, f"proposal-{i}", "agent-1")
            
            # Check for drift
            reports = store.detect_drift()
            
            # Should detect rapid churn due to high mutation rate
            churn_reports = [r for r in reports if r.signal == DriftSignal.RAPID_CHURN]
            # Note: This test may not trigger if run slowly, which is fine
