"""
Wrappers for standard library functions.

These wrappers intercept operations and route them through
the Bat Protocol governance layer.

Usage:
    from alfred.bat.wrappers import patch_subprocess, patch_filesystem

    # Patch subprocess.run
    patch_subprocess(interceptor, agent_id="curator")

    # Patch open() for writes
    patch_filesystem(interceptor, agent_id="curator")
"""

import subprocess
import builtins
from typing import Any, Optional
from pathlib import Path

from ..interceptor import BatInterceptor


def create_bat_subprocess_run(
    interceptor: BatInterceptor,
    agent_id: str,
    original_run: Optional[callable] = None,
):
    """Create a wrapped subprocess.run that goes through governance.

    Args:
        interceptor: The Bat interceptor
        agent_id: Identifier of the agent
        original_run: Original subprocess.run (default: subprocess.run)

    Returns:
        Wrapped subprocess.run function

    Example:
        >>> import subprocess
        >>> from alfred.bat.wrappers import create_bat_subprocess_run
        >>>
        >>> wrapped_run = create_bat_subprocess_run(interceptor, "curator")
        >>> subprocess.run = wrapped_run
    """
    if original_run is None:
        original_run = subprocess.run

    def bat_run(*args, **kwargs) -> subprocess.CompletedProcess:
        # Extract command
        if args:
            cmd = args[0]
        else:
            cmd = kwargs.get("args", [])

        # Build command string for metadata
        if isinstance(cmd, list):
            cmd_str = " ".join(str(c) for c in cmd)
        else:
            cmd_str = str(cmd)

        # Intercept the operation
        result = interceptor.intercept(
            agent_id=agent_id,
            operation_type="exec_command",
            target="subprocess",
            metadata={
                "command": cmd_str,
                "shell": kwargs.get("shell", False),
                "cwd": str(kwargs.get("cwd", ".")),
            },
        )

        if not result.allowed:
            raise PermissionError("GovernanceError: Operation denied by policy.")

        return original_run(*args, **kwargs)

    # Preserve function attributes
    bat_run.__name__ = "bat_subprocess_run"
    bat_run.__doc__ = "Bat-wrapped subprocess.run"
    bat_run.__wrapped__ = original_run  # type: ignore

    return bat_run


def create_bat_popen(
    interceptor: BatInterceptor,
    agent_id: str,
    original_popen: Optional[callable] = None,
):
    """Create a wrapped subprocess.Popen that goes through governance.

    Args:
        interceptor: The Bat interceptor
        agent_id: Identifier of the agent
        original_popen: Original subprocess.Popen (default: subprocess.Popen)

    Returns:
        Wrapped subprocess.Popen class
    """
    if original_popen is None:
        original_popen = subprocess.Popen

    class BatPopen(original_popen):
        """Bat-wrapped subprocess.Popen."""

        def __init__(self, *args, **kwargs):
            # Extract command
            if args:
                cmd = args[0]
            else:
                cmd = kwargs.get("args", [])

            # Build command string for metadata
            if isinstance(cmd, list):
                cmd_str = " ".join(str(c) for c in cmd)
            else:
                cmd_str = str(cmd)

            # Intercept the operation
            result = interceptor.intercept(
                agent_id=agent_id,
                operation_type="exec_command",
                target="subprocess",
                metadata={
                    "command": cmd_str,
                    "shell": kwargs.get("shell", False),
                    "cwd": str(kwargs.get("cwd", ".")),
                },
            )

            if not result.allowed:
                raise PermissionError("GovernanceError: Operation denied by policy.")

            super().__init__(*args, **kwargs)

    return BatPopen


def create_bat_open(
    interceptor: BatInterceptor,
    agent_id: str,
    original_open: Optional[callable] = None,
):
    """Create a wrapped open() that goes through governance for writes.

    Args:
        interceptor: The Bat interceptor
        agent_id: Identifier of the agent
        original_open: Original open function (default: builtins.open)

    Returns:
        Wrapped open function

    Example:
        >>> import builtins
        >>> from alfred.bat.wrappers import create_bat_open
        >>>
        >>> wrapped_open = create_bat_open(interceptor, "curator")
        >>> builtins.open = wrapped_open
    """
    if original_open is None:
        original_open = builtins.open

    def bat_open(file, mode='r', *args, **kwargs):
        # Determine operation type based on mode
        is_write = 'w' in mode or 'a' in mode or 'x' in mode
        is_read = 'r' in mode or '+' in mode

        # Intercept write operations
        if is_write:
            result = interceptor.intercept(
                agent_id=agent_id,
                operation_type="write_file",
                target=str(file),
                metadata={
                    "mode": mode,
                    "encoding": kwargs.get("encoding", "unknown"),
                },
            )

            if not result.allowed:
                raise PermissionError("GovernanceError: Operation denied by policy.")

        # Intercept read operations (lower risk, but still logged)
        elif is_read:
            result = interceptor.intercept(
                agent_id=agent_id,
                operation_type="read_file",
                target=str(file),
                metadata={
                    "mode": mode,
                    "encoding": kwargs.get("encoding", "unknown"),
                },
            )

            if not result.allowed:
                raise PermissionError("GovernanceError: Operation denied by policy.")

        return original_open(file, mode, *args, **kwargs)

    # Preserve function attributes
    bat_open.__name__ = "bat_open"
    bat_open.__doc__ = "Bat-wrapped open()"
    bat_open.__wrapped__ = original_open  # type: ignore

    return bat_open


