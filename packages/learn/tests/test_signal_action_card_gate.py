"""P0-2 — relevance/quality + de-dup gate before a signal becomes a Desk card.

Prod runs the action router in *shadow* mode, which routes EVERY effect=action
signal to the human path → a card; the over-classifying gpt-4.1-nano extractor
then floods the Desk with junk (cards whose own reasoning says "no concrete
action … just broadcast info") and duplicates (Mailgun ×2, Rayon ×2). These
tests pin two deterministic gates that run *within* the shadow path (we do NOT
flip shadow→live): de-dup and a relevance gate. A genuine actionable signal
still cards.
"""
from __future__ import annotations

import asyncio
from typing import Any

import src.activities.signal_actions as sa
import src.utils.signal_state as signal_state


class _FakeStateDb:
    def __init__(self, signal_id: str, fm: dict[str, Any]) -> None:
        self.signal_id, self.frontmatter = signal_id, dict(fm)

    async def read_signal_record(self, ref, *, config=None):
        return None if ref != self.signal_id else {
            "path": ref, "id": ref, "type": "signal",
            "frontmatter": dict(self.frontmatter)}

    async def set_signal_status(self, ref, status, **_):
        self.frontmatter["status"] = status


class _FakeVaultClient:
    open_cards: list[dict[str, Any]] = []

    def __init__(self, config: Any) -> None:
        pass

    async def read_record(self, path: str):
        return {"frontmatter": {}}

    async def list_records(self, record_type: str, status=None, limit: int = 100):
        rows = list(_FakeVaultClient.open_cards) if record_type == "needs_attention" else []
        return [r for r in rows if r.get("status") == status][:limit] if status else rows[:limit]

    async def close(self):
        return None


class _CardCounter:
    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, signal, matched_instinct_path, decision_reason) -> str:
        self.calls += 1
        return "needs_attention/2026-05-22T00-00-00Z-deadbeef.md"


def _action_fm(**over: Any) -> dict[str, Any]:
    fm = {
        "type": "signal", "status": "action_pending", "effect": "action",
        "decision_required": True, "actor": "external",
        "source_event_path": "ingest:evt-001",
        "raw_quote": "Your Mailgun account needs SMTP confirmed.",
        "reasoning": "Sir must choose SMTP vs API for Mailgun before sending.",
        "display_headline": "Confirm Mailgun SMTP vs API",
        "action_proposal": {"what": "Confirm Mailgun SMTP vs API setup"},
        "target_kind": None, "target_confidence": 0.0, "effect_confidence": 0.8,
    }
    fm.update(over)
    return fm


def _install(monkeypatch, fake_db: _FakeStateDb, card: _CardCounter):
    monkeypatch.setattr(signal_state, "read_signal_record", fake_db.read_signal_record)
    monkeypatch.setattr(signal_state, "set_signal_status", fake_db.set_signal_status)
    import src.utils.vault_client as vc_mod
    monkeypatch.setattr(vc_mod, "VaultClient", _FakeVaultClient)
    monkeypatch.setattr(sa, "VaultClient", _FakeVaultClient, raising=False)
    import src.config as cfg_mod
    monkeypatch.setattr(cfg_mod, "load_config", lambda: object())
    monkeypatch.setattr(sa, "write_needs_attention_record", card)

    async def _audit(**kw: Any) -> str:
        return "event/signal-action-test.md"

    async def _instincts() -> list[Any]:
        return []

    monkeypatch.setattr(sa, "_emit_signal_action_audit", _audit)
    monkeypatch.setattr(sa, "_load_active_instincts", _instincts)
    # Leave the env UNSET → effective_mode resolves to shadow (the prod path).
    monkeypatch.delenv(sa.SIGNAL_ACTION_LIVE_MODE_ENV, raising=False)
    _FakeVaultClient.open_cards = []


def test_genuine_actionable_signal_still_cards(monkeypatch):
    fake_db = _FakeStateDb("sig-real", _action_fm())
    card = _CardCounter()
    _install(monkeypatch, fake_db, card)
    result = asyncio.run(sa.route_signal_action("sig-real", "live"))
    assert card.calls == 1, "a genuine actionable signal must still card"
    assert result["chosen_path"] == "human"


def test_pure_broadcast_signal_does_not_card(monkeypatch):
    """Model self-contradicts: reasoning says 'no concrete action / broadcast'."""
    fake_db = _FakeStateDb("sig-junk", _action_fm(
        reasoning=("Automated PSA from external sender; no concrete action or "
                   "mutation for Sir. It's just broadcast info."),
        display_headline="Consider acknowledging International HR Day"))
    card = _CardCounter()
    _install(monkeypatch, fake_db, card)
    result = asyncio.run(sa.route_signal_action("sig-junk", "live"))
    assert card.calls == 0, "a pure-broadcast/no-action signal must NOT card"
    assert result.get("skip_reason")


def test_duplicate_open_card_is_not_re_carded(monkeypatch):
    """A recent OPEN card on the same source event blocks a second card."""
    fake_db = _FakeStateDb("sig-dupe", _action_fm())
    card = _CardCounter()
    _install(monkeypatch, fake_db, card)
    _FakeVaultClient.open_cards = [{
        "path": "needs_attention/2026-05-22T07-00-00Z-aaaa1111.md",
        "status": "pending", "source_event_path": "ingest:evt-001",
        "display_headline": "Confirm Mailgun SMTP vs API"}]
    result = asyncio.run(sa.route_signal_action("sig-dupe", "live"))
    assert card.calls == 0, "a duplicate of an open card must NOT card again"
    assert result.get("skip_reason")
