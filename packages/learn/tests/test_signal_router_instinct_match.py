"""Sir #4+#5 — close the signal→instinct loop.

Symptom on the live tenant: 8 signals in state.db, 11 instincts in vault,
**0 of 8 signals carry ``matched_instinct``**. The router (route_signal_action)
already runs the matcher and computes ``matched_path``, but that value is never
persisted back onto the state.db signal row — ``set_signal_status`` only stamps
``status`` + ``applied_at`` + ``audit_record_path``, dropping the match on the
floor. Instincts are dead inventory: the matter aggregator, /instincts UI, and
any downstream "instinct N has fired K times" surface all see zero.

These tests pin two contracts:

  1. ``set_signal_status`` accepts an optional ``matched_instinct`` kwarg and
     persists it into the signal row's payload (without clobbering the
     existing payload — the prior code path would also wipe action_proposal,
     reasoning, etc. on every PATCH).

  2. ``route_signal_action``, when its internal matcher finds a viable
     instinct, passes that path through to ``set_signal_status`` on every
     terminal status write (routed_agent, routed_human, routed_suppressed).
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

import src.activities.signal_actions as sa
import src.utils.signal_state as signal_state


# ---------------------------------------------------------------------------
# Fakes — mirror test_signal_action_card_gate.py's shape
# ---------------------------------------------------------------------------


class _FakeStateDb:
    """Captures every set_signal_status call so the test can assert on it."""

    def __init__(self, signal_id: str, fm: dict[str, Any]) -> None:
        self.signal_id = signal_id
        self.frontmatter = dict(fm)
        # Each PATCH the router makes; (status, kwargs) tuples.
        self.patches: list[tuple[str, dict[str, Any]]] = []

    async def read_signal_record(self, ref, *, config=None):
        if ref != self.signal_id:
            return None
        return {
            "path": ref,
            "id": ref,
            "type": "signal",
            "frontmatter": dict(self.frontmatter),
        }

    async def set_signal_status(self, ref, status, **kwargs):
        self.frontmatter["status"] = status
        # Mirror the matched_instinct surface ctrl-api would expose
        # via signal_row_to_record's frontmatter rehydration.
        mi = kwargs.get("matched_instinct")
        if mi is not None:
            self.frontmatter["matched_instinct"] = mi
        self.patches.append((status, dict(kwargs)))


class _FakeVaultClient:
    open_cards: list[dict[str, Any]] = []

    def __init__(self, config: Any) -> None:
        pass

    async def read_record(self, path: str):
        return {"frontmatter": {}}

    async def list_records(self, record_type: str, status=None, limit: int = 100):
        rows = (
            list(_FakeVaultClient.open_cards)
            if record_type == "needs_attention" else []
        )
        if status:
            return [r for r in rows if r.get("status") == status][:limit]
        return rows[:limit]

    async def close(self):
        return None


async def _no_card(signal, matched_instinct_path, decision_reason) -> str:
    return "needs_attention/2026-05-24T00-00-00Z-deadbeef.md"


def _action_fm(**over: Any) -> dict[str, Any]:
    fm = {
        "type": "signal",
        "status": "action_pending",
        "effect": "action",
        "decision_required": True,
        "actor": "external",
        "source_event_path": "ingest:evt-rayon-1",
        "raw_quote": "Rayon payment failed for May invoice.",
        "reasoning": "Sir owes Rayon; the autopay bounced.",
        "display_headline": "Rayon's May payment failed",
        "action_proposal": {"what": "Reply to Rayon with updated card"},
        "target_kind": None,
        "target_confidence": 0.0,
        "effect_confidence": 0.8,
    }
    fm.update(over)
    return fm


def _instinct_record(name: str, path: str, keywords: list[str]) -> dict[str, Any]:
    """A vault list_records entry shape for an instinct."""
    return {
        "path": path,
        "frontmatter": {
            "type": "instinct",
            "name": name,
            "status": "active",
            "input_patterns": {
                "keywords": keywords,
            },
            # Description carries the same keywords so the
            # signal_actions._score_signal_against_instinct token-overlap
            # scorer fires (it works on description text, not the
            # canonical scorer's metadata shape).
            "description": " ".join(keywords),
            "discretion_threshold": 0.95,  # asking tier — forces HUMAN
        },
    }


def _install(monkeypatch, fake_db: _FakeStateDb, instincts: list[dict[str, Any]]):
    monkeypatch.setattr(
        signal_state, "read_signal_record", fake_db.read_signal_record
    )
    monkeypatch.setattr(
        signal_state, "set_signal_status", fake_db.set_signal_status
    )
    # route_signal_action does `from src.utils.signal_state import …` inside
    # the activity body — patch the symbol the activity actually resolved.
    monkeypatch.setattr(
        "src.activities.signal_actions.set_signal_status",
        fake_db.set_signal_status,
        raising=False,
    )
    monkeypatch.setattr(
        "src.activities.signal_actions.read_signal_record",
        fake_db.read_signal_record,
        raising=False,
    )
    import src.utils.vault_client as vc_mod
    monkeypatch.setattr(vc_mod, "VaultClient", _FakeVaultClient)
    monkeypatch.setattr(sa, "VaultClient", _FakeVaultClient, raising=False)
    import src.config as cfg_mod
    monkeypatch.setattr(cfg_mod, "load_config", lambda: object())
    monkeypatch.setattr(sa, "write_needs_attention_record", _no_card)

    async def _audit(**kw: Any) -> str:
        return "ulid-audit-test"

    async def _instincts_fn() -> list[Any]:
        return list(instincts)

    monkeypatch.setattr(sa, "_emit_signal_action_audit", _audit)
    monkeypatch.setattr(sa, "_load_active_instincts", _instincts_fn)
    monkeypatch.delenv(sa.SIGNAL_ACTION_LIVE_MODE_ENV, raising=False)
    _FakeVaultClient.open_cards = []


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_route_signal_action_stamps_matched_instinct_on_state_db(monkeypatch):
    """When the matcher fires, the state.db signal row carries matched_instinct.

    Without the fix the router computes ``matched_path`` and uses it for the
    HIGH/HUMAN branch, but never persists it — every signal ends up with
    ``matched_instinct`` unset on the state.db row, regardless of whether an
    instinct fired. This test fails RED on the unfixed code because the
    set_signal_status call lacks the matched_instinct kwarg.
    """
    fm = _action_fm()
    fake_db = _FakeStateDb("sig-rayon-1", fm)
    inst = _instinct_record(
        name="rayon-payments",
        path="instinct/rayon-payments.md",
        keywords=["rayon", "payment", "failed"],
    )
    _install(monkeypatch, fake_db, [inst])

    result = asyncio.run(sa.route_signal_action("sig-rayon-1", "live"))

    assert result.get("matched_instinct") == "instinct/rayon-payments.md", (
        f"router result must surface the matched path; got "
        f"{result.get('matched_instinct')!r}"
    )
    # The terminal status write MUST stamp matched_instinct so the signal
    # row in state.db carries the value (where /instincts + matter
    # aggregator + audit feeds read it from).
    terminal = [(s, kw) for s, kw in fake_db.patches
                if s in ("routed_human", "routed_agent")]
    assert terminal, (
        f"expected a terminal routed_* PATCH; saw "
        f"{[s for s, _ in fake_db.patches]}"
    )
    s, kw = terminal[-1]
    assert kw.get("matched_instinct") == "instinct/rayon-payments.md", (
        f"set_signal_status({s}) must persist matched_instinct; "
        f"got kwargs={kw!r}"
    )
    # And the rehydrated row must surface it.
    assert fake_db.frontmatter.get("matched_instinct") == (
        "instinct/rayon-payments.md"
    )


def test_route_signal_action_no_match_leaves_matched_instinct_null(monkeypatch):
    """No matching instinct → matched_instinct stays None (don't stamp junk)."""
    fm = _action_fm()
    fake_db = _FakeStateDb("sig-unmatched", fm)
    inst = _instinct_record(
        name="utterly-unrelated",
        path="instinct/utterly-unrelated.md",
        keywords=["aardvark", "zenith", "qux"],
    )
    _install(monkeypatch, fake_db, [inst])

    result = asyncio.run(sa.route_signal_action("sig-unmatched", "live"))

    assert result.get("matched_instinct") in (None, ""), (
        f"unmatched signal must not synthesise a match; got "
        f"{result.get('matched_instinct')!r}"
    )
    terminal = [(s, kw) for s, kw in fake_db.patches
                if s in ("routed_human", "routed_agent")]
    assert terminal
    s, kw = terminal[-1]
    # Explicit None is fine; the contract is "not a fake path".
    mi = kw.get("matched_instinct")
    assert mi in (None, ""), (
        f"set_signal_status({s}) must not invent a match; got {mi!r}"
    )


def test_set_signal_status_merges_payload_not_clobbers(monkeypatch):
    """set_signal_status must MERGE matched_instinct into existing payload.

    Direct unit test on the helper. Today the helper sends only
    ``{applied_at, audit_record_path}`` and ctrl-api overwrites the entire
    payload_json column — clobbering action_proposal, reasoning, display_*.
    The fix: pass matched_instinct AND include it in the payload patch.
    """
    captured: dict[str, Any] = {}

    class _StubStateClient:
        def __init__(self, cfg: Any) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def get_signal(self, ref):
            # Mirror ctrl-api's GET shape: ``payload`` as a JSON STRING
            # (the column value, unparsed). The merge path must coerce.
            return {
                "id": ref,
                "status": "action_pending",
                "payload": '{"action_proposal": {"what": "Reply to Rayon"}, '
                           '"reasoning": "autopay bounced"}',
            }

        async def update_signal(self, ref, *, status=None,
                                salience=None, headline=None,
                                body=None, payload=None):
            captured["ref"] = ref
            captured["status"] = status
            captured["payload"] = dict(payload) if payload else None

    import src.utils.signal_state as ss
    monkeypatch.setattr(ss, "StateClient", _StubStateClient)
    monkeypatch.setattr(ss, "load_config", lambda: object())

    asyncio.run(ss.set_signal_status(
        "sig-merge-test", "routed_human",
        applied_at="2026-05-24T10:00:00Z",
        audit_record_ref="ulid-audit-xyz",
        matched_instinct="instinct/rayon-payments.md",
    ))

    assert captured["status"] == "routed_human"
    payload = captured["payload"] or {}
    assert payload.get("matched_instinct") == "instinct/rayon-payments.md", (
        f"matched_instinct must land in payload patch; got {payload!r}"
    )
    # Existing payload fields must survive the PATCH (ctrl-api overwrites
    # payload_json wholesale, so the merge has to happen client-side).
    assert payload.get("reasoning") == "autopay bounced", (
        "set_signal_status must merge — not clobber — the existing payload "
        f"(reasoning was dropped); got {payload!r}"
    )
    ap = payload.get("action_proposal") or {}
    assert ap.get("what") == "Reply to Rayon", (
        f"action_proposal survived merge? got {payload!r}"
    )