def create_bat_os_remove(
    interceptor: BatInterceptor,
    agent_id: str,
    original_remove: Optional[callable] = None,
):
    """Create a wrapped os.remove that goes through governance.

    Args:
        interceptor: The Bat interceptor
        agent_id: Identifier of the agent
        original_remove: Original os.remove (default: os.remove)

    Returns:
        Wrapped os.remove function
    """
    import os

    if original_remove is None:
        original_remove = os.remove

    def bat_remove(path, *args, **kwargs):
        result = interceptor.intercept(
            agent_id=agent_id,
            operation_type="delete_file",
            target=str(path),
        )

        if not result.allowed:
            raise PermissionError("GovernanceError: Operation denied by policy.")

        return original_remove(path, *args, **kwargs)

    bat_remove.__name__ = "bat_remove"
    bat_remove.__doc__ = "Bat-wrapped os.remove"
    bat_remove.__wrapped__ = original_remove  # type: ignore

    return bat_remove


def create_bat_shutil_rmtree(
    interceptor: BatInterceptor,
    agent_id: str,
    original_rmtree: Optional[callable] = None,
):
    """Create a wrapped shutil.rmtree that goes through governance.

    Args:
        interceptor: The Bat interceptor
        agent_id: Identifier of the agent
        original_rmtree: Original shutil.rmtree

    Returns:
        Wrapped shutil.rmtree function
    """
    import shutil

    if original_rmtree is None:
        original_rmtree = shutil.rmtree

    def bat_rmtree(path, *args, **kwargs):
        result = interceptor.intercept(
            agent_id=agent_id,
            operation_type="delete_file",
            target=str(path),
            metadata={"recursive": True},
        )

        if not result.allowed:
            raise PermissionError("GovernanceError: Operation denied by policy.")

        return original_rmtree(path, *args, **kwargs)

    bat_rmtree.__name__ = "bat_rmtree"
    bat_rmtree.__doc__ = "Bat-wrapped shutil.rmtree"
    bat_rmtree.__wrapped__ = original_rmtree  # type: ignore

    return bat_rmtree


class BatPatcher:
    """Context manager for patching standard library functions.

    This provides a convenient way to temporarily patch functions
    for the duration of a code block.

    Example:
        >>> from alfred.bat.wrappers import BatPatcher
        >>>
        >>> with BatPatcher(interceptor, agent_id="curator"):
        ...     # All subprocess and file operations go through governance
        ...     subprocess.run(["ls", "-la"])
        ...     with open("test.txt", "w") as f:
        ...         f.write("Hello")
    """

    def __init__(
        self,
        interceptor: BatInterceptor,
        agent_id: str,
        patch_subprocess: bool = True,
        patch_filesystem: bool = True,
    ):
        """Initialize the patcher.

        Args:
            interceptor: The Bat interceptor
            agent_id: Identifier of the agent
            patch_subprocess: Whether to patch subprocess functions
            patch_filesystem: Whether to patch filesystem functions
        """
        self.interceptor = interceptor
        self.agent_id = agent_id
        self.patch_subprocess = patch_subprocess
        self.patch_filesystem = patch_filesystem

        self._originals = {}

    def __enter__(self):
        """Apply patches."""
        import os
        import shutil

        if self.patch_subprocess:
            self._originals["subprocess.run"] = subprocess.run
            self._originals["subprocess.Popen"] = subprocess.Popen

            subprocess.run = create_bat_subprocess_run(
                self.interceptor, self.agent_id, subprocess.run
            )
            subprocess.Popen = create_bat_popen(
                self.interceptor, self.agent_id, subprocess.Popen
            )

        if self.patch_filesystem:
            self._originals["builtins.open"] = builtins.open
            self._originals["os.remove"] = os.remove
            self._originals["shutil.rmtree"] = shutil.rmtree

            builtins.open = create_bat_open(
                self.interceptor, self.agent_id, builtins.open
            )
            os.remove = create_bat_os_remove(
                self.interceptor, self.agent_id, os.remove
            )
            shutil.rmtree = create_bat_shutil_rmtree(
                self.interceptor, self.agent_id, shutil.rmtree
            )

        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Restore original functions."""
        import os
        import shutil

        if self.patch_subprocess:
            subprocess.run = self._originals.get("subprocess.run", subprocess.run)
            subprocess.Popen = self._originals.get("subprocess.Popen", subprocess.Popen)

        if self.patch_filesystem:
            builtins.open = self._originals.get("builtins.open", builtins.open)
            os.remove = self._originals.get("os.remove", os.remove)
            shutil.rmtree = self._originals.get("shutil.rmtree", shutil.rmtree)

        return False  # Don't suppress exceptions


def patch_all(
    interceptor: BatInterceptor,
    agent_id: str,
) -> dict:
    """Permanently patch all supported functions.

    This modifies the global modules in-place. Use with caution.

    Args:
        interceptor: The Bat interceptor
        agent_id: Identifier of the agent

    Returns:
        Dictionary of original functions (for restoration if needed)

    Example:
        >>> from alfred.bat.wrappers import patch_all
        >>>
        >>> originals = patch_all(interceptor, "curator")
        >>> # All operations now go through governance
    """
    import os
    import shutil

    originals = {}

    # Patch subprocess
    originals["subprocess.run"] = subprocess.run
    originals["subprocess.Popen"] = subprocess.Popen
    subprocess.run = create_bat_subprocess_run(interceptor, agent_id, subprocess.run)
    subprocess.Popen = create_bat_popen(interceptor, agent_id, subprocess.Popen)

    # Patch filesystem
    originals["builtins.open"] = builtins.open
    originals["os.remove"] = os.remove
    originals["shutil.rmtree"] = shutil.rmtree
    builtins.open = create_bat_open(interceptor, agent_id, builtins.open)
    os.remove = create_bat_os_remove(interceptor, agent_id, os.remove)
    shutil.rmtree = create_bat_shutil_rmtree(interceptor, agent_id, shutil.rmtree)

    return originals

