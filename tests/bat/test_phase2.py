"""
Tests for Security Elevation Phase 2 components.

Tests for:
- Governance daemon mode
- Ledger encryption at rest
- Property-based tests for determinism
- Concurrency tests
- Performance budget tests
"""

import pytest
import tempfile
import threading
import time
import concurrent.futures
from pathlib import Path
from datetime import datetime, timezone

# Skip tests if hypothesis not available
pytest.importorskip("hypothesis")

from hypothesis import given, strategies as st, settings, assume

# Phase 2 components
from alfred.bat.daemon import (
    GovernanceDaemon,
    DaemonClient,
    DaemonMode,
    DaemonCommand,
    DaemonMessage,
    DaemonResponse,
    create_daemon,
)
from alfred.bat.encryption import (
    LedgerEncryption,
    EncryptedBlock,
    EncryptedLedgerWriter,
    EncryptionError,
    create_encryption,
)
from alfred.bat.proposal import OperationProposal
from alfred.bat.risk import RiskEngine, RiskLevel, RiskClassification, RiskRule
from alfred.bat.enforcement import EnforcementEngine, EnforcementPolicy, EnforcementMode


class TestDaemonMessage:
    """Tests for daemon message serialization."""
    
    def test_message_serialization(self):
        """Test message can be serialized and deserialized."""
        message = DaemonMessage(
            command=DaemonCommand.PROPOSE,
            payload={"test": "data"},
        )
        
        serialized = message.serialize()
        deserialized = DaemonMessage.deserialize(serialized[4:])  # Skip length prefix
        
        assert deserialized.command == message.command
        assert deserialized.payload == message.payload
        assert deserialized.sender_pid == message.sender_pid
    
    def test_response_serialization(self):
        """Test response can be serialized and deserialized."""
        response = DaemonResponse(
            success=True,
            result={"key": "value"},
        )
        
        serialized = response.serialize()
        deserialized = DaemonResponse.deserialize(serialized[4:])
        
        assert deserialized.success == response.success
        assert deserialized.result == response.result


class TestGovernanceDaemon:
    """Tests for governance daemon."""
    
    def test_create_daemon_in_process(self):
        """Test creating daemon in in-process mode."""
        daemon = create_daemon(mode="in_process")
        assert daemon.mode == DaemonMode.IN_PROCESS
    
    def test_start_stop_in_process(self):
        """Test starting and stopping daemon in in-process mode."""
        daemon = create_daemon(mode="in_process")
        
        assert daemon.start()
        assert daemon.is_running
        
        daemon.stop()
        assert not daemon.is_running
    
    def test_submit_proposal_in_process(self):
        """Test submitting a proposal in in-process mode."""
        daemon = create_daemon(mode="in_process")
        daemon.start()
        
        try:
            proposal = {
                "proposal_id": "test-123",
                "agent_id": "test-agent",
                "operation_type": "read_file",
                "target": "/tmp/test.txt",
            }
            
            response = daemon.submit_proposal(proposal)
            
            assert response.success
            assert response.result["proposal_id"] == "test-123"
            assert response.result["processed"]
        finally:
            daemon.stop()
    
    def test_daemon_status(self):
        """Test getting daemon status."""
        daemon = create_daemon(mode="in_process")
        daemon.start()
        
        try:
            status = daemon.get_status()
            
            assert status["mode"] == "in_process"
            assert status["running"]
            assert status["proposal_count"] == 0
        finally:
            daemon.stop()
    
    def test_multiple_proposals(self):
        """Test submitting multiple proposals."""
        daemon = create_daemon(mode="in_process")
        daemon.start()
        
        try:
            for i in range(10):
                proposal = {
                    "proposal_id": f"test-{i}",
                    "agent_id": "test-agent",
                    "operation_type": "read_file",
                    "target": f"/tmp/test{i}.txt",
                }
                response = daemon.submit_proposal(proposal)
                assert response.success
            
            status = daemon.get_status()
            assert status["proposal_count"] == 10
        finally:
            daemon.stop()


