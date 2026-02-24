"""
Remote Policy Distribution for Enterprise Governance.

Implements Phase 4 Enterprise:
- Central policy server for distribution
- Remote policy client with caching
- Signature verification for server responses
- Fallback to local policies

Core Principle: Policies can be distributed securely across nodes.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from enum import Enum
from pathlib import Path
from typing import Optional
import hashlib
import hmac
import json
import logging
import threading
import urllib.request
import urllib.error
import ssl

logger = logging.getLogger(__name__)


class PolicySource(str, Enum):
    """Source of a policy."""
    LOCAL = "local"
    REMOTE = "remote"
    CACHE = "cache"
    FALLBACK = "fallback"


@dataclass
class RemotePolicyResponse:
    """Response from a remote policy server.
    
    Attributes:
        policy_content: The policy YAML/JSON content
        version: Policy version string
        signature: Server signature
        hash: Content hash
        server_timestamp: When the server generated this response
        server_id: Server identifier
        expires_at: When this response expires
    """
    policy_content: str
    version: str
    signature: str
    hash: str
    server_timestamp: datetime
    server_id: str
    expires_at: datetime
    
    def to_dict(self) -> dict:
        """Serialize to dictionary."""
        return {
            "policy_content": self.policy_content,
            "version": self.version,
            "signature": self.signature,
            "hash": self.hash,
            "server_timestamp": self.server_timestamp.isoformat(),
            "server_id": self.server_id,
            "expires_at": self.expires_at.isoformat(),
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "RemotePolicyResponse":
        """Deserialize from dictionary."""
        return cls(
            policy_content=data["policy_content"],
            version=data["version"],
            signature=data["signature"],
            hash=data["hash"],
            server_timestamp=datetime.fromisoformat(data["server_timestamp"]),
            server_id=data["server_id"],
            expires_at=datetime.fromisoformat(data["expires_at"]),
        )
    
    def is_expired(self) -> bool:
        """Check if the response has expired."""
        return datetime.now(timezone.utc) > self.expires_at


@dataclass
class CachedPolicy:
    """A cached policy entry.
    
    Attributes:
        response: The cached remote response
        cached_at: When this was cached
        source: Where the policy came from
        etag: ETag for conditional requests
    """
    response: RemotePolicyResponse
    cached_at: datetime
    source: PolicySource
    etag: str = ""
    
    def is_fresh(self, max_age: timedelta) -> bool:
        """Check if the cache entry is still fresh."""
        return datetime.now(timezone.utc) - self.cached_at < max_age


class RemotePolicyClient:
    """Client for fetching policies from a remote server.
    
    Features:
    - Signature verification for all responses
    - Local caching with configurable TTL
    - Automatic fallback to local policies
    - Conditional requests with ETags
    """
    
    DEFAULT_TIMEOUT = 30  # seconds
    DEFAULT_CACHE_TTL = timedelta(hours=1)
    
    def __init__(
        self,
        server_url: str,
        verification_key: bytes,
        cache_path: Optional[Path] = None,
        local_fallback_path: Optional[Path] = None,
        cache_ttl: timedelta = DEFAULT_CACHE_TTL,
        timeout: int = DEFAULT_TIMEOUT,
    ):
        """Initialize the remote policy client.
        
        Args:
            server_url: Base URL of the policy server
            verification_key: Key for verifying server signatures
            cache_path: Path for local cache storage
            local_fallback_path: Path to local fallback policies
            cache_ttl: Time-to-live for cached policies
            timeout: Request timeout in seconds
        """
        self._server_url = server_url.rstrip("/")
        self._verification_key = verification_key
        self._cache_path = cache_path
        self._fallback_path = local_fallback_path
        self._cache_ttl = cache_ttl
        self._timeout = timeout
        self._lock = threading.RLock()
        
        # In-memory cache
        self._cache: dict[str, CachedPolicy] = {}
        
        # Load disk cache if available
        if self._cache_path:
            self._load_disk_cache()
    
    def get_policy(
        self,
        policy_name: str = "default",
        version: Optional[str] = None,
    ) -> tuple[str, PolicySource]:
        """Get a policy, checking cache, remote, and fallback.
        
        Args:
            policy_name: Name of the policy to fetch
            version: Specific version (None for latest)
        
        Returns:
            Tuple of (policy_content, source)
        """
        with self._lock:
            cache_key = f"{policy_name}:{version or 'latest'}"
            
            # Check in-memory cache
            if cache_key in self._cache:
                cached = self._cache[cache_key]
                if cached.is_fresh(self._cache_ttl) and not cached.response.is_expired():
                    logger.debug(f"Policy {policy_name} served from cache")
                    return cached.response.policy_content, PolicySource.CACHE
            
            # Try remote
            try:
                content, response = self._fetch_remote(policy_name, version)
                
                # Cache the response
                self._cache[cache_key] = CachedPolicy(
                    response=response,
                    cached_at=datetime.now(timezone.utc),
                    source=PolicySource.REMOTE,
                    etag=response.hash,
                )
                self._save_disk_cache()
                
                logger.info(f"Policy {policy_name} fetched from remote server")
                return content, PolicySource.REMOTE
            
            except Exception as e:
                logger.warning(f"Failed to fetch policy from remote: {e}")
            
            # Try fallback
            if self._fallback_path:
                fallback_content = self._load_fallback(policy_name)
                if fallback_content:
                    logger.warning(f"Policy {policy_name} served from local fallback")
                    return fallback_content, PolicySource.FALLBACK
            
            raise RuntimeError(f"Could not fetch policy: {policy_name}")
    
    def get_policy_metadata(
        self,
        policy_name: str = "default",
    ) -> Optional[dict]:
        """Get metadata about a policy without the content.
        
        Args:
            policy_name: Name of the policy
        
        Returns:
            Policy metadata or None
        """
        try:
            url = f"{self._server_url}/policies/{policy_name}/metadata"
            
            req = urllib.request.Request(url, method="GET")
            req.add_header("Accept", "application/json")
            
            with urllib.request.urlopen(req, timeout=self._timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
                return data
        
        except Exception as e:
            logger.warning(f"Failed to fetch policy metadata: {e}")
            return None
    
    def list_policies(self) -> list[dict]:
        """List available policies on the server.
        
        Returns:
            List of policy metadata
        """
        try:
            url = f"{self._server_url}/policies"
            
            req = urllib.request.Request(url, method="GET")
            req.add_header("Accept", "application/json")
            
            with urllib.request.urlopen(req, timeout=self._timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
                return data.get("policies", [])
        
        except Exception as e:
            logger.warning(f"Failed to list policies: {e}")
            return []
    
    def refresh_cache(self) -> int:
        """Refresh all cached policies.
        
        Returns:
            Number of policies refreshed
        """
        refreshed = 0
        
        for cache_key in list(self._cache.keys()):
            policy_name, version = cache_key.rsplit(":", 1)
            version = None if version == "latest" else version
            
            try:
                content, response = self._fetch_remote(policy_name, version)
                self._cache[cache_key] = CachedPolicy(
                    response=response,
                    cached_at=datetime.now(timezone.utc),
                    source=PolicySource.REMOTE,
                    etag=response.hash,
                )
                refreshed += 1
            except Exception as e:
                logger.warning(f"Failed to refresh {cache_key}: {e}")
        
        self._save_disk_cache()
        return refreshed
    
    def clear_cache(self) -> None:
        """Clear the policy cache."""
        with self._lock:
            self._cache.clear()
            if self._cache_path:
                cache_file = self._cache_path / "policy_cache.json"
                if cache_file.exists():
                    cache_file.unlink()
            logger.info("Policy cache cleared")
    
    def _fetch_remote(
        self,
        policy_name: str,
        version: Optional[str] = None,
    ) -> tuple[str, RemotePolicyResponse]:
        """Fetch a policy from the remote server.
        
        Args:
            policy_name: Name of the policy
            version: Specific version or None for latest
        
        Returns:
            Tuple of (content, response)
        """
        if version:
            url = f"{self._server_url}/policies/{policy_name}/versions/{version}"
        else:
            url = f"{self._server_url}/policies/{policy_name}"
        
        req = urllib.request.Request(url, method="GET")
        req.add_header("Accept", "application/json")
        
        # Add conditional request headers if we have an etag
        cache_key = f"{policy_name}:{version or 'latest'}"
        if cache_key in self._cache:
            req.add_header("If-None-Match", self._cache[cache_key].etag)
        
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
                remote_response = RemotePolicyResponse.from_dict(data)
                
                # Verify signature
                if not self._verify_response(remote_response):
                    raise ValueError("Server signature verification failed")
                
                return remote_response.policy_content, remote_response
        
        except urllib.error.HTTPError as e:
            if e.code == 304:
                # Not modified - use cached version
                if cache_key in self._cache:
                    cached = self._cache[cache_key]
                    return cached.response.policy_content, cached.response
            raise
    
    def _verify_response(self, response: RemotePolicyResponse) -> bool:
        """Verify the signature of a remote response."""
        # Verify hash
        expected_hash = hashlib.sha256(response.policy_content.encode()).hexdigest()
        if response.hash != expected_hash:
            logger.warning("Policy hash mismatch")
            return False
        
        # Verify signature
        sig_data = f"{response.hash}:{response.version}:{response.server_id}:{response.server_timestamp.isoformat()}"
        expected_sig = hmac.new(
            self._verification_key,
            sig_data.encode(),
            hashlib.sha256
        ).hexdigest()
        
        if not hmac.compare_digest(response.signature, expected_sig):
            logger.warning("Policy signature verification failed")
            return False
        
        return True
    
    def _load_fallback(self, policy_name: str) -> Optional[str]:
        """Load a local fallback policy."""
        if not self._fallback_path:
            return None
        
        # Try multiple extensions
        for ext in (".yaml", ".yml", ".json"):
            path = self._fallback_path / f"{policy_name}{ext}"
            if path.exists():
                return path.read_text(encoding="utf-8")
        
        return None
    
    def _load_disk_cache(self) -> None:
        """Load cache from disk."""
        if not self._cache_path:
            return
        
        cache_file = self._cache_path / "policy_cache.json"
        if not cache_file.exists():
            return
        
        try:
            data = json.loads(cache_file.read_text())
            for key, entry in data.items():
                self._cache[key] = CachedPolicy(
                    response=RemotePolicyResponse.from_dict(entry["response"]),
                    cached_at=datetime.fromisoformat(entry["cached_at"]),
                    source=PolicySource(entry.get("source", "remote")),
                    etag=entry.get("etag", ""),
                )
            logger.debug(f"Loaded {len(self._cache)} cached policies")
        except Exception as e:
            logger.warning(f"Failed to load disk cache: {e}")
    
    def _save_disk_cache(self) -> None:
        """Save cache to disk."""
        if not self._cache_path:
            return
        
        self._cache_path.mkdir(parents=True, exist_ok=True)
        cache_file = self._cache_path / "policy_cache.json"
        
        data = {}
        for key, entry in self._cache.items():
            data[key] = {
                "response": entry.response.to_dict(),
                "cached_at": entry.cached_at.isoformat(),
                "source": entry.source.value,
                "etag": entry.etag,
            }
        
        cache_file.write_text(json.dumps(data, indent=2))


class PolicyServer:
    """Simple policy server for central distribution.
    
    Provides a basic HTTP server for distributing signed policies.
    In production, this would be replaced with a proper web server
    or API gateway.
    """
    
    def __init__(
        self,
        policy_store_path: Path,
        signing_key: bytes,
        server_id: str,
        default_expiry_hours: int = 24,
    ):
        """Initialize the policy server.
        
        Args:
            policy_store_path: Path to policy store
            signing_key: Key for signing responses
            server_id: Server identifier
            default_expiry_hours: Hours until responses expire
        """
        self._store_path = Path(policy_store_path)
        self._signing_key = signing_key
        self._server_id = server_id
        self._default_expiry = timedelta(hours=default_expiry_hours)
    
    def get_policy(self, policy_name: str) -> Optional[dict]:
        """Get a policy and create a signed response.
        
        Args:
            policy_name: Name of the policy
        
        Returns:
            Signed response dictionary or None
        """
        # Find policy file
        policy_file = None
        for ext in (".yaml", ".yml", ".json"):
            path = self._store_path / f"{policy_name}{ext}"
            if path.exists():
                policy_file = path
                break
        
        if not policy_file:
            return None
        
        content = policy_file.read_text(encoding="utf-8")
        
        # Get version from metadata or hash
        version = self._get_version(policy_name)
        
        # Create signed response
        response = self._create_signed_response(content, version)
        
        return response.to_dict()
    
    def get_policy_version(self, policy_name: str, version: str) -> Optional[dict]:
        """Get a specific policy version.
        
        Args:
            policy_name: Name of the policy
            version: Version string
        
        Returns:
            Signed response dictionary or None
        """
        # Look for versioned file
        versioned_file = self._store_path / policy_name / f"{version}.yaml"
        if not versioned_file.exists():
            versioned_file = self._store_path / policy_name / f"{version}.json"
        
        if not versioned_file.exists():
            return None
        
        content = versioned_file.read_text(encoding="utf-8")
        response = self._create_signed_response(content, version)
        
        return response.to_dict()
    
    def get_metadata(self, policy_name: str) -> Optional[dict]:
        """Get policy metadata without content.
        
        Args:
            policy_name: Name of the policy
        
        Returns:
            Metadata dictionary or None
        """
        # Find policy file
        policy_file = None
        for ext in (".yaml", ".yml", ".json"):
            path = self._store_path / f"{policy_name}{ext}"
            if path.exists():
                policy_file = path
                break
        
        if not policy_file:
            return None
        
        content = policy_file.read_text(encoding="utf-8")
        version = self._get_version(policy_name)
        hash_val = hashlib.sha256(content.encode()).hexdigest()
        
        return {
            "name": policy_name,
            "version": version,
            "hash": hash_val[:16],
            "size": len(content),
        }
    
    def list_policies(self) -> dict:
        """List all available policies.
        
        Returns:
            Dictionary with list of policies
        """
        policies = []
        
        for ext in (".yaml", ".yml", ".json"):
            for path in self._store_path.glob(f"*{ext}"):
                name = path.stem
                policies.append(self.get_metadata(name))
        
        return {"policies": [p for p in policies if p]}
    
    def _create_signed_response(
        self,
        content: str,
        version: str,
    ) -> RemotePolicyResponse:
        """Create a signed response for policy content."""
        hash_val = hashlib.sha256(content.encode()).hexdigest()
        timestamp = datetime.now(timezone.utc)
        expires = timestamp + self._default_expiry
        
        # Create signature
        sig_data = f"{hash_val}:{version}:{self._server_id}:{timestamp.isoformat()}"
        signature = hmac.new(
            self._signing_key,
            sig_data.encode(),
            hashlib.sha256
        ).hexdigest()
        
        return RemotePolicyResponse(
            policy_content=content,
            version=version,
            signature=signature,
            hash=hash_val,
            server_timestamp=timestamp,
            server_id=self._server_id,
            expires_at=expires,
        )
    
    def _get_version(self, policy_name: str) -> str:
        """Get the version of a policy."""
        # Check for version file
        version_file = self._store_path / f"{policy_name}.version"
        if version_file.exists():
            return version_file.read_text().strip()
        
        # Default to timestamp-based version
        return datetime.now(timezone.utc).strftime("%Y%m%d")


def create_remote_client(
    server_url: str,
    verification_key: bytes,
    cache_path: Optional[Path] = None,
    fallback_path: Optional[Path] = None,
) -> RemotePolicyClient:
    """Factory function to create a remote policy client.
    
    Args:
        server_url: URL of the policy server
        verification_key: Key for verifying signatures
        cache_path: Path for cache storage
        fallback_path: Path to local fallback policies
    
    Returns:
        Configured RemotePolicyClient instance
    """
    return RemotePolicyClient(
        server_url=server_url,
        verification_key=verification_key,
        cache_path=cache_path,
        local_fallback_path=fallback_path,
    )


def create_policy_server(
    policy_store_path: Path,
    signing_key: bytes,
    server_id: str,
) -> PolicyServer:
    """Factory function to create a policy server.
    
    Args:
        policy_store_path: Path to policy store
        signing_key: Key for signing responses
        server_id: Server identifier
    
    Returns:
        Configured PolicyServer instance
    """
    return PolicyServer(
        policy_store_path=policy_store_path,
        signing_key=signing_key,
        server_id=server_id,
    )
