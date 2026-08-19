"""`set` and `json_set` are not interchangeable, and the failure is remote.

ctrl-api's PATCH contract:

    set:      scalars only — each value is stringified for the vault CLI's
              --set flag.
    json_set: lists, dicts, bools, numbers — merged as native YAML.

Sending a list through `set` made ctrl build the CLI argument
`--set relationships=[object Object]` (JavaScript coercing an object to a
string), and the vault daemon rejected it:

    {"error": "Field 'relationships' must be a list, got str"}   -> HTTP 500

~150 failed writes per 20 minutes on the dev tenant, every one a surveyor
entity-link update — the payload most likely to be a list.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

import alfred.ctrl_client as cc


def _capture(monkeypatch) -> dict:
    seen: dict = {}

    class _Resp:
        @staticmethod
        def raise_for_status(): return None
        @staticmethod
        def json(): return {"path": "p"}

    class _C:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def patch(self, url, json=None):
            seen["url"] = url
            seen["payload"] = json
            return _Resp()

    monkeypatch.setattr(cc, "_client", lambda: _C())
    return seen


def test_lists_go_to_json_set_not_set(monkeypatch):
    """The regression. A list in `set` becomes [object Object] at the far end."""
    seen = _capture(monkeypatch)
    cc.ctrl_edit("task/x.md", set_fields={"relationships": ["a", "b"]})
    assert seen["payload"].get("json_set") == {"relationships": ["a", "b"]}
    assert "relationships" not in seen["payload"].get("set", {})


def test_dicts_go_to_json_set(monkeypatch):
    seen = _capture(monkeypatch)
    cc.ctrl_edit("task/x.md", set_fields={"undo_recipe": {"evidence": [1]}})
    assert seen["payload"].get("json_set") == {"undo_recipe": {"evidence": [1]}}


def test_scalars_still_go_to_set(monkeypatch):
    """Scalars must keep using `set` — json_set bypasses the CLI entirely and
    with it the validation the CLI performs."""
    seen = _capture(monkeypatch)
    cc.ctrl_edit("task/x.md", set_fields={"status": "done", "count": 3, "ok": True})
    assert seen["payload"]["set"] == {"status": "done", "count": 3, "ok": True}
    assert "json_set" not in seen["payload"]


def test_mixed_payload_is_split_by_value_type(monkeypatch):
    seen = _capture(monkeypatch)
    cc.ctrl_edit(
        "task/x.md",
        set_fields={"status": "active", "related_matters": ["matter/a.md"]},
    )
    assert seen["payload"]["set"] == {"status": "active"}
    assert seen["payload"]["json_set"] == {"related_matters": ["matter/a.md"]}


def test_none_is_a_scalar(monkeypatch):
    """Clearing a field must still go through the CLI path."""
    seen = _capture(monkeypatch)
    cc.ctrl_edit("task/x.md", set_fields={"closure_predicate": None})
    assert seen["payload"]["set"] == {"closure_predicate": None}
    assert "json_set" not in seen["payload"]


def test_fields_changed_still_reports_every_key(monkeypatch):
    """Splitting the payload must not lose keys from the caller's receipt."""
    _capture(monkeypatch)
    out = cc.ctrl_edit(
        "task/x.md", set_fields={"status": "active", "related_matters": ["m.md"]}
    )
    assert out["fields_changed"] == ["related_matters", "status"]
