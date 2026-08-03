"""Regression tests for the task-pipeline P0 pair (#364 + #367).

Live incident (home, 2026-07): a `depends_on` entry stored as the raw
wikilink ``[[task/repair-alfred-code-delivery-control-plane]]`` was used as
a literal API path — 404 on every attempt, and because the activity call
sat outside any try/except with a SKIP-overlap schedule, one bad task
wedged the whole al-task-runner schedule for 3 days (322 skipped ticks).

Second half (#364): ``write_ledger_entry`` wrote vault type
``ledger_entry`` — never a canonical type, so every write was a guaranteed
promotion-contract 422 (the same class that wedged session-tracker for 9
days at 7,731 attempts). It now lands in the audit table.
"""
from __future__ import annotations

import asyncio

import pytest

from src.activities import tasks as tasks_mod
from src.activities.tasks import _normalize_record_path


class TestNormalizeRecordPath:
    def test_strips_wikilink(self):
        assert (
            _normalize_record_path("[[task/repair-alfred-code-delivery-control-plane]]")
            == "task/repair-alfred-code-delivery-control-plane.md"
        )

    def test_strips_wikilink_alias(self):
        assert _normalize_record_path("[[task/foo|The Foo Task]]") == "task/foo.md"

    def test_plain_path_gains_md(self):
        assert _normalize_record_path("task/foo") == "task/foo.md"

    def test_md_path_untouched(self):
        assert _normalize_record_path("task/foo.md") == "task/foo.md"

    def test_non_path_string_untouched(self):
        # A bare slug without a slash is left alone — we only know how to
        # complete type-prefixed vault paths.
        assert _normalize_record_path("just-a-slug") == "just-a-slug"

    def test_whitespace_stripped(self):
        assert _normalize_record_path("  [[task/foo]]  ") == "task/foo.md"


class _FakeVaultClient:
    """Captures reads/writes; serves canned records by path."""

    def __init__(self, records: dict[str, dict] | None = None) -> None:
        self.records = records or {}
        self.read_paths: list[str] = []
        self.writes: list[tuple[str, str, str]] = []

    async def read_record(self, path: str) -> dict:
        self.read_paths.append(path)
        try:
            return self.records[path]
        except KeyError:
            import httpx

            req = httpx.Request("GET", f"http://ctrl-api/api/v1/vault/records/{path}")
            resp = httpx.Response(404, request=req)
            raise httpx.HTTPStatusError("404", request=req, response=resp)

    async def list_records(self, *_a, **_k) -> list:
        return []

    async def write_record(self, rtype: str, name: str, content: str) -> str:
        self.writes.append((rtype, name, content))
        return name

    async def close(self) -> None:
        return None


class _FakeStateClient:
    def __init__(self, *_a, **_k) -> None:
        self.audits: list[dict] = []

    async def append_audit(self, **kwargs) -> str:
        self.audits.append(kwargs)
        return "01AUDIT"

    async def close(self) -> None:
        return None


class TestCheckTaskPrerequisites:
    def test_wikilink_dependency_resolves(self, monkeypatch):
        """The exact live failure shape: wikilink dep, record exists at the
        normalized path. Old code 404'd forever; new code resolves it."""
        fake = _FakeVaultClient(
            records={"task/repair-alfred-code-delivery-control-plane.md": {"status": "done"}}
        )
        monkeypatch.setattr(tasks_mod, "VaultClient", lambda _cfg: fake)
        ready = asyncio.run(
            tasks_mod.check_task_prerequisites(
                {"depends_on": ["[[task/repair-alfred-code-delivery-control-plane]]"]}
            )
        )
        assert ready is True
        assert fake.read_paths == ["task/repair-alfred-code-delivery-control-plane.md"]

    def test_unfinished_dependency_not_ready(self, monkeypatch):
        fake = _FakeVaultClient(records={"task/dep.md": {"status": "todo"}})
        monkeypatch.setattr(tasks_mod, "VaultClient", lambda _cfg: fake)
        ready = asyncio.run(
            tasks_mod.check_task_prerequisites({"depends_on": ["[[task/dep]]"]})
        )
        assert ready is False


