"""#6 — signal-pipeline flags default ON.

``STEWARD_SIGNAL_EXTRACT_ENABLED`` / ``STEWARD_SIGNAL_ROUTER_ENABLED`` gate
the SignalExtract / SignalRouter schedule registration. They previously
defaulted OFF, so a fresh single-tenant box never registered the schedules
and the Desk was silently empty. The defaults flip to ON; an operator can
still disable a flag explicitly (``false``/``0``/``no``).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.register_schedules import (  # noqa: E402
    _signal_extract_enabled,
    _signal_router_enabled,
)

FLAGS = {
    "STEWARD_SIGNAL_EXTRACT_ENABLED": _signal_extract_enabled,
    "STEWARD_SIGNAL_ROUTER_ENABLED": _signal_router_enabled,
}


@pytest.mark.parametrize("env_name, fn", list(FLAGS.items()))
def test_default_when_unset_is_on(monkeypatch, env_name, fn) -> None:
    monkeypatch.delenv(env_name, raising=False)
    assert fn() is True


@pytest.mark.parametrize("env_name, fn", list(FLAGS.items()))
@pytest.mark.parametrize("blank", ["", "   "])
def test_blank_is_on(monkeypatch, env_name, fn, blank) -> None:
    monkeypatch.setenv(env_name, blank)
    assert fn() is True


@pytest.mark.parametrize("env_name, fn", list(FLAGS.items()))
@pytest.mark.parametrize("falsy", ["false", "0", "no", "FALSE", "Off"])
def test_explicit_falsy_disables(monkeypatch, env_name, fn, falsy) -> None:
    monkeypatch.setenv(env_name, falsy)
    assert fn() is False


@pytest.mark.parametrize("env_name, fn", list(FLAGS.items()))
@pytest.mark.parametrize("truthy", ["true", "1", "yes", "TRUE"])
def test_explicit_truthy_enables(monkeypatch, env_name, fn, truthy) -> None:
    monkeypatch.setenv(env_name, truthy)
    assert fn() is True