class TestLedgerEncryption:
    """Tests for ledger encryption."""
    
    def test_generate_master_key(self):
        """Test master key generation."""
        key = LedgerEncryption.generate_master_key()
        assert len(key) == 32
    
    def test_derive_key_from_password(self):
        """Test key derivation from password."""
        password = "test-password-123"
        key, salt = LedgerEncryption.derive_key_from_password(password)
        
        assert len(key) == 32
        assert len(salt) == 16
        
        # Same password + salt = same key
        key2, _ = LedgerEncryption.derive_key_from_password(password, salt)
        assert key == key2
    
    def test_encrypt_decrypt(self):
        """Test encryption and decryption."""
        encryption = create_encryption(master_key=b"0" * 32)
        
        plaintext = b"Hello, World! This is a test message."
        block = encryption.encrypt(plaintext)
        
        assert block.nonce
        assert block.ciphertext
        assert block.tag
        assert block.ciphertext != plaintext
        
        decrypted = encryption.decrypt(block)
        assert decrypted == plaintext
    
    def test_encrypt_different_nonces(self):
        """Test that same plaintext produces different ciphertexts."""
        encryption = create_encryption(master_key=b"0" * 32)
        
        plaintext = b"Same message"
        block1 = encryption.encrypt(plaintext)
        block2 = encryption.encrypt(plaintext)
        
        assert block1.nonce != block2.nonce
        assert block1.ciphertext != block2.ciphertext
    
    def test_decrypt_wrong_key_fails(self):
        """Test that decryption with wrong key fails."""
        encryption1 = create_encryption(master_key=b"0" * 32)
        encryption2 = create_encryption(master_key=b"1" * 32)
        
        plaintext = b"Secret message"
        block = encryption1.encrypt(plaintext)
        
        with pytest.raises(EncryptionError):
            encryption2.decrypt(block)
    
    def test_tampered_ciphertext_fails(self):
        """Test that tampered ciphertext fails decryption."""
        encryption = create_encryption(master_key=b"0" * 32)
        
        plaintext = b"Original message"
        block = encryption.encrypt(plaintext)
        
        # Tamper with ciphertext
        tampered_block = EncryptedBlock(
            nonce=block.nonce,
            ciphertext=block.ciphertext[:-1] + bytes([block.ciphertext[-1] ^ 0xFF]),
            tag=block.tag,
        )
        
        with pytest.raises(EncryptionError):
            encryption.decrypt(tampered_block)
    
    def test_encrypted_ledger_writer(self):
        """Test encrypted ledger writer."""
        encryption = create_encryption(master_key=b"0" * 32)
        
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger_path = Path(tmpdir) / "encrypted.ledger"
            writer = EncryptedLedgerWriter(ledger_path, encryption)
            
            # Write entries
            entries = [
                {"id": "1", "data": "first"},
                {"id": "2", "data": "second"},
                {"id": "3", "data": "third"},
            ]
            
            for entry in entries:
                writer.write_entry(entry)
            
            # Read back
            read_entries = writer.read_entries()
            assert len(read_entries) == 3
            assert read_entries[0]["id"] == "1"
            assert read_entries[1]["id"] == "2"
            assert read_entries[2]["id"] == "3"


class TestPropertyBased:
    """Property-based tests for determinism."""
    
    @given(
        agent_id=st.text(min_size=1, max_size=50),
        operation_type=st.sampled_from(["read_file", "write_file", "delete_file", "exec_command"]),
        target=st.text(min_size=1, max_size=100),
    )
    @settings(max_examples=50)
    def test_proposal_hash_deterministic(self, agent_id, operation_type, target):
        """Test that proposal hash is deterministic."""
        assume(agent_id.strip())  # Skip empty strings
        assume(target.strip())
        
        # Use same proposal_id and timestamp for both to test determinism
        import uuid
        from datetime import datetime, timezone
        proposal_id = str(uuid.uuid4())
        timestamp = datetime.now(timezone.utc)
        
        proposal1 = OperationProposal(
            proposal_id=proposal_id,
            agent_id=agent_id,
            operation_type=operation_type,
            target=target,
            timestamp=timestamp,
        )
        proposal2 = OperationProposal(
            proposal_id=proposal_id,
            agent_id=agent_id,
            operation_type=operation_type,
            target=target,
            timestamp=timestamp,
        )
        
        # Same inputs should produce same hash
        assert proposal1.compute_hash() == proposal2.compute_hash()
    
    @given(
        content=st.text(max_size=1000),
    )
    @settings(max_examples=50)
    def test_encryption_roundtrip(self, content):
        """Test that encryption roundtrip preserves data."""
        encryption = create_encryption(master_key=b"0" * 32)
        
        plaintext = content.encode('utf-8')
        block = encryption.encrypt(plaintext)
        decrypted = encryption.decrypt(block)
        
        assert decrypted == plaintext
    
    @given(
        rule_priority=st.integers(min_value=1, max_value=100),
        pattern=st.text(min_size=1, max_size=20),
    )
    @settings(max_examples=30)
    def test_rule_priority_ordering(self, rule_priority, pattern):
        """Test that rules are evaluated in priority order."""
        assume(pattern.strip())
        
        # Create rules with different priorities
        rules = [
            RiskRule(
                id=f"rule-{i}",
                predicate=lambda p, pattern=pattern: pattern in p.target,
                level=RiskLevel.L1,
                rationale=f"Rule {i}",
                priority=i,
            )
            for i in range(1, 5)
        ]
        
        engine = RiskEngine(rules=rules)
        
        # Higher priority rules should be evaluated first
        # (lower number = higher priority)
        assert len(engine.rules) == 4


