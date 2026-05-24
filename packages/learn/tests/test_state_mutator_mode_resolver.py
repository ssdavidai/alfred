"""Sir-matter-task #3 — _resolve_state_mutator_mode reads settings + default live.

Symptom on the live tenant (2026-05-24): ``STEWARD_LIVE_MODE`` env
unset → ``_resolve_env_live_mode`` defaulted to ``"shadow"`` →
state_mutator wrote audit records but applied zero real frontmatter
patches → 13 matters all sit at ``current_state: null,
signal_count_24h: 0``.

Mirrors the precedence Fix-Loop-close already established for
``signal_actions._resolve_signal_action_mode``:

  1. Env ``STEWARD_LIVE_MODE`` (override — kept for ops emergency)
  2. ``/alfred-data/settings.json`` key ``state_mutator_mode``
  3. Default ``"live"`` (was ``"shadow"``)

Fail-safe on missing file / malformed JSON / unrecognised value: log
warning where appropriate, default ``live``. Missing file is the
steady state (Lane I's deploy creates it lazily) and MUST NOT warn.

Test cases (RED → GREEN):
  a. Env override wins over settings file
  b. Settings file value wins over default
  c. Default is "live" when both absent
  d. Malformed JSON falls back to default with a warning
  e. Missing file falls back silently to default
  f. Missing key in existing settings → default
  g. Unrecognised settings value → default + warning
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import src.activities.state_mutator as sm


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def settings_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the resolver at a tmp_path settings.json instead of /alfred-data."""
    path = tmp_path / "settings.json"
    monkeypatch.setattr(
        sm, "_STATE_MUTATOR_SETTINGS_PATH", path, raising=False
    )
    monkeypatch.delenv(sm.STEWARD_LIVE_MODE_ENV, raising=False)
    return path


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_env_override_wins(settings_file: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """ENV beats both settings file and default — kept as emergency override."""
    settings_file.write_text(json.dumps({"state_mutator_mode": "live"}))
    monkeypatch.setenv(sm.STEWARD_LIVE_MODE_ENV, "shadow")

    assert sm._resolve_state_mutator_mode() == "shadow", (
        "env override must win even when settings.json says live"
    )


def test_settings_file_value_wins_over_default(settings_file: Path) -> None:
    """If env is unset, settings.json key supplies the mode."""
    settings_file.write_text(json.dumps({"state_mutator_mode": "shadow"}))

    assert sm._resolve_state_mutator_mode() == "shadow", (
        "settings.json value must override the default"
    )


def test_default_is_live_when_both_absent(settings_file: Path) -> None:
    """No env, no settings file → live (was shadow before sir-matter-task #3)."""
    assert not settings_file.exists(), "fixture should leave settings file absent"

    assert sm._resolve_state_mutator_mode() == "live", (
        "default must be 'live' (sir-matter-task #3 — was 'shadow')"
    )


def test_malformed_json_falls_back_to_default_with_warning(
    settings_file: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Bad JSON: warn + default. NEVER raise."""
    settings_file.write_text("{not valid json")

    with caplog.at_level("WARNING", logger="alfred-learn"):
        mode = sm._resolve_state_mutator_mode()

    assert mode == "live", "malformed settings → default 'live'"
    assert any(
        "settings" in rec.message.lower() and rec.levelname == "WARNING"
        for rec in caplog.records
    ), f"expected a WARNING log about settings parse; got {[r.message for r in caplog.records]!r}"


def test_missing_file_falls_back_silently(
    settings_file: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Missing file is the steady state on a fresh tenant — must not warn."""
    assert not settings_file.exists()

    with caplog.at_level("WARNING", logger="alfred-learn"):
        mode = sm._resolve_state_mutator_mode()

    assert mode == "live"
    assert not any(
        rec.levelname == "WARNING" for rec in caplog.records
    ), "missing settings.json must not emit a warning (steady state)"


def test_missing_key_in_existing_settings_falls_back(settings_file: Path) -> None:
    """Settings file exists but the key isn't there → default."""
    settings_file.write_text(json.dumps({"other_setting": "x"}))

    assert sm._resolve_state_mutator_mode() == "live"


def test_unrecognised_settings_value_falls_back(
    settings_file: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Settings file has a garbage value → default + warning."""
    settings_file.write_text(json.dumps({"state_mutator_mode": "gibberish"}))

    with caplog.at_level("WARNING", logger="alfred-learn"):
        mode = sm._resolve_state_mutator_mode()

    assert mode == "live"
    assert any(
        "unrecognised" in rec.message.lower() or "gibberish" in rec.message.lower()
        for rec in caplog.records
    )
