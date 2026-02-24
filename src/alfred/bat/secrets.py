"""
Secret Backend - Secure secret storage interface.

Provides abstraction over secret storage backends:
- KeyringBackend: System keyring (default for desktop)
- EnvironmentBackend: Environment variables (for CI/CD)

Core Principle: Secrets are never stored in plaintext in the codebase.
"""

from abc import ABC, abstractmethod
from typing import Optional
import os
import logging


logger = logging.getLogger(__name__)


class SecretStorageError(Exception):
    """Raised when secret storage fails.

    This indicates a problem with the secret backend, not
    a missing secret (which returns None).
    """

    pass


class SecretBackend(ABC):
    """Abstract interface for secret storage.

    This interface provides a consistent API for secret storage
    regardless of the underlying backend.

    Implementations:
        - KeyringBackend: System keyring
        - EnvironmentBackend: Environment variables
    """

    @abstractmethod
    def get(self, key: str) -> Optional[str]:
        """Retrieve a secret.

        Args:
            key: The secret key/identifier

        Returns:
            The secret value, or None if not found
        """
        ...

    @abstractmethod
    def set(self, key: str, value: str) -> None:
        """Store a secret.

        Args:
            key: The secret key/identifier
            value: The secret value to store

        Raises:
            SecretStorageError: If storage fails
        """
        ...

    @abstractmethod
    def delete(self, key: str) -> None:
        """Delete a secret.

        Args:
            key: The secret key/identifier

        Note:
            This should not raise if the secret doesn't exist.
        """
        ...

    @abstractmethod
    def list_keys(self) -> list[str]:
        """List all stored secret keys.

        Returns:
            List of secret keys (not values)
        """
        ...

    @abstractmethod
    def is_available(self) -> bool:
        """Check if the backend is available.

        Returns:
            True if the backend can be used, False otherwise
        """
        ...


class KeyringBackend(SecretBackend):
    """System keyring backend using the keyring library.

    This backend uses the system's native secret storage:
    - macOS: Keychain
    - Linux: Secret Service (GNOME Keyring, KWallet)
    - Windows: Windows Credential Manager

    Example:
        >>> backend = KeyringBackend()
        >>> backend.set("api_key", "secret123")
        >>> backend.get("api_key")
        'secret123'
        >>> backend.delete("api_key")
    """

    SERVICE_NAME = "alfred-bat"

    def __init__(self):
        """Initialize the keyring backend.

        Raises:
            ImportError: If keyring is not installed
        """
        try:
            import keyring
            import keyring.errors
            self._keyring = keyring
            self._errors = keyring.errors
        except ImportError as e:
            raise ImportError(
                "keyring library not installed. "
                "Install with: pip install keyring"
            ) from e

    def get(self, key: str) -> Optional[str]:
        """Retrieve a secret from the keyring.

        Args:
            key: The secret key

        Returns:
            The secret value, or None if not found
        """
        try:
            return self._keyring.get_password(self.SERVICE_NAME, key)
        except self._errors.KeyringError as e:
            logger.warning(f"Keyring get failed for '{key}': {e}")
            return None

    def set(self, key: str, value: str) -> None:
        """Store a secret in the keyring.

        Args:
            key: The secret key
            value: The secret value

        Raises:
            SecretStorageError: If storage fails
        """
        try:
            self._keyring.set_password(self.SERVICE_NAME, key, value)
            logger.debug(f"Secret '{key}' stored in keyring")
        except self._errors.KeyringError as e:
            logger.error(f"Keyring set failed for '{key}': {e}")
            raise SecretStorageError(f"Failed to store secret '{key}': {e}")

    def delete(self, key: str) -> None:
        """Delete a secret from the keyring.

        Args:
            key: The secret key
        """
        try:
            self._keyring.delete_password(self.SERVICE_NAME, key)
            logger.debug(f"Secret '{key}' deleted from keyring")
        except self._errors.KeyringError:
            # Already deleted or never existed
            pass

    def list_keys(self) -> list[str]:
        """List all stored secret keys.

        Note:
            The keyring library doesn't support listing keys.
            This returns an empty list.

        Returns:
            Empty list (not supported by keyring)
        """
        # keyring doesn't support listing
        return []

    def is_available(self) -> bool:
        """Check if the keyring is available.

        Returns:
            True if a keyring backend is active
        """
        try:
            # Try to get the backend name
            backend = self._keyring.get_keyring()
            return backend is not None
        except Exception:
            return False


