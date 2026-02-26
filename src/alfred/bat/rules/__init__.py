"""
Default Risk Rules for Bat Protocol.

These rules provide baseline security for common operations.
They can be extended or overridden by custom rules.
"""

from ..risk import RiskRule, RiskLevel
from ..proposal import OperationProposal
import re
import os


# Sensitive path patterns that should be protected
SENSITIVE_PATHS = [
    r"^/etc/.*",                    # System configuration
    r"^~?/\.ssh/.*",                # SSH keys
    r"^~?/\.gnupg/.*",              # GPG keys
    r"^~?/\.aws/.*",                # AWS credentials
    r"^~?/\.config/.*credentials.*", # Credential files
    r"\.env$",                       # Environment files
    r"credentials",                  # Generic credentials
    r"secret",                       # Generic secrets
    r"\.pem$",                       # Certificate files
    r"\.key$",                       # Key files
    r"\.p12$",                       # PKCS12 files
    r"\.pfx$",                       # PFX files
    r"id_rsa",                       # SSH private keys
    r"id_ed25519",                   # Ed25519 private keys
    r"authorized_keys",              # SSH authorized keys
    r"known_hosts",                  # SSH known hosts
    r"\.netrc",                      # Netrc files
    r"\.pgp/.*",                     # PGP directory
]

# Remote code execution patterns (curl | bash, wget | sh, etc.)
RCE_PATTERNS = [
    r"curl.*\|.*(?:bash|sh|python|perl|ruby|php|node)",  # curl pipe to interpreter
    r"wget.*\|.*(?:bash|sh|python|perl|ruby|php|node)",  # wget pipe to interpreter
    r"eval\s+",                     # eval is dangerous
    r"exec\s+<",                    # exec with input redirection
    r"source\s+<(?:curl|wget)",     # source from remote
    r"\$\([^)]+\)",                 # Command substitution
    r"`[^`]+`",                     # Backtick command substitution
    r"&&\s*(?:curl|wget).*\|",      # Chained remote execution
    r"\|\s*(?:bash|sh|python|perl|ruby|php|node)\s*$",  # Pipe to interpreter at end
]

# Dangerous command patterns
DANGEROUS_COMMANDS = [
    r"rm\s+-rf\s+/(?!\w)",          # rm -rf / (but not /path/to/something)
    r"rm\s+-rf\s+~",                # rm -rf ~
    r"rm\s+-rf\s+\*",               # rm -rf *
    r"mkfs\.",                      # Format filesystem
    r"dd\s+if=.*of=/dev/",          # dd to device
    r":(){ :|:& };:",               # Fork bomb
    r"chmod\s+(-R\s+)?777\s+/",     # chmod 777 on root
    r"chown\s+.*\s+/",              # chown on root
    r">\s*/dev/sd",                 # Write to disk device
    r">\s*/dev/hd",                 # Write to disk device
]


def is_sensitive_path(path: str) -> bool:
    """Check if path matches sensitive patterns.

    Args:
        path: File path to check

    Returns:
        True if path is sensitive, False otherwise
    """
    if not path:
        return False

    # Expand user home directory
    expanded = os.path.expanduser(path)
    normalized = os.path.normpath(expanded)

    for pattern in SENSITIVE_PATHS:
        if re.search(pattern, normalized, re.IGNORECASE):
            return True
        if re.search(pattern, path, re.IGNORECASE):
            return True

    return False


def is_rce_command(command: str) -> bool:
    """Check if command matches remote code execution patterns.

    Args:
        command: Command string to check

    Returns:
        True if command is RCE pattern, False otherwise
    """
    if not command:
        return False

    for pattern in RCE_PATTERNS:
        if re.search(pattern, command, re.IGNORECASE):
            return True

    return False


def is_dangerous_command(command: str) -> bool:
    """Check if command matches dangerous patterns.

    Args:
        command: Command string to check

    Returns:
        True if command is dangerous, False otherwise
    """
    if not command:
        return False

    for pattern in DANGEROUS_COMMANDS:
        if re.search(pattern, command, re.IGNORECASE):
            return True

    return False


