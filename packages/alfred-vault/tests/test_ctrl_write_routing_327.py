"""#327 — canonical writes route through ctrl-api; loop-breaker respected."""
from __future__ import annotations

import pytest

from alfred import ctrl_client
from alfred.vault import ops


@pytest.fixture
def vault(tmp_path):
    (tmp_path / "matter").mkdir()
    (tmp_path / "matter" / "house.md").write_text(
        "---\ntype: matter\nname: House\nstatus: active\ntags: []\n---\nbody\n"
    )
    return tmp_path


class TestRoutingDecision:
    def test_daemons_route_via_ctrl(self, monkeypatch):
        monkeypatch.setenv("ALFRED_CTRL_URL", "http://ctrl-api:3100")
        monkeypatch.delenv("ALFRED_CTRL_BACKEND", raising=False)
        assert ctrl_client.via_ctrl_enabled() is True

    def test_ctrl_backend_writes_direct(self, monkeypatch):
        monkeypatch.setenv("ALFRED_CTRL_URL", "http://ctrl-api:3100")
        monkeypatch.setenv("ALFRED_CTRL_BACKEND", "1")
        assert ctrl_client.via_ctrl_enabled() is False

    def test_escape_hatch(self, monkeypatch):
        monkeypatch.setenv("ALFRED_CTRL_URL", "http://ctrl-api:3100")
        monkeypatch.setenv("ALFRED_VAULT_DIRECT_WRITES", "1")
        assert ctrl_client.via_ctrl_enabled() is False

    def test_no_ctrl_url_direct(self, monkeypatch):
        monkeypatch.delenv("ALFRED_CTRL_URL", raising=False)
        assert ctrl_client.via_ctrl_enabled() is False


class TestOpsRouting:
    def test_edit_routes_to_ctrl(self, vault, monkeypatch):
        monkeypatch.setenv("ALFRED_CTRL_URL", "http://x")
        monkeypatch.delenv("ALFRED_CTRL_BACKEND", raising=False)
        calls = []
        monkeypatch.setattr(
            ctrl_client, "ctrl_edit",
            lambda rel, **kw: calls.append((rel, kw)) or {"path": rel, "fields_changed": ["status"]},
        )
        out = ops.vault_edit(vault, "matter/house.md", set_fields={"status": "dormant"})
        assert calls and calls[0][0] == "matter/house.md"
        assert calls[0][1]["set_fields"] == {"status": "dormant"}
        assert out["path"] == "matter/house.md"
        # file untouched — ctrl owns the write
        assert "status: active" in (vault / "matter" / "house.md").read_text()

    def test_edit_append_fields_merged_clientside(self, vault, monkeypatch):
        monkeypatch.setenv("ALFRED_CTRL_URL", "http://x")
        monkeypatch.delenv("ALFRED_CTRL_BACKEND", raising=False)
        calls = []
        monkeypatch.setattr(
            ctrl_client, "ctrl_edit",
            lambda rel, **kw: calls.append(kw) or {"path": rel, "fields_changed": []},
        )
        ops.vault_edit(vault, "matter/house.md", append_fields={"tags": "hot"})
        assert calls[0]["set_fields"]["tags"] == ["hot"]

    def test_backend_env_keeps_direct_write(self, vault, monkeypatch):
        monkeypatch.setenv("ALFRED_CTRL_URL", "http://x")
        monkeypatch.setenv("ALFRED_CTRL_BACKEND", "1")
        out = ops.vault_edit(vault, "matter/house.md", set_fields={"status": "dormant"})
        assert out["fields_changed"] == ["status"]
        assert "status: dormant" in (vault / "matter" / "house.md").read_text()

    def test_create_routes_rendered_content(self, vault, monkeypatch):
        monkeypatch.setenv("ALFRED_CTRL_URL", "http://x")
        monkeypatch.delenv("ALFRED_CTRL_BACKEND", raising=False)
        calls = []
        monkeypatch.setattr(
            ctrl_client, "ctrl_create",
            lambda rt, name, content: calls.append((rt, name, content)) or {"path": f"{rt}/{name}.md"},
        )
        out = ops.vault_create(vault, "note", "test-note", body="hello")
        rt, name, content = calls[0]
        assert (rt, name) == ("note", "test-note")
        assert content.startswith("---") and "type: note" in content and "hello" in content
        assert out["path"] == "note/test-note.md"
        assert not (vault / "note" / "test-note.md").exists()
