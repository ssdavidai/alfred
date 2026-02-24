"""
Tests for Security Elevation Phase 3 components.

Tests:
- Wire protocol message serialization/deserialization
- Index rebuild governance with anomaly quarantine
- Drift detection and governance triggers
- Sandbox execution isolation
"""

import pytest
from datetime import datetime, timezone, timedelta
from pathlib import Path
import tempfile
import threading
import time

from alfred.bat.wire_protocol import (
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
from alfred.bat.index_governance import (
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
from alfred.bat.drift_analytics import (
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
from alfred.bat.sandbox import (
    SandboxManager,
    ProcessSandbox,
    SandboxConfig,
    SandboxResources,
    SandboxStatus,
    SandboxType,
    IsolationLevel,
    ExecutionResult,
    create_sandbox_manager,
)


# =============================================================================
# Wire Protocol Tests
# =============================================================================

class TestProtocolHeader:
    """Tests for ProtocolHeader serialization."""
    
    def test_header_serialization_roundtrip(self):
        """Header should serialize and deserialize correctly."""
        original = ProtocolHeader(
            message_type=MessageType.VECTOR_INSERT,
            priority=MessagePriority.HIGH,
            source_id="test-agent",
            target_id="target-agent",
            flags=ProtocolHeader.FLAG_SIGNED,
        )
        
        serialized = original.serialize()
        assert len(serialized) == 232
        
        deserialized = ProtocolHeader.deserialize(serialized)
        
        assert deserialized.message_type == original.message_type
        assert deserialized.priority == original.priority
        assert deserialized.source_id == original.source_id
        assert deserialized.target_id == original.target_id
        assert deserialized.flags == original.flags
    
    def test_header_invalid_magic_rejected(self):
        """Header with invalid magic bytes should be rejected."""
        header = ProtocolHeader()
        serialized = header.serialize()
        
        # Corrupt magic bytes
        corrupted = b"XXXX" + serialized[4:]
        
        with pytest.raises(ValueError, match="Invalid magic bytes"):
            ProtocolHeader.deserialize(corrupted)
    
    def test_header_too_short_rejected(self):
        """Header that is too short should be rejected."""
        with pytest.raises(ValueError, match="too short"):
            ProtocolHeader.deserialize(b"ZVEC" + b"\x00" * 100)


class TestWireMessage:
    """Tests for WireMessage serialization."""
    
    def test_vector_message_roundtrip(self):
        """Vector message should serialize and deserialize correctly."""
        payload = VectorPayload(
            artifact_id="test-artifact-123",
            content_hash="abc123",
            embedding_hash="def456",
            model_id="text-embedding-3-small",
            dimensions=1536,
            source_path="/vault/note.md",
            proposal_id="prop-123",
            agent_id="curator",
        )
        
        handler = create_protocol_handler(source_id="test-source")
        message = handler.create_message(
            message_type=MessageType.VECTOR_INSERT,
            payload=payload,
            priority=MessagePriority.NORMAL,
        )
        
        serialized = handler.serialize_message(message)
        deserialized = WireMessage.deserialize(serialized)
        
        assert deserialized.header.message_type == MessageType.VECTOR_INSERT
        assert isinstance(deserialized.payload, VectorPayload)
        assert deserialized.payload.artifact_id == "test-artifact-123"
        assert deserialized.payload.dimensions == 1536
    
    def test_anomaly_message_roundtrip(self):
        """Anomaly message should serialize and deserialize correctly."""
        payload = AnomalyPayload(
            anomaly_id="anomaly-123",
            anomaly_type=AnomalyType.EMBEDDING_MISMATCH,
            artifact_id="artifact-456",
            severity=0.85,
            description="Embedding hash mismatch detected",
            quarantine_status=QuarantineStatus.QUARANTINED,
            evidence={"expected": "hash1", "actual": "hash2"},
        )
        
        handler = create_protocol_handler(source_id="drift-monitor")
        message = handler.create_message(
            message_type=MessageType.ANOMALY_DETECTED,
            payload=payload,
            priority=MessagePriority.CRITICAL,
        )
        
        serialized = handler.serialize_message(message)
        deserialized = WireMessage.deserialize(serialized)
        
        assert deserialized.header.message_type == MessageType.ANOMALY_DETECTED
        assert deserialized.header.priority == MessagePriority.CRITICAL
        assert isinstance(deserialized.payload, AnomalyPayload)
        assert deserialized.payload.anomaly_type == AnomalyType.EMBEDDING_MISMATCH
        assert deserialized.payload.severity == 0.85
    
    def test_signed_message_verification(self):
        """Signed message should verify correctly."""
        signing_key = b"test-signing-key-32-bytes-long!!!"
        verification_key = signing_key
        
        handler = create_protocol_handler(
            source_id="test-source",
            signing_key=signing_key,
            verification_key=verification_key,
        )
        
        message = handler.create_message(
            message_type=MessageType.HEARTBEAT,
            payload={"status": "alive"},
        )
        
        serialized = handler.serialize_message(message)
        
        # Should verify successfully
        deserialized = WireMessage.deserialize(serialized, verification_key)
        assert deserialized.header.flags & ProtocolHeader.FLAG_SIGNED
    
    def test_signed_message_tampered_fails(self):
        """Tampered signed message should fail verification."""
        signing_key = b"test-signing-key-32-bytes-long!!!"
        
        handler = create_protocol_handler(
            source_id="test-source",
            signing_key=signing_key,
        )
        
        message = handler.create_message(
            message_type=MessageType.HEARTBEAT,
            payload={"status": "alive"},
        )
        
        serialized = handler.serialize_message(message)
        
        # Tamper with the signature portion (last 32 bytes)
        tampered = serialized[:-32] + b'\xff' * 32
        
        # Should fail verification or parsing
        with pytest.raises((ValueError, Exception)):
            WireMessage.deserialize(tampered, signing_key)


class TestWireProtocolHandler:
    """Tests for WireProtocolHandler."""
    
    def test_create_heartbeat(self):
        """Heartbeat message should be created correctly."""
        handler = create_protocol_handler(source_id="test-agent")
        heartbeat = handler.create_heartbeat()
        
        assert heartbeat.header.message_type == MessageType.HEARTBEAT
        assert heartbeat.header.priority == MessagePriority.LOW
    
    def test_create_anomaly_message(self):
        """Anomaly message should be created correctly."""
        handler = create_protocol_handler(source_id="monitor")
        message = handler.create_anomaly_message(
            anomaly_type=AnomalyType.INDEX_CORRUPTION,
            artifact_id="artifact-123",
            severity=0.9,
            description="Index corruption detected",
            evidence={"index_hash": "abc"},
        )
        
        assert message.header.message_type == MessageType.ANOMALY_DETECTED
        assert message.header.priority == MessagePriority.CRITICAL
        assert isinstance(message.payload, AnomalyPayload)
        assert message.payload.severity == 0.9
    
    def test_message_handler_registration(self):
        """Message handlers should be called correctly."""
        handler = create_protocol_handler(source_id="test")
        
        received = []
        
        def handle_heartbeat(msg):
            received.append(msg)
            return handler._create_ack(msg)
        
        handler.register_handler(MessageType.HEARTBEAT, handle_heartbeat)
        
        heartbeat = handler.create_heartbeat(target_id="test")
        serialized = handler.serialize_message(heartbeat)
        
        response = handler.process_message(serialized)
        
        assert len(received) == 1
        assert response is not None
        assert response.header.message_type == MessageType.HEARTBEAT_ACK


# =============================================================================
# Index Rebuild Governance Tests
# =============================================================================

class TestAnomalyQuarantine:
    """Tests for AnomalyQuarantine."""
    
    def test_quarantine_artifact(self):
        """Artifact should be quarantined correctly."""
        quarantine = AnomalyQuarantine()
        
        quarantined = quarantine.quarantine(
            artifact_id="artifact-123",
            reason=QuarantineReason.EMBEDDING_MISMATCH,
            original_data={"embedding": [1.0, 2.0, 3.0]},
            evidence={"expected_hash": "abc", "actual_hash": "def"},
            quarantined_by="detector",
        )
        
        assert quarantined.artifact_id == "artifact-123"
        assert quarantined.reason == QuarantineReason.EMBEDDING_MISMATCH
        assert not quarantined.resolved_at
        
        # Should be in active list
        active = quarantine.list_active()
        assert len(active) == 1
        assert active[0].quarantine_id == quarantined.quarantine_id
    
    def test_release_quarantined_artifact(self):
        """Quarantined artifact should be releasable."""
        quarantine = AnomalyQuarantine()
        
        quarantined = quarantine.quarantine(
            artifact_id="artifact-123",
            reason=QuarantineReason.MANUAL_QUARANTINE,
            original_data={},
        )
        
        released = quarantine.release(
            quarantine_id=quarantined.quarantine_id,
            resolution="Verified as safe",
        )
        
        assert released is not None
        assert released.resolution == "Verified as safe"
        assert released.resolved_at is not None
        
        # Should not be in active list
        active = quarantine.list_active()
        assert len(active) == 0
    
    def test_purge_quarantined_artifact(self):
        """Quarantined artifact should be purgeable."""
        quarantine = AnomalyQuarantine()
        
        quarantined = quarantine.quarantine(
            artifact_id="artifact-123",
            reason=QuarantineReason.CORRUPTION_DETECTED,
            original_data={},
        )
        
        purged = quarantine.purge(
            quarantine_id=quarantined.quarantine_id,
            purged_by="admin",
        )
        
        assert purged is True
        
        # Should not be retrievable
        retrieved = quarantine.get(quarantined.quarantine_id)
        assert retrieved is None
    
    def test_quarantine_stats(self):
        """Quarantine statistics should be correct."""
        quarantine = AnomalyQuarantine()
        
        quarantine.quarantine("a1", QuarantineReason.EMBEDDING_MISMATCH, {})
        quarantine.quarantine("a2", QuarantineReason.CONTENT_HASH_MISMATCH, {})
        quarantine.quarantine("a3", QuarantineReason.MANUAL_QUARANTINE, {})
        
        stats = quarantine.get_stats()
        
        assert stats["total_quarantined"] == 3
        assert stats["active_count"] == 3
        assert stats["by_reason"]["embedding_mismatch"] == 1


class TestIndexRebuildGovernor:
    """Tests for IndexRebuildGovernor."""
    
    def test_create_and_approve_request(self):
        """Rebuild request should be created and approved."""
        quarantine = AnomalyQuarantine()
        governor = IndexRebuildGovernor(quarantine=quarantine)
        
        request = governor.create_request(
            source_model_id="old-model",
            target_model_id="new-model",
            total_vectors=1000,
            justification="Model upgrade",
            requested_by="admin",
        )
        
        assert request.approval_status == RebuildApprovalStatus.PENDING
        
        approved = governor.approve_request(
            request_id=request.request_id,
            approved_by="approver",
        )
        
        assert approved is not None
        assert approved.approval_status == RebuildApprovalStatus.APPROVED
        assert approved.approved_by == "approver"
    
    def test_reject_request(self):
        """Rebuild request should be rejectable."""
        quarantine = AnomalyQuarantine()
        governor = IndexRebuildGovernor(quarantine=quarantine)
        
        request = governor.create_request(
            source_model_id="old",
            target_model_id="new",
            total_vectors=100,
            justification="Test",
            requested_by="user",
        )
        
        rejected = governor.reject_request(
            request_id=request.request_id,
            rejected_by="admin",
            reason="Not approved",
        )
        
        assert rejected is not None
        assert rejected.approval_status == RebuildApprovalStatus.REJECTED
    
    def test_start_and_complete_rebuild(self):
        """Rebuild should start and complete correctly."""
        quarantine = AnomalyQuarantine()
        governor = IndexRebuildGovernor(
            quarantine=quarantine,
            max_quarantine_rate=0.2,
            min_success_rate=0.8,
        )
        
        request = governor.create_request(
            source_model_id="old",
            target_model_id="new",
            total_vectors=100,
            justification="Upgrade",
            requested_by="admin",
        )
        
        governor.approve_request(request.request_id, "approver")
        
        progress = governor.start_rebuild(
            request_id=request.request_id,
            pre_rebuild_hash="pre-hash-123",
            batch_size=10,
        )
        
        assert progress is not None
        assert progress.status == RebuildStatus.IN_PROGRESS
        
        # Update progress
        governor.update_progress(
            rebuild_id=progress.rebuild_id,
            processed=100,
            successful=95,
            failed=5,
            quarantined=5,
        )
        
        # Complete rebuild
        completed = governor.complete_rebuild(
            rebuild_id=progress.rebuild_id,
            post_rebuild_hash="post-hash-456",
        )
        
        assert completed is not None
        assert completed.status == RebuildStatus.COMPLETED
        assert completed.success_rate == 0.95
    
    def test_rebuild_fails_high_quarantine_rate(self):
        """Rebuild should fail if quarantine rate is too high."""
        quarantine = AnomalyQuarantine()
        governor = IndexRebuildGovernor(
            quarantine=quarantine,
            max_quarantine_rate=0.1,  # 10% max
        )
        
        request = governor.create_request(
            source_model_id="old",
            target_model_id="new",
            total_vectors=100,
            justification="Test",
            requested_by="admin",
        )
        
        governor.approve_request(request.request_id, "approver")
        progress = governor.start_rebuild(request.request_id, "pre-hash")
        
        # High quarantine rate (20%)
        governor.update_progress(
            rebuild_id=progress.rebuild_id,
            processed=100,
            successful=80,
            failed=0,
            quarantined=20,
        )
        
        completed = governor.complete_rebuild(
            rebuild_id=progress.rebuild_id,
            post_rebuild_hash="post-hash",
        )
        
        assert completed.status == RebuildStatus.FAILED
        assert "Quarantine rate" in completed.error_message


# =============================================================================
# Drift Analytics Tests
# =============================================================================

class TestDriftDetector:
    """Tests for DriftDetector."""
    
    def test_set_baseline(self):
        """Baseline should be set correctly."""
        detector = DriftDetector()
        
        vectors = [
            [1.0, 0.0, 0.0],
            [0.9, 0.1, 0.0],
            [0.8, 0.2, 0.0],
        ]
        
        stats = detector.set_baseline(vectors)
        
        assert stats.count == 3
        assert stats.dimensions == 3
        assert len(stats.centroid) == 3
    
    def test_detect_centroid_shift(self):
        """Centroid shift should be detected."""
        detector = DriftDetector(centroid_threshold=0.1)
        
        # Baseline vectors around [1, 0, 0]
        baseline = [[1.0, 0.0, 0.0] for _ in range(10)]
        detector.set_baseline(baseline)
        
        # Current vectors around [0, 1, 0] - significant shift
        current = [[0.0, 1.0, 0.0] for _ in range(10)]
        
        metrics = detector.detect(current)
        
        # Should detect centroid shift
        centroid_metrics = [m for m in metrics if m.metric_type == "centroid_shift"]
        assert len(centroid_metrics) > 0
        
        # Should be anomalous (cosine distance ~1.0)
        assert centroid_metrics[0].current_value > 0.5
    
    def test_detect_no_drift(self):
        """No drift should be detected for similar distributions."""
        detector = DriftDetector(centroid_threshold=0.5)
        
        # Baseline vectors
        baseline = [[1.0, 0.0, 0.0] for _ in range(10)]
        detector.set_baseline(baseline)
        
        # Similar vectors
        current = [[0.95, 0.05, 0.0] for _ in range(10)]
        
        metrics = detector.detect(current)
        
        # Centroid shift should be small
        centroid_metrics = [m for m in metrics if m.metric_type == "centroid_shift"]
        if centroid_metrics:
            assert centroid_metrics[0].score in (AnomalyScore.NORMAL, AnomalyScore.WARNING)


class TestAnomalyAnalyzer:
    """Tests for AnomalyAnalyzer."""
    
    def test_analyze_normal_embedding(self):
        """Normal embedding should pass analysis."""
        analyzer = AnomalyAnalyzer()
        
        # Create a more realistic embedding with some variance
        import random
        random.seed(42)
        embedding = [random.gauss(0, 0.1) for _ in range(128)]
        
        metrics = analyzer.analyze_embedding(
            embedding=embedding,
            expected_dimensions=128,
        )
        
        # Should have no critical anomalies
        critical = [m for m in metrics if m.score == AnomalyScore.CRITICAL]
        assert len(critical) == 0
    
    def test_detect_dimension_mismatch(self):
        """Dimension mismatch should be detected."""
        analyzer = AnomalyAnalyzer()
        
        embedding = [0.1] * 64  # Wrong dimensions
        
        metrics = analyzer.analyze_embedding(
            embedding=embedding,
            expected_dimensions=128,
        )
        
        dim_metrics = [m for m in metrics if m.metric_type == "dimension_mismatch"]
        assert len(dim_metrics) > 0
        assert dim_metrics[0].score == AnomalyScore.CRITICAL
    
    def test_detect_high_sparsity(self):
        """High sparsity should be detected."""
        analyzer = AnomalyAnalyzer()
        
        # Mostly zeros
        embedding = [0.0] * 100 + [1.0] * 28
        
        metrics = analyzer.analyze_embedding(
            embedding=embedding,
            expected_dimensions=128,
        )
        
        sparsity_metrics = [m for m in metrics if m.metric_type == "high_sparsity"]
        assert len(sparsity_metrics) > 0
    
    def test_plausibility_check(self):
        """Plausibility check should work with references."""
        analyzer = AnomalyAnalyzer(plausibility_threshold=0.7)
        
        # Reference embeddings
        references = [
            [1.0, 0.0, 0.0],
            [0.9, 0.1, 0.0],
            [0.8, 0.2, 0.0],
        ]
        
        # Similar embedding
        similar = [0.95, 0.05, 0.0]
        metrics_similar = analyzer.analyze_embedding(similar, 3, references)
        plausibility_similar = [m for m in metrics_similar if m.metric_type == "low_plausibility"]
        assert len(plausibility_similar) == 0
        
        # Dissimilar embedding
        dissimilar = [0.0, 0.0, 1.0]
        metrics_dissimilar = analyzer.analyze_embedding(dissimilar, 3, references)
        plausibility_dissimilar = [m for m in metrics_dissimilar if m.metric_type == "low_plausibility"]
        assert len(plausibility_dissimilar) > 0


class TestDriftGovernor:
    """Tests for DriftGovernor."""
    
    def test_evaluate_no_drift(self):
        """No trigger should be generated for normal data."""
        governor = create_drift_governor(
            centroid_threshold=0.5,
            alert_threshold=AnomalyScore.ANOMALOUS,
        )
        
        # Set baseline
        baseline = [[1.0, 0.0, 0.0] for _ in range(10)]
        governor._detector.set_baseline(baseline)
        
        # Similar data
        current = [[0.95, 0.05, 0.0] for _ in range(10)]
        
        trigger = governor.evaluate(current)
        
        # Should be None or low severity
        if trigger:
            assert trigger.severity in (AnomalyScore.NORMAL, AnomalyScore.WARNING)
    
    def test_evaluate_with_drift(self):
        """Trigger should be generated for significant drift."""
        governor = create_drift_governor(
            centroid_threshold=0.01,  # Very low threshold
            alert_threshold=AnomalyScore.NORMAL,  # Alert on any deviation
        )
        
        # Set baseline
        baseline = [[1.0, 0.0, 0.0] for _ in range(10)]
        governor._detector.set_baseline(baseline)
        
        # Very different data (orthogonal)
        current = [[0.0, 1.0, 0.0] for _ in range(10)]
        
        trigger = governor.evaluate(current)
        
        assert trigger is not None
        # Any severity is fine as long as we get a trigger
    
    def test_acknowledge_trigger(self):
        """Trigger should be acknowledgeable."""
        governor = create_drift_governor(
            centroid_threshold=0.01,
            alert_threshold=AnomalyScore.NORMAL,
        )
        
        baseline = [[1.0, 0.0, 0.0] for _ in range(10)]
        governor._detector.set_baseline(baseline)
        
        current = [[0.0, 1.0, 0.0] for _ in range(10)]
        trigger = governor.evaluate(current)
        
        assert trigger is not None
        assert not trigger.acknowledged
        
        acknowledged = governor.acknowledge_trigger(
            trigger_id=trigger.trigger_id,
            acknowledged_by="admin",
        )
        
        assert acknowledged is not None
        assert acknowledged.acknowledged
        assert acknowledged.acknowledged_by == "admin"


# =============================================================================
# Sandbox Tests
# =============================================================================

class TestProcessSandbox:
    """Tests for ProcessSandbox."""
    
    def test_create_and_destroy_sandbox(self):
        """Sandbox should be created and destroyed correctly."""
        config = SandboxConfig(
            sandbox_id="test-sandbox",
            sandbox_type=SandboxType.PROCESS,
        )
        
        sandbox = ProcessSandbox(config)
        
        assert sandbox.create() is True
        assert sandbox.status == SandboxStatus.READY
        
        assert sandbox.destroy() is True
        assert sandbox.status == SandboxStatus.DESTROYED
    
    def test_execute_command(self):
        """Command should execute in sandbox."""
        import platform
        
        # On Windows, use cmd commands; on Unix, use standard commands
        if platform.system() == "Windows":
            allowed = ["cmd"]
            cmd = "cmd"
            args = ["/c", "echo", "hello"]
        else:
            allowed = ["echo"]
            cmd = "echo"
            args = ["hello"]
        
        config = SandboxConfig(
            sandbox_id="test-sandbox",
            sandbox_type=SandboxType.PROCESS,
            allowed_commands=allowed,
        )
        
        sandbox = ProcessSandbox(config)
        sandbox.create()
        
        result = sandbox.execute(command=cmd, args=args)
        
        assert result.success
        assert "hello" in result.stdout
        
        sandbox.destroy()
    
    def test_command_not_in_allowlist(self):
        """Command not in allowlist should be rejected."""
        config = SandboxConfig(
            sandbox_id="test-sandbox",
            sandbox_type=SandboxType.PROCESS,
            allowed_commands=["ls"],  # Only ls allowed
        )
        
        sandbox = ProcessSandbox(config)
        sandbox.create()
        
        result = sandbox.execute(command="echo", args=["hello"])
        
        assert not result.success
        assert "not in allowlist" in result.error_message
        
        sandbox.destroy()
    
    def test_execution_timeout(self):
        """Execution should timeout correctly."""
        import platform
        
        config = SandboxConfig(
            sandbox_id="test-sandbox",
            sandbox_type=SandboxType.PROCESS,
            resources=SandboxResources(execution_timeout=1),
        )
        
        sandbox = ProcessSandbox(config)
        sandbox.create()
        
        # Use a command that takes longer than timeout
        if platform.system() == "Windows":
            # Windows: use ping as a delay (ping localhost 5 times takes ~5 seconds)
            result = sandbox.execute(command="ping", args=["-n", "5", "127.0.0.1"])
        else:
            result = sandbox.execute(command="sleep", args=["5"])
        
        assert not result.success
        assert result.exit_code == -2 or "timed out" in result.error_message.lower()
        
        sandbox.destroy()


class TestSandboxManager:
    """Tests for SandboxManager."""
    
    def test_create_sandbox(self):
        """SandboxManager should create sandboxes."""
        manager = create_sandbox_manager(
            default_type=SandboxType.PROCESS,
        )
        
        sandbox = manager.create_sandbox(
            agent_id="test-agent",
            allowed_commands=["cmd", "echo"],
        )
        
        assert sandbox is not None
        assert sandbox.status == SandboxStatus.READY
        
        # Cleanup
        manager.destroy_all()
    
    def test_execute_in_sandbox(self):
        """SandboxManager should execute commands in sandboxes."""
        import platform
        
        manager = create_sandbox_manager()
        
        if platform.system() == "Windows":
            allowed = ["cmd"]
            cmd = "cmd"
            args = ["/c", "echo", "test"]
        else:
            allowed = ["echo"]
            cmd = "echo"
            args = ["test"]
        
        sandbox = manager.create_sandbox(
            agent_id="test-agent",
            allowed_commands=allowed,
        )
        
        result = manager.execute_in_sandbox(
            sandbox_id=sandbox.sandbox_id,
            command=cmd,
            args=args,
        )
        
        assert result is not None
        assert result.success
        
        manager.destroy_all()
    
    def test_destroy_sandbox(self):
        """SandboxManager should destroy sandboxes."""
        manager = create_sandbox_manager()
        
        sandbox = manager.create_sandbox(agent_id="test-agent")
        sandbox_id = sandbox.sandbox_id
        
        destroyed = manager.destroy_sandbox(sandbox_id)
        
        assert destroyed is True
        assert manager.get_sandbox(sandbox_id) is None
    
    def test_get_stats(self):
        """SandboxManager should provide statistics."""
        manager = create_sandbox_manager()
        
        manager.create_sandbox(agent_id="agent1")
        manager.create_sandbox(agent_id="agent2")
        
        stats = manager.get_stats()
        
        assert stats["total_sandboxes"] == 2
        
        manager.destroy_all()


# =============================================================================
# Integration Tests
# =============================================================================

class TestPhase3Integration:
    """Integration tests for Phase 3 components."""
    
    def test_drift_to_quarantine_flow(self):
        """Drift detection should lead to quarantine."""
        # Setup
        quarantine = AnomalyQuarantine()
        governor = create_drift_governor(
            centroid_threshold=0.01,
            alert_threshold=AnomalyScore.NORMAL,
        )
        
        # Set baseline
        baseline = [[1.0, 0.0, 0.0] for _ in range(10)]
        governor._detector.set_baseline(baseline)
        
        # Detect drift
        current = [[0.0, 1.0, 0.0] for _ in range(10)]
        trigger = governor.evaluate(current)
        
        assert trigger is not None
        
        # Quarantine affected artifact
        quarantined = quarantine.quarantine(
            artifact_id="artifact-123",
            reason=QuarantineReason.ANOMALY_DETECTED,
            original_data={"embedding": current[0]},
            evidence={"trigger_id": trigger.trigger_id},
        )
        
        assert quarantined is not None
        assert len(quarantine.list_active()) == 1
    
    def test_wire_protocol_anomaly_propagation(self):
        """Anomaly should propagate via wire protocol."""
        handler = create_protocol_handler(source_id="drift-monitor")
        
        # Create anomaly message
        message = handler.create_anomaly_message(
            anomaly_type=AnomalyType.EMBEDDING_MISMATCH,
            artifact_id="artifact-123",
            severity=0.9,
            description="Critical embedding mismatch",
        )
        
        serialized = handler.serialize_message(message)
        deserialized = WireMessage.deserialize(serialized)
        
        assert deserialized.header.message_type == MessageType.ANOMALY_DETECTED
        assert isinstance(deserialized.payload, AnomalyPayload)
        assert deserialized.payload.severity == 0.9
    
    def test_sandbox_execution_audit(self):
        """Sandbox execution should produce audit trail."""
        import platform
        
        manager = create_sandbox_manager()
        
        if platform.system() == "Windows":
            allowed = ["cmd"]
            cmd = "cmd"
            args = ["/c", "echo", "test"]
        else:
            allowed = ["echo"]
            cmd = "echo"
            args = ["test"]
        
        sandbox = manager.create_sandbox(
            agent_id="untrusted-agent",
            allowed_commands=allowed,
        )
        
        # Execute multiple commands
        for i in range(3):
            manager.execute_in_sandbox(
                sandbox_id=sandbox.sandbox_id,
                command=cmd,
                args=args,
            )
        
        # Check execution history
        executions = sandbox.get_executions()
        assert len(executions) == 3
        
        # All should be successful
        assert all(e.success for e in executions)
        
        manager.destroy_all()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
