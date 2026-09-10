"""Unit tests for the Outlook provider edge (issue #758).

Pure functions, no network: provider vocabulary, argument building, response
extraction, and the two normalised message shapes. The round-trip test proves
an Outlook message flattened by ``outlook_msg_to_flat`` is understood by the
existing ``composio`` parser with no parser change.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.activities.email_providers import (  # noqa: E402
    DEFAULT_EMAIL_PROVIDER,
    OUTLOOK_LIST_ACTION,
    OUTLOOK_ONBOARDING_FOLDERS,
    normalise_email_provider,
    outlook_list_args,
    outlook_messages_from_response,
    outlook_msg_to_email,
    outlook_msg_to_flat,
)
from src.parsers import get_parser  # noqa: E402


# --- provider vocabulary (C-758-1) -----------------------------------------

def test_normalise_provider_defaults_empty_to_gmail() -> None:
    assert normalise_email_provider("") == "gmail"
    assert normalise_email_provider(None) == DEFAULT_EMAIL_PROVIDER


def test_normalise_provider_accepts_supported() -> None:
    assert normalise_email_provider("gmail") == "gmail"
    assert normalise_email_provider("outlook") == "outlook"
    assert normalise_email_provider("OUTLOOK") == "outlook"


def test_normalise_provider_rejects_unknown() -> None:
    with pytest.raises(ValueError):
        normalise_email_provider("yahoo")


# --- argument building ------------------------------------------------------

def test_list_args_backfill_uses_ge_and_folder() -> None:
    args = outlook_list_args("Inbox", received_ge_iso="2026-06-01T00:00:00Z")
    assert args["folder"] == "Inbox"
    assert args["received_date_time_ge"] == "2026-06-01T00:00:00Z"
    assert "received_date_time_gt" not in args
    assert args["orderby"] == ["receivedDateTime desc"]
    assert "id" in args["select"] and "receivedDateTime" in args["select"]
    assert args["user_id"] == "me"


def test_list_args_paginates_by_skip() -> None:
    args = outlook_list_args("SentItems", received_ge_iso="x", skip=250, top=250)
    assert args["skip"] == 250
    assert args["top"] == 250


def test_list_action_and_folders_are_the_verified_ones() -> None:
    # The doubled-prefix slug is the one that actually exists on the project.
    assert OUTLOOK_LIST_ACTION == "OUTLOOK_OUTLOOK_LIST_MESSAGES"
    assert OUTLOOK_ONBOARDING_FOLDERS == ("Inbox", "SentItems")


# --- response extraction ----------------------------------------------------

def _wrap(value):
    return {"successful": True, "data": {"response_data": {"value": value}}}


def test_messages_from_nested_response_data() -> None:
    msgs, err = outlook_messages_from_response(_wrap([{"id": "1"}, {"id": "2"}]))
    assert err is None
    assert [m["id"] for m in msgs] == ["1", "2"]


def test_messages_from_flat_value() -> None:
    msgs, err = outlook_messages_from_response({"value": [{"id": "1"}]})
    assert err is None and len(msgs) == 1


def test_messages_empty_page_is_not_an_error() -> None:
    msgs, err = outlook_messages_from_response(_wrap([]))
    assert msgs == [] and err is None


def test_messages_successful_false_surfaces_error() -> None:
    msgs, err = outlook_messages_from_response(
        {"successful": False, "error": "HTTP 429 throttled"}
    )
    assert msgs == []
    assert err is not None and "429" in err


def test_messages_non_dict_is_safe() -> None:
    assert outlook_messages_from_response(None) == ([], "non-dict response")


def test_messages_drops_non_dict_items() -> None:
    msgs, err = outlook_messages_from_response(_wrap([{"id": "1"}, "junk", 5]))
    assert err is None and [m["id"] for m in msgs] == ["1"]


# --- profiler shape ---------------------------------------------------------

def _graph_msg() -> dict:
    return {
        "id": "AAMk-xyz",
        "subject": "Q3 numbers",
        "from": {"emailAddress": {"address": "rob@neoterra.example", "name": "Rob"}},
        "toRecipients": [
            {"emailAddress": {"address": "me@corp.example"}},
            {"emailAddress": {"address": "cc@corp.example"}},
        ],
        "receivedDateTime": "2026-08-01T09:15:00Z",
        "bodyPreview": "Attaching the Q3 figures for review.",
        "conversationId": "conv-77",
        "isRead": True,
    }


def test_msg_to_email_maps_graph_shape() -> None:
    e = outlook_msg_to_email(_graph_msg())
    assert e == {
        "from": "rob@neoterra.example",
        "to": "me@corp.example, cc@corp.example",
        "subject": "Q3 numbers",
        "date": "2026-08-01T09:15:00Z",
        "snippet": "Attaching the Q3 figures for review.",
        "domain": "neoterra.example",
    }


def test_msg_to_email_missing_fields_default_empty() -> None:
    e = outlook_msg_to_email({"id": "x"})
    assert e["from"] == "" and e["to"] == "" and e["subject"] == ""
    assert e["domain"] == "unknown"


def test_msg_to_email_falls_back_to_sent_date() -> None:
    e = outlook_msg_to_email({"from": {"emailAddress": {"address": "a@b.com"}},
                              "sentDateTime": "2026-01-01T00:00:00Z"})
    assert e["date"] == "2026-01-01T00:00:00Z"
    assert e["domain"] == "b.com"


# --- flat shape + parser round-trip ----------------------------------------

def test_msg_to_flat_has_parser_keys() -> None:
    f = outlook_msg_to_flat(_graph_msg())
    assert f["id"] == "AAMk-xyz"
    assert f["from"] == "rob@neoterra.example"
    assert f["date"] == "2026-08-01T09:15:00Z"
    assert f["snippet"].startswith("Attaching")
    assert f["threadId"] == "conv-77"


def test_flat_message_round_trips_through_composio_parser() -> None:
    parser = get_parser("composio")
    events = parser(outlook_msg_to_flat(_graph_msg()))
    assert len(events) == 1
    ev = events[0]
    assert ev.source_ref == "composio:AAMk-xyz"
    assert "Q3 numbers" in ev.summary
    # the email's real send time, not the fetch time
    assert ev.received_at.startswith("2026-08-01")
    # body preview survives into metadata
    assert "Attaching" in (ev.metadata.get("body") or "")