def is_within_vault(path: str, vault_root: str = None) -> bool:
    """Check if path is within the vault directory.

    Args:
        path: File path to check
        vault_root: Root directory of the vault (default: ~/vault)

    Returns:
        True if path is within vault, False otherwise
    """
    if not path:
        return False

    if vault_root is None:
        vault_root = os.path.expanduser("~/vault")
    else:
        vault_root = os.path.expanduser(vault_root)

    try:
        from pathlib import Path
        resolved_path = Path(path).expanduser().resolve()
        resolved_vault = Path(vault_root).expanduser().resolve()
        # relative_to raises ValueError if path is not within vault
        resolved_path.relative_to(resolved_vault)
        return True
    except ValueError:
        return False


# Default risk classification rules
# Sorted by priority (highest first)
DEFAULT_RULES = [
    # ============================================
    # L3 (High Risk) Rules - Priority 100
    # ============================================

    # Block writes to sensitive paths
    RiskRule(
        id="sensitive-path-write",
        predicate=lambda p: (
            p.operation_type == "write_file" and
            is_sensitive_path(p.target)
        ),
        level=RiskLevel.L3,
        rationale="Write to security-sensitive path detected",
        priority=100,
    ),

    # Block deletes of sensitive paths
    RiskRule(
        id="sensitive-path-delete",
        predicate=lambda p: (
            p.operation_type == "delete_file" and
            is_sensitive_path(p.target)
        ),
        level=RiskLevel.L3,
        rationale="Delete of security-sensitive path detected",
        priority=100,
    ),

    # Block remote code execution patterns
    RiskRule(
        id="rce-pattern",
        predicate=lambda p: (
            p.operation_type == "exec_command" and
            is_rce_command(p.metadata.get("command", ""))
        ),
        level=RiskLevel.L3,
        rationale="Remote code execution pattern detected",
        priority=100,
    ),

    # Block dangerous commands
    RiskRule(
        id="dangerous-command",
        predicate=lambda p: (
            p.operation_type == "exec_command" and
            is_dangerous_command(p.metadata.get("command", ""))
        ),
        level=RiskLevel.L3,
        rationale="Dangerous command pattern detected",
        priority=100,
    ),

    # Block network requests to sensitive URLs
    RiskRule(
        id="sensitive-network",
        predicate=lambda p: (
            p.operation_type == "network_request" and
            any(s in p.target.lower() for s in [
                "metadata.google",
                "169.254.169.254",  # Cloud metadata endpoints
                "localhost",
                "127.0.0.1",
            ])
        ),
        level=RiskLevel.L3,
        rationale="Network request to sensitive endpoint detected",
        priority=100,
    ),

    # ============================================
    # L3 (High Risk) Rules - Priority 50
    # ============================================

    # All exec commands default to L3
    RiskRule(
        id="exec-default-l3",
        predicate=lambda p: p.operation_type == "exec_command",
        level=RiskLevel.L3,
        rationale="Command execution requires explicit allowlist",
        priority=50,
    ),

    # Secret access is L3 by default
    RiskRule(
        id="secret-access-default",
        predicate=lambda p: p.operation_type == "secret_access",
        level=RiskLevel.L3,
        rationale="Secret access requires explicit allowlist",
        priority=50,
    ),

    # External API access is L3 by default
    RiskRule(
        id="external-api-default",
        predicate=lambda p: p.operation_type == "external_api",
        level=RiskLevel.L3,
        rationale="External API access requires explicit allowlist",
        priority=50,
    ),

    # Agent spawning is L3 by default
    RiskRule(
        id="agent-spawn-default",
        predicate=lambda p: p.operation_type == "agent_spawn",
        level=RiskLevel.L3,
        rationale="Agent spawning requires explicit allowlist",
        priority=50,
    ),

    # ============================================
    # L2 (Medium Risk) Rules - Priority 20
    # ============================================

    # File deletion outside vault is L2
    RiskRule(
        id="delete-outside-vault",
        predicate=lambda p: (
            p.operation_type == "delete_file" and
            not is_within_vault(p.target)
        ),
        level=RiskLevel.L2,
        rationale="File deletion outside vault requires confirmation",
        priority=20,
    ),

    # Network requests to non-HTTPS are L2
    RiskRule(
        id="non-https-request",
        predicate=lambda p: (
            p.operation_type == "network_request" and
            p.target.startswith("http://")
        ),
        level=RiskLevel.L2,
        rationale="Non-HTTPS network request requires confirmation",
        priority=20,
    ),

    # ============================================
    # L1 (Low Risk) Rules - Priority 10
    # ============================================

    # Inbox writes are L1
    RiskRule(
        id="inbox-write-l1",
        predicate=lambda p: (
            p.operation_type == "write_file" and
            "inbox" in p.target.lower()
        ),
        level=RiskLevel.L1,
        rationale="Inbox write within normal operation",
        priority=10,
    ),

    # Note creation is L1
    RiskRule(
        id="note-create-l1",
        predicate=lambda p: (
            p.operation_type == "write_file" and
            "note/" in p.target.lower()
        ),
        level=RiskLevel.L1,
        rationale="Note creation within normal operation",
        priority=10,
    ),

    # Session writes are L1
    RiskRule(
        id="session-write-l1",
        predicate=lambda p: (
            p.operation_type == "write_file" and
            "session/" in p.target.lower()
        ),
        level=RiskLevel.L1,
        rationale="Session write within normal operation",
        priority=10,
    ),

    # Conversation writes are L1
    RiskRule(
        id="conversation-write-l1",
        predicate=lambda p: (
            p.operation_type == "write_file" and
            "conversation/" in p.target.lower()
        ),
        level=RiskLevel.L1,
        rationale="Conversation write within normal operation",
        priority=10,
    ),

    # Project writes are L1
    RiskRule(
        id="project-write-l1",
        predicate=lambda p: (
            p.operation_type == "write_file" and
            "project/" in p.target.lower()
        ),
        level=RiskLevel.L1,
        rationale="Project write within normal operation",
        priority=10,
    ),

    # Task writes are L1
    RiskRule(
        id="task-write-l1",
        predicate=lambda p: (
            p.operation_type == "write_file" and
            "task/" in p.target.lower()
        ),
        level=RiskLevel.L1,
        rationale="Task write within normal operation",
        priority=10,
    ),

    # Read operations within vault are L1
    RiskRule(
        id="vault-read-l1",
        predicate=lambda p: (
            p.operation_type == "read_file" and
            is_within_vault(p.target)
        ),
        level=RiskLevel.L1,
        rationale="Vault read within normal operation",
        priority=10,
    ),

    # ============================================
    # L1 (Low Risk) Rules - Priority 5
    # ============================================

    # All read operations default to L1
    RiskRule(
        id="read-default-l1",
        predicate=lambda p: p.operation_type == "read_file",
        level=RiskLevel.L1,
        rationale="Read operations are generally safe",
        priority=5,
    ),
]


def get_default_rules() -> list[RiskRule]:
    """Get the default risk classification rules.

    Returns:
        List of RiskRule instances
    """
    return DEFAULT_RULES.copy()


def create_custom_rules(
    additional_rules: list[RiskRule] = None,
    exclude_rule_ids: list[str] = None,
) -> list[RiskRule]:
    """Create a custom rule set based on defaults.

    Args:
        additional_rules: Rules to add to the defaults
        exclude_rule_ids: IDs of default rules to exclude

    Returns:
        List of RiskRule instances
    """
    rules = DEFAULT_RULES.copy()

    # Exclude specified rules
    if exclude_rule_ids:
        rules = [r for r in rules if r.id not in exclude_rule_ids]

    # Add additional rules
    if additional_rules:
        rules.extend(additional_rules)

    return rules