class TestWriteLedgerEntry:
    def test_lands_in_audit_not_vault(self, monkeypatch):
        """#364: ledger entries are machine bookkeeping → audit table.
        The old vault write could never succeed (non-canonical type)."""
        fake_state = _FakeStateClient()
        fake_vault = _FakeVaultClient()
        monkeypatch.setattr(tasks_mod, "StateClient", lambda _cfg: fake_state)
        monkeypatch.setattr(tasks_mod, "VaultClient", lambda _cfg: fake_vault)

        audit_id = asyncio.run(
            tasks_mod.write_ledger_entry(
                {"title": "Fix the gutters", "path": "task/fix-the-gutters.md",
                 "matter": "matter/house.md"},
                {"summary": "Gutters fixed."},
            )
        )

        assert audit_id == "01AUDIT"
        assert fake_vault.writes == [], "must not touch the vault"
        (audit,) = fake_state.audits
        assert audit["action_type"] == "task-completed"
        assert audit["target_kind"] == "task"
        assert audit["target_path"] == "task/fix-the-gutters.md"
        assert "Fix the gutters" in audit["summary"]
        assert "Gutters fixed." in audit["summary"]


class TestConsequentialFollowUpShape:
    def test_follow_up_task_has_validator_safe_shape(self, monkeypatch):
        """§15.2: status 'queued' is validator-rejected; writers must set
        BOTH status and state, plus parent_matter/matter_ref linkage."""
        fake_state = _FakeStateClient()
        fake_vault = _FakeVaultClient()
        monkeypatch.setattr(tasks_mod, "StateClient", lambda _cfg: fake_state)
        monkeypatch.setattr(tasks_mod, "VaultClient", lambda _cfg: fake_vault)

        created = asyncio.run(
            tasks_mod.evaluate_consequentials(
                {"title": "Parent", "path": "task/parent.md", "matter": ""},
                {
                    "summary": "done",
                    "follow_up_tasks": [
                        {"title": "Call the plumber", "owner": "human", "reason": "leak"}
                    ],
                },
            )
        )

        assert len(created) == 1
        task_writes = [w for w in fake_vault.writes if w[0] == "task"]
        assert len(task_writes) == 1
        content = task_writes[0][2]
        assert "status: todo" in content
        assert "state: pending" in content
        assert "status: queued" not in content
        assert "parent_matter:" in content
        assert "matter_ref:" in content


class TestMatterRefNormalization:
    """Smoke follow-up: live run showed GET /vault/records/[[matter/...]]
    404 — matter refs need the same wikilink normalization as depends_on."""

    def test_matter_resolution_normalizes_wikilink(self, monkeypatch):
        """#328: matter completion now routes through apply_state_change_v2;
        its target_path must be the wikilink-normalized matter path."""
        fake_state = _FakeStateClient()
        fake_vault = _FakeVaultClient(records={})  # list_records -> [] => all_done
        monkeypatch.setattr(tasks_mod, "StateClient", lambda _cfg: fake_state)
        monkeypatch.setattr(tasks_mod, "VaultClient", lambda _cfg: fake_vault)

        seen = {}

        async def fake_v2(*, target_path, **kw):
            seen["target_path"] = target_path
            seen["propose"] = kw.get("propose_fn_name")
            class _R: pass
            return _R()

        monkeypatch.setattr(
            "src.activities.state_mutator.apply_state_change_v2", fake_v2
        )
        asyncio.run(
            tasks_mod.evaluate_consequentials(
                {"title": "Parent", "path": "task/parent.md", "matter": "[[matter/house]]"},
                {"summary": "done", "follow_up_tasks": []},
            )
        )
        assert seen["target_path"] == "matter/house.md"   # normalized, no [[ ]]
        assert seen["propose"] == "task_runner.matter_resolved"
