"""Batch reversal of bulk_triage decisions — five requirements tested."""
from __future__ import annotations
import asyncio
from typing import Any
import httpx
import src.activities.decision_router as dr


class _R:
    def __init__(self, code: int = 200) -> None:
        self.status_code = code
    def json(self) -> dict:
        return {}
    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("e", request=httpx.Request("G","http://t"), response=httpx.Response(self.status_code))


class _FC:
    def __init__(self, card_404s: set[str] | None = None) -> None:
        self.calls: list[tuple[str, str, Any]] = []
        self._404s = card_404s or set()
    async def __aenter__(self): return self
    async def __aexit__(self, *a): pass
    async def get(self, u, **_): return _R(404)
    async def post(self, u, **k):
        self.calls.append(("POST", u, k.get("json")))
        return _R()
    async def patch(self, u, **k):
        self.calls.append(("PATCH", u, k.get("json")))
        for na in self._404s:
            if na in u:
                return _R(404)
        return _R()
    def card_patches(self): return [u for m,u,_ in self.calls if m=="PATCH" and "needs_attention" in u]
    def decision_patches(self): return [b for m,u,b in self.calls if m=="PATCH" and "decisions/" in u]
    def audit_posts(self): return [b for m,u,b in self.calls if m=="POST" and "state/audit" in u]


class _Cfg:
    alfred_ctrl_url = "http://ctrl-test:3100"


def _install(monkeypatch, card_404s=None):
    fc = _FC(card_404s)
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: fc)
    import src.config as c; monkeypatch.setattr(c, "load_config", lambda: _Cfg())
    monkeypatch.setenv("AAS_API_KEY", "k")
    return fc


def _bd(cards, extra_se=None):
    return {"id": "b-001", "intent": "done", "source": "needs_attention",
            "source_record": "", "decision_origin": "bulk_triage", "state": "reversed",
            "side_effects": {"source_records": cards, **(extra_se or {})}}


def test_reopens_all_cards(monkeypatch):
    fc = _install(monkeypatch)
    cards = ["needs_attention/a.md", "needs_attention/b.md", "needs_attention/c.md"]
    r = asyncio.run(dr.reverse_decision(_bd(cards)))
    assert r["batch_reversal"]["reopened"] == 3
    assert r["batch_reversal"]["skipped"] == 0
    assert len(fc.card_patches()) == 3


def test_stamps_reversal_processed(monkeypatch):
    fc = _install(monkeypatch)
    asyncio.run(dr.reverse_decision(_bd(["needs_attention/x.md"])))
    stamped = any(
        isinstance(b, dict) and b.get("side_effects", {}).get("reversal_processed") is True
        for b in fc.decision_patches()
    )
    assert stamped, f"reversal_processed not stamped; patches={fc.decision_patches()}"


def test_skips_missing_card(monkeypatch):
    fc = _install(monkeypatch, card_404s={"card-gone"})
    r = asyncio.run(dr.reverse_decision(_bd(["needs_attention/card-gone.md", "needs_attention/card-ok.md"])))
    assert r["batch_reversal"]["reopened"] == 1
    assert r["batch_reversal"]["skipped"] == 1
    se = next(b["side_effects"] for b in fc.decision_patches() if isinstance(b, dict) and "batch_reversal_skipped" in (b.get("side_effects") or {}))
    assert se["batch_reversal_skipped_details"][0]["reason"] == "not_found"


def test_writes_exactly_one_audit_row(monkeypatch):
    fc = _install(monkeypatch)
    asyncio.run(dr.reverse_decision(_bd(["needs_attention/a.md", "needs_attention/b.md"])))
    assert len(fc.audit_posts()) == 1
    a = fc.audit_posts()[0]
    assert a["source"] == "decision_router.batch_reversal"
    assert a["changes"]["total"] == 2 and a["changes"]["reopened"] == 2


def test_single_card_path_unchanged(monkeypatch):
    fc = _install(monkeypatch)
    r = asyncio.run(dr.reverse_decision({
        "id": "s-001", "intent": "done", "source": "needs_attention",
        "source_record": "needs_attention/solo.md", "state": "reversed", "side_effects": {},
    }))
    assert "batch_reversal" not in r
    assert any("solo" in u for u in fc.card_patches())
