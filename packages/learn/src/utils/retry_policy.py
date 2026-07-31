"""Shared transient-vs-permanent failure classification for activities (#296).

Temporal retries an activity until its policy is exhausted. That is right for a
transient failure and actively harmful for a permanent one: the same doomed
call is re-made forever, burning worker capacity and burying genuinely new
failures in the noise.

Two live examples on home (2026-07-31), both still climbing when found:

    create_session            attempt 7208   HTTP 422 on POST /vault/records
    check_task_prerequisites  attempt 2387   HTTP 404 on a malformed
                                             `[[task/...]]` wikilink path

Neither can ever succeed. A 422 means the payload is invalid; a 404 on a
malformed path means the path is wrong. Retrying either 7000 times changes
nothing — it just makes the logs useless.

This module centralises the judgement so activities don't each invent it, and
so the rule can be corrected in one place. It deliberately does NOT wrap the
HTTP client: several callers catch `httpx.HTTPStatusError` to handle a 404 as
"record absent", and hijacking that globally would break them. Adoption is at
the activity boundary, where the caller knows whether a status is meaningful.

Mirrors the precedent set for clerk calls in #240 (`ApplicationError(...,
non_retryable=True)`).
"""
from __future__ import annotations

from typing import Any

import httpx
from temporalio.exceptions import ApplicationError

# Statuses that will never succeed on replay of the SAME request.
# 404 is included deliberately: for these activities the path is derived from
# stored data, so a miss means the data is wrong, not that the record is late.
PERMANENT_STATUSES: frozenset[int] = frozenset(
    {400, 401, 402, 403, 404, 405, 409, 410, 413, 422}
)

# Statuses that plausibly succeed later without the caller changing anything.
TRANSIENT_STATUSES: frozenset[int] = frozenset({408, 425, 429, 500, 502, 503, 504})


def classify_status(status: int | None) -> str:
    """Return ``"permanent"``, ``"transient"`` or ``"unknown"``.

    Unknown is the safe default: an unrecognised status keeps the existing
    retry behaviour rather than inventing a terminal verdict.
    """
    if status is None:
        return "unknown"
    if status in PERMANENT_STATUSES:
        return "permanent"
    if status in TRANSIENT_STATUSES:
        return "transient"
    if 500 <= status <= 599:
        return "transient"
    if 400 <= status <= 499:
        return "permanent"
    return "unknown"


def retry_after_ms(response: Any) -> int | None:
    """Parse a ``Retry-After`` header (delta-seconds form) into milliseconds."""
    try:
        raw = response.headers.get("Retry-After")
    except Exception:  # noqa: BLE001 — header access on a non-response
        return None
    if not raw:
        return None
    try:
        seconds = float(str(raw).strip())
    except (TypeError, ValueError):
        return None  # HTTP-date form: not worth parsing for a retry hint
    if seconds < 0:
        return None
    return int(seconds * 1000)


def raise_if_permanent(exc: BaseException, *, context: str) -> None:
    """Re-raise a permanent HTTP failure as a non-retryable ApplicationError.

    Returns normally when the failure is transient or unclassifiable, so the
    caller can let Temporal's existing policy handle it.

    ``context`` names the operation in the surfaced error, because the whole
    point is that an operator reading the log can tell WHAT stopped and why.
    """
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if classify_status(status) != "permanent":
        return

    detail = str(exc)[:300]
    raise ApplicationError(
        f"{context}: HTTP {status} is permanent — not retrying. {detail}",
        type="PermanentHttpError",
        non_retryable=True,
    ) from exc


def is_transient(exc: BaseException) -> bool:
    """True when ``exc`` is worth retrying.

    Transport-level errors (connect/read/timeout) are transient by nature —
    they say nothing about whether the request itself is valid.
    """
    if isinstance(exc, (httpx.TimeoutException, httpx.TransportError)):
        return True
    status = getattr(getattr(exc, "response", None), "status_code", None)
    return classify_status(status) == "transient"
