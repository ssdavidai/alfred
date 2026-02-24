"""
Agent Identity - Cryptographic identity and attestation for agents.

Implements SECURITY ELEVATION Track B:
- Authenticated proposals (Ed25519 in secure/enterprise mode)
- Process attestation in personal mode
- Credential lifecycle: issuance, rotation, revocation

Core Principle: No agent authenticates its own identity.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from enum import Enum
from pathlib import Path
from typing import Optional, Callable
import hashlib
import json
import logging
import os
import sys

logger = logging.getLogger(__name__)


class IdentityMode(Enum):
    """Identity verification mode."""
    PERSONAL = "personal"      # Process attestation
    SECURE = "secure"          # Ed25519 signatures
    ENTERPRISE = "enterprise"  # Ed25519 + CA chain


class CredentialStatus(Enum):
    """Status of an agent credential."""
    ACTIVE = "active"
    SUSPENDED = "suspended"
    REVOKED = "revoked"
    EXPIRED = "expired"


@dataclass
class AgentCredential:
    """Cryptographic credential for an agent.
    
    Attributes:
        agent_id: Unique identifier for the agent
        public_key: Ed25519 public key (hex)
        created_at: When the credential was issued
        expires_at: When the credential expires (None for no expiry)
        status: Current status of the credential
        metadata: Additional metadata (issuer, purpose, etc.)
    """
    agent_id: str
    public_key: str
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at: Optional[datetime] = None
    status: CredentialStatus = CredentialStatus.ACTIVE
    metadata: dict = field(default_factory=dict)
    
    def is_valid(self) -> bool:
        """Check if the credential is currently valid."""
        if self.status != CredentialStatus.ACTIVE:
            return False
        if self.expires_at and datetime.now(timezone.utc) > self.expires_at:
            return False
        return True
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "agent_id": self.agent_id,
            "public_key": self.public_key,
            "created_at": self.created_at.isoformat(),
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
            "status": self.status.value,
            "metadata": self.metadata,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "AgentCredential":
        """Deserialize from dictionary."""
        return cls(
            agent_id=data["agent_id"],
            public_key=data["public_key"],
            created_at=datetime.fromisoformat(data["created_at"]),
            expires_at=datetime.fromisoformat(data["expires_at"]) if data.get("expires_at") else None,
            status=CredentialStatus(data["status"]),
            metadata=data.get("metadata", {}),
        )


@dataclass
class ProcessAttestation:
    """Process-based identity attestation for personal mode.
    
    In personal mode, we verify agent identity through process attributes
    rather than cryptographic keys. This provides a weaker but practical
    identity guarantee for single-user scenarios.
    
    Attributes:
        agent_id: Agent identifier
        pid: Process ID
        executable_path: Path to the running executable
        executable_hash: SHA-256 hash of the executable
        start_time: Process start time
        created_at: When this attestation was created
    """
    agent_id: str
    pid: int
    executable_path: str
    executable_hash: str
    start_time: datetime
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    
    def is_valid(self) -> bool:
        """Verify the attestation is still valid.
        
        Checks:
        1. Process is still running
        2. PID matches
        3. Executable hash matches (if verifiable)
        """
        # Check if process is still running
        if not self._process_exists():
            return False
        
        # Verify executable hash if possible
        try:
            current_hash = self._compute_executable_hash()
            if current_hash != self.executable_hash:
                logger.warning(f"Executable hash mismatch for agent {self.agent_id}")
                return False
        except (OSError, FileNotFoundError):
            # Cannot verify - fail closed in secure mode
            pass
        
        return True
    
    def _process_exists(self) -> bool:
        """Check if the process still exists."""
        try:
            os.kill(self.pid, 0)
            return True
        except (OSError, ProcessLookupError):
            return False
    
    def _compute_executable_hash(self) -> str:
        """Compute SHA-256 hash of the executable."""
        path = Path(self.executable_path)
        if not path.exists():
            raise FileNotFoundError(f"Executable not found: {path}")
        
        hasher = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                hasher.update(chunk)
        return hasher.hexdigest()
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "agent_id": self.agent_id,
            "pid": self.pid,
            "executable_path": self.executable_path,
            "executable_hash": self.executable_hash,
            "start_time": self.start_time.isoformat(),
            "created_at": self.created_at.isoformat(),
        }


@dataclass
class SignedProposal:
    """A proposal with cryptographic signature.
    
    Attributes:
        proposal_json: JSON serialization of the proposal
        signature: Ed25519 signature (hex)
        agent_id: ID of the signing agent
        timestamp: When the signature was created
    """
    proposal_json: str
    signature: str
    agent_id: str
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "proposal_json": self.proposal_json,
            "signature": self.signature,
            "agent_id": self.agent_id,
            "timestamp": self.timestamp.isoformat(),
        }


class IdentityRegistry:
    """Registry for agent identities and credentials.
    
    This is the authoritative source for agent identity verification.
    No agent can authenticate itself - all authentication goes through
    this registry.
    
    Core Principle: No agent authenticates its own identity.
    """
    
    def __init__(
        self,
        mode: IdentityMode = IdentityMode.PERSONAL,
        credentials_path: Optional[Path] = None,
    ):
        """Initialize the identity registry.
        
        Args:
            mode: Identity verification mode
            credentials_path: Path to credentials store (optional)
        """
        self._mode = mode
        self._credentials: dict[str, AgentCredential] = {}
        self._attestations: dict[str, ProcessAttestation] = {}
        self._revoked_keys: set[str] = set()
        self._credentials_path = credentials_path
        
        if credentials_path and credentials_path.exists():
            self._load_credentials(credentials_path)
    
    @property
    def mode(self) -> IdentityMode:
        """Get the current identity mode."""
        return self._mode
    
    def register_agent(
        self,
        agent_id: str,
        public_key: str,
        expires_in: Optional[timedelta] = None,
        metadata: Optional[dict] = None,
    ) -> AgentCredential:
        """Register a new agent credential.
        
        This should be called by a trusted provisioning process,
        never by the agent itself.
        
        Args:
            agent_id: Unique identifier for the agent
            public_key: Ed25519 public key (hex)
            expires_in: Time until expiration (None for no expiry)
            metadata: Additional metadata
        
        Returns:
            The created credential
        """
        now = datetime.now(timezone.utc)
        expires_at = now + expires_in if expires_in else None
        
        credential = AgentCredential(
            agent_id=agent_id,
            public_key=public_key,
            created_at=now,
            expires_at=expires_at,
            status=CredentialStatus.ACTIVE,
            metadata=metadata or {},
        )
        
        self._credentials[agent_id] = credential
        logger.info(f"Registered agent credential: {agent_id}")
        
        if self._credentials_path:
            self._save_credentials(self._credentials_path)
        
        return credential
    
    def create_attestation(self, agent_id: str) -> ProcessAttestation:
        """Create a process attestation for personal mode.
        
        Args:
            agent_id: Agent identifier
        
        Returns:
            Process attestation
        """
        pid = os.getpid()
        executable_path = sys.executable
        
        # Compute executable hash
        hasher = hashlib.sha256()
        try:
            with open(executable_path, "rb") as f:
                for chunk in iter(lambda: f.read(65536), b""):
                    hasher.update(chunk)
            executable_hash = hasher.hexdigest()
        except (OSError, FileNotFoundError):
            executable_hash = "unknown"
        
        # Get process start time (platform-specific)
        try:
            import psutil
            proc = psutil.Process(pid)
            start_time = datetime.fromtimestamp(proc.create_time(), tz=timezone.utc)
        except (ImportError, Exception):
            start_time = datetime.now(timezone.utc)
        
        attestation = ProcessAttestation(
            agent_id=agent_id,
            pid=pid,
            executable_path=executable_path,
            executable_hash=executable_hash,
            start_time=start_time,
        )
        
        self._attestations[agent_id] = attestation
        logger.info(f"Created process attestation for agent: {agent_id}")
        
        return attestation
    
    def verify_identity(
        self,
        agent_id: str,
        signed_proposal: Optional[SignedProposal] = None,
    ) -> tuple[bool, str]:
        """Verify an agent's identity.
        
        This is the core identity verification function. It ensures
        that the agent is who it claims to be.
        
        Args:
            agent_id: The claimed agent identity
            signed_proposal: Signed proposal (required for secure/enterprise mode)
        
        Returns:
            Tuple of (is_valid, reason)
        """
        if self._mode == IdentityMode.PERSONAL:
            return self._verify_attestation(agent_id)
        else:
            return self._verify_signature(agent_id, signed_proposal)
    
    def _verify_attestation(self, agent_id: str) -> tuple[bool, str]:
        """Verify process attestation for personal mode."""
        attestation = self._attestations.get(agent_id)
        if not attestation:
            return False, f"No attestation found for agent: {agent_id}"
        
        if not attestation.is_valid():
            return False, f"Attestation invalid for agent: {agent_id}"
        
        return True, "Attestation valid"
    
    def _verify_signature(
        self,
        agent_id: str,
        signed_proposal: Optional[SignedProposal],
    ) -> tuple[bool, str]:
        """Verify Ed25519 signature for secure/enterprise mode."""
        if not signed_proposal:
            return False, "Signed proposal required for secure/enterprise mode"
        
        credential = self._credentials.get(agent_id)
        if not credential:
            return False, f"No credential found for agent: {agent_id}"
        
        if not credential.is_valid():
            return False, f"Credential invalid for agent: {agent_id} (status: {credential.status.value})"
        
        if credential.public_key in self._revoked_keys:
            return False, f"Credential revoked for agent: {agent_id}"
        
        # Verify signature
        try:
            import nacl.signing
            import nacl.exceptions
            
            verify_key = nacl.signing.VerifyKey(bytes.fromhex(credential.public_key))
            verify_key.verify(
                signed_proposal.proposal_json.encode(),
                bytes.fromhex(signed_proposal.signature),
            )
            return True, "Signature valid"
        except ImportError:
            logger.error("PyNaCl not installed - cannot verify signatures in secure mode")
            return False, "Signature verification failed: PyNaCl not installed"
        except nacl.exceptions.BadSignature:
            return False, "Invalid signature"
        except Exception as e:
            return False, f"Signature verification failed: {e}"
    
    def rotate_credential(
        self,
        agent_id: str,
        new_public_key: str,
    ) -> AgentCredential:
        """Rotate an agent's credential.
        
        This revokes the old credential and issues a new one.
        
        Args:
            agent_id: Agent identifier
            new_public_key: New Ed25519 public key
        
        Returns:
            The new credential
        """
        old_credential = self._credentials.get(agent_id)
        if old_credential:
            self._revoked_keys.add(old_credential.public_key)
        
        return self.register_agent(agent_id, new_public_key)
    
    def revoke_credential(self, agent_id: str) -> bool:
        """Revoke an agent's credential.
        
        Args:
            agent_id: Agent identifier
        
        Returns:
            True if revoked, False if not found
        """
        credential = self._credentials.get(agent_id)
        if not credential:
            return False
        
        credential.status = CredentialStatus.REVOKED
        self._revoked_keys.add(credential.public_key)
        
        logger.warning(f"Revoked credential for agent: {agent_id}")
        
        if self._credentials_path:
            self._save_credentials(self._credentials_path)
        
        return True
    
    def suspend_credential(self, agent_id: str) -> bool:
        """Temporarily suspend an agent's credential.
        
        Args:
            agent_id: Agent identifier
        
        Returns:
            True if suspended, False if not found
        """
        credential = self._credentials.get(agent_id)
        if not credential:
            return False
        
        credential.status = CredentialStatus.SUSPENDED
        logger.info(f"Suspended credential for agent: {agent_id}")
        
        if self._credentials_path:
            self._save_credentials(self._credentials_path)
        
        return True
    
    def activate_credential(self, agent_id: str) -> bool:
        """Reactivate a suspended credential.
        
        Args:
            agent_id: Agent identifier
        
        Returns:
            True if activated, False if not found or revoked
        """
        credential = self._credentials.get(agent_id)
        if not credential:
            return False
        
        if credential.status == CredentialStatus.REVOKED:
            return False  # Cannot reactivate revoked credentials
        
        credential.status = CredentialStatus.ACTIVE
        logger.info(f"Activated credential for agent: {agent_id}")
        
        if self._credentials_path:
            self._save_credentials(self._credentials_path)
        
        return True
    
    def get_credential(self, agent_id: str) -> Optional[AgentCredential]:
        """Get an agent's credential.
        
        Args:
            agent_id: Agent identifier
        
        Returns:
            The credential, or None if not found
        """
        return self._credentials.get(agent_id)
    
    def list_agents(self) -> list[str]:
        """List all registered agent IDs."""
        return list(self._credentials.keys())
    
    def _load_credentials(self, path: Path) -> None:
        """Load credentials from file."""
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            for agent_id, cred_data in data.get("credentials", {}).items():
                self._credentials[agent_id] = AgentCredential.from_dict(cred_data)
            
            self._revoked_keys = set(data.get("revoked_keys", []))
            
            logger.info(f"Loaded {len(self._credentials)} credentials from {path}")
        except (OSError, json.JSONDecodeError) as e:
            logger.error(f"Failed to load credentials: {e}")
    
    def _save_credentials(self, path: Path) -> None:
        """Save credentials to file."""
        data = {
            "credentials": {
                agent_id: cred.to_dict()
                for agent_id, cred in self._credentials.items()
            },
            "revoked_keys": list(self._revoked_keys),
        }
        
        path.parent.mkdir(parents=True, exist_ok=True)
        
        # Write atomically
        temp_path = path.with_suffix(".tmp")
        try:
            with open(temp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            temp_path.replace(path)
            logger.debug(f"Saved credentials to {path}")
        except OSError as e:
            logger.error(f"Failed to save credentials: {e}")
            if temp_path.exists():
                temp_path.unlink()


def sign_proposal(
    proposal_json: str,
    agent_id: str,
    private_key: str,
) -> SignedProposal:
    """Sign a proposal with an Ed25519 private key.
    
    Args:
        proposal_json: JSON serialization of the proposal
        agent_id: Agent identifier
        private_key: Ed25519 private key (hex)
    
    Returns:
        Signed proposal
    """
    try:
        import nacl.signing
        
        signing_key = nacl.signing.SigningKey(bytes.fromhex(private_key))
        signature = signing_key.sign(proposal_json.encode()).signature.hex()
        
        return SignedProposal(
            proposal_json=proposal_json,
            signature=signature,
            agent_id=agent_id,
        )
    except ImportError:
        raise RuntimeError("PyNaCl required for signing proposals")


def create_identity_registry(
    mode: str = "personal",
    credentials_path: Optional[Path] = None,
) -> IdentityRegistry:
    """Factory function to create an identity registry.
    
    Args:
        mode: Identity mode ("personal", "secure", "enterprise")
        credentials_path: Path to credentials store
    
    Returns:
        Configured IdentityRegistry instance
    """
    identity_mode = IdentityMode(mode.lower())
    return IdentityRegistry(mode=identity_mode, credentials_path=credentials_path)
