"""Transient-vs-permanent classification (#296).

Temporal retries until the policy is exhausted, which is right for a transient
failure and harmful for a permanent one. Two activities on home were still
climbing when found:

    create_session            attempt 7208   HTTP 422 on POST /vault/records
    check_task_prerequisites  attempt 2387   HTTP 404 on a malformed
                                             `[[task/...]]` wikilink path

Neither could ever succeed.
"""
from __future__ import annotations

import httpx
import pytest
from temporalio.exceptions import ApplicationError

from src.utils.retry_policy import (
    classify_status,
    is_transient,
    raise_if_permanent,
    retry_after_ms,
)


def _http_error(status: int, headers: dict | None = None) -> httpx.HTTPStatusError:
    req = httpx.Request("POST", "http://ctrl-api/api/v1/vault/records")
    resp = httpx.Response(status, request=req, headers=headers or {})
    return httpx.HTTPStatusError(f"{status}", request=req, response=resp)


class TestClassifyStatus:
    @pytest.mark.parametrize("status", [400, 401, 403, 404, 409, 413, 422])
    def test_client_errors_are_permanent(self, status):
        assert classify_status(status) == "permanent"

    @pytest.mark.parametrize("status", [408, 429, 500, 502, 503, 504])
    def test_retryable_statuses_are_transient(self, status):
        assert classify_status(status) == "transient"

    def test_429_is_transient_not_permanent(self):
        """Rate limiting is the classic 4xx that IS worth retrying."""
        assert classify_status(429) == "transient"

    def test_408_is_transient_not_permanent(self):
        assert classify_status(408) == "transient"

    @pytest.mark.parametrize("status", [None, 200, 201, 304])
    def test_non_failures_are_not_permanent(self, status):
        assert classify_status(status) != "permanent"

    def test_unknown_status_defaults_to_unknown(self):
        """An unrecognised status must not invent a terminal verdict —
        unknown keeps the caller's existing retry behaviour."""
        assert classify_status(None) == "unknown"
        assert classify_status(600) == "unknown"


class TestRaiseIfPermanent:
    def test_permanent_becomes_non_retryable(self):
        with pytest.raises(ApplicationError) as caught:
            raise_if_permanent(_http_error(422), context="create_session")
        err = caught.value
        assert err.non_retryable is True
        assert err.type == "PermanentHttpError"
        assert "422" in str(err)
        assert "create_session" in str(err), "the operation must be named in the error"

    def test_404_is_permanent(self):
        """The check_task_prerequisites case: a malformed dependency path."""
        with pytest.raises(ApplicationError):
            raise_if_permanent(_http_error(404), context="check_task_prerequisites")

    @pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
    def test_transient_is_left_alone(self, status):
        """Returns normally so Temporal's existing policy still retries."""
        raise_if_permanent(_http_error(status), context="x")

    def test_non_http_error_is_left_alone(self):
        raise_if_permanent(RuntimeError("something else"), context="x")


class TestIsTransient:
    def test_timeouts_are_transient(self):
        assert is_transient(httpx.ReadTimeout("timed out")) is True

    def test_transport_errors_are_transient(self):
        assert is_transient(httpx.ConnectError("refused")) is True

    def test_422_is_not_transient(self):
        assert is_transient(_http_error(422)) is False


class TestRetryAfter:
    def test_parses_delta_seconds(self):
        assert retry_after_ms(_http_error(429, {"Retry-After": "30"}).response) == 30_000

    def test_missing_header_is_none(self):
        assert retry_after_ms(_http_error(429).response) is None

    def test_http_date_form_is_ignored_not_crashed(self):
        resp = _http_error(429, {"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}).response
        assert retry_after_ms(resp) is None

    def test_negative_is_ignored(self):
        assert retry_after_ms(_http_error(429, {"Retry-After": "-5"}).response) is None