class EnvironmentBackend(SecretBackend):
    """Environment variable backend for CI/CD environments.

    Secrets are stored in environment variables with a prefix.
    This backend is read-only (cannot set at runtime).

    Environment variable format: BAT_SECRET_<KEY>

    Example:
        >>> # Set environment variable: BAT_SECRET_API_KEY=secret123
        >>> backend = EnvironmentBackend()
        >>> backend.get("api_key")
        'secret123'
    """

    PREFIX = "BAT_SECRET_"

    def get(self, key: str) -> Optional[str]:
        """Retrieve a secret from environment variables.

        Args:
            key: The secret key (will be uppercased and prefixed)

        Returns:
            The secret value, or None if not found
        """
        env_key = f"{self.PREFIX}{key.upper()}"
        return os.environ.get(env_key)

    def set(self, key: str, value: str) -> None:
        """Store a secret (not supported for environment backend).

        Args:
            key: The secret key
            value: The secret value

        Raises:
            SecretStorageError: Always (read-only backend)
        """
        raise SecretStorageError(
            "Cannot set environment variables at runtime. "
            "Set BAT_SECRET_<KEY> environment variables before running."
        )

    def delete(self, key: str) -> None:
        """Delete a secret (not supported for environment backend).

        Raises:
            SecretStorageError: Always (read-only backend)
        """
        raise SecretStorageError(
            "Cannot delete environment variables at runtime."
        )

    def list_keys(self) -> list[str]:
        """List all secret keys from environment variables.

        Returns:
            List of secret keys (without prefix, lowercase)
        """
        return [
            k[len(self.PREFIX):].lower()
            for k in os.environ
            if k.startswith(self.PREFIX)
        ]

    def is_available(self) -> bool:
        """Check if any BAT_SECRET_ variables are set.

        Returns:
            True if at least one secret is available
        """
        return any(k.startswith(self.PREFIX) for k in os.environ)


class MemoryBackend(SecretBackend):
    """In-memory secret backend for testing.

    Secrets are stored in memory and lost when the process exits.
    DO NOT USE IN PRODUCTION.
    """

    def __init__(self):
        """Initialize the in-memory backend."""
        self._secrets: dict[str, str] = {}

    def get(self, key: str) -> Optional[str]:
        """Retrieve a secret from memory.

        Args:
            key: The secret key

        Returns:
            The secret value, or None if not found
        """
        return self._secrets.get(key)

    def set(self, key: str, value: str) -> None:
        """Store a secret in memory.

        Args:
            key: The secret key
            value: The secret value
        """
        self._secrets[key] = value

    def delete(self, key: str) -> None:
        """Delete a secret from memory.

        Args:
            key: The secret key
        """
        self._secrets.pop(key, None)

    def list_keys(self) -> list[str]:
        """List all stored secret keys.

        Returns:
            List of secret keys
        """
        return list(self._secrets.keys())

    def is_available(self) -> bool:
        """Always available.

        Returns:
            True
        """
        return True


def get_default_backend() -> SecretBackend:
    """Get the default secret backend based on environment.

    Selection order:
    1. EnvironmentBackend if CI or BAT_USE_ENV_SECRETS is set
    2. KeyringBackend if available
    3. EnvironmentBackend as fallback

    Returns:
        SecretBackend instance
    """
    # Prefer environment variables in CI
    if os.environ.get("CI") or os.environ.get("BAT_USE_ENV_SECRETS"):
        logger.info("Using EnvironmentBackend for secrets (CI mode)")
        return EnvironmentBackend()

    # Try keyring
    try:
        backend = KeyringBackend()
        if backend.is_available():
            logger.info("Using KeyringBackend for secrets")
            return backend
    except ImportError:
        pass

    # Fallback to environment
    logger.info("Using EnvironmentBackend for secrets (fallback)")
    return EnvironmentBackend()


class SecretManager:
    """High-level secret management.

    Provides a unified interface for secret operations with:
    - Automatic backend selection
    - Caching (optional)
    - Audit logging

    Example:
        >>> manager = SecretManager()
        >>> manager.set("api_key", "secret123")
        >>> api_key = manager.get("api_key")
    """

    def __init__(
        self,
        backend: Optional[SecretBackend] = None,
        cache: bool = False,
    ):
        """Initialize the secret manager.

        Args:
            backend: Secret backend to use (default: auto-detect)
            cache: Whether to cache secrets in memory
        """
        self._backend = backend or get_default_backend()
        self._cache_enabled = cache
        self._cache: dict[str, str] = {}

    def get(self, key: str) -> Optional[str]:
        """Retrieve a secret.

        Args:
            key: The secret key

        Returns:
            The secret value, or None if not found
        """
        # Check cache first
        if self._cache_enabled and key in self._cache:
            return self._cache[key]

        # Get from backend
        value = self._backend.get(key)

        # Cache if enabled
        if self._cache_enabled and value is not None:
            self._cache[key] = value

        return value

    def set(self, key: str, value: str) -> None:
        """Store a secret.

        Args:
            key: The secret key
            value: The secret value
        """
        self._backend.set(key, value)

        # Update cache
        if self._cache_enabled:
            self._cache[key] = value

    def delete(self, key: str) -> None:
        """Delete a secret.

        Args:
            key: The secret key
        """
        self._backend.delete(key)

        # Clear from cache
        self._cache.pop(key, None)

    def require(self, key: str) -> str:
        """Get a required secret, raising if not found.

        Args:
            key: The secret key

        Returns:
            The secret value

        Raises:
            SecretStorageError: If the secret is not found
        """
        value = self.get(key)
        if value is None:
            raise SecretStorageError(f"Required secret '{key}' not found")
        return value

    def list_keys(self) -> list[str]:
        """List all stored secret keys.

        Returns:
            List of secret keys
        """
        return self._backend.list_keys()

    def clear_cache(self) -> None:
        """Clear the secret cache."""
        self._cache.clear()
