"""
Contract tests: alfred-learn VaultClient <-> alfred-ctrl API routes.

Verifies that VaultClient calls the correct endpoints with the correct payloads,
matching what alfred-ctrl implements in packages/ctrl/src/api/routes/:
  - vault.ts     -> /api/v1/vault/*
  - streams.ts   -> /api/v1/streams/events/*
  - learning.ts  -> /api/v1/learning/queue
  - notifications.ts -> /api/v1/notifications

These are NOT integration tests — the HTTP layer is mocked. The tests verify
the *interface contract* so that if ctrl renames a route or changes a payload
field, these tests break loudly instead of failing silently at runtime.
"""

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock

import httpx

from src.utils.vault_client import VaultClient


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------

class MockConfig:
    """Minimal Config stub — only the field VaultClient.__init__ reads."""
    alfred_ctrl_url = "http://ctrl-api:3100"


def make_response(status_code: int = 200, data: dict = None):
    """Return a mock httpx.Response with the given status and JSON body."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = data if data is not None else {}
    resp.raise_for_status = MagicMock()  # no-op by default
    return resp


@pytest.fixture
def vc():
    """
    VaultClient with its internal httpx.AsyncClient replaced by a MagicMock.

    Returns (client, mock_http) so each test can configure responses and
    inspect which calls were made.
    """
    client = VaultClient.__new__(VaultClient)
    client._base = MockConfig.alfred_ctrl_url

    mock_http = MagicMock()
    mock_http.post = AsyncMock()
    mock_http.get = AsyncMock()
    mock_http.patch = AsyncMock()
    mock_http.aclose = AsyncMock()
    client._client = mock_http

    return client, mock_http


# ---------------------------------------------------------------------------
# Vault routes — packages/ctrl/src/api/routes/vault.ts
# ---------------------------------------------------------------------------

class TestWriteRecord:
    """POST /api/v1/vault/records"""

    def test_calls_correct_endpoint(self, vc):
        client, http = vc
        http.post.return_value = make_response(201, {"path": "observation/test.md"})

        asyncio.run(client.write_record("observation", "test", "# Content"))

        http.post.assert_called_once()
        assert http.post.call_args.args[0] == "/api/v1/vault/records"

    def test_payload_has_type_name_content(self, vc):
        """ctrl requires: type (str), name (str), content (str)."""
        client, http = vc
        http.post.return_value = make_response(201, {"path": "observation/my-obs.md"})

        asyncio.run(client.write_record("observation", "my-obs", "# Body"))

        payload = http.post.call_args.kwargs["json"]
        assert payload["type"] == "observation"
        assert payload["name"] == "my-obs"
        assert payload["content"] == "# Body"

    def test_returns_path_from_response(self, vc):
        """ctrl responds with {"path": "..."} on 201; client returns that string."""
        client, http = vc
        http.post.return_value = make_response(201, {"path": "observation/my-obs.md"})

        result = asyncio.run(client.write_record("observation", "my-obs", "body"))

        assert result == "observation/my-obs.md"


class TestReadRecord:
    """GET /api/v1/vault/records/{path}"""

    def test_calls_correct_endpoint(self, vc):
        client, http = vc
        http.get.return_value = make_response(200, {
            "path": "observation/test.md",
            "frontmatter": {"type": "observation"},
            "body": "content",
        })

        asyncio.run(client.read_record("observation/test.md"))

        http.get.assert_called_once()
        assert http.get.call_args.args[0] == "/api/v1/vault/records/observation/test.md"

    def test_returns_full_record_dict(self, vc):
        """ctrl returns {"path", "frontmatter", "body"}; client passes it through."""
        client, http = vc
        record = {"path": "observation/test.md", "frontmatter": {}, "body": "hello"}
        http.get.return_value = make_response(200, record)

        result = asyncio.run(client.read_record("observation/test.md"))

        assert result == record


class TestUpdateRecord:
    """PATCH /api/v1/vault/records/{path}"""

    def test_calls_correct_endpoint(self, vc):
        client, http = vc
        http.patch.return_value = make_response(200, {})

        asyncio.run(client.update_record("observation/test.md", "appended text"))

        http.patch.assert_called_once()
        assert http.patch.call_args.args[0] == "/api/v1/vault/records/observation/test.md"

    def test_payload_uses_body_append_key(self, vc):
        """ctrl reads 'body_append' from the request body (not 'content' or 'body')."""
        client, http = vc
        http.patch.return_value = make_response(200, {})

        asyncio.run(client.update_record("observation/test.md", "new paragraph"))

        payload = http.patch.call_args.kwargs["json"]
        assert "body_append" in payload
        assert payload["body_append"] == "new paragraph"

    def test_no_unexpected_payload_keys(self, vc):
        """ctrl only processes known keys; extra keys are silently ignored but
        drift here would signal a contract mismatch."""
        client, http = vc
        http.patch.return_value = make_response(200, {})

        asyncio.run(client.update_record("observation/test.md", "x"))

        payload = http.patch.call_args.kwargs["json"]
        # VaultClient should only send body_append for this operation
        assert set(payload.keys()) == {"body_append"}


class TestListRecords:
    """GET /api/v1/vault/list/{type}"""

    def test_calls_correct_endpoint(self, vc):
        client, http = vc
        http.get.return_value = make_response(200, {"results": [], "count": 0})

        asyncio.run(client.list_records("observation"))

        http.get.assert_called_once()
        assert http.get.call_args.args[0] == "/api/v1/vault/list/observation"

    def test_returns_results_list(self, vc):
        """ctrl wraps records in {"results": [...]}; client unwraps it."""
        client, http = vc
        records = [{"path": "a.md", "name": "A", "status": "unprocessed"}]
        http.get.return_value = make_response(200, {"results": records, "count": 1})

        result = asyncio.run(client.list_records("observation"))

        assert result == records

    def test_status_filter_is_client_side(self, vc):
        """ctrl's list endpoint has no status query param — filtering is done
        client-side in VaultClient. Sending a status param would be a contract bug."""
        client, http = vc
        records = [
            {"path": "a.md", "name": "A", "status": "unprocessed"},
            {"path": "b.md", "name": "B", "status": "processed"},
        ]
        http.get.return_value = make_response(200, {"results": records, "count": 2})

        result = asyncio.run(client.list_records("observation", status="unprocessed"))

        # Only the unprocessed record should be returned
        assert len(result) == 1
        assert result[0]["name"] == "A"
        # No status query param should have been sent to ctrl
        call_kwargs = http.get.call_args.kwargs
        assert "status" not in (call_kwargs.get("params") or {})

    def test_limit_applied_client_side(self, vc):
        """ctrl list has no limit param — VaultClient slices the results."""
        client, http = vc
        records = [{"path": f"{i}.md", "name": str(i), "status": "unprocessed"} for i in range(5)]
        http.get.return_value = make_response(200, {"results": records})

        result = asyncio.run(client.list_records("observation", limit=2))

        assert len(result) == 2


class TestSearchRecords:
    """GET /api/v1/vault/search"""

    def test_calls_correct_endpoint(self, vc):
        client, http = vc
        http.get.return_value = make_response(200, {"results": [], "count": 0})

        asyncio.run(client.search_records("email"))

        http.get.assert_called_once()
        assert http.get.call_args.args[0] == "/api/v1/vault/search"

    def test_query_sent_as_grep_param(self, vc):
        """ctrl uses the query param name 'grep', not 'q' or 'query'."""
        client, http = vc
        http.get.return_value = make_response(200, {"results": []})

        asyncio.run(client.search_records("invoice"))

        params = http.get.call_args.kwargs.get("params", {})
        assert "grep" in params
        assert params["grep"] == "invoice"

    def test_returns_results_list(self, vc):
        """ctrl returns {"results": [...]}; client unwraps it."""
        client, http = vc
        records = [{"path": "a.md", "name": "A", "type": "observation", "status": ""}]
        http.get.return_value = make_response(200, {"results": records})

        result = asyncio.run(client.search_records("invoice"))

        assert result == records

    def test_type_filter_is_client_side(self, vc):
        """ctrl search has no type param — VaultClient filters by type client-side."""
        client, http = vc
        records = [
            {"path": "a.md", "name": "A", "type": "observation", "status": ""},
            {"path": "b.md", "name": "B", "type": "instinct", "status": ""},
        ]
        http.get.return_value = make_response(200, {"results": records})

        result = asyncio.run(client.search_records("x", record_type="observation"))

        assert len(result) == 1
        assert result[0]["type"] == "observation"
        # No type param should have been sent
        params = http.get.call_args.kwargs.get("params", {})
        assert "type" not in params


# ---------------------------------------------------------------------------
# Streams routes — packages/ctrl/src/api/routes/streams.ts
# ---------------------------------------------------------------------------

class TestFetchUnprocessedEvents:
    """GET /api/v1/streams/events"""

    def test_calls_correct_endpoint(self, vc):
        client, http = vc
        http.get.return_value = make_response(200, {"events": [], "count": 0})

        asyncio.run(client.fetch_unprocessed_events())

        http.get.assert_called_once()
        assert http.get.call_args.args[0] == "/api/v1/streams/events"

    def test_status_param_is_unprocessed(self, vc):
        """ctrl filters by ?status=unprocessed to exclude processed/quarantined events."""
        client, http = vc
        http.get.return_value = make_response(200, {"events": []})

        asyncio.run(client.fetch_unprocessed_events())

        params = http.get.call_args.kwargs.get("params", {})
        assert params.get("status") == "unprocessed"

    def test_limit_param_forwarded(self, vc):
        """limit is passed directly as a query param to ctrl."""
        client, http = vc
        http.get.return_value = make_response(200, {"events": []})

        asyncio.run(client.fetch_unprocessed_events(limit=5))

        params = http.get.call_args.kwargs.get("params", {})
        assert params.get("limit") == 5

    def test_returns_events_list(self, vc):
        """ctrl responds with {"events": [...]}; client unwraps it."""
        client, http = vc
        events = [{"id": "abc", "stream_id": "s1", "stream_type": "t"}]
        http.get.return_value = make_response(200, {"events": events})

        result = asyncio.run(client.fetch_unprocessed_events())

        assert result == events


class TestMarkEventProcessed:
    """POST /api/v1/streams/events/{id}/processed"""

    def test_calls_correct_endpoint(self, vc):
        client, http = vc
        http.post.return_value = make_response(200, {
            "status": "marked_processed", "event_id": "evt-1"
        })

        asyncio.run(client.mark_event_processed("evt-1", "observation/test.md", "email"))

        http.post.assert_called_once()
        assert http.post.call_args.args[0] == "/api/v1/streams/events/evt-1/processed"

    def test_payload_has_vault_path_and_classification(self, vc):
        """ctrl stores vault_path and classification on the processed event record."""
        client, http = vc
        http.post.return_value = make_response(200, {
            "status": "marked_processed", "event_id": "evt-1"
        })

        asyncio.run(client.mark_event_processed("evt-1", "observation/test.md", "email"))

        payload = http.post.call_args.kwargs["json"]
        assert payload["vault_path"] == "observation/test.md"
        assert payload["classification"] == "email"


class TestQuarantineEvent:
    """POST /api/v1/streams/events/{id}/quarantine"""

    def test_calls_correct_endpoint(self, vc):
        client, http = vc
        http.post.return_value = make_response(200, {
            "status": "quarantined", "event_id": "evt-2"
        })

        asyncio.run(client.quarantine_event("evt-2", ["parse error"]))

        http.post.assert_called_once()
        assert http.post.call_args.args[0] == "/api/v1/streams/events/evt-2/quarantine"

    def test_payload_uses_reason_key(self, vc):
        """ctrl reads 'reason' (a string), not 'errors' (a list)."""
        client, http = vc
        http.post.return_value = make_response(200, {"status": "quarantined", "event_id": "x"})

        asyncio.run(client.quarantine_event("x", ["err1"]))

        payload = http.post.call_args.kwargs["json"]
        assert "reason" in payload
        assert isinstance(payload["reason"], str)

    def test_multiple_errors_joined_with_semicolons(self, vc):
        """VaultClient joins the errors list into a single string with '; '."""
        client, http = vc
        http.post.return_value = make_response(200, {"status": "quarantined", "event_id": "x"})

        asyncio.run(client.quarantine_event("x", ["err1", "err2", "err3"]))

        payload = http.post.call_args.kwargs["json"]
        assert payload["reason"] == "err1; err2; err3"

    def test_empty_errors_uses_fallback_message(self, vc):
        """An empty errors list must not send an empty reason string."""
        client, http = vc
        http.post.return_value = make_response(200, {"status": "quarantined", "event_id": "x"})

        asyncio.run(client.quarantine_event("x", []))

        payload = http.post.call_args.kwargs["json"]
        assert payload["reason"] == "Unknown error"


# ---------------------------------------------------------------------------
# Learning routes — packages/ctrl/src/api/routes/learning.ts
# ---------------------------------------------------------------------------

class TestFetchUnroutedInputs:
    """GET /api/v1/learning/queue"""

    def test_calls_correct_endpoint(self, vc):
        client, http = vc
        http.get.return_value = make_response(200, {"items": [], "total": 0})

        asyncio.run(client.fetch_unrouted_inputs())

        http.get.assert_called_once()
        assert http.get.call_args.args[0] == "/api/v1/learning/queue"

    def test_limit_param_forwarded(self, vc):
        client, http = vc
        http.get.return_value = make_response(200, {"items": []})

        asyncio.run(client.fetch_unrouted_inputs(limit=10))

        params = http.get.call_args.kwargs.get("params", {})
        assert params.get("limit") == 10

    def test_returns_items_list(self, vc):
        """ctrl uses the key 'items' (not 'results') for the queue response."""
        client, http = vc
        items = [{"path": "input/a.md", "name": "A", "type": "input", "created": "2026-01-01"}]
        http.get.return_value = make_response(200, {"items": items, "total": 1})

        result = asyncio.run(client.fetch_unrouted_inputs())

        assert result == items


# ---------------------------------------------------------------------------
# Notification routes — packages/ctrl/src/api/routes/notifications.ts
# ---------------------------------------------------------------------------

class TestNotify:
    """POST /api/v1/notifications"""

    def test_calls_correct_endpoint(self, vc):
        client, http = vc
        http.post.return_value = make_response(200, {"status": "sent"})

        asyncio.run(client.notify("observation/test.md", "New observation"))

        http.post.assert_called_once()
        assert http.post.call_args.args[0] == "/api/v1/notifications"

    def test_payload_has_required_message_field(self, vc):
        """ctrl validates that 'message' is present and is a string."""
        client, http = vc
        http.post.return_value = make_response(200, {"status": "sent"})

        asyncio.run(client.notify("observation/test.md", "summary text"))

        payload = http.post.call_args.kwargs["json"]
        assert "message" in payload
        assert isinstance(payload["message"], str)

    def test_payload_has_urgency_field(self, vc):
        """ctrl accepts an 'urgency' field; VaultClient hardcodes 'normal'."""
        client, http = vc
        http.post.return_value = make_response(200, {"status": "sent"})

        asyncio.run(client.notify("observation/test.md", "summary"))

        payload = http.post.call_args.kwargs["json"]
        assert payload.get("urgency") == "normal"

    def test_payload_has_session_id_field(self, vc):
        """ctrl routes to a session; VaultClient hardcodes 'main'."""
        client, http = vc
        http.post.return_value = make_response(200, {"status": "sent"})

        asyncio.run(client.notify("observation/test.md", "summary"))

        payload = http.post.call_args.kwargs["json"]
        assert payload.get("session_id") == "main"

    def test_message_contains_path_and_summary(self, vc):
        """The message body must embed both the vault path and the summary text."""
        client, http = vc
        http.post.return_value = make_response(200, {"status": "sent"})

        asyncio.run(client.notify("observation/my-obs.md", "New instinct found"))

        payload = http.post.call_args.kwargs["json"]
        assert "observation/my-obs.md" in payload["message"]
        assert "New instinct found" in payload["message"]

    def test_best_effort_does_not_raise_on_4xx(self, vc):
        """notify() is best-effort: 4xx responses must NOT propagate as exceptions."""
        client, http = vc
        resp = make_response(404, {})
        # raise_for_status would throw on 4xx if called — but notify() checks status_code
        resp.raise_for_status = MagicMock(side_effect=Exception("should not be called"))
        http.post.return_value = resp

        # Must not raise
        asyncio.run(client.notify("observation/test.md", "summary"))

    def test_does_raise_on_5xx(self, vc):
        """notify() calls raise_for_status() only on 5xx; that exception must propagate."""
        client, http = vc
        resp = MagicMock()
        resp.status_code = 503
        resp.raise_for_status = MagicMock(
            side_effect=httpx.HTTPStatusError(
                "503 Service Unavailable",
                request=MagicMock(),
                response=resp,
            )
        )
        http.post.return_value = resp

        with pytest.raises(httpx.HTTPStatusError):
            asyncio.run(client.notify("observation/test.md", "summary"))
