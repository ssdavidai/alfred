"""F39 — decision→observation must fire and stamp instinct_ref.

The intuition engine advances an instinct off "Asking" only as
``kind='decision'`` observations carrying ``instinct_ref`` accumulate
(``live_observation_count`` drives the discretion threshold). Live, the
``observation`` table had 0 ``kind='decision'`` rows and 0 ``instinct_ref``
so every pattern stayed frozen in Asking.

These tests pin the producer: ``extract_observation_from_decision`` writes
exactly one ``kind='decision'`` observation per decision and, when the
deterministic scorer matches an instinct, stamps that instinct path as
``instinct_ref`` (the field the /instincts count reader keys on). Depends
on F31 (decisions must flow to the router for this to fire on real cards).
"""
from __future__ import annotations

import asyncio
from typing import Any

import src.activities.decision_observations as dobs


class _FakeStateClient:
    def __init__(self, recorder: dict) -> None:
        self.recorder = recorder

    async def __aenter__(self) -> "_FakeStateClient":
        return self

    async def __aexit__(self, *a: Any) -> None:
        return None

    async def create_observation(self, **kwargs: Any) -> str:
        self.recorder["calls"].append(kwargs)
        return "01OBSULID0000000000000000"


def _install(monkeypatch, *, instinct_path: str | None) -> dict:
    recorder: dict[str, list] = {"calls": []}

    import src.config as cfg_mod

    class _Cfg:
        alfred_ctrl_url = "http://ctrl-test:3100"

    monkeypatch.setattr(cfg_mod, "load_config", lambda: _Cfg())
    monkeypatch.setenv("AAS_API_KEY", "test-key")

    # StateClient is imported lazily inside the activity from signal_state.
    import src.utils.signal_state as ss
    monkeypatch.setattr(
        ss, "StateClient", lambda cfg: _FakeStateClient(recorder)
    )

    # Sender enrichment + instinct scoring are best-effort network calls;
    # stub them deterministically so the test is hermetic.
    async def _no_sender(client, source_record):  # noqa: ANN001
        return ""

    async def _match(**kwargs: Any) -> str | None:
        return instinct_path

    monkeypatch.setattr(dobs, "_resolve_sender_for_needs_attention", _no_sender)
    monkeypatch.setattr(dobs, "_match_instinct_for_observation", _match)
    # _http() is only used for sender enrichment, which we stubbed; give it
    # a no-op client so the context manager doesn't try a real connection.

    class _NoopClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

    monkeypatch.setattr(dobs, "_http", lambda: _NoopClient())
    return recorder


def _decision() -> dict[str, Any]:
    return {
        "id": "2026-05-22-dec-1",
        "intent": "noise",
        "source": "needs_attention",
        "source_record": "needs_attention/card.md",
        "source_headline": "Newsletter from Acme",
        "note": "",
    }


def test_writes_one_kind_decision_observation(monkeypatch):
    rec = _install(monkeypatch, instinct_path=None)
    result = asyncio.run(dobs.extract_observation_from_decision(_decision()))
    assert len(rec["calls"]) == 1, "exactly one observation per decision"
    call = rec["calls"][0]
    assert call["kind"] == "decision"
    assert call["decision_ref"] == "decision/2026-05-22-dec-1.md"
    assert result["observation_path"]


def test_stamps_instinct_ref_when_scorer_matches(monkeypatch):
    rec = _install(monkeypatch, instinct_path="instinct/2026-05-acme-noise.md")
    asyncio.run(dobs.extract_observation_from_decision(_decision()))
    call = rec["calls"][0]
    # instinct_ref is the field the /instincts count reader keys on to
    # advance a pattern off "Asking".
    assert call["instinct_ref"] == "instinct/2026-05-acme-noise.md"
    # The payload mirror carries it too for the clusterer.
    assert call["payload"]["instinct"] == "instinct/2026-05-acme-noise.md"


def test_instinct_ref_none_when_no_match(monkeypatch):
    rec = _install(monkeypatch, instinct_path=None)
    asyncio.run(dobs.extract_observation_from_decision(_decision()))
    call = rec["calls"][0]
    assert call["instinct_ref"] is None
    assert call["kind"] == "decision"
