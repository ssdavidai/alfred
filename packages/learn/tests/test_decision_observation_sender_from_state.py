"""BUG 2 — Desk clicks must link to instincts (sender resolved post-cutover).

`_resolve_sender_for_needs_attention` chased the signal/event over the
VAULT route, but post-4-store-cutover the NA card's `source_signal_path`
is a state.db ULID and its `source_event_path` is an `ingest:<id>` ref —
both 404 on the vault route, so sender="" and `instinct_ref` stayed NULL
for ~81% of clicks. The resolver must read the signal from state.db and
the event from ingest.db.
"""
from __future__ import annotations

from src.activities import decision_observations as dobs


class _Resp:
    def __init__(self, status: int, payload: dict) -> None:
        self.status_code = status
        self._p = payload

    def json(self) -> dict:
        return self._p


class _NAClient:
    """Stands in for the httpx client: only the NA-card vault read is
    served here; the signal/event reads go through the state.db / ingest
    helpers (monkeypatched below), NOT this client."""

    async def get(self, url: str, *a, **k):
        if url.startswith("/api/v1/vault/records/needs_attention/"):
            return _Resp(200, {"frontmatter": {
                "source_signal_path": "01ULIDSIGNAL0000000000000",
                "source_event_path": "ingest:01ULIDEVENT0000000000000",
            }})
        # Any attempt to read the ULID/ingest ref over the vault route
        # 404s — exactly the pre-cutover breakage this fix routes around.
        return _Resp(404, {})


async def test_sender_resolved_from_state_and_ingest(monkeypatch) -> None:
    import src.utils.signal_state as sstate
    import src.activities.signals as sigmod

    async def fake_read_signal(ref, **k):
        assert ref == "01ULIDSIGNAL0000000000000"
        return {"frontmatter": {
            "source_event_path": "ingest:01ULIDEVENT0000000000000",
            "raw_quote": "Your run failed — body only, no From header",
        }}

    async def fake_fetch_ingest(evid):
        assert evid == "01ULIDEVENT0000000000000"
        return {"frontmatter": {
            "source_type": "gmail",
            "from": "GitHub <notifications@github.com>",
            "subject": "CI workflow failed",
        }}

    monkeypatch.setattr(sstate, "read_signal_record", fake_read_signal)
    monkeypatch.setattr(sigmod, "_fetch_ingest_event_as_record", fake_fetch_ingest)

    sender = await dobs._resolve_sender_for_needs_attention(
        _NAClient(), "needs_attention/card.md",
    )
    # Pre-fix: "" (vault GET of the ULID 404s). Post-fix: recovered.
    assert "notifications@github.com" in sender


async def test_sender_falls_back_to_na_card_event_path_when_signal_evicted(
    monkeypatch,
) -> None:
    """If the signal row aged out of state.db but the ingest event
    survives, recover the sender from the NA card's own event ref."""
    import src.utils.signal_state as sstate
    import src.activities.signals as sigmod

    async def fake_read_signal(ref, **k):
        return None  # signal evicted

    async def fake_fetch_ingest(evid):
        assert evid == "01ULIDEVENT0000000000000"
        return {"frontmatter": {
            "source_type": "gmail",
            "from": "GitHub <notifications@github.com>",
        }}

    monkeypatch.setattr(sstate, "read_signal_record", fake_read_signal)
    monkeypatch.setattr(sigmod, "_fetch_ingest_event_as_record", fake_fetch_ingest)

    sender = await dobs._resolve_sender_for_needs_attention(
        _NAClient(), "needs_attention/card.md",
    )
    assert "notifications@github.com" in sender
