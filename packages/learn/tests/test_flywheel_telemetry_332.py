"""#332 — flywheel loop-health telemetry."""
from __future__ import annotations

import asyncio
import json

from src.activities import flywheel_telemetry as ft


class _SC:
    def __init__(self):
        self.audits = []

    async def __aenter__(self): return self
    async def __aexit__(self, *a): return None

    async def list_observations(self, **kw):
        return [
            {"ts": "2026-07-31T10:00:00Z", "kind": "decision", "status": "processed"},
            {"ts": "2026-07-31T11:00:00Z", "kind": "signal", "status": "open"},
            {"ts": "2026-07-30T09:00:00Z", "kind": "decision", "status": "open"},  # out of window
        ]

    async def list_signals(self, **kw):
        return [
            {"ts": "2026-07-31T10:05:00Z", "status": "routed_human",
             "payload_json": json.dumps({"matched_instinct": "instinct/x.md"})},
            {"ts": "2026-07-31T10:06:00Z", "status": "routed_suppressed", "payload_json": "{}"},
        ]

    async def list_audit(self, **kw):
        if kw.get("action_type") == "instinct_tier_event":
            return {"entries": [{"ts": "2026-07-31T12:00:00Z"}]}
        return {"entries": []}

    async def append_audit(self, **kw):
        self.audits.append(kw)
        return "01A"


class _VC:
    def __init__(self, _cfg=None): pass
    async def list_decisions(self, **kw):
        return [
            {"created": "2026-07-31T10:10:00Z", "intent": "done", "state": "completed"},
            {"created": "2026-07-31T10:20:00Z", "intent": "delegate", "state": "reversed"},
        ]
    async def list_records(self, rtype, **kw):
        if rtype == "matter":
            return [{"frontmatter": {"as_of": "2026-07-31T23:00:00Z"}},
                    {"frontmatter": {"as_of": "2026-06-01T00:00:00Z"}}]
        return [{"frontmatter": {"parent_matter": "matter/x.md"}},
                {"frontmatter": {}}]
    async def notify(self, path, summary):
        self.notified = (path, summary)
    async def close(self): return None


def test_rollup_counts_and_persists(monkeypatch):
    sc = _SC()
    monkeypatch.setattr(ft, "StateClient", lambda _c: sc)
    monkeypatch.setattr(ft, "VaultClient", _VC)
    m = asyncio.run(ft.compute_flywheel_rollup("2026-07-31"))
    assert m["observations_by_kind"] == {"decision": 1, "signal": 1}
    assert m["observations_unprocessed_eod"] == 1
    assert m["signals_total"] == 2 and m["signals_matched_instinct"] == 1
    assert m["signals_routing"]["routed_suppressed"] == 1
    assert m["decisions_total"] == 2 and m["reversals"] == 1
    assert m["tier_events"] == 1
    assert m["matters_active"] == 2
    assert m["open_tasks_unlinked"] == 1
    (row,) = [a for a in sc.audits if a["action_type"] == "flywheel_rollup"]
    assert row["changes"]["day"] == "2026-07-31"
    assert "flywheel 2026-07-31" in row["summary"]


def test_digest_flags_flat_arms(monkeypatch):
    class _SC2(_SC):
        async def list_audit(self, **kw):
            return {"entries": [{"changes": {
                "day": "2026-07-30", "observations_total": 5,
                "observations_unprocessed_eod": 0, "signals_total": 9,
                "signals_matched_instinct": 0, "decisions_total": 4,
                "reversals": 0, "tier_events": 0, "open_tasks_unlinked": 2,
            }}]}
    vc = _VC()
    monkeypatch.setattr(ft, "StateClient", lambda _c: _SC2())
    monkeypatch.setattr(ft, "VaultClient", lambda _c: vc)
    out = asyncio.run(ft.send_flywheel_digest())
    assert out["sent"] is True
    assert any("instinct matching" in a for a in out["flat_arms"])
    assert any("tier promotion" in a for a in out["flat_arms"])
    assert "FLAT ARMS" in vc.notified[1]


def test_digest_no_rollups_no_send(monkeypatch):
    class _SC3(_SC):
        async def list_audit(self, **kw): return {"entries": []}
    monkeypatch.setattr(ft, "StateClient", lambda _c: _SC3())
    out = asyncio.run(ft.send_flywheel_digest())
    assert out["sent"] is False
