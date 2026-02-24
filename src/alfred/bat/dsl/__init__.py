"""
Bat Protocol DSL - Declarative Risk Rules.

This module provides a YAML-based DSL for defining risk classification rules.
Rules are version-controllable, human-readable, and can be hot-reloaded.

Example rules.yaml:
    metadata:
      version: "1.0.0"
      name: "default-rules"

    rules:
      - id: "sensitive-path-write"
        priority: 100
        when:
          operation_type: "write_file"
          target:
            matches_any:
              - "~/.ssh/**"
              - "**/.env"
        then:
          risk: L3
          rationale: "Write to security-sensitive path"

    allowlists:
      safe_commands:
        - "echo *"
        - "ls *"
"""

from .parser import DSLParser, DSLRule
from .loader import RuleLoader, RuleLoadError

__all__ = [
    "DSLParser",
    "DSLRule",
    "RuleLoader",
    "RuleLoadError",
]
