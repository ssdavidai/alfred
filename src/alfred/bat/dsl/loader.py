"""
Rule Loader - Load and hot-reload risk rules from files.

Supports:
- Loading rules from YAML files
- Hot-reloading with file watching
- Rule validation before loading
"""

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional
import yaml

from ..risk import RiskRule
from .parser import DSLParser, DSLError, validate_rules_file


logger = logging.getLogger(__name__)


class RuleLoadError(Exception):
    """Raised when rule loading fails."""
    pass


@dataclass
class RuleSet:
    """A loaded set of rules with metadata."""
    name: str
    version: str
    rules: list[RiskRule]
    source_path: Optional[Path]
    loaded_at: datetime
    checksum: str

    def __len__(self) -> int:
        return len(self.rules)


class RuleLoader:
    """Load and manage risk rules from files.

    Features:
    - Load rules from YAML files
    - Validate rules before loading
    - Track loaded rule sets
    - Support hot-reload via checksum comparison

    Example:
        >>> loader = RuleLoader()
        >>> ruleset = loader.load(Path("rules.yaml"))
        >>> print(f"Loaded {len(ruleset)} rules")
    """

    def __init__(self, parser: Optional[DSLParser] = None):
        """Initialize the rule loader.

        Args:
            parser: DSL parser to use (default: create new)
        """
        self._parser = parser or DSLParser()
        self._loaded: dict[str, RuleSet] = {}
        self._on_reload_callbacks: list[Callable[[RuleSet], None]] = []

    def load(self, path: Path) -> RuleSet:
        """Load rules from a YAML file.

        Args:
            path: Path to the YAML file

        Returns:
            RuleSet with loaded rules

        Raises:
            RuleLoadError: If loading fails
        """
        path = Path(path).resolve()

        # Validate first
        is_valid, errors = validate_rules_file(path)
        if not is_valid:
            raise RuleLoadError(f"Invalid rules file: {'; '.join(errors)}")

        # Calculate checksum
        checksum = self._calculate_checksum(path)

        # Check if already loaded with same checksum
        existing = self._loaded.get(str(path))
        if existing and existing.checksum == checksum:
            logger.debug(f"Rules file {path} unchanged (checksum match)")
            return existing

        # Parse rules
        try:
            rules = self._parser.parse_file(path)
        except DSLError as e:
            raise RuleLoadError(f"Failed to parse {path}: {e}")

        # Create rule set
        ruleset = RuleSet(
            name=self._parser.metadata.get("name", path.stem),
            version=self._parser.metadata.get("version", "0.0.0"),
            rules=rules,
            source_path=path,
            loaded_at=datetime.now(timezone.utc),
            checksum=checksum,
        )

        # Store
        self._loaded[str(path)] = ruleset

        logger.info(
            f"Loaded {len(rules)} rules from {path} "
            f"(name={ruleset.name}, version={ruleset.version})"
        )

        return ruleset

    def reload(self, path: Path) -> tuple[RuleSet, bool]:
        """Reload rules from a file if changed.

        Args:
            path: Path to the YAML file

        Returns:
            Tuple of (RuleSet, was_reloaded)
        """
        path = Path(path).resolve()
        existing = self._loaded.get(str(path))

        if existing:
            checksum = self._calculate_checksum(path)
            if checksum == existing.checksum:
                return existing, False

        ruleset = self.load(path)

        # Notify callbacks
        for callback in self._on_reload_callbacks:
            try:
                callback(ruleset)
            except Exception as e:
                logger.error(f"Reload callback failed: {e}")

        return ruleset, True

    def load_directory(self, directory: Path, pattern: str = "*.yaml") -> list[RuleSet]:
        """Load all rule files from a directory.

        Args:
            directory: Directory to scan
            pattern: Glob pattern for rule files

        Returns:
            List of loaded RuleSets
        """
        directory = Path(directory)
        if not directory.is_dir():
            raise RuleLoadError(f"Not a directory: {directory}")

        rulesets = []
        for path in directory.glob(pattern):
            try:
                ruleset = self.load(path)
                rulesets.append(ruleset)
            except RuleLoadError as e:
                logger.warning(f"Failed to load {path}: {e}")

        return rulesets

    def get_all_rules(self) -> list[RiskRule]:
        """Get all loaded rules from all rule sets.

        Returns:
            Combined list of all rules
        """
        rules = []
        for ruleset in self._loaded.values():
            rules.extend(ruleset.rules)
        return rules

    def get_ruleset(self, path: Path) -> Optional[RuleSet]:
        """Get a loaded rule set by path.

        Args:
            path: Path to the rules file

        Returns:
            RuleSet if loaded, None otherwise
        """
        return self._loaded.get(str(Path(path).resolve()))

    def on_reload(self, callback: Callable[[RuleSet], None]) -> None:
        """Register a callback for rule reloads.

        Args:
            callback: Function to call when rules are reloaded
        """
        self._on_reload_callbacks.append(callback)

    def clear(self) -> None:
        """Clear all loaded rules."""
        self._loaded.clear()

    def _calculate_checksum(self, path: Path) -> str:
        """Calculate SHA-256 checksum of a file."""
        sha256 = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                sha256.update(chunk)
        return sha256.hexdigest()

    def get_status(self) -> dict:
        """Get loader status.

        Returns:
            Dictionary with loader status
        """
        return {
            "loaded_files": len(self._loaded),
            "total_rules": sum(len(rs) for rs in self._loaded.values()),
            "rulesets": [
                {
                    "name": rs.name,
                    "version": rs.version,
                    "rules": len(rs),
                    "source": str(rs.source_path) if rs.source_path else None,
                    "loaded_at": rs.loaded_at.isoformat(),
                    "checksum": rs.checksum[:8] + "...",
                }
                for rs in self._loaded.values()
            ],
        }


