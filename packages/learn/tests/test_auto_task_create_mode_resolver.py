"""Sir-matter-task #4 — _resolve_auto_task_create_mode reads settings + default live.

Symptom on the live tenant (2026-05-24): ``STEWARD_SIGNAL_AUTOCREATE_TASKS``
env unset → the gate in ``create_task_from_signal`` short-circuits to
no-op → signals with no resolvable target never become tasks → 0
auto-tasks ever created on home.alfred.black.

Mirrors the precedence already in
``signal_actions._resolve_signal_action_mode`` and
``state_mutator._resolve_state_mutator_mode`` (Fix C):

  1. Env ``STEWARD_SIGNAL_AUTOCREATE_TASKS`` (override — ops emergency)
  2. ``/alfred-data/settings.json`` key ``auto_task_create_mode``
  3. Default ``"live"`` (was env-unset → off)

Modes are ``"live"`` (do work) or ``"shadow"`` (no-op).

Test cases (RED → GREEN):
  a. Env override wins over settings file
  b. Settings file value wins over default
  c. Default is "live" when both absent
  d. Malformed JSON falls back to default with a warning
  e. Missing file falls back silently to default
  f. Missing key in existing settings → default
  g. Unrecognised settings value → default + warning
  h. Legacy env values ``"true"`` / ``"false"`` still work (backward compat)
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import src.activities.task_creation as tc


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def settings_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the resolver at a tmp_path settings.json instead of /alfred-data."""
    path = tmp_path / "settings.json"
    monkeypatch.setattr(
        tc, "_AUTO_TASK_CREATE_SETTINGS_PATH", path, raising=False
    )
    monkeypatch.delenv(tc.ENV_AUTOCREATE_FLAG, raising=False)
    return path


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_env_override_wins(
    settings_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ENV beats both settings file and default."""
    settings_file.write_text(json.dumps({"auto_task_create_mode": "live"}))
    monkeypatch.setenv(tc.ENV_AUTOCREATE_FLAG, "shadow")

    assert tc._resolve_auto_task_create_mode() == "shadow"


def test_settings_file_value_wins_over_default(settings_file: Path) -> None:
    """If env is unset, settings.json key supplies the mode."""
    settings_file.write_text(json.dumps({"auto_task_create_mode": "shadow"}))

    assert tc._resolve_auto_task_create_mode() == "shadow"


def test_default_is_live_when_both_absent(settings_file: Path) -> None:
    """No env, no settings file → live (was env-unset → off)."""
    assert not settings_file.exists()

    assert tc._resolve_auto_task_create_mode() == "live", (
        "default must be 'live' (sir-matter-task #4 — was off)"
    )


def test_malformed_json_falls_back_to_default_with_warning(
    settings_file: Path, caplog: pytest.LogCaptureFixture
) -> None:
    settings_file.write_text("{not valid json")

    with caplog.at_level("WARNING", logger="alfred-learn"):
        mode = tc._resolve_auto_task_create_mode()

    assert mode == "live"
    assert any(
        "settings" in rec.message.lower() and rec.levelname == "WARNING"
        for rec in caplog.records
    )


def test_missing_file_falls_back_silently(
    settings_file: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Missing file is the steady state on a fresh tenant — must not warn."""
    assert not settings_file.exists()

    with caplog.at_level("WARNING", logger="alfred-learn"):
        mode = tc._resolve_auto_task_create_mode()

    assert mode == "live"
    assert not any(
        rec.levelname == "WARNING" for rec in caplog.records
    )


def test_missing_key_in_existing_settings_falls_back(settings_file: Path) -> None:
    """Settings file exists but the key isn't there → default."""
    settings_file.write_text(json.dumps({"other_setting": "x"}))

    assert tc._resolve_auto_task_create_mode() == "live"


def test_unrecognised_settings_value_falls_back(
    settings_file: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Settings file has a garbage value → default + warning."""
    settings_file.write_text(json.dumps({"auto_task_create_mode": "gibberish"}))

    with caplog.at_level("WARNING", logger="alfred-learn"):
        mode = tc._resolve_auto_task_create_mode()

    assert mode == "live"
    assert any(
        "unrecognised" in rec.message.lower() or "gibberish" in rec.message.lower()
        for rec in caplog.records
    )


def test_legacy_env_true_maps_to_live(
    settings_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Backward compat: the legacy env was ``"true"`` / ``"false"`` —
    we accept those as aliases for ``"live"`` / ``"shadow"`` so a
    tenant with the old env set keeps working."""
    monkeypatch.setenv(tc.ENV_AUTOCREATE_FLAG, "true")
    assert tc._resolve_auto_task_create_mode() == "live"


def test_legacy_env_false_maps_to_shadow(
    settings_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Backward compat: env=false → shadow (no-op)."""
    monkeypatch.setenv(tc.ENV_AUTOCREATE_FLAG, "false")
    assert tc._resolve_auto_task_create_mode() == "shadow"
