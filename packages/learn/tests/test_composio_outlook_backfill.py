"""Tests for the Outlook onboarding collectors (issue #758).

The page loop, the two activities, and the incremental-sync argument entry —
with ``composio_pull`` and the ctrl client monkeypatched so nothing hits the
network. Mirrors ``test_composio_gmail_backfill.py``.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities import pull  # noqa: E402
from src.activities.pull import (  # noqa: E402
    _composio_outlook_pages,
    build_sync_args,
    composio_backfill_outlook_as_events,
    composio_fetch_email_metadata_outlook,
)


def _page(n: int, start: int = 0) -> dict:
    return {
        "successful": True,
        "data": {"response_data": {"value": [
            {
                "id": f"AAMk-{start + i}",
                "subject": f"msg {start + i}",
                "from": {"emailAddress": {"address": f"sender{start + i}@corp.example"}},
                "toRecipients": [{"emailAddress": {"address": "me@corp.example"}}],
                "receivedDateTime": "2026-08-01T09:00:00Z",
                "bodyPreview": "body",
                "conversationId": f"c{start + i}",
            }
            for i in range(n)
        ]}},
    }


# --- page loop --------------------------------------------------------------

async def _collect(gen) -> list[dict]:
    out: list[dict] = []
    async for page in gen:
        out.extend(page)
    return out


@pytest.mark.asyncio
async def test_pages_loop_terminates_on_short_page(monkeypatch) -> None:
    calls: list[dict] = []

    async def fake_pull(action, args=None, connected_account_id=None, **kw):
        calls.append(args)
        # first call full page (250), second call short page (10) → stop
        return _page(250) if len(calls) == 1 else _page(10, start=250)

    monkeypatch.setattr(pull, "composio_pull", fake_pull)
    msgs = await _collect(_composio_outlook_pages("Inbox", "2026-06-01T00:00:00Z", max_messages=5000))
    assert len(msgs) == 260
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_pages_loop_paginates_by_skip(monkeypatch) -> None:
    skips: list[int] = []

    async def fake_pull(action, args=None, connected_account_id=None, **kw):
        skips.append(args["skip"])
        return _page(250) if len(skips) == 1 else _page(3, start=250)

    monkeypatch.setattr(pull, "composio_pull", fake_pull)
    await _collect(_composio_outlook_pages("Inbox", "x", max_messages=5000))
    assert skips == [0, 250]


@pytest.mark.asyncio
async def test_pages_loop_respects_max_messages(monkeypatch) -> None:
    async def fake_pull(action, args=None, connected_account_id=None, **kw):
        return _page(250, start=args["skip"])

    monkeypatch.setattr(pull, "composio_pull", fake_pull)
    msgs = await _collect(_composio_outlook_pages("Inbox", "x", max_messages=300))
    assert len(msgs) >= 300  # stops at the first page boundary past the cap
    assert len(msgs) <= 500


@pytest.mark.asyncio
async def test_pages_loop_retries_flaky_page(monkeypatch) -> None:
    calls = {"n": 0}

    async def fake_pull(action, args=None, connected_account_id=None, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"successful": False, "error": "HTTP 429 throttled"}
        return _page(2)

    async def no_sleep(*a, **k):
        return None

    monkeypatch.setattr(pull, "composio_pull", fake_pull)
    monkeypatch.setattr("asyncio.sleep", no_sleep)
    msgs = await _collect(_composio_outlook_pages("Inbox", "x", max_messages=5000))
    assert len(msgs) == 2
    assert calls["n"] == 2  # one retry then success


@pytest.mark.asyncio
async def test_pages_loop_raises_after_max_retries(monkeypatch) -> None:
    async def fake_pull(action, args=None, connected_account_id=None, **kw):
        return {"successful": False, "error": "HTTP 500 boom"}

    async def no_sleep(*a, **k):
        return None

    monkeypatch.setattr(pull, "composio_pull", fake_pull)
    monkeypatch.setattr("asyncio.sleep", no_sleep)
    with pytest.raises(RuntimeError):
        await _collect(_composio_outlook_pages("Inbox", "x", max_messages=5000))


# --- metadata activity ------------------------------------------------------

@pytest.mark.asyncio
async def test_fetch_metadata_writes_profiler_shape(monkeypatch, tmp_path) -> None:
    async def fake_pages(folder, received_ge_iso, max_messages, connected_account_id=None, **kw):
        # one page per folder
        for m in _page(2, start=0 if folder == "Inbox" else 100)["data"]["response_data"]["value"]:
            pass
        yield _page(2, start=0 if folder == "Inbox" else 100)["data"]["response_data"]["value"]

    monkeypatch.setattr(pull, "_composio_outlook_pages", fake_pages)
    monkeypatch.setattr(pull, "sample_emails_per_day", lambda e: e, raising=False)
    import src.activities._email_sampling as es
    monkeypatch.setattr(es, "sample_emails_per_day", lambda e: e)
    monkeypatch.setattr(
        "src.integrations.composio_client.resolve_active_connected_account_id",
        lambda tk: "ca_x",
    )

    async def no_narr(emails):
        return None
    monkeypatch.setattr("src.activities.inbox_narration.generate_inbox_narration", no_narr)

    onboard = tmp_path / "onboard.json"
    monkeypatch.setenv("ONBOARD_PATH", str(onboard))
    result = await composio_fetch_email_metadata_outlook("me")

    assert result["count"] == 4  # 2 Inbox + 2 SentItems
    data = json.loads(onboard.read_text())
    assert len(data["emails"]) == 4
    e = data["emails"][0]
    assert set(e.keys()) == {"from", "to", "subject", "date", "snippet", "domain"}
    assert e["domain"] == "corp.example"


# --- backfill activity ------------------------------------------------------

@pytest.mark.asyncio
async def test_backfill_ingests_with_outlook_stream_type(monkeypatch) -> None:
    posted: list[dict] = []

    async def fake_pages(folder, received_ge_iso, max_messages, connected_account_id=None, **kw):
        if folder == "Inbox":
            yield _page(2)["data"]["response_data"]["value"]

    class FakeResp:
        status_code = 200
        def json(self):
            return {"status": "ok"}

    class FakeCtrl:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def post(self, path, json=None):
            posted.append(json)
            return FakeResp()

    monkeypatch.setattr(pull, "_composio_outlook_pages", fake_pages)
    monkeypatch.setattr(pull, "_ctrl_client", lambda cfg: FakeCtrl())
    monkeypatch.setattr(pull, "load_config", lambda: {})
    monkeypatch.setattr(
        "src.integrations.composio_client.resolve_active_connected_account_id",
        lambda tk: "ca_x",
    )

    ingested = await composio_backfill_outlook_as_events("stream-1", "me")
    assert ingested == 2
    assert all(p["stream_type"] == "outlook" for p in posted)
    assert all(p["metadata"]["provider"] == "outlook" for p in posted)
    assert posted[0]["source_ref"].startswith("composio:")


# --- incremental sync args (the _z placeholders) ---------------------------

@pytest.mark.asyncio
async def test_sync_args_backfill_uses_iso_z() -> None:
    args = await build_sync_args("OUTLOOK_OUTLOOK_LIST_MESSAGES", "", "")
    # backfill (no last_pull) → received_date_time_ge, ISO with a Z suffix
    assert "received_date_time_ge" in args
    assert args["received_date_time_ge"].endswith("Z")
    assert "+00:00" not in args["received_date_time_ge"]
    assert args["top"] == 250


@pytest.mark.asyncio
async def test_sync_args_incremental_uses_gt() -> None:
    args = await build_sync_args(
        "OUTLOOK_OUTLOOK_LIST_MESSAGES", "", "2026-09-01T00:00:00+00:00"
    )
    assert "received_date_time_gt" in args
    assert args["received_date_time_gt"].endswith("Z")
