"""Tests for the Composio Gmail email-backfill path (issue #70, P3).

Covers the Composio variants of onboarding's email fetch:
  - composio_fetch_email_metadata  — Stage 1 metadata fetch
  - composio_backfill_gmail_as_events — background full backfill

The behaviour that matters:
  * the pagination loop terminates on an empty page;
  * every GMAIL_FETCH_EMAILS call sets verbose:false + max_results:500
    (the verbose:true path is capped at 30 — #474);
  * the per-message → onboard.json mapping carries the exact fields the
    behavioral profiler reads (from/to/subject/date/snippet/domain).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.pull import (  # noqa: E402
    _COMPOSIO_GMAIL_PAGE_SIZE,
    _composio_gmail_messages,
    _composio_gmail_pages,
    _composio_msg_to_email,
    composio_backfill_gmail_as_events,
    composio_fetch_email_metadata,
)


# ---------------------------------------------------------------------------
# _composio_gmail_messages — extract (messages, nextPageToken) from a response
# ---------------------------------------------------------------------------


def test_gmail_messages_flat_shape() -> None:
    resp = {"messages": [{"messageId": "a"}], "nextPageToken": "tok1"}
    msgs, token, err = _composio_gmail_messages(resp)
    assert msgs == [{"messageId": "a"}]
    assert token == "tok1"
    assert err is None


def test_gmail_messages_nested_under_data() -> None:
    resp = {"data": {"messages": [{"messageId": "b"}], "nextPageToken": "tok2"}}
    msgs, token, err = _composio_gmail_messages(resp)
    assert msgs == [{"messageId": "b"}]
    assert token == "tok2"
    assert err is None


def test_gmail_messages_nested_under_response_data() -> None:
    resp = {"data": {"response_data": {"messages": [{"messageId": "c"}]}}}
    msgs, token, err = _composio_gmail_messages(resp)
    assert msgs == [{"messageId": "c"}]
    assert token == ""
    assert err is None


def test_gmail_messages_empty_page_returns_empty() -> None:
    # An empty page is the loop's termination signal.
    msgs, token, err = _composio_gmail_messages({"data": {"messages": []}})
    assert msgs == []
    assert token == ""
    # No error — a truly empty page (Composio said ok) terminates the loop.
    assert err is None


def test_gmail_messages_missing_messages_returns_empty() -> None:
    msgs, token, err = _composio_gmail_messages({"data": {"nextPageToken": "x"}})
    assert msgs == []
    # token still surfaces, but the loop stops on empty `messages` anyway.
    assert token == "x"
    assert err is None


def test_gmail_messages_non_dict_is_safe() -> None:
    msgs, token, err = _composio_gmail_messages(None)
    assert (msgs, token) == ([], "")
    # non-dict surfaces as an error so the caller can decide to retry.
    assert err == "non-dict response"
    msgs, token, err = _composio_gmail_messages("not-a-dict")
    assert (msgs, token) == ([], "")
    msgs, token, err = _composio_gmail_messages([1, 2])
    assert (msgs, token) == ([], "")


def test_gmail_messages_drops_non_dict_items() -> None:
    resp = {"messages": [{"messageId": "a"}, "junk", None, {"messageId": "b"}]}
    msgs, _, err = _composio_gmail_messages(resp)
    assert msgs == [{"messageId": "a"}, {"messageId": "b"}]
    assert err is None


def test_gmail_messages_detects_composio_successful_false() -> None:
    # Composio's GMAIL_FETCH_EMAILS sometimes returns successful=false with
    # a 400 from Gmail on a single message's metadata — the whole batch fails
    # (#74). The parser MUST surface this as an error, not as an empty page,
    # so the page loop can retry instead of silently terminating with 0 emails.
    resp = {
        "successful": False,
        "data": {
            "message": (
                "HTTP 400 error while fetching message metadata: "
                "400 Client Error: Bad Request for url: "
                "https://www.googleapis.com/gmail/v1/users/me/messages/X?format=metadata"
            ),
            "status_code": 200,
        },
        "error": "HTTP 400 error while fetching message metadata: ...",
    }
    msgs, token, err = _composio_gmail_messages(resp)
    assert msgs == []
    assert token == ""
    assert err is not None
    assert "HTTP 400" in err


def test_gmail_messages_falls_back_to_data_message_when_no_top_error() -> None:
    # Some Composio responses set successful=false but only carry the message
    # under data.{message,error}; the parser must still surface a usable err.
    resp = {"successful": False, "data": {"message": "quota exceeded"}}
    msgs, token, err = _composio_gmail_messages(resp)
    assert (msgs, token) == ([], "")
    assert err == "quota exceeded"


# ---------------------------------------------------------------------------
# _composio_msg_to_email — verbose:false message → profiler email shape
# ---------------------------------------------------------------------------


def test_msg_to_email_full_verbose_false_shape() -> None:
    # The exact per-message shape the epic #66 probe confirmed under
    # verbose:false.
    msg = {
        "messageId": "18f...",
        "threadId": "t1",
        "sender": "Jane Doe <jane@acme.com>",
        "to": "owner@tenant.test",
        "subject": "Q2 numbers",
        "messageTimestamp": "2026-03-01T09:14:00Z",
        "labelIds": ["INBOX", "IMPORTANT"],
        "preview": {"body": "Here are the figures you asked for."},
    }
    email = _composio_msg_to_email(msg)
    # The profiler reads exactly these six keys (src/profiler/features.py).
    assert set(email) == {"from", "to", "subject", "date", "snippet", "domain"}
    assert email["from"] == "Jane Doe <jane@acme.com>"
    assert email["to"] == "owner@tenant.test"
    assert email["subject"] == "Q2 numbers"
    assert email["date"] == "2026-03-01T09:14:00Z"
    assert email["snippet"] == "Here are the figures you asked for."
    # Domain derived from the sender address — strips the angle bracket.
    assert email["domain"] == "acme.com"


def test_msg_to_email_no_at_sign_domain_is_unknown() -> None:
    email = _composio_msg_to_email({"sender": "mailer-daemon", "subject": "x"})
    assert email["domain"] == "unknown"


def test_msg_to_email_falls_back_to_snippet_field() -> None:
    # No preview.body — fall back to a flat snippet.
    msg = {"sender": "a@b.com", "snippet": "flat snippet text"}
    assert _composio_msg_to_email(msg)["snippet"] == "flat snippet text"


def test_msg_to_email_missing_fields_default_empty() -> None:
    email = _composio_msg_to_email({})
    assert email["from"] == ""
    assert email["subject"] == ""
    assert email["date"] == ""
    assert email["snippet"] == ""
    assert email["domain"] == "unknown"


# ---------------------------------------------------------------------------
# _composio_gmail_pages — the pagination loop
# ---------------------------------------------------------------------------


def _page(msg_ids: list[str], token: str = "") -> dict[str, Any]:
    """Build a fake GMAIL_FETCH_EMAILS response page."""
    body: dict[str, Any] = {"messages": [{"messageId": m} for m in msg_ids]}
    if token:
        body["nextPageToken"] = token
    return {"data": body}


async def test_pages_loop_terminates_on_empty_page() -> None:
    # Three real pages then an empty page — the loop must STOP on the empty
    # page, not spin forever.
    responses = [
        _page(["a", "b"], token="p2"),
        _page(["c", "d"], token="p3"),
        _page(["e"], token="p4"),
        _page([]),  # empty page — terminates the loop
    ]
    mock_pull = AsyncMock(side_effect=responses)
    with patch("src.activities.pull.composio_pull", mock_pull):
        collected: list[str] = []
        async for page in _composio_gmail_pages("after:2026/01/01", max_messages=5000):
            collected.extend(m["messageId"] for m in page)

    assert collected == ["a", "b", "c", "d", "e"]
    # 4 calls — three data pages + the empty terminator.
    assert mock_pull.await_count == 4


async def test_pages_loop_stops_when_no_next_token() -> None:
    # A page with messages but NO nextPageToken is the last page — the loop
    # must not make a further call.
    mock_pull = AsyncMock(side_effect=[_page(["a", "b"])])
    with patch("src.activities.pull.composio_pull", mock_pull):
        collected: list[str] = []
        async for page in _composio_gmail_pages("after:2026/01/01", max_messages=5000):
            collected.extend(m["messageId"] for m in page)

    assert collected == ["a", "b"]
    assert mock_pull.await_count == 1


async def test_pages_loop_sets_verbose_false_and_page_size() -> None:
    # EVERY call must carry verbose:false + max_results:500 — verbose:true
    # would silently cap the page at 30 (#474).
    mock_pull = AsyncMock(side_effect=[_page(["a"], token="p2"), _page([])])
    with patch("src.activities.pull.composio_pull", mock_pull):
        async for _ in _composio_gmail_pages("after:2026/01/01", max_messages=5000):
            pass

    for call in mock_pull.await_args_list:
        action_slug, args = call.args
        assert action_slug == "GMAIL_FETCH_EMAILS"
        assert args["verbose"] is False
        assert args["max_results"] == _COMPOSIO_GMAIL_PAGE_SIZE == 500
        assert args["userId"] == "me"
        assert "after:2026/01/01" in args["query"]


async def test_pages_loop_threads_page_token() -> None:
    # The nextPageToken from page N must be passed as page_token on call N+1.
    mock_pull = AsyncMock(
        side_effect=[_page(["a"], token="TOKEN-X"), _page([])]
    )
    with patch("src.activities.pull.composio_pull", mock_pull):
        async for _ in _composio_gmail_pages("q", max_messages=5000):
            pass

    first_args = mock_pull.await_args_list[0].args[1]
    second_args = mock_pull.await_args_list[1].args[1]
    assert "page_token" not in first_args  # first call has no token
    assert second_args["page_token"] == "TOKEN-X"


async def test_pages_loop_retries_flaky_page_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Composio bulk-fetch flake: page 1 fails (successful=false), retry
    # succeeds on the same args. The loop must NOT break on the failed
    # page — it must retry until it gets real data.
    failure = {
        "successful": False,
        "data": {"message": "HTTP 400 error fetching message metadata"},
        "error": "HTTP 400 ...",
    }
    success = _page(["a"], token="")  # one page, no next token
    # Compress the backoff so the test doesn't sleep for real.
    # Compress backoff: pull.py imports asyncio locally inside the loop,
    # so we patch the underlying asyncio.sleep module-wide.
    import asyncio as _asyncio
    monkeypatch.setattr(_asyncio, "sleep", AsyncMock())

    mock_pull = AsyncMock(side_effect=[failure, failure, success])
    with patch("src.activities.pull.composio_pull", mock_pull):
        collected: list[str] = []
        async for page in _composio_gmail_pages("q", max_messages=5000):
            collected.extend(m["messageId"] for m in page)

    assert collected == ["a"]
    # 2 failed attempts then 1 success = 3 calls.
    assert mock_pull.await_count == 3


async def test_pages_loop_raises_after_max_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # When EVERY page-level retry fails, the loop must raise so Temporal
    # retries the whole activity instead of silently producing 0 emails.
    failure = {
        "successful": False,
        "error": "HTTP 400 fetching message metadata",
    }
    # Generate enough failures to exhaust the retry budget.
    from src.activities.pull import _PAGE_MAX_RETRIES
    mock_pull = AsyncMock(side_effect=[failure] * (_PAGE_MAX_RETRIES + 2))
    # Compress backoff: pull.py imports asyncio locally inside the loop,
    # so we patch the underlying asyncio.sleep module-wide.
    import asyncio as _asyncio
    monkeypatch.setattr(_asyncio, "sleep", AsyncMock())

    with patch("src.activities.pull.composio_pull", mock_pull):
        with pytest.raises(RuntimeError, match="composio GMAIL_FETCH_EMAILS failed"):
            async for _ in _composio_gmail_pages("q", max_messages=5000):
                pass

    # Exactly _PAGE_MAX_RETRIES attempts — no more.
    assert mock_pull.await_count == _PAGE_MAX_RETRIES


async def test_pages_loop_respects_max_messages() -> None:
    # max_messages is a hard ceiling — the loop stops once reached even if
    # more pages are available.
    pages = [_page([f"m{i}"], token=f"p{i}") for i in range(20)]
    mock_pull = AsyncMock(side_effect=pages)
    with patch("src.activities.pull.composio_pull", mock_pull):
        total = 0
        async for page in _composio_gmail_pages("q", max_messages=3):
            total += len(page)

    assert total >= 3
    # Stopped well before exhausting all 20 pages.
    assert mock_pull.await_count <= 4


# ---------------------------------------------------------------------------
# composio_fetch_email_metadata — Stage 1 activity
# ---------------------------------------------------------------------------


async def test_fetch_email_metadata_writes_profiler_shape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    onboard_path = tmp_path / "onboard.json"
    onboard_path.write_text(json.dumps({"user_id": "u1", "stage": "metadata"}))
    monkeypatch.setenv("ONBOARD_PATH", str(onboard_path))

    responses = [
        {
            "data": {
                "messages": [
                    {
                        "messageId": "m1",
                        "sender": "alice@one.com",
                        "to": "owner@tenant.test",
                        "subject": "Hello",
                        "messageTimestamp": "2026-04-01T00:00:00Z",
                        "preview": {"body": "body one"},
                    },
                    {
                        "messageId": "m2",
                        "sender": "bob@two.com",
                        "subject": "Re: Hello",
                        "messageTimestamp": "2026-04-02T00:00:00Z",
                        "preview": {"body": "body two"},
                    },
                ],
                "nextPageToken": "p2",
            }
        },
        {"data": {"messages": []}},  # empty page terminates
    ]
    mock_pull = AsyncMock(side_effect=responses)
    # resolve_active_connected_account_id calls Composio at runtime —
    # stub it so the test doesn't need COMPOSIO_API_KEY. The pinned
    # ID flows through composio_pull which is also mocked.
    with patch("src.activities.pull.composio_pull", mock_pull), patch(
        "src.integrations.composio_client.resolve_active_connected_account_id",
        return_value="ca_test_gmail",
    ):
        result = await composio_fetch_email_metadata("u1")

    # Every composio_pull call must be pinned to the resolved Gmail account.
    for call in mock_pull.await_args_list:
        assert call.kwargs.get("connected_account_id") == "ca_test_gmail"

    assert result == {"count": 2, "domains": 2}

    written = json.loads(onboard_path.read_text())
    emails = written["emails"]
    assert len(emails) == 2
    # onboard.json `emails` carries the exact keys the profiler reads.
    for email in emails:
        assert set(email) == {"from", "to", "subject", "date", "snippet", "domain"}
    assert emails[0]["domain"] == "one.com"
    assert emails[0]["snippet"] == "body one"
    # progress + top_domains updated, existing keys preserved.
    assert written["user_id"] == "u1"
    assert written["progress"]["total_days"] == 2
    assert len(written["top_domains"]) == 2


async def test_fetch_email_metadata_handles_no_emails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    onboard_path = tmp_path / "onboard.json"
    monkeypatch.setenv("ONBOARD_PATH", str(onboard_path))

    mock_pull = AsyncMock(side_effect=[{"data": {"messages": []}}])
    with patch("src.activities.pull.composio_pull", mock_pull), patch(
        "src.integrations.composio_client.resolve_active_connected_account_id",
        return_value="ca_test_gmail",
    ):
        result = await composio_fetch_email_metadata("u1")

    assert result == {"count": 0, "domains": 0}
    written = json.loads(onboard_path.read_text())
    assert written["emails"] == []


# ---------------------------------------------------------------------------
# composio_backfill_gmail_as_events — background full backfill
# ---------------------------------------------------------------------------


async def test_backfill_ingests_via_composio_parser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AAS_API_KEY", "test-key")

    responses = [
        {
            "data": {
                "messages": [
                    {
                        "messageId": "m1",
                        "sender": "alice@one.com",
                        "subject": "Hello",
                        "messageTimestamp": "2026-04-01T00:00:00Z",
                        "labelIds": ["INBOX"],
                        "preview": {"body": "body one"},
                    },
                    {
                        "messageId": "m2",
                        "sender": "bob@two.com",
                        "subject": "World",
                        "messageTimestamp": "2026-04-02T00:00:00Z",
                        "labelIds": ["INBOX"],
                        "preview": {"body": "body two"},
                    },
                ],
                "nextPageToken": "p2",
            }
        },
        {"data": {"messages": []}},
    ]
    mock_pull = AsyncMock(side_effect=responses)

    # Fake ctrl-api ingest client — every POST is a fresh (non-duplicate) row.
    ingest_resp = MagicMock()
    ingest_resp.status_code = 201
    ingest_resp.json.return_value = {"status": "ingested"}
    ctrl = MagicMock()
    ctrl.post = AsyncMock(return_value=ingest_resp)
    ctrl.__aenter__ = AsyncMock(return_value=ctrl)
    ctrl.__aexit__ = AsyncMock(return_value=False)

    with patch("src.activities.pull.composio_pull", mock_pull), patch(
        "src.activities.pull._ctrl_client", return_value=ctrl
    ), patch(
        "src.integrations.composio_client.resolve_active_connected_account_id",
        return_value="ca_test_gmail",
    ):
        ingested = await composio_backfill_gmail_as_events(
            "stream-1", "u1", 100, 5000
        )

    assert ingested == 2
    # Two ingest POSTs, each tagged parser=composio + backfill=True.
    assert ctrl.post.await_count == 2
    body = ctrl.post.await_args_list[0].kwargs["json"]
    assert body["stream_id"] == "stream-1"
    assert body["stream_type"] == "gmail"
    assert body["metadata"]["parser"] == "composio"
    assert body["metadata"]["backfill"] is True
    assert body["source_ref"].startswith("composio:")


async def test_backfill_skips_duplicates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AAS_API_KEY", "test-key")

    responses = [
        {
            "data": {
                "messages": [
                    {"messageId": "m1", "sender": "a@b.com", "subject": "x"},
                ]
            }
        },
    ]
    mock_pull = AsyncMock(side_effect=responses)

    dup_resp = MagicMock()
    dup_resp.status_code = 200
    dup_resp.json.return_value = {"status": "duplicate"}
    ctrl = MagicMock()
    ctrl.post = AsyncMock(return_value=dup_resp)
    ctrl.__aenter__ = AsyncMock(return_value=ctrl)
    ctrl.__aexit__ = AsyncMock(return_value=False)

    with patch("src.activities.pull.composio_pull", mock_pull), patch(
        "src.activities.pull._ctrl_client", return_value=ctrl
    ), patch(
        "src.integrations.composio_client.resolve_active_connected_account_id",
        return_value="ca_test_gmail",
    ):
        ingested = await composio_backfill_gmail_as_events(
            "stream-1", "u1", 100, 5000
        )

    # A duplicate row does not count toward `ingested`.
    assert ingested == 0
    assert ctrl.post.await_count == 1