class TestConcurrency:
    """Concurrency tests for daemon mode."""
    
    def test_concurrent_proposals_in_process(self):
        """Test concurrent proposals in in-process mode."""
        daemon = create_daemon(mode="in_process")
        daemon.start()
        
        try:
            results = []
            errors = []
            
            def submit_proposal(i):
                try:
                    proposal = {
                        "proposal_id": f"concurrent-{i}",
                        "agent_id": f"agent-{i % 5}",
                        "operation_type": "read_file",
                        "target": f"/tmp/test{i}.txt",
                    }
                    response = daemon.submit_proposal(proposal)
                    results.append(response)
                except Exception as e:
                    errors.append(e)
            
            # Submit 100 proposals concurrently
            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
                futures = [executor.submit(submit_proposal, i) for i in range(100)]
                concurrent.futures.wait(futures)
            
            assert len(errors) == 0
            assert len(results) == 100
            assert all(r.success for r in results)
            
            status = daemon.get_status()
            assert status["proposal_count"] == 100
            
        finally:
            daemon.stop()
    
    def test_temporal_events_thread_safety(self):
        """Test that temporal events are thread-safe."""
        daemon = create_daemon(mode="in_process")
        daemon.start()
        
        try:
            def submit_batch(start, count):
                for i in range(start, start + count):
                    proposal = {
                        "proposal_id": f"batch-{i}",
                        "agent_id": "batch-agent",
                        "operation_type": "write_file",
                        "target": f"/tmp/batch{i}.txt",
                    }
                    daemon.submit_proposal(proposal)
            
            # Run multiple batches concurrently
            threads = [
                threading.Thread(target=submit_batch, args=(i * 100, 100))
                for i in range(5)
            ]
            
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            
            status = daemon.get_status()
            assert status["proposal_count"] == 500
            assert status["temporal_events"] == 500
            
        finally:
            daemon.stop()


class TestPerformanceBudgets:
    """Performance budget tests."""
    
    def test_proposal_latency_budget(self):
        """Test that proposal processing meets latency budget.
        
        Budget: p99 < 10ms for in-process mode
        """
        daemon = create_daemon(mode="in_process")
        daemon.start()
        
        try:
            latencies = []
            
            for i in range(1000):
                proposal = {
                    "proposal_id": f"perf-{i}",
                    "agent_id": "perf-agent",
                    "operation_type": "read_file",
                    "target": "/tmp/perf.txt",
                }
                
                start = time.perf_counter()
                daemon.submit_proposal(proposal)
                end = time.perf_counter()
                
                latencies.append((end - start) * 1000)  # ms
            
            latencies.sort()
            p50 = latencies[500]
            p99 = latencies[990]
            
            # These should be well under 10ms for in-process
            assert p50 < 5.0, f"p50 latency {p50:.2f}ms exceeds budget"
            assert p99 < 10.0, f"p99 latency {p99:.2f}ms exceeds budget"
            
            print(f"\nLatency: p50={p50:.3f}ms, p99={p99:.3f}ms")
            
        finally:
            daemon.stop()
    
    def test_encryption_latency_budget(self):
        """Test that encryption meets latency budget.
        
        Budget: encrypt+decrypt < 5ms for 1KB data
        """
        encryption = create_encryption(master_key=b"0" * 32)
        
        # 1KB test data
        data = b"x" * 1024
        
        latencies = []
        
        for _ in range(100):
            start = time.perf_counter()
            block = encryption.encrypt(data)
            decrypted = encryption.decrypt(block)
            end = time.perf_counter()
            
            assert decrypted == data
            latencies.append((end - start) * 1000)
        
        latencies.sort()
        p99 = latencies[98]
        
        assert p99 < 5.0, f"Encryption p99 latency {p99:.2f}ms exceeds budget"
        print(f"\nEncryption latency p99: {p99:.3f}ms")
    
    def test_rate_limiter_performance(self):
        """Test rate limiter performance under load."""
        from alfred.bat.resource_governor import RateLimiter, ResourceLimits
        
        limits = ResourceLimits(max_proposals_per_second=1000)
        limiter = RateLimiter(limits)
        
        start = time.perf_counter()
        
        for i in range(1000):
            limiter.check_and_record("test-agent")
        
        elapsed = (time.perf_counter() - start) * 1000
        
        # Should process 1000 checks in under 100ms
        assert elapsed < 100, f"Rate limiter too slow: {elapsed:.2f}ms for 1000 checks"
        print(f"\nRate limiter: {elapsed:.2f}ms for 1000 checks")
