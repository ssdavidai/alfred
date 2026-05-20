"""#BUG-5 — _write_onboard must write onboard.json atomically.

The original ``open(path, "w") + json.dump`` truncated the destination in
place, so a concurrent ``/onboarding/progress`` reader could observe a
half-written (torn) file → ``JSON.parse`` throws → stage reads as
``not_started``. The fix writes to a temp file in the same directory and
``os.replace``-es it into place (atomic rename on POSIX).
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from src.activities.onboarding_v3 import _read_onboard, _write_onboard


def test_write_then_read_roundtrips(tmp_path: Path) -> None:
    target = str(tmp_path / "sub" / "onboard.json")
    data = {"stage": "patterns", "progress": {"facts_count": 3}}
    _write_onboard(target, data)
    assert _read_onboard(target) == data


def test_write_is_atomic_replace(tmp_path: Path, monkeypatch) -> None:
    """The destination must never be opened for truncating write directly;
    the new content must arrive via os.replace from a temp file."""
    target = str(tmp_path / "onboard.json")
    # Seed a valid existing file.
    _write_onboard(target, {"stage": "facts"})

    real_replace = os.replace
    replaced: list[tuple[str, str]] = []

    def _spy_replace(src, dst):
        replaced.append((str(src), str(dst)))
        return real_replace(src, dst)

    monkeypatch.setattr("src.activities.onboarding_v3.os.replace", _spy_replace)

    _write_onboard(target, {"stage": "patterns"})

    # Exactly one replace landed on the destination from a different temp path.
    assert any(dst == target and src != target for src, dst in replaced), replaced
    assert _read_onboard(target) == {"stage": "patterns"}


def test_failed_write_leaves_old_file_intact(tmp_path: Path, monkeypatch) -> None:
    """If serialization fails mid-write, the previous good file must remain —
    an in-place truncate would have left a torn/empty file."""
    target = str(tmp_path / "onboard.json")
    _write_onboard(target, {"stage": "facts", "facts_count": 9})

    class _Unserializable:
        pass

    try:
        _write_onboard(target, {"stage": "patterns", "bad": _Unserializable()})
    except TypeError:
        pass

    # The original content is still readable and uncorrupted.
    assert _read_onboard(target) == {"stage": "facts", "facts_count": 9}
    # No leftover temp files in the directory.
    leftovers = [p for p in os.listdir(tmp_path) if p != "onboard.json"]
    assert leftovers == [], leftovers
