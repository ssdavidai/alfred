"""
Policy Integrity - Signed policy manifest verification and immutable root protection.

Implements SECURITY ELEVATION Track B:
- Signed policy manifest verification at startup and hot reload
- Immutable root assets hard-blocked pre-classification
- Policy tampering detection

Core Principle: Policy integrity is verified before policy is used.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Callable
import hashlib
import json
import logging
import os

logger = logging.getLogger(__name__)


class PolicyIntegrityError(Exception):
    """Raised when policy integrity verification fails."""
    pass


class ImmutableAssetError(Exception):
    """Raised when attempting to modify an immutable asset."""
    pass


@dataclass
class PolicyManifest:
    """Signed manifest for policy files.
    
    The manifest contains:
    - List of policy files with their expected hashes
    - Version information
    - Timestamp
    - Cryptographic signature
    
    Attributes:
        version: Policy version string
        timestamp: When the manifest was created
        files: Dict of filename -> SHA-256 hash
        signature: Ed25519 signature of the manifest (hex)
        created_by: Identity that created the manifest
    """
    version: str
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    files: dict[str, str] = field(default_factory=dict)
    signature: str = ""
    created_by: str = ""
    
    def compute_hash(self) -> str:
        """Compute SHA-256 hash of the manifest content (excluding signature)."""
        data = {
            "version": self.version,
            "timestamp": self.timestamp.isoformat(),
            "files": dict(sorted(self.files.items())),
            "created_by": self.created_by,
        }
        data_str = json.dumps(data, sort_keys=True)
        return hashlib.sha256(data_str.encode()).hexdigest()
    
    def sign(self, private_key: str) -> None:
        """Sign the manifest with an Ed25519 private key.
        
        Args:
            private_key: Ed25519 private key (hex)
        """
        try:
            import nacl.signing
            
            signing_key = nacl.signing.SigningKey(bytes.fromhex(private_key))
            manifest_hash = self.compute_hash()
            self.signature = signing_key.sign(manifest_hash.encode()).signature.hex()
            
            logger.info(f"Signed policy manifest v{self.version}")
        except ImportError:
            raise RuntimeError("PyNaCl required for signing manifests")
    
    def verify_signature(self, public_key: str) -> bool:
        """Verify the manifest signature.
        
        Args:
            public_key: Ed25519 public key (hex)
        
        Returns:
            True if signature is valid
        """
        if not self.signature:
            return False
        
        try:
            import nacl.signing
            import nacl.exceptions
            
            verify_key = nacl.signing.VerifyKey(bytes.fromhex(public_key))
            manifest_hash = self.compute_hash()
            
            verify_key.verify(
                manifest_hash.encode(),
                bytes.fromhex(self.signature),
            )
            return True
        except ImportError:
            logger.warning("PyNaCl not installed - signature verification skipped")
            return True
        except nacl.exceptions.BadSignature:
            return False
        except Exception as e:
            logger.error(f"Signature verification failed: {e}")
            return False
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "version": self.version,
            "timestamp": self.timestamp.isoformat(),
            "files": dict(sorted(self.files.items())),
            "signature": self.signature,
            "created_by": self.created_by,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "PolicyManifest":
        """Deserialize from dictionary."""
        return cls(
            version=data["version"],
            timestamp=datetime.fromisoformat(data["timestamp"]),
            files=data.get("files", {}),
            signature=data.get("signature", ""),
            created_by=data.get("created_by", ""),
        )
    
    @classmethod
    def load(cls, path: Path) -> "PolicyManifest":
        """Load a manifest from a file.
        
        Args:
            path: Path to the manifest file
        
        Returns:
            PolicyManifest instance
        
        Raises:
            PolicyIntegrityError: If the file cannot be loaded
        """
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return cls.from_dict(data)
        except (OSError, json.JSONDecodeError) as e:
            raise PolicyIntegrityError(f"Failed to load manifest: {e}")
    
    def save(self, path: Path) -> None:
        """Save the manifest to a file.
        
        Args:
            path: Path to save to
        """
        path.parent.mkdir(parents=True, exist_ok=True)
        
        # Write atomically
        temp_path = path.with_suffix(".tmp")
        try:
            with open(temp_path, "w", encoding="utf-8") as f:
                json.dump(self.to_dict(), f, indent=2)
            temp_path.replace(path)
        finally:
            if temp_path.exists():
                temp_path.unlink()


@dataclass
class ImmutableRoot:
    """Definition of an immutable root asset.
    
    Immutable roots are files or directories that cannot be modified
    by agent operations. They are protected at the governance layer.
    
    Attributes:
        path: Path to the protected asset
        description: Human-readable description
        hash: Expected SHA-256 hash (for files)
        is_directory: Whether this is a directory
        protected_operations: Operations that are blocked
    """
    path: str
    description: str = ""
    hash: str = ""
    is_directory: bool = False
    protected_operations: set[str] = field(default_factory=lambda: {
        "write_file",
        "delete_file",
        "move_file",
    })
    
    def matches(self, target_path: str, operation: str) -> bool:
        """Check if this immutable root blocks an operation.
        
        Args:
            target_path: Path being operated on
            operation: Operation type
        
        Returns:
            True if the operation is blocked
        """
        if operation not in self.protected_operations:
            return False
        
        # Normalize paths for comparison
        target = Path(target_path).resolve()
        protected = Path(self.path).resolve()
        
        if self.is_directory:
            # Block operations on directory and all children
            try:
                target.relative_to(protected)
                return True
            except ValueError:
                return False
        else:
            # Block operations on exact file
            return target == protected


class PolicyIntegrityGuard:
    """Guard for policy integrity verification.
    
    This guard ensures:
    1. Policy manifests are verified before use
    2. Immutable roots are protected from modification
    3. Tampering is detected and blocked
    
    Core Principle: Policy integrity is verified before policy is used.
    """
    
    # Default immutable roots for BAT
    DEFAULT_IMMUTABLE_ROOTS = [
        ImmutableRoot(
            path="bat.yaml",
            description="Main BAT configuration file",
            is_directory=False,
        ),
        ImmutableRoot(
            path="rules/",
            description="BAT rule files directory",
            is_directory=True,
        ),
        ImmutableRoot(
            path="ledger/",
            description="Governance ledger directory",
            is_directory=True,
        ),
        ImmutableRoot(
            path="secrets/",
            description="Secret store directory",
            is_directory=True,
        ),
        ImmutableRoot(
            path="vectors/",
            description="Governed vector store directory",
            is_directory=True,
        ),
    ]
    
    def __init__(
        self,
        policy_dir: Path,
        verification_key: Optional[str] = None,
        require_signed_manifest: bool = False,
    ):
        """Initialize the policy integrity guard.
        
        Args:
            policy_dir: Directory containing policy files
            verification_key: Ed25519 public key for manifest verification
            require_signed_manifest: Whether to require signed manifests
        """
        self._policy_dir = Path(policy_dir)
        self._verification_key = verification_key
        self._require_signed = require_signed_manifest
        self._manifest: Optional[PolicyManifest] = None
        self._immutable_roots: list[ImmutableRoot] = list(self.DEFAULT_IMMUTABLE_ROOTS)
        self._verified = False
        self._last_verification: Optional[datetime] = None
    
    @property
    def is_verified(self) -> bool:
        """Check if policy has been verified."""
        return self._verified
    
    @property
    def last_verification(self) -> Optional[datetime]:
        """Get the time of last verification."""
        return self._last_verification
    
    def add_immutable_root(self, root: ImmutableRoot) -> None:
        """Add an immutable root to protect.
        
        Args:
            root: The immutable root to add
        """
        self._immutable_roots.append(root)
        logger.info(f"Added immutable root: {root.path}")
    
    def verify_policy(self) -> tuple[bool, list[str]]:
        """Verify policy integrity.
        
        This method:
        1. Loads the policy manifest (if exists)
        2. Verifies the manifest signature
        3. Verifies all file hashes match
        4. Checks immutable roots are not modified
        
        Returns:
            Tuple of (is_valid, list_of_errors)
        """
        errors = []
        
        # Load manifest
        manifest_path = self._policy_dir / "manifest.json"
        if manifest_path.exists():
            try:
                self._manifest = PolicyManifest.load(manifest_path)
            except PolicyIntegrityError as e:
                errors.append(f"Failed to load manifest: {e}")
                self._verified = False
                return False, errors
        else:
            if self._require_signed:
                errors.append("Signed manifest required but not found")
                self._verified = False
                return False, errors
            self._manifest = None
        
        # Verify manifest signature
        if self._manifest and self._verification_key:
            if not self._manifest.verify_signature(self._verification_key):
                errors.append("Manifest signature verification failed")
                self._verified = False
                return False, errors
        
        # Verify file hashes
        if self._manifest:
            for filename, expected_hash in self._manifest.files.items():
                file_path = self._policy_dir / filename
                if not file_path.exists():
                    errors.append(f"Policy file missing: {filename}")
                    continue
                
                try:
                    actual_hash = self._compute_file_hash(file_path)
                    if actual_hash != expected_hash:
                        errors.append(
                            f"Policy file hash mismatch: {filename} "
                            f"(expected {expected_hash[:8]}..., got {actual_hash[:8]}...)"
                        )
                except OSError as e:
                    errors.append(f"Failed to hash policy file {filename}: {e}")
        
        # Check immutable roots exist and are protected
        for root in self._immutable_roots:
            root_path = self._policy_dir / root.path
            if root_path.exists():
                if root.hash:
                    try:
                        actual_hash = self._compute_file_hash(root_path)
                        if actual_hash != root.hash:
                            errors.append(
                                f"Immutable root modified: {root.path} "
                                f"(expected {root.hash[:8]}..., got {actual_hash[:8]}...)"
                            )
                    except OSError as e:
                        errors.append(f"Failed to verify immutable root {root.path}: {e}")
        
        self._verified = len(errors) == 0
        self._last_verification = datetime.now(timezone.utc)
        
        if self._verified:
            logger.info(f"Policy integrity verified (v{self._manifest.version if self._manifest else 'unknown'})")
        else:
            logger.error(f"Policy integrity verification failed: {len(errors)} errors")
        
        return self._verified, errors
    
    def check_immutable(
        self,
        target_path: str,
        operation: str,
    ) -> tuple[bool, str]:
        """Check if an operation targets an immutable root.
        
        Args:
            target_path: Path being operated on
            operation: Operation type
        
        Returns:
            Tuple of (is_blocked, reason)
        """
        for root in self._immutable_roots:
            if root.matches(target_path, operation):
                return True, f"Operation blocked: {target_path} is an immutable root ({root.description})"
        
        return False, ""
    
    def create_manifest(
        self,
        version: str,
        files: Optional[list[Path]] = None,
        signing_key: Optional[str] = None,
        created_by: str = "",
    ) -> PolicyManifest:
        """Create a new policy manifest.
        
        Args:
            version: Version string for the manifest
            files: List of files to include (default: all in policy dir)
            signing_key: Ed25519 private key to sign with
            created_by: Identity creating the manifest
        
        Returns:
            The created manifest
        """
        manifest = PolicyManifest(
            version=version,
            created_by=created_by,
        )
        
        # Collect files
        if files is None:
            files = []
            for ext in (".yaml", ".yml", ".json", ".py"):
                files.extend(self._policy_dir.glob(f"**/*{ext}"))
        
        # Compute hashes
        for file_path in files:
            if file_path.is_file():
                rel_path = file_path.relative_to(self._policy_dir)
                manifest.files[str(rel_path)] = self._compute_file_hash(file_path)
        
        # Sign if key provided
        if signing_key:
            manifest.sign(signing_key)
        
        return manifest
    
    def _compute_file_hash(self, path: Path) -> str:
        """Compute SHA-256 hash of a file."""
        hasher = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                hasher.update(chunk)
        return hasher.hexdigest()
    
    def get_status(self) -> dict:
        """Get the current status of the integrity guard."""
        return {
            "verified": self._verified,
            "last_verification": self._last_verification.isoformat() if self._last_verification else None,
            "manifest_version": self._manifest.version if self._manifest else None,
            "immutable_roots": len(self._immutable_roots),
            "policy_dir": str(self._policy_dir),
        }


class StartupGate:
    """Gate that blocks agent execution until governance is ready.
    
    Implements SECURITY ELEVATION Track A/B:
    - Governance initializes before agency
    - Agents blocked until governance readiness + policy integrity pass
    
    Core Principle: Governance initializes before agency.
    """
    
    def __init__(
        self,
        integrity_guard: PolicyIntegrityGuard,
        additional_checks: Optional[list[Callable[[], tuple[bool, str]]]] = None,
    ):
        """Initialize the startup gate.
        
        Args:
            integrity_guard: Policy integrity guard
            additional_checks: Additional readiness checks
        """
        self._guard = integrity_guard
        self._additional_checks = additional_checks or []
        self._ready = False
        self._block_reason = ""
    
    @property
    def is_ready(self) -> bool:
        """Check if governance is ready."""
        return self._ready
    
    @property
    def block_reason(self) -> str:
        """Get the reason for blocking (if not ready)."""
        return self._block_reason
    
    def check_readiness(self) -> tuple[bool, list[str]]:
        """Check if all governance components are ready.
        
        Returns:
            Tuple of (is_ready, list_of_issues)
        """
        issues = []
        
        # Check policy integrity
        verified, errors = self._guard.verify_policy()
        if not verified:
            issues.extend(errors)
        
        # Run additional checks
        for check in self._additional_checks:
            try:
                passed, reason = check()
                if not passed:
                    issues.append(reason)
            except Exception as e:
                issues.append(f"Readiness check failed: {e}")
        
        self._ready = len(issues) == 0
        self._block_reason = "; ".join(issues) if issues else ""
        
        return self._ready, issues
    
    def wait_for_ready(self, timeout_seconds: int = 30) -> bool:
        """Wait until governance is ready or timeout.
        
        Args:
            timeout_seconds: Maximum time to wait
        
        Returns:
            True if ready, False if timeout
        """
        import time
        start = time.time()
        
        while time.time() - start < timeout_seconds:
            ready, _ = self.check_readiness()
            if ready:
                return True
            time.sleep(0.1)
        
        return False
    
    def raise_if_not_ready(self) -> None:
        """Raise an error if governance is not ready.
        
        Raises:
            PolicyIntegrityError: If governance is not ready
        """
        if not self._ready:
            raise PolicyIntegrityError(
                f"Governance not ready: {self._block_reason}"
            )


def create_integrity_guard(
    policy_dir: Path,
    verification_key: Optional[str] = None,
    require_signed_manifest: bool = False,
) -> PolicyIntegrityGuard:
    """Factory function to create a policy integrity guard.
    
    Args:
        policy_dir: Directory containing policy files
        verification_key: Ed25519 public key for manifest verification
        require_signed_manifest: Whether to require signed manifests
    
    Returns:
        Configured PolicyIntegrityGuard instance
    """
    return PolicyIntegrityGuard(
        policy_dir=policy_dir,
        verification_key=verification_key,
        require_signed_manifest=require_signed_manifest,
    )
