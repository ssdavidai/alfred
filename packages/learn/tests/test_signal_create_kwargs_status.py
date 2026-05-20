"""C2 — signal status default = ``unrouted``.

``signal_dict_to_create_kwargs`` translates an extractor signal dict into
``StateClient.create_signal`` kwargs. A freshly extracted signal must be
routable, so when the dict carries no explicit status the create kwargs
default ``status="unrouted"`` (ctrl Lane I sets the SQL column default too;
this is the belt to that braces). An explicit status already on the dict is
honoured so a re-projected/already-routed signal is not silently reset.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.utils.signal_state import signal_dict_to_create_kwargs  # noqa: E402


def test_no_status_defaults_to_unrouted() -> None:
    kwargs = signal_dict_to_create_kwargs(
        {"effect": "schedule", "source_type": "gmail", "display_headline": "hi"}
    )
    assert kwargs["status"] == "unrouted"


def test_blank_status_defaults_to_unrouted() -> None:
    kwargs = signal_dict_to_create_kwargs(
        {"effect": "schedule", "source_type": "gmail", "status": "   "}
    )
    assert kwargs["status"] == "unrouted"


def test_explicit_status_is_honoured() -> None:
    kwargs = signal_dict_to_create_kwargs(
        {"effect": "schedule", "source_type": "gmail", "status": "routed_human"}
    )
    assert kwargs["status"] == "routed_human"
