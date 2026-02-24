"""
Policy Signing and Immutability for Enterprise Governance.

Implements Phase 4 Enterprise:
- Cryptographic policy signing
- Immutable policy storage with hash chaining
- Policy version management
- Tamper detection and verification

Core Principle: Policies cannot be modified without detection.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional
import hashlib
import hmac
import json
import logging
import threading
import yaml

logger = logging.getLogger(__name__)


class PolicyStatus(str, Enum):
    """Status of a policy version."""
    DRAFT = "draft"
    ACTIVE = "active"
    DEPRECATED = "deprecated"
    REVOKED = "revoked"


@dataclass
class SignedPolicy:
    """A cryptographically signed policy file.
    
    Attributes:
        policy_hash: SHA-256 hash of policy content
        policy_content: The actual policy YAML/JSON content
        signature: HMAC signature
        signed_at: When the policy was signed
        signed_by: Who signed the policy
        version: Policy version string
        previous_hash: Hash of previous version (for chain)
        status: Current status of the policy
        metadata: Additional metadata
    """
    policy_hash: str
    policy_content: str
    signature: str
    signed_at: datetime
    signed_by: str
    version: str
    previous_hash: Optional[str] = None
    status: PolicyStatus = PolicyStatus.ACTIVE
    metadata: dict = field(default_factory=dict)
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "policy_hash": self.policy_hash,
            "policy_content": self.policy_content,
            "signature": self.signature,
            "signed_at": self.signed_at.isoformat(),
            "signed_by": self.signed_by,
            "version": self.version,
            "previous_hash": self.previous_hash,
            "status": self.status.value,
            "metadata": self.metadata,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "SignedPolicy":
        """Deserialize from dictionary."""
        return cls(
            policy_hash=data["policy_hash"],
            policy_content=data["policy_content"],
            signature=data["signature"],
            signed_at=datetime.fromisoformat(data["signed_at"]),
            signed_by=data["signed_by"],
            version=data["version"],
            previous_hash=data.get("previous_hash"),
            status=PolicyStatus(data.get("status", "active")),
            metadata=data.get("metadata", {}),
        )


class PolicySigner:
    """Sign policy files for integrity verification.
    
    Provides cryptographic signing and verification of policy files
    to ensure they cannot be tampered with.
    """
    
    def __init__(self, signing_key: bytes):
        """Initialize the policy signer.
        
        Args:
            signing_key: HMAC signing key
        """
        self._key = signing_key
    
    def sign_policy(
        self,
        policy_content: str,
        signed_by: str,
        version: str,
        previous_hash: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> SignedPolicy:
        """Sign a policy.
        
        Args:
            policy_content: The policy YAML/JSON content
            signed_by: Who is signing the policy
            version: Policy version string
            previous_hash: Hash of previous version
            metadata: Additional metadata
        
        Returns:
            SignedPolicy with signature
        """
        # Compute hash
        policy_hash = hashlib.sha256(policy_content.encode()).hexdigest()
        
        # Create signature
        sig_data = f"{policy_hash}:{version}:{signed_by}"
        if previous_hash:
            sig_data += f":{previous_hash}"
        
        signature = hmac.new(
            self._key,
            sig_data.encode(),
            hashlib.sha256
        ).hexdigest()
        
        return SignedPolicy(
            policy_hash=policy_hash,
            policy_content=policy_content,
            signature=signature,
            signed_at=datetime.now(timezone.utc),
            signed_by=signed_by,
            version=version,
            previous_hash=previous_hash,
            metadata=metadata or {},
        )
    
    def sign_policy_file(
        self,
        policy_path: Path,
        signed_by: str,
        version: str,
        previous_hash: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> SignedPolicy:
        """Sign a policy file.
        
        Args:
            policy_path: Path to the policy file
            signed_by: Who is signing the policy
            version: Policy version string
            previous_hash: Hash of previous version
            metadata: Additional metadata
        
        Returns:
            SignedPolicy with signature
        """
        content = policy_path.read_text(encoding="utf-8")
        return self.sign_policy(content, signed_by, version, previous_hash, metadata)
    
    def verify_policy(self, signed: SignedPolicy) -> bool:
        """Verify a signed policy.
        
        Args:
            signed: The signed policy to verify
        
        Returns:
            True if signature is valid
        """
        # Verify hash
        expected_hash = hashlib.sha256(signed.policy_content.encode()).hexdigest()
        if signed.policy_hash != expected_hash:
            logger.warning(
                f"Policy hash mismatch: expected {expected_hash[:16]}..., "
                f"got {signed.policy_hash[:16]}..."
            )
            return False
        
        # Verify signature
        sig_data = f"{signed.policy_hash}:{signed.version}:{signed.signed_by}"
        if signed.previous_hash:
            sig_data += f":{signed.previous_hash}"
        
        expected_sig = hmac.new(
            self._key,
            sig_data.encode(),
            hashlib.sha256
        ).hexdigest()
        
        if not hmac.compare_digest(signed.signature, expected_sig):
            logger.warning("Policy signature verification failed")
            return False
        
        return True


class ImmutablePolicyStore:
    """Store policies with immutability guarantees.
    
    Policies are stored in an append-only format with hash chaining,
    similar to the governance ledger. This ensures:
    - Policies cannot be modified without detection
    - All versions are preserved
    - Chain integrity can be verified
    
    Core Principle: Policy history is immutable and verifiable.
    """
    
    def __init__(
        self,
        store_path: Path,
        signing_key: bytes,
    ):
        """Initialize the immutable policy store.
        
        Args:
            store_path: Path to store policy versions
            signing_key: Key for signing policies
        """
        self._path = Path(store_path)
        self._signer = PolicySigner(signing_key)
        self._lock = threading.RLock()
        
        self._path.mkdir(parents=True, exist_ok=True)
    
    def store_policy(
        self,
        policy_content: str,
        signed_by: str,
        version: str,
        metadata: Optional[dict] = None,
    ) -> SignedPolicy:
        """Store a new policy version.
        
        Args:
            policy_content: The policy YAML/JSON content
            signed_by: Who is signing the policy
            version: Policy version string
            metadata: Additional metadata
        
        Returns:
            SignedPolicy that was stored
        """
        with self._lock:
            # Get previous hash
            previous = self._get_latest()
            previous_hash = previous.policy_hash if previous else None
            
            # Check version doesn't already exist
            if self._version_exists(version):
                raise ValueError(f"Policy version already exists: {version}")
            
            # Sign
            signed = self._signer.sign_policy(
                policy_content,
                signed_by,
                version,
                previous_hash,
                metadata,
            )
            
            # Store
            entry_path = self._path / f"{version}.json"
            entry_path.write_text(json.dumps(signed.to_dict(), indent=2))
            
            # Update index
            self._update_index(signed)
            
            logger.info(
                f"Stored policy version {version} "
                f"(hash={signed.policy_hash[:16]}...)"
            )
            
            return signed
    
    def store_policy_file(
        self,
        policy_path: Path,
        signed_by: str,
        version: str,
        metadata: Optional[dict] = None,
    ) -> SignedPolicy:
        """Store a policy file.
        
        Args:
            policy_path: Path to the policy file
            signed_by: Who is signing the policy
            version: Policy version string
            metadata: Additional metadata
        
        Returns:
            SignedPolicy that was stored
        """
        content = policy_path.read_text(encoding="utf-8")
        return self.store_policy(content, signed_by, version, metadata)
    
    def get_policy(self, version: str) -> Optional[SignedPolicy]:
        """Get a specific policy version.
        
        Args:
            version: Policy version string
        
        Returns:
            SignedPolicy or None if not found
        """
        entry_path = self._path / f"{version}.json"
        if not entry_path.exists():
            return None
        
        try:
            data = json.loads(entry_path.read_text())
            return SignedPolicy.from_dict(data)
        except (json.JSONDecodeError, KeyError) as e:
            logger.error(f"Failed to load policy {version}: {e}")
            return None
    
    def get_current(self) -> Optional[SignedPolicy]:
        """Get the current (latest active) policy."""
        return self._get_latest()
    
    def get_all_versions(self) -> list[SignedPolicy]:
        """Get all policy versions."""
        versions = []
        for entry_path in self._path.glob("*.json"):
            if entry_path.name == "_index.json":
                continue
            try:
                data = json.loads(entry_path.read_text())
                versions.append(SignedPolicy.from_dict(data))
            except Exception:
                continue
        
        # Sort by version
        return sorted(versions, key=lambda p: p.version)
    
    def deprecate_version(self, version: str, reason: str) -> Optional[SignedPolicy]:
        """Deprecate a policy version.
        
        Args:
            version: Version to deprecate
            reason: Reason for deprecation
        
        Returns:
            Updated SignedPolicy or None
        """
        with self._lock:
            policy = self.get_policy(version)
            if not policy:
                return None
            
            # Update status and metadata
            policy.status = PolicyStatus.DEPRECATED
            policy.metadata["deprecated_at"] = datetime.now(timezone.utc).isoformat()
            policy.metadata["deprecation_reason"] = reason
            
            # Store updated version (overwrite existing)
            entry_path = self._path / f"{version}.json"
            entry_path.write_text(json.dumps(policy.to_dict(), indent=2))
            
            logger.info(f"Deprecated policy version {version}: {reason}")
            
            return policy
    
    def revoke_version(self, version: str, reason: str, revoked_by: str) -> Optional[SignedPolicy]:
        """Revoke a policy version.
        
        Args:
            version: Version to revoke
            reason: Reason for revocation
            revoked_by: Who revoked the policy
        
        Returns:
            Updated SignedPolicy or None
        """
        with self._lock:
            policy = self.get_policy(version)
            if not policy:
                return None
            
            policy.status = PolicyStatus.REVOKED
            policy.metadata["revoked_at"] = datetime.now(timezone.utc).isoformat()
            policy.metadata["revocation_reason"] = reason
            policy.metadata["revoked_by"] = revoked_by
            
            # Re-sign with updated metadata
            signed = self._signer.sign_policy(
                policy.policy_content,
                policy.signed_by,
                policy.version,
                policy.previous_hash,
                policy.metadata,
            )
            
            # Store updated version
            entry_path = self._path / f"{version}.json"
            entry_path.write_text(json.dumps(signed.to_dict(), indent=2))
            
            logger.warning(f"Revoked policy version {version}: {reason}")
            
            return signed
    
    def verify_chain(self) -> tuple[bool, list[str]]:
        """Verify the integrity of the policy chain.
        
        Returns:
            Tuple of (is_valid, list_of_errors)
        """
        errors = []
        versions = self.get_all_versions()
        
        # Build hash map
        hash_map = {v.version: v for v in versions}
        
        previous_hash = None
        for signed in versions:
            # Verify signature
            if not self._signer.verify_policy(signed):
                errors.append(f"{signed.version}: Invalid signature")
                continue
            
            # Verify chain
            if signed.previous_hash != previous_hash:
                errors.append(
                    f"{signed.version}: Chain broken "
                    f"(expected {previous_hash[:16] if previous_hash else 'None'}..., "
                    f"got {signed.previous_hash[:16] if signed.previous_hash else 'None'}...)"
                )
            
            previous_hash = signed.policy_hash
        
        if errors:
            logger.warning(f"Policy chain verification failed: {len(errors)} errors")
        else:
            logger.info("Policy chain verification passed")
        
        return len(errors) == 0, errors
    
    def verify_version(self, version: str) -> tuple[bool, list[str]]:
        """Verify a specific policy version.
        
        Args:
            version: Version to verify
        
        Returns:
            Tuple of (is_valid, list_of_errors)
        """
        errors = []
        signed = self.get_policy(version)
        
        if not signed:
            return False, [f"Version not found: {version}"]
        
        # Verify signature
        if not self._signer.verify_policy(signed):
            errors.append("Invalid signature")
        
        # Verify hash
        expected_hash = hashlib.sha256(signed.policy_content.encode()).hexdigest()
        if signed.policy_hash != expected_hash:
            errors.append("Content hash mismatch")
        
        # Verify previous hash if present
        if signed.previous_hash:
            prev = self._find_by_hash(signed.previous_hash)
            if not prev:
                errors.append("Previous version not found in chain")
        
        return len(errors) == 0, errors
    
    def get_stats(self) -> dict:
        """Get policy store statistics."""
        versions = self.get_all_versions()
        
        by_status: dict[str, int] = {}
        for v in versions:
            by_status[v.status.value] = by_status.get(v.status.value, 0) + 1
        
        current = self.get_current()
        
        return {
            "total_versions": len(versions),
            "by_status": by_status,
            "current_version": current.version if current else None,
            "current_hash": current.policy_hash[:16] if current else None,
        }
    
    def _get_latest(self) -> Optional[SignedPolicy]:
        """Get the latest active policy."""
        versions = [v for v in self.get_all_versions() if v.status == PolicyStatus.ACTIVE]
        if not versions:
            return None
        return versions[-1]
    
    def _version_exists(self, version: str) -> bool:
        """Check if a version already exists."""
        return (self._path / f"{version}.json").exists()
    
    def _find_by_hash(self, policy_hash: str) -> Optional[SignedPolicy]:
        """Find a policy by its hash."""
        for signed in self.get_all_versions():
            if signed.policy_hash == policy_hash:
                return signed
        return None
    
    def _update_index(self, signed: SignedPolicy) -> None:
        """Update the policy index."""
        index_path = self._path / "_index.json"
        
        index = {}
        if index_path.exists():
            try:
                index = json.loads(index_path.read_text())
            except Exception:
                pass
        
        index[signed.version] = {
            "hash": signed.policy_hash,
            "signed_at": signed.signed_at.isoformat(),
            "signed_by": signed.signed_by,
            "status": signed.status.value,
        }
        
        index_path.write_text(json.dumps(index, indent=2))


class PolicyVersionManager:
    """Manage policy versions and transitions.
    
    Provides high-level operations for:
    - Creating new policy versions
    - Rolling back to previous versions
    - Comparing policy versions
    """
    
    def __init__(self, store: ImmutablePolicyStore):
        """Initialize the version manager.
        
        Args:
            store: The immutable policy store
        """
        self._store = store
    
    def create_version(
        self,
        policy_content: str,
        signed_by: str,
        version: str,
        metadata: Optional[dict] = None,
    ) -> SignedPolicy:
        """Create a new policy version.
        
        Args:
            policy_content: The policy content
            signed_by: Who is creating the version
            version: Version string
            metadata: Additional metadata
        
        Returns:
            The created SignedPolicy
        """
        return self._store.store_policy(policy_content, signed_by, version, metadata)
    
    def rollback_to(self, version: str, reason: str, rolled_back_by: str) -> Optional[SignedPolicy]:
        """Rollback to a previous policy version.
        
        This creates a new version that is a copy of the specified version,
        with rollback metadata.
        
        Args:
            version: Version to rollback to
            reason: Reason for rollback
            rolled_back_by: Who initiated the rollback
        
        Returns:
            New SignedPolicy representing the rollback
        """
        old_policy = self._store.get_policy(version)
        if not old_policy:
            raise ValueError(f"Version not found: {version}")
        
        # Create new version with rollback metadata
        new_version = f"{version}-rollback-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
        
        metadata = {
            "rollback_from": version,
            "rollback_reason": reason,
            "rolled_back_by": rolled_back_by,
            "original_signed_at": old_policy.signed_at.isoformat(),
            "original_signed_by": old_policy.signed_by,
        }
        
        return self._store.store_policy(
            old_policy.policy_content,
            rolled_back_by,
            new_version,
            metadata,
        )
    
    def compare_versions(
        self,
        version1: str,
        version2: str,
    ) -> dict:
        """Compare two policy versions.
        
        Args:
            version1: First version
            version2: Second version
        
        Returns:
            Comparison result
        """
        p1 = self._store.get_policy(version1)
        p2 = self._store.get_policy(version2)
        
        if not p1 or not p2:
            raise ValueError("One or both versions not found")
        
        # Parse policies
        try:
            content1 = yaml.safe_load(p1.policy_content)
            content2 = yaml.safe_load(p2.policy_content)
        except yaml.YAMLError:
            content1 = p1.policy_content
            content2 = p2.policy_content
        
        return {
            "version1": version1,
            "version2": version2,
            "hash1": p1.policy_hash,
            "hash2": p2.policy_hash,
            "identical": p1.policy_hash == p2.policy_hash,
            "signed_by_1": p1.signed_by,
            "signed_by_2": p2.signed_by,
            "signed_at_1": p1.signed_at.isoformat(),
            "signed_at_2": p2.signed_at.isoformat(),
        }
    
    def get_history(self) -> list[dict]:
        """Get the full policy history.
        
        Returns:
            List of policy version summaries
        """
        versions = self._store.get_all_versions()
        
        return [
            {
                "version": v.version,
                "hash": v.policy_hash[:16],
                "signed_by": v.signed_by,
                "signed_at": v.signed_at.isoformat(),
                "status": v.status.value,
                "previous_hash": v.previous_hash[:16] if v.previous_hash else None,
            }
            for v in versions
        ]


def create_policy_store(
    store_path: Path,
    signing_key: bytes,
) -> ImmutablePolicyStore:
    """Factory function to create an immutable policy store.
    
    Args:
        store_path: Path to store policy versions
        signing_key: Key for signing policies
    
    Returns:
        Configured ImmutablePolicyStore instance
    """
    return ImmutablePolicyStore(store_path, signing_key)
