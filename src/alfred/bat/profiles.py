"""
Configurable Profiles - Pre-configured governance profiles.

Provides three profiles:
- personal: Relaxed governance for personal use
- secure: Balanced governance for security-conscious users
- enterprise: Strict governance for organizational use
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional
import logging

from .enforcement import EnforcementPolicy, EnforcementMode, Action
from .risk import RiskLevel


logger = logging.getLogger(__name__)


class ProfileName(Enum):
    """Available governance profiles."""
    PERSONAL = "personal"
    SECURE = "secure"
    ENTERPRISE = "enterprise"


@dataclass
class BatProfile:
    """Pre-configured governance profile.

    Profiles define default settings for:
    - Enforcement mode
    - Risk level handling
    - Temporal analysis
    - Break-glass availability
    - Audit retention
    """

    name: ProfileName
    description: str
    default_mode: EnforcementMode
    l1_action: Action
    l2_action: Action
    l3_action: Action
    enable_temporal_analysis: bool
    enable_break_glass: bool
    enable_path_hardening: bool
    ledger_retention_days: int
    max_operations_per_minute: int

    def create_policy(self, version: str = "1.0") -> EnforcementPolicy:
        """Create an enforcement policy from this profile.

        Args:
            version: Policy version string

        Returns:
            EnforcementPolicy configured for this profile
        """
        return EnforcementPolicy(
            version=version,
            mode=self.default_mode,
            l1_action=self.l1_action,
            l2_action=self.l2_action,
            l3_action=self.l3_action,
        )

    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return {
            "name": self.name.value,
            "description": self.description,
            "default_mode": self.default_mode.value,
            "l1_action": self.l1_action.value,
            "l2_action": self.l2_action.value,
            "l3_action": self.l3_action.value,
            "enable_temporal_analysis": self.enable_temporal_analysis,
            "enable_break_glass": self.enable_break_glass,
            "enable_path_hardening": self.enable_path_hardening,
            "ledger_retention_days": self.ledger_retention_days,
            "max_operations_per_minute": self.max_operations_per_minute,
        }


# Pre-defined profiles
PROFILES = {
    ProfileName.PERSONAL: BatProfile(
        name=ProfileName.PERSONAL,
        description=(
            "Relaxed governance for personal use. "
            "Logs all operations but blocks only high-risk. "
            "Suitable for single-user development environments."
        ),
        default_mode=EnforcementMode.PASSIVE,
        l1_action=Action.ALLOW,
        l2_action=Action.LOG,
        l3_action=Action.LOG,  # Even L3 is logged, not blocked
        enable_temporal_analysis=False,
        enable_break_glass=False,
        enable_path_hardening=True,
        ledger_retention_days=30,
        max_operations_per_minute=1000,
    ),

    ProfileName.SECURE: BatProfile(
        name=ProfileName.SECURE,
        description=(
            "Balanced governance for security-conscious users. "
            "Blocks high-risk operations, requires confirmation for medium-risk. "
            "Suitable for production personal systems."
        ),
        default_mode=EnforcementMode.ENFORCE,
        l1_action=Action.ALLOW,
        l2_action=Action.REQUIRE_CONFIRMATION,
        l3_action=Action.BLOCK,
        enable_temporal_analysis=True,
        enable_break_glass=True,
        enable_path_hardening=True,
        ledger_retention_days=90,
        max_operations_per_minute=100,
    ),

    ProfileName.ENTERPRISE: BatProfile(
        name=ProfileName.ENTERPRISE,
        description=(
            "Strict governance for organizational use. "
            "Maximum audit and control. All operations require logging. "
            "Suitable for multi-user or regulated environments."
        ),
        default_mode=EnforcementMode.ENFORCE,
        l1_action=Action.LOG,  # Even L1 is logged
        l2_action=Action.REQUIRE_CONFIRMATION,
        l3_action=Action.BLOCK,
        enable_temporal_analysis=True,
        enable_break_glass=True,
        enable_path_hardening=True,
        ledger_retention_days=365,
        max_operations_per_minute=50,
    ),
}


def get_profile(name: str) -> BatProfile:
    """Get a profile by name.

    Args:
        name: Profile name (personal, secure, enterprise)

    Returns:
        BatProfile instance

    Raises:
        ValueError: If profile name is unknown
    """
    try:
        return PROFILES[ProfileName(name.lower())]
    except ValueError:
        valid_names = [p.value for p in ProfileName]
        raise ValueError(f"Unknown profile: {name}. Valid profiles: {valid_names}")


def list_profiles() -> list[BatProfile]:
    """Get all available profiles.

    Returns:
        List of all profiles
    """
    return list(PROFILES.values())


def get_default_profile() -> BatProfile:
    """Get the default profile.

    Returns:
        Default profile (secure)
    """
    return PROFILES[ProfileName.SECURE]


def create_custom_profile(
    name: str,
    description: str,
    base_profile: Optional[str] = None,
    **overrides,
) -> BatProfile:
    """Create a custom profile based on an existing one.

    Args:
        name: Profile name
        description: Profile description
        base_profile: Base profile to inherit from
        **overrides: Fields to override

    Returns:
        Custom BatProfile instance
    """
    # Start with base profile
    if base_profile:
        base = get_profile(base_profile)
        base_dict = {
            "name": ProfileName(name.lower()),  # Will fail enum validation
            "description": description,
            "default_mode": base.default_mode,
            "l1_action": base.l1_action,
            "l2_action": base.l2_action,
            "l3_action": base.l3_action,
            "enable_temporal_analysis": base.enable_temporal_analysis,
            "enable_break_glass": base.enable_break_glass,
            "enable_path_hardening": base.enable_path_hardening,
            "ledger_retention_days": base.ledger_retention_days,
            "max_operations_per_minute": base.max_operations_per_minute,
        }
    else:
        base_dict = {
            "name": ProfileName(name.lower()),
            "description": description,
            "default_mode": EnforcementMode.ENFORCE,
            "l1_action": Action.ALLOW,
            "l2_action": Action.REQUIRE_CONFIRMATION,
            "l3_action": Action.BLOCK,
            "enable_temporal_analysis": True,
            "enable_break_glass": True,
            "enable_path_hardening": True,
            "ledger_retention_days": 90,
            "max_operations_per_minute": 100,
        }

    # Apply overrides
    for key, value in overrides.items():
        if key in base_dict:
            base_dict[key] = value
        else:
            logger.warning(f"Unknown profile field: {key}")

    return BatProfile(**base_dict)


def profile_from_dict(data: dict) -> BatProfile:
    """Create a profile from a dictionary.

    Args:
        data: Dictionary with profile settings

    Returns:
        BatProfile instance
    """
    # Parse enums
    name = ProfileName(data.get("name", "custom"))
    default_mode = EnforcementMode(data.get("default_mode", "enforce"))
    l1_action = Action(data.get("l1_action", "allow"))
    l2_action = Action(data.get("l2_action", "require_confirmation"))
    l3_action = Action(data.get("l3_action", "block"))

    return BatProfile(
        name=name,
        description=data.get("description", ""),
        default_mode=default_mode,
        l1_action=l1_action,
        l2_action=l2_action,
        l3_action=l3_action,
        enable_temporal_analysis=data.get("enable_temporal_analysis", True),
        enable_break_glass=data.get("enable_break_glass", True),
        enable_path_hardening=data.get("enable_path_hardening", True),
        ledger_retention_days=data.get("ledger_retention_days", 90),
        max_operations_per_minute=data.get("max_operations_per_minute", 100),
    )


def compare_profiles(profile1: BatProfile, profile2: BatProfile) -> dict:
    """Compare two profiles and show differences.

    Args:
        profile1: First profile
        profile2: Second profile

    Returns:
        Dictionary with differences
    """
    differences = {}

    fields = [
        "default_mode",
        "l1_action",
        "l2_action",
        "l3_action",
        "enable_temporal_analysis",
        "enable_break_glass",
        "enable_path_hardening",
        "ledger_retention_days",
        "max_operations_per_minute",
    ]

    for field in fields:
        val1 = getattr(profile1, field)
        val2 = getattr(profile2, field)

        # Handle enums
        if isinstance(val1, Enum):
            val1 = val1.value
            val2 = val2.value

        if val1 != val2:
            differences[field] = {
                profile1.name.value: val1,
                profile2.name.value: val2,
            }

    return differences


def print_profile_comparison(profiles: list[BatProfile]) -> None:
    """Print a comparison table of profiles.

    Args:
        profiles: List of profiles to compare
    """
    print("\nProfile Comparison:")
    print("=" * 80)

    # Header
    headers = ["Setting"] + [p.name.value for p in profiles]
    print(f"{headers[0]:<25} " + "  ".join(f"{h:<15}" for h in headers[1:]))
    print("-" * 80)

    # Rows
    fields = [
        ("Mode", "default_mode"),
        ("L1 Action", "l1_action"),
        ("L2 Action", "l2_action"),
        ("L3 Action", "l3_action"),
        ("Temporal Analysis", "enable_temporal_analysis"),
        ("Break-Glass", "enable_break_glass"),
        ("Path Hardening", "enable_path_hardening"),
        ("Retention (days)", "ledger_retention_days"),
        ("Ops/min limit", "max_operations_per_minute"),
    ]

    for label, field in fields:
        values = []
        for p in profiles:
            val = getattr(p, field)
            if isinstance(val, Enum):
                val = val.value
            values.append(str(val))

        print(f"{label:<25} " + "  ".join(f"{v:<15}" for v in values))

    print("=" * 80)
