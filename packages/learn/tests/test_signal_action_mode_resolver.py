"""Gap 3b — _resolve_signal_action_mode reads settings file, defaults live.

Symptom on home.alfred.black: ``STEWARD_SIGNAL_ACTION_LIVE_MODE`` env
unset → resolver defaulted to ``"shadow"`` → 100% of signals routed
HUMAN regardless of confidence. Sir wants a user-toggleable setting,
default ``"live"``, with env still available as an emergency override.

New precedence (highest first):
  1. Env STEWARD_SIGNAL_ACTION_LIVE_MODE (override — kept for ops)
  2. /alfred-data/settings.json key ``signal_action_mode``
  3. Default ``"live"`` (was ``"shadow"``)

All read errors (missing file, malformed JSON, missing key, IO error)
fail-safe to the default — never raise, log a warning where appropriate.

Test cases (RED → GREEN):
  a. Env override wins over settings file
  b. Settings file value wins over default
  c. Default is "live" when both absent
  d. Malformed JSON falls back to default with a warning
  e. Missing file falls back silently to default
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import src.activities.signal_actions as sa


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def settings_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the resolver at a tmp_path settings.json instead of /alfred-data."""
    path = tmp_path / "settings.json"
    monkeypatch.setattr(sa, "_SIGNAL_ACTION_SETTINGS_PATH", path, raising=False)
    monkeypatch.delenv(sa.SIGNAL_ACTION_LIVE_MODE_ENV, raising=False)
    return path


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_env_override_wins(settings_file: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """ENV beats both settings file and default — kept as emergency override."""
    settings_file.write_text(json.dumps({"signal_action_mode": "live"}))
    monkeypatch.setenv(sa.SIGNAL_ACTION_LIVE_MODE_ENV, "shadow")

    assert sa._resolve_signal_action_mode() == "shadow", (
        "env override must win even when settings.json says live"
    )


def test_settings_file_value_wins_over_default(settings_file: Path) -> None:
    """If env is unset, settings.json key supplies the mode."""
    settings_file.write_text(json.dumps({"signal_action_mode": "shadow"}))

    assert sa._resolve_signal_action_mode() == "shadow", (
        "settings.json value must override the default"
    )


def test_default_is_live_when_both_absent(settings_file: Path) -> None:
    """No env, no settings file → live (was shadow before Gap 3b)."""
    # settings_file fixture creates the path but doesn't write — file absent.
    assert not settings_file.exists(), "fixture should leave settings file absent"

    assert sa._resolve_signal_action_mode() == "live", (
        "default must be 'live' (Gap 3b — was 'shadow')"
    )


def test_malformed_json_falls_back_to_default_with_warning(
    settings_file: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Bad JSON: warn + default. NEVER raise."""
    settings_file.write_text("{not valid json")

    with caplog.at_level("WARNING", logger="alfred-learn"):
        mode = sa._resolve_signal_action_mode()

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
        mode = sa._resolve_signal_action_mode()

    assert mode == "live"
    # Missing file is normal; should not produce a WARNING.
    assert not any(
        rec.levelname == "WARNING" for rec in caplog.records
    ), "missing settings.json must not emit a warning (steady state)"


def test_missing_key_in_existing_settings_falls_back(settings_file: Path) -> None:
    """Settings file exists but the key isn't there → default."""
    settings_file.write_text(json.dumps({"other_setting": "x"}))

    assert sa._resolve_signal_action_mode() == "live"


def test_unrecognised_settings_value_falls_back(
    settings_file: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Settings file has a garbage value → default + warning (same as bad env)."""
    settings_file.write_text(json.dumps({"signal_action_mode": "gibberish"}))

    with caplog.at_level("WARNING", logger="alfred-learn"):
        mode = sa._resolve_signal_action_mode()

    assert mode == "live"
    assert any(
        "unrecognised" in rec.message.lower() or "gibberish" in rec.message.lower()
        for rec in caplog.records
    )
