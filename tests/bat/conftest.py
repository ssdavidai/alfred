"""
Pytest configuration for Bat Protocol tests.
"""

import pytest
import tempfile
from pathlib import Path

from alfred.bat import (
    RiskEngine,
    EnforcementEngine,
    EnforcementPolicy,
    EnforcementMode,
    GovernanceLedger,
    BatInterceptor,
)
from alfred.bat.rules import DEFAULT_RULES


@pytest.fixture
def temp_ledger_path():
    """Create a temporary ledger file path."""
    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False) as f:
        path = Path(f.name)
    yield path
    if path.exists():
        path.unlink()


@pytest.fixture
def temp_ledger(temp_ledger_path):
    """Create a temporary governance ledger."""
    return GovernanceLedger(path=temp_ledger_path, signing_key=b"test-signing-key")


@pytest.fixture
def risk_engine():
    """Create a risk engine with default rules."""
    return RiskEngine(rules=DEFAULT_RULES)


@pytest.fixture
def enforcement_policy():
    """Create an enforcement policy in enforce mode."""
    return EnforcementPolicy(version="1.0", mode=EnforcementMode.ENFORCE)


@pytest.fixture
def passive_policy():
    """Create an enforcement policy in passive mode."""
    return EnforcementPolicy(version="1.0", mode=EnforcementMode.PASSIVE)


@pytest.fixture
def enforcement_engine(enforcement_policy, temp_ledger):
    """Create an enforcement engine."""
    return EnforcementEngine(policy=enforcement_policy, ledger=temp_ledger)


@pytest.fixture
def interceptor(risk_engine, enforcement_engine, temp_ledger):
    """Create a fully configured Bat interceptor."""
    return BatInterceptor(
        risk_engine=risk_engine,
        enforcement_engine=enforcement_engine,
        ledger=temp_ledger,
    )


@pytest.fixture
def passive_interceptor(risk_engine, passive_policy, temp_ledger):
    """Create a Bat interceptor in passive mode."""
    enforcement = EnforcementEngine(policy=passive_policy, ledger=temp_ledger)
    return BatInterceptor(
        risk_engine=risk_engine,
        enforcement_engine=enforcement,
        ledger=temp_ledger,
    )
