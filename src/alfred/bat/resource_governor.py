"""
Resource Governor - Resource controls and safe deserialization.

Implements SECURITY ELEVATION Track D:
- Rate limits
- Metadata size caps
- Queue depth caps
- Temporal window bounds
- Ledger rotation
- Safe deserialization controls

Core Principle: Governance resource consumption is bounded.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, Any, Callable
from collections import deque
import json
import logging
import os
import threading
import time

logger = logging.getLogger(__name__)


class ResourceLimitExceeded(Exception):
    """Raised when a resource limit is exceeded."""
    pass


class DeserializationError(Exception):
    """Raised when unsafe deserialization is attempted."""
    pass


@dataclass
class ResourceLimits:
    """Configuration for resource limits.
    
    Attributes:
        max_proposals_per_second: Maximum proposals per second per agent
        max_proposals_per_minute: Maximum proposals per minute per agent
        max_proposals_per_hour: Maximum proposals per hour globally
        max_metadata_size_bytes: Maximum size of proposal metadata
        max_queue_depth: Maximum pending proposals in queue
        max_ledger_size_mb: Maximum ledger file size in MB
        max_ledger_age_days: Maximum age of ledger entries before rotation
        max_temporal_window_hours: Maximum temporal window for analysis
    """
    max_proposals_per_second: int = 10
    max_proposals_per_minute: int = 100
    max_proposals_per_hour: int = 1000
    max_metadata_size_bytes: int = 65536  # 64 KB
    max_queue_depth: int = 1000
    max_ledger_size_mb: int = 100
    max_ledger_age_days: int = 30
    max_temporal_window_hours: int = 24
    
    @classmethod
    def personal(cls) -> "ResourceLimits":
        """Limits for personal mode (relaxed)."""
        return cls(
            max_proposals_per_second=20,
            max_proposals_per_minute=200,
            max_proposals_per_hour=2000,
            max_metadata_size_bytes=131072,  # 128 KB
            max_queue_depth=2000,
            max_ledger_size_mb=500,
            max_ledger_age_days=90,
        )
    
    @classmethod
    def secure(cls) -> "ResourceLimits":
        """Limits for secure mode (default)."""
        return cls()
    
    @classmethod
    def enterprise(cls) -> "ResourceLimits":
        """Limits for enterprise mode (strict)."""
        return cls(
            max_proposals_per_second=5,
            max_proposals_per_minute=50,
            max_proposals_per_hour=500,
            max_metadata_size_bytes=32768,  # 32 KB
            max_queue_depth=500,
            max_ledger_size_mb=50,
            max_ledger_age_days=7,
        )


@dataclass
class RateLimitEntry:
    """Entry for rate limit tracking."""
    timestamp: float
    agent_id: str
    operation: str


class RateLimiter:
    """Rate limiter for governance operations.
    
    Implements sliding window rate limiting for:
    - Per-second limits (agent-specific)
    - Per-minute limits (agent-specific)
    - Per-hour limits (global)
    """
    
    def __init__(self, limits: ResourceLimits):
        """Initialize the rate limiter.
        
        Args:
            limits: Resource limits configuration
        """
        self._limits = limits
        self._second_window: dict[str, deque[float]] = {}
        self._minute_window: dict[str, deque[float]] = {}
        self._hour_window: deque[float] = deque()
        self._lock = threading.Lock()
    
    def check_and_record(
        self,
        agent_id: str,
        operation: str = "proposal",
    ) -> tuple[bool, str]:
        """Check if an operation is allowed and record it.
        
        Args:
            agent_id: Agent making the request
            operation: Operation type
        
        Returns:
            Tuple of (allowed, reason)
        """
        now = time.time()
        
        with self._lock:
            # Clean old entries
            self._clean_old_entries(now)
            
            # Check per-second limit
            second_key = f"{agent_id}:{operation}"
            second_count = len(self._second_window.get(second_key, deque()))
            if second_count >= self._limits.max_proposals_per_second:
                return False, f"Rate limit exceeded: {self._limits.max_proposals_per_second}/second"
            
            # Check per-minute limit
            minute_count = len(self._minute_window.get(agent_id, deque()))
            if minute_count >= self._limits.max_proposals_per_minute:
                return False, f"Rate limit exceeded: {self._limits.max_proposals_per_minute}/minute"
            
            # Check per-hour limit (global)
            hour_count = len(self._hour_window)
            if hour_count >= self._limits.max_proposals_per_hour:
                return False, f"Global rate limit exceeded: {self._limits.max_proposals_per_hour}/hour"
            
            # Record the operation
            if second_key not in self._second_window:
                self._second_window[second_key] = deque()
            self._second_window[second_key].append(now)
            
            if agent_id not in self._minute_window:
                self._minute_window[agent_id] = deque()
            self._minute_window[agent_id].append(now)
            
            self._hour_window.append(now)
            
            return True, ""
    
    def _clean_old_entries(self, now: float) -> None:
        """Remove entries outside the time windows."""
        # Clean second window (keep last 2 seconds for safety margin)
        for key in list(self._second_window.keys()):
            while self._second_window[key] and now - self._second_window[key][0] > 2:
                self._second_window[key].popleft()
        
        # Clean minute window (keep last 70 seconds for safety margin)
        for key in list(self._minute_window.keys()):
            while self._minute_window[key] and now - self._minute_window[key][0] > 70:
                self._minute_window[key].popleft()
        
        # Clean hour window (keep last 3700 seconds for safety margin)
        while self._hour_window and now - self._hour_window[0] > 3700:
            self._hour_window.popleft()
    
    def get_usage(self, agent_id: str) -> dict:
        """Get current rate limit usage for an agent."""
        now = time.time()
        self._clean_old_entries(now)
        
        return {
            "per_second": len(self._second_window.get(agent_id, deque())),
            "per_minute": len(self._minute_window.get(agent_id, deque())),
            "per_hour": len(self._hour_window),
            "limits": {
                "per_second": self._limits.max_proposals_per_second,
                "per_minute": self._limits.max_proposals_per_minute,
                "per_hour": self._limits.max_proposals_per_hour,
            },
        }


class MetadataValidator:
    """Validator for proposal metadata size."""
    
    def __init__(self, max_size_bytes: int = 65536):
        """Initialize the validator.
        
        Args:
            max_size_bytes: Maximum metadata size in bytes
        """
        self._max_size = max_size_bytes
    
    def validate(self, metadata: dict) -> tuple[bool, str]:
        """Validate metadata size.
        
        Args:
            metadata: Metadata dictionary to validate
        
        Returns:
            Tuple of (valid, reason)
        """
        try:
            serialized = json.dumps(metadata, default=str)
            size = len(serialized.encode('utf-8'))
            
            if size > self._max_size:
                return False, f"Metadata size {size} exceeds limit {self._max_size}"
            
            return True, ""
        except (TypeError, ValueError) as e:
            return False, f"Metadata serialization failed: {e}"


class QueueDepthMonitor:
    """Monitor for proposal queue depth."""
    
    def __init__(self, max_depth: int = 1000):
        """Initialize the monitor.
        
        Args:
            max_depth: Maximum queue depth
        """
        self._max_depth = max_depth
        self._current_depth = 0
        self._lock = threading.Lock()
    
    def acquire(self) -> tuple[bool, str]:
        """Attempt to acquire a queue slot.
        
        Returns:
            Tuple of (acquired, reason)
        """
        with self._lock:
            if self._current_depth >= self._max_depth:
                return False, f"Queue depth {self._current_depth} exceeds limit {self._max_depth}"
            self._current_depth += 1
            return True, ""
    
    def release(self) -> None:
        """Release a queue slot."""
        with self._lock:
            self._current_depth = max(0, self._current_depth - 1)
    
    def get_depth(self) -> int:
        """Get current queue depth."""
        with self._lock:
            return self._current_depth


class LedgerRotator:
    """Rotates ledger files based on size and age."""
    
    def __init__(
        self,
        ledger_path: Path,
        max_size_mb: int = 100,
        max_age_days: int = 30,
    ):
        """Initialize the ledger rotator.
        
        Args:
            ledger_path: Path to the ledger file
            max_size_mb: Maximum size in MB before rotation
            max_age_days: Maximum age in days before rotation
        """
        self._path = Path(ledger_path)
        self._max_size = max_size_mb * 1024 * 1024
        self._max_age = timedelta(days=max_age_days)
    
    def check_rotation_needed(self) -> tuple[bool, str]:
        """Check if ledger rotation is needed.
        
        Returns:
            Tuple of (needs_rotation, reason)
        """
        if not self._path.exists():
            return False, ""
        
        # Check size
        size = self._path.stat().st_size
        if size > self._max_size:
            return True, f"Ledger size {size / 1024 / 1024:.1f}MB exceeds limit"
        
        # Check age
        mtime = datetime.fromtimestamp(self._path.stat().st_mtime, tz=timezone.utc)
        age = datetime.now(timezone.utc) - mtime
        if age > self._max_age:
            return True, f"Ledger age {age.days} days exceeds limit"
        
        return False, ""
    
    def rotate(self) -> Optional[Path]:
        """Rotate the ledger file.
        
        Returns:
            Path to the rotated file, or None if no rotation
        """
        needs_rotation, reason = self.check_rotation_needed()
        if not needs_rotation:
            return None
        
        # Generate rotated filename
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        rotated_path = self._path.with_suffix(f".{timestamp}.jsonl")
        
        # Move the file
        self._path.rename(rotated_path)
        
        logger.warning(f"Rotated ledger: {reason} -> {rotated_path}")
        
        return rotated_path


class SafeDeserializer:
    """Safe deserialization controls.
    
    BLOCKS unsafe deserialization methods:
    - pickle
    - eval/exec/compile
    - yaml.load (unsafe)
    
    Core Principle: Deserialization is always safe.
    """
    
    BLOCKED_MODULES = {"pickle", "marshal", "shelve"}
    BLOCKED_FUNCTIONS = {"eval", "exec", "compile", "__import__"}
    
    @classmethod
    def safe_yaml_load(cls, data: str) -> dict:
        """Safely load YAML data.
        
        Uses yaml.safe_load to prevent code execution.
        
        Args:
            data: YAML string
        
        Returns:
            Parsed dictionary
        
        Raises:
            DeserializationError: If loading fails
        """
        try:
            import yaml
            return yaml.safe_load(data)
        except ImportError:
            raise DeserializationError("PyYAML not installed")
        except yaml.YAMLError as e:
            raise DeserializationError(f"YAML parsing failed: {e}")
    
    @classmethod
    def safe_json_load(cls, data: str) -> Any:
        """Safely load JSON data.
        
        Args:
            data: JSON string
        
        Returns:
            Parsed data
        
        Raises:
            DeserializationError: If loading fails
        """
        try:
            return json.loads(data)
        except json.JSONDecodeError as e:
            raise DeserializationError(f"JSON parsing failed: e")
    
    @classmethod
    def check_code_path(cls, module_name: str, function_name: str) -> bool:
        """Check if a function is in a blocked path.
        
        Args:
            module_name: Module name
            function_name: Function name
        
        Returns:
            True if the path is blocked
        """
        if module_name in cls.BLOCKED_MODULES:
            return True
        if function_name in cls.BLOCKED_FUNCTIONS:
            return True
        return False
    
    @classmethod
    def validate_import(cls, module_name: str) -> tuple[bool, str]:
        """Validate that an import is safe.
        
        Args:
            module_name: Module to import
        
        Returns:
            Tuple of (is_safe, reason)
        """
        if module_name in cls.BLOCKED_MODULES:
            return False, f"Import of '{module_name}' is blocked for security"
        return True, ""


class ResourceGovernor:
    """Comprehensive resource governance.
    
    Combines all resource controls:
    - Rate limiting
    - Metadata validation
    - Queue depth monitoring
    - Ledger rotation
    - Safe deserialization
    """
    
    def __init__(
        self,
        limits: ResourceLimits,
        ledger_path: Optional[Path] = None,
    ):
        """Initialize the resource governor.
        
        Args:
            limits: Resource limits configuration
            ledger_path: Path to the ledger file (for rotation)
        """
        self._limits = limits
        self._rate_limiter = RateLimiter(limits)
        self._metadata_validator = MetadataValidator(limits.max_metadata_size_bytes)
        self._queue_monitor = QueueDepthMonitor(limits.max_queue_depth)
        self._ledger_rotator = LedgerRotator(
            ledger_path,
            limits.max_ledger_size_mb,
            limits.max_ledger_age_days,
        ) if ledger_path else None
    
    @property
    def limits(self) -> ResourceLimits:
        """Get the current limits."""
        return self._limits
    
    def check_rate_limit(
        self,
        agent_id: str,
        operation: str = "proposal",
    ) -> tuple[bool, str]:
        """Check rate limits for an operation."""
        return self._rate_limiter.check_and_record(agent_id, operation)
    
    def validate_metadata(self, metadata: dict) -> tuple[bool, str]:
        """Validate metadata size."""
        return self._metadata_validator.validate(metadata)
    
    def acquire_queue_slot(self) -> tuple[bool, str]:
        """Acquire a queue slot."""
        return self._queue_monitor.acquire()
    
    def release_queue_slot(self) -> None:
        """Release a queue slot."""
        self._queue_monitor.release()
    
    def check_ledger_rotation(self) -> tuple[bool, str]:
        """Check if ledger rotation is needed."""
        if self._ledger_rotator:
            return self._ledger_rotator.check_rotation_needed()
        return False, ""
    
    def rotate_ledger(self) -> Optional[Path]:
        """Rotate the ledger if needed."""
        if self._ledger_rotator:
            return self._ledger_rotator.rotate()
        return None
    
    def get_status(self) -> dict:
        """Get the current status of all resource controls."""
        return {
            "limits": {
                "per_second": self._limits.max_proposals_per_second,
                "per_minute": self._limits.max_proposals_per_minute,
                "per_hour": self._limits.max_proposals_per_hour,
                "metadata_size": self._limits.max_metadata_size_bytes,
                "queue_depth": self._limits.max_queue_depth,
                "ledger_size_mb": self._limits.max_ledger_size_mb,
            },
            "queue_depth": self._queue_monitor.get_depth(),
        }
    
    def check_all(
        self,
        agent_id: str,
        metadata: Optional[dict] = None,
    ) -> tuple[bool, list[str]]:
        """Check all resource limits.
        
        Args:
            agent_id: Agent making the request
            metadata: Metadata to validate (optional)
        
        Returns:
            Tuple of (all_passed, list_of_errors)
        """
        errors = []
        
        # Check rate limit
        allowed, reason = self.check_rate_limit(agent_id)
        if not allowed:
            errors.append(reason)
        
        # Check metadata
        if metadata:
            valid, reason = self.validate_metadata(metadata)
            if not valid:
                errors.append(reason)
        
        # Check queue depth
        acquired, reason = self.acquire_queue_slot()
        if not acquired:
            errors.append(reason)
        else:
            self.release_queue_slot()  # Release immediately, just checking
        
        return len(errors) == 0, errors


def create_resource_governor(
    limits: Optional[ResourceLimits] = None,
    ledger_path: Optional[Path] = None,
) -> ResourceGovernor:
    """Factory function to create a resource governor.
    
    Args:
        limits: Resource limits (default: secure mode)
        ledger_path: Path to ledger file
    
    Returns:
        Configured ResourceGovernor instance
    """
    if limits is None:
        limits = ResourceLimits.secure()
    
    return ResourceGovernor(limits=limits, ledger_path=ledger_path)
