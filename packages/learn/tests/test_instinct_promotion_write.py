"""fix #1 — apply_instinct_change must patch instinct FRONTMATTER, not body-append.

The bug: the update/merge/deprecate branches wrote via `VaultClient.update_record()`,
which sends `{"body_append": ...}` — a body-only PATCH verb that can never change
`tier` / `confidence_score` / `observation_count`. So every nightly Reflection
promotion silently no-op'd: the PATCH returned 200, an `instinct_tier_event` audit
row was written claiming the promotion, but the record's frontmatter never changed
on disk — no instinct ever graduated past `Asking`.

These tests pin the write verb: the update/deprecate paths MUST call
`patch_frontmatter()` (`{"set": ...}`) and MUST NOT call `update_record()`.
"""
from __future__ import annotations

import pytest

from src.activities.vault import apply_instinct_change


class _FakeVaultClient:
    last: "_FakeVaultClient | None" = None

    def __init__(self, *args, **kwargs):
        self.patched: list = []          # (path, updates) from patch_frontmatter
        self.body_appended: list = []    # (path, content) from update_record — MUST stay empty
        self.written: list = []          # (type, name) from write_record
        _FakeVaultClient.last = self

    async def read_record(self, path):
        return {"content": "---\ntype: instinct\nstatus: active\ntier: Asking\n---\nbody\n"}

    async def patch_frontmatter(self, path, updates):
        self.patched.append((path, dict(updates)))

    async def update_record(self, path, content):
        self.body_appended.append((path, content))

    async def write_record(self, record_type, name, content):
        self.written.append((record_type, name))
        return f"instinct/{name}.md"

    async def close(self):
        pass


class _FakeStateClient:
    audits: list = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def append_audit(self, **kwargs):
        _FakeStateClient.audits.append(kwargs)


@pytest.fixture(autouse=True)
def _mock(monkeypatch):
    monkeypatch.setattr("src.activities.vault.VaultClient", _FakeVaultClient)
    monkeypatch.setattr("src.utils.state_client.StateClient", _FakeStateClient)
    _FakeStateClient.audits = []


async def test_update_patches_frontmatter_and_never_body_appends():
    await apply_instinct_change(
        {
            "action": "update",
            "path": "instinct/critical-payments-guard.md",
            "changes": {"tier": "Confirming", "observation_count": 11, "confidence_score": 0.9},
        }
    )
    fc = _FakeVaultClient.last
    assert fc is not None
    # The regression: no body-append (that was the silent no-op).
    assert fc.body_appended == [], "instinct edit must NOT use body_append"
    # The fix: a frontmatter set with the promoted fields.
    assert fc.patched == [
        (
            "instinct/critical-payments-guard.md",
            {"tier": "Confirming", "observation_count": 11, "confidence_score": 0.9},
        )
    ]


async def test_update_with_tier_emits_truthful_audit():
    await apply_instinct_change(
        {"action": "update", "path": "instinct/x.md", "changes": {"tier": "Acting"}}
    )
    # audit now rides *after* a real frontmatter patch (patch_frontmatter raises on
    # non-2xx, so the audit only lands when the write actually succeeded).
    assert any(a.get("action_type") == "instinct_tier_event" for a in _FakeStateClient.audits)


async def test_deprecate_patches_status_frontmatter_not_body_append():
    await apply_instinct_change(
        {"action": "deprecate", "path": "instinct/y.md", "reason": "stale"}
    )
    fc = _FakeVaultClient.last
    assert fc.body_appended == []
    assert fc.patched and fc.patched[0][0] == "instinct/y.md"
    assert fc.patched[0][1].get("status") == "deprecated"


async def test_merge_deprecates_sources_via_frontmatter_patch():
    await apply_instinct_change(
        {
            "action": "merge",
            "merged_instinct": {"name": "merged-guard"},
            "source_paths": ["instinct/a.md", "instinct/b.md"],
        }
    )
    fc = _FakeVaultClient.last
    assert fc.body_appended == []
    # both sources deprecated via frontmatter patch; merged instinct created
    assert {p for p, _ in fc.patched} == {"instinct/a.md", "instinct/b.md"}
    assert all(u.get("status") == "deprecated" for _, u in fc.patched)
    assert fc.written and fc.written[0][0] == "instinct"
