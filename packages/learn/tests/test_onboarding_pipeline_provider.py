"""OnboardingPipelineWorkflow's email-provider branch (issue #758).

The provider is a second axis alongside gmail_mode. These tests pin the
replay-safe defaults, the ``persist_onboarding_provider`` activity, and — via a
static source guard — that the workflow wires the Outlook collectors into the
metadata/backfill selection, gates the new persist call with
``workflow.patched()``, and refuses an unsupported provider.

Deliberately no ``WorkflowEnvironment`` here: the runtime selection MECHANISM is
already covered by ``test_onboarding_pipeline_gmail_mode.py`` (google vs
composio through a live worker), and this Outlook branch is the same expression
plus one more arm. Keeping this file free of the temporal test server (and of a
cross-import of that module) keeps the full CI suite fast and deterministic.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
import sys  # noqa: E402
sys.path.insert(0, str(ROOT))

from src.activities.onboarding import persist_onboarding_provider  # noqa: E402
from src.workflows.onboarding_pipeline import OnboardingInput  # noqa: E402

_PIPELINE_SRC = (ROOT / "src/workflows/onboarding_pipeline.py").read_text()


# --- dataclass defaults (replay safety) ------------------------------------

def test_input_has_provider_fields_defaulting_to_gmail() -> None:
    inp = OnboardingInput(user_id="u1")
    assert inp.email_provider == "gmail"
    assert inp.connection_id == ""


def test_input_accepts_outlook() -> None:
    inp = OnboardingInput(user_id="u1", email_provider="outlook", connection_id="ca_x")
    assert inp.email_provider == "outlook"
    assert inp.connection_id == "ca_x"


# --- the persist activity ---------------------------------------------------

@pytest.mark.asyncio
async def test_persist_provider_writes_fields(tmp_path: Path) -> None:
    p = tmp_path / "onboard.json"
    p.write_text("{}")
    await persist_onboarding_provider(str(p), "outlook", "ca_x")
    data = json.loads(p.read_text())
    assert data["email_provider"] == "outlook"
    assert data["connection_id"] == "ca_x"


@pytest.mark.asyncio
async def test_persist_provider_normalises_unknown(tmp_path: Path) -> None:
    p = tmp_path / "onboard.json"
    p.write_text("{}")
    await persist_onboarding_provider(str(p), "yahoo", "")
    assert json.loads(p.read_text())["email_provider"] == "gmail"


# --- static replay-safety + wiring guard -----------------------------------

def test_new_activity_call_is_patched() -> None:
    """The new persist_onboarding_provider call must be gated with
    workflow.patched(), or replay of pre-#758 in-flight histories diverges."""
    assert 'workflow.patched("758-onboarding-provider")' in _PIPELINE_SRC
    # the gated block calls the new activity
    assert re.search(
        r'workflow\.patched\("758-onboarding-provider"\)[\s\S]{0,200}persist_onboarding_provider',
        _PIPELINE_SRC,
    )


def test_outlook_activities_wired_into_selection() -> None:
    # both selection expressions reach for the Outlook collectors when use_outlook
    assert "composio_fetch_email_metadata_outlook" in _PIPELINE_SRC
    assert "composio_backfill_outlook_as_events" in _PIPELINE_SRC
    assert re.search(r"use_outlook\s*=\s*input\.email_provider\s*==\s*[\"']outlook[\"']", _PIPELINE_SRC)


def test_unknown_provider_is_refused() -> None:
    # an explicit unsupported provider raises, never falls back to gmail
    assert "InvalidEmailProvider" in _PIPELINE_SRC
    assert re.search(r"email_provider\s+not\s+in\s+\(\s*[\"']gmail[\"']\s*,\s*[\"']outlook[\"']\s*\)", _PIPELINE_SRC)
