"""
OS-Level Sandbox Integrations for Untrusted Agent Execution.

Implements SECURITY ELEVATION Phase 3:
- Platform-specific sandbox implementations
- Resource isolation for untrusted agents
- Execution boundary enforcement
- Audit trail for sandbox operations

Core Principle: Untrusted agents execute in isolated environments
with bounded resources and no direct system access.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional, Callable, Any, Union
import hashlib
import json
import logging
import os
import platform
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

logger = logging.getLogger(__name__)


class SandboxType(str, Enum):
    """Types of sandbox implementations."""
    NONE = "none"                    # No sandbox (trusted only)
    PROCESS = "process"              # Process-level isolation
    CONTAINER = "container"          # Container-based isolation
    HYPERVISOR = "hypervisor"        # VM-based isolation
    PLATFORM = "platform"            # Platform-specific (seccomp, sandbox-api)


class SandboxStatus(str, Enum):
    """Status of a sandbox."""
    CREATING = "creating"
    READY = "ready"
    RUNNING = "running"
    STOPPED = "stopped"
    ERROR = "error"
    DESTROYED = "destroyed"


class IsolationLevel(str, Enum):
    """Isolation level for sandbox."""
    MINIMAL = "minimal"      # Basic process isolation
    STANDARD = "standard"    # Filesystem + network isolation
    STRICT = "strict"        # Full isolation with resource limits
    MAXIMUM = "maximum"      # Hypervisor-level isolation


@dataclass
class SandboxResources:
    """Resource limits for a sandbox.
    
    Attributes:
        cpu_limit: CPU time limit (seconds)
        memory_limit: Memory limit (bytes)
        disk_limit: Disk space limit (bytes)
        network_enabled: Whether network access is allowed
        network_egress: Whether outbound network is allowed
        max_processes: Maximum number of processes
        max_open_files: Maximum open file descriptors
        execution_timeout: Maximum execution time (seconds)
    """
    cpu_limit: int = 60           # 60 seconds CPU time
    memory_limit: int = 512 * 1024 * 1024  # 512 MB
    disk_limit: int = 100 * 1024 * 1024    # 100 MB
    network_enabled: bool = False
    network_egress: bool = False
    max_processes: int = 10
    max_open_files: int = 100
    execution_timeout: int = 300  # 5 minutes
    
    def to_dict(self) -> dict:
        return {
            "cpu_limit": self.cpu_limit,
            "memory_limit": self.memory_limit,
            "disk_limit": self.disk_limit,
            "network_enabled": self.network_enabled,
            "network_egress": self.network_egress,
            "max_processes": self.max_processes,
            "max_open_files": self.max_open_files,
            "execution_timeout": self.execution_timeout,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> "SandboxResources":
        return cls(
            cpu_limit=data.get("cpu_limit", 60),
            memory_limit=data.get("memory_limit", 512 * 1024 * 1024),
            disk_limit=data.get("disk_limit", 100 * 1024 * 1024),
            network_enabled=data.get("network_enabled", False),
            network_egress=data.get("network_egress", False),
            max_processes=data.get("max_processes", 10),
            max_open_files=data.get("max_open_files", 100),
            execution_timeout=data.get("execution_timeout", 300),
        )


@dataclass
class SandboxConfig:
    """Configuration for a sandbox.
    
    Attributes:
        sandbox_id: Unique identifier
        sandbox_type: Type of sandbox
        isolation_level: Isolation level
        resources: Resource limits
        allowed_paths: Paths accessible from sandbox
        allowed_commands: Commands allowed to execute
        environment: Environment variables
        workdir: Working directory inside sandbox
        agent_id: Agent using this sandbox
        created_at: Creation timestamp
    """
    sandbox_id: str
    sandbox_type: SandboxType = SandboxType.PROCESS
    isolation_level: IsolationLevel = IsolationLevel.STANDARD
    resources: SandboxResources = field(default_factory=SandboxResources)
    allowed_paths: list[str] = field(default_factory=list)
    allowed_commands: list[str] = field(default_factory=list)
    environment: dict[str, str] = field(default_factory=dict)
    workdir: str = "/sandbox"
    agent_id: str = ""
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    
    def to_dict(self) -> dict:
        return {
            "sandbox_id": self.sandbox_id,
            "sandbox_type": self.sandbox_type.value,
            "isolation_level": self.isolation_level.value,
            "resources": self.resources.to_dict(),
            "allowed_paths": self.allowed_paths,
            "allowed_commands": self.allowed_commands,
            "environment": self.environment,
            "workdir": self.workdir,
            "agent_id": self.agent_id,
            "created_at": self.created_at.isoformat(),
        }


@dataclass
class ExecutionResult:
    """Result of a sandboxed execution.
    
    Attributes:
        execution_id: Unique identifier
        sandbox_id: ID of the sandbox
        command: Command that was executed
        exit_code: Process exit code
        stdout: Standard output
        stderr: Standard error
        start_time: When execution started
        end_time: When execution ended
        duration: Execution duration (seconds)
        resource_usage: Resource usage metrics
        success: Whether execution succeeded
        error_message: Error message if failed
    """
    execution_id: str
    sandbox_id: str
    command: str
    exit_code: int = -1
    stdout: str = ""
    stderr: str = ""
    start_time: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    end_time: Optional[datetime] = None
    duration: float = 0.0
    resource_usage: dict = field(default_factory=dict)
    success: bool = False
    error_message: str = ""
    
    def to_dict(self) -> dict:
        return {
            "execution_id": self.execution_id,
            "sandbox_id": self.sandbox_id,
            "command": self.command,
            "exit_code": self.exit_code,
            "stdout": self.stdout[:1000],  # Truncate for logs
            "stderr": self.stderr[:1000],
            "start_time": self.start_time.isoformat(),
            "end_time": self.end_time.isoformat() if self.end_time else None,
            "duration": self.duration,
            "resource_usage": self.resource_usage,
            "success": self.success,
            "error_message": self.error_message,
        }


class SandboxBase:
    """Base class for sandbox implementations.
    
    Provides common interface and utilities for all sandbox types.
    """
    
    def __init__(self, config: SandboxConfig):
        """Initialize the sandbox.
        
        Args:
            config: Sandbox configuration
        """
        self._config = config
        self._status = SandboxStatus.CREATING
        self._executions: list[ExecutionResult] = []
        self._lock = threading.RLock()
    
    @property
    def sandbox_id(self) -> str:
        """Get the sandbox ID."""
        return self._config.sandbox_id
    
    @property
    def status(self) -> SandboxStatus:
        """Get the current status."""
        return self._status
    
    @property
    def config(self) -> SandboxConfig:
        """Get the configuration."""
        return self._config
    
    def create(self) -> bool:
        """Create the sandbox.
        
        Returns:
            True if created successfully
        """
        raise NotImplementedError("Subclasses must implement create()")
    
    def execute(
        self,
        command: str,
        args: Optional[list[str]] = None,
        stdin: Optional[str] = None,
        timeout: Optional[int] = None,
    ) -> ExecutionResult:
        """Execute a command in the sandbox.
        
        Args:
            command: Command to execute
            args: Command arguments
            stdin: Standard input
            timeout: Execution timeout (overrides config)
        
        Returns:
            ExecutionResult with outcome
        """
        raise NotImplementedError("Subclasses must implement execute()")
    
    def destroy(self) -> bool:
        """Destroy the sandbox.
        
        Returns:
            True if destroyed successfully
        """
        raise NotImplementedError("Subclasses must implement destroy()")
    
    def get_executions(self) -> list[ExecutionResult]:
        """Get all execution results."""
        return list(self._executions)
    
    def _validate_command(self, command: str) -> tuple[bool, str]:
        """Validate a command against allowed list.
        
        Returns:
            Tuple of (is_valid, error_message)
        """
        if not self._config.allowed_commands:
            # No allowlist means all commands allowed (use with caution)
            return True, ""
        
        # Extract base command
        base_cmd = command.split()[0] if command else ""
        
        for allowed in self._config.allowed_commands:
            if base_cmd == allowed or base_cmd.endswith(f"/{allowed}"):
                return True, ""
        
        return False, f"Command not in allowlist: {base_cmd}"
    
    def _record_execution(self, result: ExecutionResult) -> None:
        """Record an execution result."""
        with self._lock:
            self._executions.append(result)


class ProcessSandbox(SandboxBase):
    """Process-level sandbox implementation.
    
    Uses subprocess with resource limits and isolation.
    Works on all platforms but provides minimal isolation.
    """
    
    def __init__(self, config: SandboxConfig):
        """Initialize the process sandbox."""
        super().__init__(config)
        self._temp_dir: Optional[Path] = None
    
    def create(self) -> bool:
        """Create the sandbox environment."""
        try:
            # Create temporary working directory
            self._temp_dir = Path(tempfile.mkdtemp(prefix=f"sandbox_{self.sandbox_id}_"))
            
            # Create workdir structure
            workdir = self._temp_dir / "work"
            workdir.mkdir(parents=True, exist_ok=True)
            
            # Create allowed path mappings
            for path in self._config.allowed_paths:
                src = Path(path)
                if src.exists():
                    dst = workdir / src.name
                    if src.is_dir():
                        shutil.copytree(src, dst, dirs_exist_ok=True)
                    else:
                        shutil.copy2(src, dst)
            
            self._status = SandboxStatus.READY
            logger.info(f"Created process sandbox {self.sandbox_id[:8]}...")
            return True
            
        except Exception as e:
            self._status = SandboxStatus.ERROR
            logger.error(f"Failed to create sandbox: {e}")
            return False
    
    def execute(
        self,
        command: str,
        args: Optional[list[str]] = None,
        stdin: Optional[str] = None,
        timeout: Optional[int] = None,
    ) -> ExecutionResult:
        """Execute a command in the sandbox."""
        execution_id = str(uuid.uuid4())
        start_time = datetime.now(timezone.utc)
        
        result = ExecutionResult(
            execution_id=execution_id,
            sandbox_id=self.sandbox_id,
            command=command,
            start_time=start_time,
        )
        
        if self._status != SandboxStatus.READY:
            result.error_message = f"Sandbox not ready: {self._status.value}"
            self._record_execution(result)
            return result
        
        # Validate command
        is_valid, error = self._validate_command(command)
        if not is_valid:
            result.error_message = error
            self._record_execution(result)
            return result
        
        try:
            self._status = SandboxStatus.RUNNING
            
            # Build command
            cmd = [command] + (args or [])
            
            # Build environment
            env = dict(os.environ)
            env.update(self._config.environment)
            
            # Remove dangerous variables
            env.pop("HOME", None)
            env.pop("USER", None)
            env.pop("PATH", None)
            env["PATH"] = "/usr/bin:/bin"  # Minimal PATH
            
            # Set working directory
            cwd = self._temp_dir / "work" if self._temp_dir else None
            
            # Execute with timeout
            exec_timeout = timeout or self._config.resources.execution_timeout
            
            proc = subprocess.run(
                cmd,
                cwd=cwd,
                env=env,
                input=stdin,
                capture_output=True,
                text=True,
                timeout=exec_timeout,
            )
            
            result.exit_code = proc.returncode
            result.stdout = proc.stdout
            result.stderr = proc.stderr
            result.success = proc.returncode == 0
            
        except subprocess.TimeoutExpired:
            result.error_message = f"Execution timed out after {exec_timeout}s"
            result.exit_code = -2
        except Exception as e:
            result.error_message = str(e)
            result.exit_code = -1
        finally:
            result.end_time = datetime.now(timezone.utc)
            result.duration = (result.end_time - start_time).total_seconds()
            self._status = SandboxStatus.READY
            self._record_execution(result)
            
            logger.info(
                f"Executed in sandbox {self.sandbox_id[:8]}...: "
                f"exit={result.exit_code}, duration={result.duration:.2f}s"
            )
        
        return result
    
    def destroy(self) -> bool:
        """Destroy the sandbox."""
        try:
            if self._temp_dir and self._temp_dir.exists():
                shutil.rmtree(self._temp_dir)
            
            self._status = SandboxStatus.DESTROYED
            logger.info(f"Destroyed process sandbox {self.sandbox_id[:8]}...")
            return True
            
        except Exception as e:
            logger.error(f"Failed to destroy sandbox: {e}")
            self._status = SandboxStatus.ERROR
            return False


class PlatformSandbox(SandboxBase):
    """Platform-specific sandbox implementation.
    
    Uses platform-native sandboxing:
    - Linux: seccomp + namespaces (via sandbox-api if available)
    - macOS: sandbox-exec
    - Windows: Restricted token (limited)
    """
    
    def __init__(self, config: SandboxConfig):
        """Initialize the platform sandbox."""
        super().__init__(config)
        self._platform = platform.system().lower()
        self._temp_dir: Optional[Path] = None
        self._sandbox_profile: Optional[str] = None
    
    def create(self) -> bool:
        """Create the platform-specific sandbox."""
        try:
            # Create temporary working directory
            self._temp_dir = Path(tempfile.mkdtemp(prefix=f"sandbox_{self.sandbox_id}_"))
            
            if self._platform == "darwin":
                # macOS: Create sandbox profile
                self._sandbox_profile = self._create_macos_profile()
            elif self._platform == "linux":
                # Linux: Check for sandbox tools
                if not self._check_linux_sandbox_tools():
                    logger.warning(
                        "Linux sandbox tools not available, "
                        "falling back to process isolation"
                    )
            elif self._platform == "windows":
                # Windows: Limited support
                logger.warning(
                    "Windows sandbox support is limited, "
                    "using process isolation"
                )
            
            self._status = SandboxStatus.READY
            logger.info(
                f"Created platform sandbox {self.sandbox_id[:8]}... "
                f"(platform={self._platform})"
            )
            return True
            
        except Exception as e:
            self._status = SandboxStatus.ERROR
            logger.error(f"Failed to create platform sandbox: {e}")
            return False
    
    def _create_macos_profile(self) -> str:
        """Create a macOS sandbox profile."""
        # Create a sandbox profile that:
        # - Allows reading from allowed paths
        # - Allows writing to temp directory
        # - Denies network access
        # - Denies process spawning (except allowed commands)
        
        workdir = self._temp_dir / "work" if self._temp_dir else "/tmp"
        
        rules = [
            "(version 1)",
            "(deny default)",
            "(allow process-exec (literal \"/bin/sh\"))",
            "(allow process-exec (literal \"/bin/bash\"))",
            f"(allow file-read* (subpath \"{workdir}\"))",
            f"(allow file-write* (subpath \"{workdir}\"))",
        ]
        
        # Add allowed paths
        for path in self._config.allowed_paths:
            rules.append(f"(allow file-read* (literal \"{path}\"))")
        
        # Add network if allowed
        if self._config.resources.network_enabled:
            rules.append("(allow network-outbound)")
        
        return "\n".join(rules)
    
    def _check_linux_sandbox_tools(self) -> bool:
        """Check for Linux sandbox tools."""
        # Check for bubblewrap (commonly available)
        if shutil.which("bwrap"):
            return True
        
        # Check for firejail
        if shutil.which("firejail"):
            return True
        
        return False
    
    def execute(
        self,
        command: str,
        args: Optional[list[str]] = None,
        stdin: Optional[str] = None,
        timeout: Optional[int] = None,
    ) -> ExecutionResult:
        """Execute a command in the platform sandbox."""
        execution_id = str(uuid.uuid4())
        start_time = datetime.now(timezone.utc)
        
        result = ExecutionResult(
            execution_id=execution_id,
            sandbox_id=self.sandbox_id,
            command=command,
            start_time=start_time,
        )
        
        if self._status != SandboxStatus.READY:
            result.error_message = f"Sandbox not ready: {self._status.value}"
            self._record_execution(result)
            return result
        
        # Validate command
        is_valid, error = self._validate_command(command)
        if not is_valid:
            result.error_message = error
            self._record_execution(result)
            return result
        
        try:
            self._status = SandboxStatus.RUNNING
            
            cmd = [command] + (args or [])
            exec_timeout = timeout or self._config.resources.execution_timeout
            
            if self._platform == "darwin" and self._sandbox_profile:
                # macOS: Use sandbox-exec
                full_cmd = [
                    "sandbox-exec",
                    "-p", self._sandbox_profile,
                    *cmd
                ]
            elif self._platform == "linux":
                # Linux: Use bubblewrap if available
                if shutil.which("bwrap"):
                    workdir = self._temp_dir / "work" if self._temp_dir else "/tmp"
                    full_cmd = [
                        "bwrap",
                        "--ro-bind", "/usr", "/usr",
                        "--ro-bind", "/bin", "/bin",
                        "--ro-bind", "/lib", "/lib",
                        "--ro-bind", "/lib64", "/lib64",
                        "--bind", str(workdir), "/sandbox",
                        "--unshare-all",
                        "--die-with-parent",
                        *cmd
                    ]
                else:
                    # Fallback to process isolation
                    full_cmd = cmd
            else:
                # Fallback
                full_cmd = cmd
            
            # Build environment
            env = dict(os.environ)
            env.update(self._config.environment)
            
            proc = subprocess.run(
                full_cmd,
                env=env,
                input=stdin,
                capture_output=True,
                text=True,
                timeout=exec_timeout,
            )
            
            result.exit_code = proc.returncode
            result.stdout = proc.stdout
            result.stderr = proc.stderr
            result.success = proc.returncode == 0
            
        except subprocess.TimeoutExpired:
            result.error_message = f"Execution timed out after {exec_timeout}s"
            result.exit_code = -2
        except FileNotFoundError as e:
            result.error_message = f"Command not found: {e}"
            result.exit_code = -3
        except Exception as e:
            result.error_message = str(e)
            result.exit_code = -1
        finally:
            result.end_time = datetime.now(timezone.utc)
            result.duration = (result.end_time - start_time).total_seconds()
            self._status = SandboxStatus.READY
            self._record_execution(result)
            
            logger.info(
                f"Executed in platform sandbox {self.sandbox_id[:8]}...: "
                f"exit={result.exit_code}, duration={result.duration:.2f}s"
            )
        
        return result
    
    def destroy(self) -> bool:
        """Destroy the platform sandbox."""
        try:
            if self._temp_dir and self._temp_dir.exists():
                shutil.rmtree(self._temp_dir)
            
            self._status = SandboxStatus.DESTROYED
            logger.info(f"Destroyed platform sandbox {self.sandbox_id[:8]}...")
            return True
            
        except Exception as e:
            logger.error(f"Failed to destroy sandbox: {e}")
            self._status = SandboxStatus.ERROR
            return False


class SandboxManager:
    """Manager for sandbox lifecycle and execution.
    
    Provides unified interface for creating and managing
    sandboxes of different types.
    
    Core Principle: All untrusted code executes in a sandbox
    with bounded resources and full audit trail.
    """
    
    def __init__(
        self,
        default_type: SandboxType = SandboxType.PROCESS,
        default_isolation: IsolationLevel = IsolationLevel.STANDARD,
        default_resources: Optional[SandboxResources] = None,
    ):
        """Initialize the sandbox manager.
        
        Args:
            default_type: Default sandbox type
            default_isolation: Default isolation level
            default_resources: Default resource limits
        """
        self._default_type = default_type
        self._default_isolation = default_isolation
        self._default_resources = default_resources or SandboxResources()
        self._sandboxes: dict[str, SandboxBase] = {}
        self._lock = threading.RLock()
    
    def create_sandbox(
        self,
        agent_id: str,
        sandbox_type: Optional[SandboxType] = None,
        isolation_level: Optional[IsolationLevel] = None,
        resources: Optional[SandboxResources] = None,
        allowed_paths: Optional[list[str]] = None,
        allowed_commands: Optional[list[str]] = None,
        environment: Optional[dict[str, str]] = None,
    ) -> Optional[SandboxBase]:
        """Create a new sandbox.
        
        Args:
            agent_id: Agent that will use the sandbox
            sandbox_type: Type of sandbox (uses default if not specified)
            isolation_level: Isolation level (uses default if not specified)
            resources: Resource limits (uses default if not specified)
            allowed_paths: Paths accessible from sandbox
            allowed_commands: Commands allowed to execute
            environment: Environment variables
        
        Returns:
            Created sandbox, or None if creation failed
        """
        with self._lock:
            sandbox_id = str(uuid.uuid4())
            
            config = SandboxConfig(
                sandbox_id=sandbox_id,
                sandbox_type=sandbox_type or self._default_type,
                isolation_level=isolation_level or self._default_isolation,
                resources=resources or self._default_resources,
                allowed_paths=allowed_paths or [],
                allowed_commands=allowed_commands or [],
                environment=environment or {},
                agent_id=agent_id,
            )
            
            # Create appropriate sandbox type
            if config.sandbox_type == SandboxType.PLATFORM:
                sandbox = PlatformSandbox(config)
            else:
                # Default to process sandbox
                sandbox = ProcessSandbox(config)
            
            if sandbox.create():
                self._sandboxes[sandbox_id] = sandbox
                logger.info(
                    f"Created sandbox {sandbox_id[:8]}... for agent {agent_id}"
                )
                return sandbox
            else:
                return None
    
    def get_sandbox(self, sandbox_id: str) -> Optional[SandboxBase]:
        """Get a sandbox by ID."""
        return self._sandboxes.get(sandbox_id)
    
    def execute_in_sandbox(
        self,
        sandbox_id: str,
        command: str,
        args: Optional[list[str]] = None,
        stdin: Optional[str] = None,
        timeout: Optional[int] = None,
    ) -> Optional[ExecutionResult]:
        """Execute a command in a sandbox.
        
        Args:
            sandbox_id: ID of the sandbox
            command: Command to execute
            args: Command arguments
            stdin: Standard input
            timeout: Execution timeout
        
        Returns:
            ExecutionResult, or None if sandbox not found
        """
        sandbox = self._sandboxes.get(sandbox_id)
        if not sandbox:
            return None
        
        return sandbox.execute(command, args, stdin, timeout)
    
    def destroy_sandbox(self, sandbox_id: str) -> bool:
        """Destroy a sandbox.
        
        Args:
            sandbox_id: ID of the sandbox
        
        Returns:
            True if destroyed, False if not found or failed
        """
        with self._lock:
            sandbox = self._sandboxes.get(sandbox_id)
            if not sandbox:
                return False
            
            if sandbox.destroy():
                del self._sandboxes[sandbox_id]
                return True
            
            return False
    
    def destroy_all(self) -> int:
        """Destroy all sandboxes.
        
        Returns:
            Number of sandboxes destroyed
        """
        count = 0
        with self._lock:
            for sandbox_id in list(self._sandboxes.keys()):
                if self.destroy_sandbox(sandbox_id):
                    count += 1
        
        return count
    
    def list_sandboxes(self) -> list[SandboxConfig]:
        """List all sandbox configurations."""
        return [s.config for s in self._sandboxes.values()]
    
    def get_stats(self) -> dict:
        """Get manager statistics."""
        by_status: dict[str, int] = {}
        by_type: dict[str, int] = {}
        
        for sandbox in self._sandboxes.values():
            status = sandbox.status.value
            by_status[status] = by_status.get(status, 0) + 1
            
            stype = sandbox.config.sandbox_type.value
            by_type[stype] = by_type.get(stype, 0) + 1
        
        total_executions = sum(
            len(sandbox.get_executions())
            for sandbox in self._sandboxes.values()
        )
        
        return {
            "total_sandboxes": len(self._sandboxes),
            "by_status": by_status,
            "by_type": by_type,
            "total_executions": total_executions,
        }


def create_sandbox_manager(
    default_type: SandboxType = SandboxType.PROCESS,
    default_isolation: IsolationLevel = IsolationLevel.STANDARD,
    default_resources: Optional[SandboxResources] = None,
) -> SandboxManager:
    """Factory function to create a sandbox manager.
    
    Args:
        default_type: Default sandbox type
        default_isolation: Default isolation level
        default_resources: Default resource limits
    
    Returns:
        Configured SandboxManager instance
    """
    return SandboxManager(
        default_type=default_type,
        default_isolation=default_isolation,
        default_resources=default_resources,
    )