def create_default_rules_file(path: Path) -> None:
    """Create a default rules file.

    Args:
        path: Path to create the file at
    """
    default_rules = {
        "metadata": {
            "version": "1.0.0",
            "name": "default-rules",
            "description": "Default risk classification rules for Alfred",
        },
        "rules": [
            {
                "id": "sensitive-path-write",
                "description": "Block writes to security-sensitive paths",
                "priority": 100,
                "when": {
                    "operation_type": "write_file",
                    "target": {
                        "matches_any": [
                            "/etc/**",
                            "~/.ssh/**",
                            "~/.gnupg/**",
                            "~/.aws/**",
                            "**/.env",
                            "**/credentials*",
                            "**/*.pem",
                            "**/*.key",
                        ]
                    },
                },
                "then": {
                    "risk": "L3",
                    "rationale": "Write to security-sensitive path",
                },
            },
            {
                "id": "rce-pattern",
                "description": "Block remote code execution patterns",
                "priority": 100,
                "when": {
                    "operation_type": "exec_command",
                    "metadata.command": {
                        "matches_regex": r"curl.*\|.*(?:bash|sh|python|perl|ruby)"
                    },
                },
                "then": {
                    "risk": "L3",
                    "rationale": "Remote code execution pattern detected",
                },
            },
            {
                "id": "exec-default-l3",
                "description": "Default command execution to L3",
                "priority": 50,
                "when": {
                    "operation_type": "exec_command"
                },
                "then": {
                    "risk": "L3",
                    "rationale": "Command execution requires explicit allowlist",
                },
            },
            {
                "id": "inbox-write-l1",
                "description": "Inbox writes are low risk",
                "priority": 10,
                "when": {
                    "operation_type": "write_file",
                    "target": {"contains": "inbox"},
                },
                "then": {
                    "risk": "L1",
                    "rationale": "Inbox write within normal operation",
                },
            },
            {
                "id": "note-create-l1",
                "description": "Note creation is low risk",
                "priority": 10,
                "when": {
                    "operation_type": "write_file",
                    "target": {"contains": "note/"},
                },
                "then": {
                    "risk": "L1",
                    "rationale": "Note creation within normal operation",
                },
            },
            {
                "id": "read-default-l1",
                "description": "Read operations are generally safe",
                "priority": 5,
                "when": {
                    "operation_type": "read_file"
                },
                "then": {
                    "risk": "L1",
                    "rationale": "Read operations are generally safe",
                },
            },
        ],
        "allowlists": {
            "safe_commands": [
                "echo *",
                "cat *",
                "ls *",
                "pwd",
                "date",
                "which *",
                "git status",
                "git log *",
            ]
        },
    }

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    with open(path, "w", encoding="utf-8") as f:
        yaml.dump(default_rules, f, default_flow_style=False, sort_keys=False)

    logger.info(f"Created default rules file at {path}")
