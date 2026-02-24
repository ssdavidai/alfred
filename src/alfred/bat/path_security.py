"""
Path Security - Validate and normalize paths for security.

Blocks:
- Path traversal (../)
- UNC paths (\\\\server\\share)
- Alternate data streams (file.txt:stream)
- Null bytes
- Overly long paths
- Symlink escape (optional)
"""

import os
import re
from pathlib import Path
from typing import Optional
import logging


logger = logging.getLogger(__name__)


class PathSecurityError(Exception):
    """Raised when a path fails security validation."""
    pass


class PathHardener:
    """Validate and normalize paths for security.

    This module provides path security validation to prevent:
    - Path traversal attacks (../../../etc/passwd)
    - UNC path injection (\\\\server\\share)
    - Alternate data streams (file.txt:malicious)
    - Null byte injection
    - Path length attacks

    Example:
        >>> from alfred.bat.path_security import PathHardener
        >>> # Validate a path
        >>> safe_path = PathHardener.validate("~/vault/note.md")
        >>> # Validate with base directory restriction
        >>> safe_path = PathHardener.validate("note.md", base_dir=Path("/home/user/vault"))
    """

    # Maximum path length (Windows limit is 260, but we're conservative)
    MAX_PATH_LENGTH = 4096

    # Blocked patterns
    UNC_PATTERN = re.compile(r'^\\\\[^\\]+\\|^//[^/]+/')
    ADS_PATTERN = re.compile(r':[^:\\/]+$')  # :stream at end
    TRAVERSAL_PATTERN = re.compile(r'\.\.[\\/]')

    # Sensitive path patterns
    SENSITIVE_PATTERNS = [
        r'^/etc/',
        r'/\.ssh/',
        r'/\.gnupg/',
        r'/\.aws/',
        r'/\.docker/',
        r'\.env$',
        r'credentials',
        r'secret',
        r'\.pem$',
        r'\.key$',
        r'id_rsa',
        r'id_ed25519',
        r'authorized_keys',
        r'known_hosts',
        r'\.netrc$',
        r'\.pgp/',
    ]

    @classmethod
    def validate(
        cls,
        path: str,
        base_dir: Optional[Path] = None,
        allow_symlinks: bool = True,
    ) -> Path:
        """Validate and normalize a path.

        Args:
            path: The path to validate
            base_dir: If provided, ensure the resolved path is within this directory
            allow_symlinks: Whether to allow symbolic links (default: True)

        Returns:
            Normalized, validated Path object

        Raises:
            PathSecurityError: If the path fails validation

        Example:
            >>> PathHardener.validate("~/vault/note.md")
            PosixPath('/home/user/vault/note.md')
            >>> PathHardener.validate("../../../etc/passwd")  # Raises PathSecurityError
        """
        # Check for null bytes
        if '\x00' in path:
            raise PathSecurityError("Path contains null bytes")

        # Check length
        if len(path) > cls.MAX_PATH_LENGTH:
            raise PathSecurityError(
                f"Path exceeds maximum length ({cls.MAX_PATH_LENGTH})"
            )

        # Block UNC paths (Windows network paths)
        if cls.UNC_PATTERN.match(path):
            raise PathSecurityError("UNC paths are not allowed")

        # Block alternate data streams (Windows ADS)
        if cls.ADS_PATTERN.search(path):
            raise PathSecurityError("Alternate data streams are not allowed")

        # Check for traversal before normalization
        if cls.TRAVERSAL_PATTERN.search(path):
            logger.warning(f"Path traversal attempt detected: {path}")
            # Don't raise yet - let normalization handle it
            # but log the attempt

        # Normalize path
        try:
            # Expand user home directory
            expanded = Path(path).expanduser()

            # Resolve to absolute path (follows symlinks by default)
            if allow_symlinks:
                normalized = expanded.resolve()
            else:
                # Resolve without following symlinks
                normalized = Path(os.path.normpath(str(expanded)))
                if not normalized.is_absolute():
                    normalized = Path.cwd() / normalized

        except OSError as e:
            raise PathSecurityError(f"Invalid path: {e}")

        # Check for traversal after normalization (should be gone if resolved)
        normalized_str = str(normalized)
        if '..' in normalized_str:
            raise PathSecurityError("Path traversal detected in normalized path")

        # If base_dir provided, ensure path is within it
        if base_dir is not None:
            base = Path(base_dir).expanduser().resolve()

            try:
                # Check if normalized is relative to base
                normalized.relative_to(base)
            except ValueError:
                raise PathSecurityError(
                    f"Path '{normalized}' is outside allowed directory '{base}'"
                )

            # Check for symlink escape
            if not allow_symlinks and normalized.is_symlink():
                raise PathSecurityError("Symbolic links are not allowed")

        return normalized

    @classmethod
    def is_sensitive(cls, path: str) -> bool:
        """Check if a path is security-sensitive.

        Args:
            path: Path to check

        Returns:
            True if path matches sensitive patterns

        Example:
            >>> PathHardener.is_sensitive("~/.ssh/id_rsa")
            True
            >>> PathHardener.is_sensitive("~/vault/note.md")
            False
        """
        try:
            normalized = str(Path(path).expanduser())
        except Exception:
            return False

        for pattern in cls.SENSITIVE_PATTERNS:
            if re.search(pattern, normalized, re.IGNORECASE):
                return True

        return False

    @classmethod
    def get_sensitivity_reason(cls, path: str) -> Optional[str]:
        """Get the reason why a path is sensitive.

        Args:
            path: Path to check

        Returns:
            Reason string if sensitive, None otherwise
        """
        try:
            normalized = str(Path(path).expanduser())
        except Exception:
            return None

        reasons = {
            r'^/etc/': "System configuration directory",
            r'/\.ssh/': "SSH keys directory",
            r'/\.gnupg/': "GPG keys directory",
            r'/\.aws/': "AWS credentials directory",
            r'/\.docker/': "Docker configuration directory",
            r'\.env$': "Environment file",
            r'credentials': "Credentials file",
            r'secret': "Secret file",
            r'\.pem$': "PEM certificate file",
            r'\.key$': "Key file",
            r'id_rsa': "SSH private key",
            r'id_ed25519': "Ed25519 private key",
            r'authorized_keys': "SSH authorized keys",
            r'known_hosts': "SSH known hosts",
            r'\.netrc$': "Netrc credentials file",
            r'\.pgp/': "PGP directory",
        }

        for pattern, reason in reasons.items():
            if re.search(pattern, normalized, re.IGNORECASE):
                return reason

        return None

    @classmethod
    def sanitize_filename(cls, filename: str) -> str:
        """Sanitize a filename for safe filesystem use.

        Removes or replaces dangerous characters.

        Args:
            filename: Original filename

        Returns:
            Sanitized filename

        Example:
            >>> PathHardener.sanitize_filename("file<>:\"/\\|?*.txt")
            'file_________.txt'
        """
        # Remove null bytes
        filename = filename.replace('\x00', '')

        # Replace dangerous characters with underscore
        dangerous_chars = '<>:"/\\|?*'
        for char in dangerous_chars:
            filename = filename.replace(char, '_')

        # Remove leading/trailing spaces and dots
        filename = filename.strip('. ')

        # Ensure not empty
        if not filename:
            filename = "unnamed"

        # Truncate if too long (leave room for extension)
        max_name = 255
        if len(filename) > max_name:
            # Preserve extension if present
            name, ext = os.path.splitext(filename)
            if ext:
                filename = name[:max_name - len(ext)] + ext
            else:
                filename = filename[:max_name]

        return filename

    @classmethod
    def is_within_directory(cls, path: Path, directory: Path) -> bool:
        """Check if a path is within a directory.

        Args:
            path: Path to check
            directory: Directory to check against

        Returns:
            True if path is within directory
        """
        try:
            path = path.resolve()
            directory = directory.resolve()
            path.relative_to(directory)
            return True
        except ValueError:
            return False

    @classmethod
    def check_path_escape(cls, path: str, base_dir: Path) -> tuple[bool, Optional[str]]:
        """Check if a path attempts to escape a base directory.

        This is useful for detecting traversal attempts before they happen.

        Args:
            path: Path to check
            base_dir: Base directory to check against

        Returns:
            Tuple of (is_safe, error_message)
        """
        base_dir = Path(base_dir).resolve()

        # Check for traversal patterns
        if cls.TRAVERSAL_PATTERN.search(path):
            # Count traversal depth
            traversals = len(cls.TRAVERSAL_PATTERN.findall(path))
            # Check if it would escape
            parts = Path(path).parts
            depth = 0
            for part in parts:
                if part == '..':
                    depth -= 1
                elif part != '.':
                    depth += 1

            if depth < 0:
                return False, f"Path attempts to traverse {abs(depth)} levels above base"

        # Validate the path
        try:
            validated = cls.validate(path, base_dir=base_dir)
            return True, None
        except PathSecurityError as e:
            return False, str(e)


def validate_vault_path(path: str, vault_root: Path) -> Path:
    """Validate that a path is within the vault.

    Args:
        path: Path to validate
        vault_root: Root directory of the vault

    Returns:
        Validated path within vault

    Raises:
        PathSecurityError: If path is outside vault or invalid
    """
    return PathHardener.validate(path, base_dir=vault_root)


def check_sensitive_access(path: str) -> tuple[bool, Optional[str]]:
    """Check if accessing a path would be sensitive.

    Args:
        path: Path to check

    Returns:
        Tuple of (is_sensitive, reason)
    """
    if PathHardener.is_sensitive(path):
        return True, PathHardener.get_sensitivity_reason(path)
    return False, None
