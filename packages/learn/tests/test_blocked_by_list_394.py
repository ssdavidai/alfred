"""#394 — blocked_by must be written as a list, never a bare string.

Live: 3 task records carried string blocked_by; the vault daemon
revalidates full frontmatter on ANY edit, so every subsequent PATCH
against those records failed (16 failures/6h) until repaired.
"""
from __future__ import annotations

import asyncio

from src.activities import tasks as tasks_mod


class _FakeVaultClient:
    def __init__(self):
        self.writes = []

    async def read_record(self, path):
        return {"frontmatter": {"status": "active"}, "body": "b",
                "content": "---\nstatus: active\n---\nb"}

    async def write_record(self, rtype, name, content):
        self.writes.append((rtype, name, content))
        return name

    async def close(self):
        return None


def test_blocked_reason_lands_as_list(monkeypatch):
    fake = _FakeVaultClient()
    monkeypatch.setattr(tasks_mod, "VaultClient", lambda _cfg: fake)
    asyncio.run(
        tasks_mod.complete_task(
            {"path": "task/t.md", "title": "T"},
            {"status": "blocked", "blocked_reason": "waiting on approval",
             "summary": "s"},
        )
    )
    content = fake.writes[0][2]
    # list form: a "blocked_by:" line followed by a "- " item — never
    # "blocked_by: <bare string>"
    assert "blocked_by:" in content
    import re
    assert not re.search(r"^blocked_by: (?!\[)\S.*$", content, flags=re.M) or \
           "blocked_by: [" in content, content
    assert "waiting on approval" in content
