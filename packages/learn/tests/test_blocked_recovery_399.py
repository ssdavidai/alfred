"""#399 — bounded recovery for transient-error-blocked tasks."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from src.activities import tasks as tasks_mod


def _fm(blocked_by, hours_ago=12, attempts=0):
    return {
        "status": "blocked",
        "blocked_by": blocked_by,
        "blocked_at": (
            datetime.now(timezone.utc) - timedelta(hours=hours_ago)
        ).isoformat(timespec="seconds"),
        "recovery_attempts": attempts,
    }


class _FakeVault:
    def __init__(self, stubs):
        self.stubs = stubs
        self.writes = []

    async def list_records(self, *_a, **_k):
        return self.stubs

    async def read_record(self, path):
        stub = next(s for s in self.stubs if s["path"] == path)
        import yaml
        fm_yaml = yaml.dump(stub["frontmatter"])
        return {"content": f"---\n{fm_yaml}---\nbody"}

    async def write_record(self, rtype, name, content):
        self.writes.append((name, content))
        return name

    async def close(self):
        return None


class _FakeState:
    def __init__(self):
        self.audits = []

    async def append_audit(self, **kw):
        self.audits.append(kw)
        return "01A"

    async def close(self):
        return None


def _run(stubs, monkeypatch):
    fake_v, fake_s = _FakeVault(stubs), _FakeState()
    monkeypatch.setattr(tasks_mod, "VaultClient", lambda _c: fake_v)
    monkeypatch.setattr("src.utils.state_client.StateClient", lambda _c: fake_s)
    out = asyncio.run(tasks_mod.recover_stale_blocked_tasks())
    return out, fake_v, fake_s


def test_transient_block_recovers(monkeypatch):
    stubs = [{"path": "task/a.md",
              "frontmatter": _fm(["transient-execution-error: runner exception"])}]
    out, v, s = _run(stubs, monkeypatch)
    assert out == {"recovered": 1, "parked": 0}
    name, content = v.writes[0]
    assert "status: todo" in content
    assert "recovery_attempts: 1" in content
    assert s.audits[0]["action_type"] == "task_recovery"


def test_human_block_never_touched(monkeypatch):
    stubs = [{"path": "task/b.md",
              "frontmatter": _fm(["waiting for Sir's approval"])}]
    out, v, _ = _run(stubs, monkeypatch)
    assert out == {"recovered": 0, "parked": 0}
    assert v.writes == []


def test_cap_parks(monkeypatch):
    stubs = [{"path": "task/c.md",
              "frontmatter": _fm(["transient-execution-error: x"], attempts=3)}]
    out, v, _ = _run(stubs, monkeypatch)
    assert out == {"recovered": 0, "parked": 1}
    assert "recovery exhausted" in v.writes[0][1]


def test_fresh_block_waits(monkeypatch):
    stubs = [{"path": "task/d.md",
              "frontmatter": _fm(["transient-execution-error: x"], hours_ago=1)}]
    out, v, _ = _run(stubs, monkeypatch)
    assert out == {"recovered": 0, "parked": 0}


def test_update_task_status_stamps_reason(monkeypatch):
    class _V:
        writes = []
        async def read_record(self, p):
            return {"content": "---\nstatus: active\n---\nb"}
        async def write_record(self, rtype, name, content):
            self.writes.append(content)
            return name
        async def close(self):
            return None
    v = _V()
    monkeypatch.setattr(tasks_mod, "VaultClient", lambda _c: v)
    asyncio.run(tasks_mod.update_task_status(
        {"path": "task/e.md"}, "blocked",
        "transient-execution-error: runner exception"))
    c = v.writes[0]
    assert "status: blocked" in c and "transient-execution-error" in c
    assert "blocked_at:" in c
