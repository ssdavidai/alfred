"""Provider-specific edges for email onboarding + sync (issue #758).

Gmail and Outlook differ only at the collection boundary: the Composio action,
its arguments, the response envelope, and the per-message field names. Every
downstream stage — the behavioural profiler, the Opus fact/pattern/brief
stages, the curator, the signal scorer — reads ONE normalised shape and never
learns which mailbox the mail came from. Keeping that promise is what makes the
provider a two-value axis rather than a second pipeline.

The Gmail edge already lives in ``pull.py`` (``_composio_gmail_messages`` /
``_composio_msg_to_email``) and is left byte-for-byte unchanged. This module is
the Outlook mirror of that contract, written as pure functions so the Temporal
activities stay thin and the mapping is unit-testable with no network.

Two normalised shapes, matching the Gmail edge exactly:

  * profiler shape  — ``{from, to, subject, date, snippet, domain}``; this is
    what ``onboard.json["emails"]`` holds and the profiler + Opus stages read.
  * flat ingest shape — a dict whose keys are the ones the existing
    ``parsers.composio`` parser already reads (``id`` / ``from`` / ``to`` /
    ``subject`` / ``date`` / ``snippet`` / ``threadId``), so Outlook backfill
    events flow through that parser with NO parser change.

Facts about Composio's Outlook toolkit, verified live against the project on
2026-09-10 (the public docs are wrong — the documented ``OUTLOOK_LIST_MESSAGES``
slug 404s):

  * List action slug is ``OUTLOOK_OUTLOOK_LIST_MESSAGES`` (doubled prefix).
  * It takes ONE folder per call (well-known names ``Inbox`` / ``SentItems``),
    typed date filters (``received_date_time_ge`` / ``received_date_time_gt``,
    ISO-8601 with a ``Z`` suffix, not a ``+00:00`` offset), ``top`` (1-1000),
    ``skip`` for pagination, and ``orderby``. There is NO continuation token —
    paging is ``skip``/``top`` and terminates on a short page.
  * The page arrives at ``data.response_data.value`` (a list of Microsoft Graph
    ``message`` resources). Composio surfaces a hard failure as
    ``successful: false`` at the top level, exactly like Gmail.
"""

from __future__ import annotations

from typing import Any

# ---------------------------------------------------------------------------
# Provider vocabulary (contract C-758-1)
# ---------------------------------------------------------------------------

EMAIL_PROVIDERS = ("gmail", "outlook")
DEFAULT_EMAIL_PROVIDER = "gmail"


def normalise_email_provider(provider: str | None) -> str:
    """Return a supported provider id, defaulting an empty value to gmail.

    Raises ``ValueError`` on a non-empty but unrecognised value — an unknown
    provider is a caller bug (C-758-1: reject unsupported explicit values),
    never a silent fall-back to Gmail.
    """
    p = (provider or "").strip().lower()
    if not p:
        return DEFAULT_EMAIL_PROVIDER
    if p not in EMAIL_PROVIDERS:
        raise ValueError(
            f"unsupported email_provider {provider!r}; expected one of {EMAIL_PROVIDERS}"
        )
    return p


# ---------------------------------------------------------------------------
# Outlook constants
# ---------------------------------------------------------------------------

OUTLOOK_LIST_ACTION = "OUTLOOK_OUTLOOK_LIST_MESSAGES"

# The two folders that mirror Gmail's ``-in:drafts -in:spam -in:trash -in:chats``
# exclusion: everything a person actually sent or received. Graph's
# ``/me/messages`` would otherwise sweep Deleted Items and Junk too.
OUTLOOK_ONBOARDING_FOLDERS = ("Inbox", "SentItems")

# ``verbose:false`` has no Outlook analogue; instead we ask Graph for exactly
# the fields the two normalised shapes need, which keeps each message small.
OUTLOOK_SELECT_FIELDS = [
    "id",
    "subject",
    "from",
    "toRecipients",
    "ccRecipients",
    "receivedDateTime",
    "sentDateTime",
    "bodyPreview",
    "conversationId",
    "isRead",
    "parentFolderId",
]

OUTLOOK_PAGE_SIZE = 250
OUTLOOK_ORDER_BY = ["receivedDateTime desc"]


def outlook_list_args(
    folder: str,
    *,
    received_ge_iso: str | None = None,
    received_gt_iso: str | None = None,
    skip: int = 0,
    top: int = OUTLOOK_PAGE_SIZE,
    user_id: str = "me",
) -> dict[str, Any]:
    """Build the ``OUTLOOK_OUTLOOK_LIST_MESSAGES`` arguments for one page.

    ``received_ge_iso`` (inclusive, used for a backfill window) and
    ``received_gt_iso`` (exclusive, used for an incremental pull so the cursor
    row is not re-fetched) are mutually exclusive; pass at most one.
    """
    args: dict[str, Any] = {
        "user_id": user_id,
        "folder": folder,
        "top": top,
        "skip": skip,
        "orderby": OUTLOOK_ORDER_BY,
        "select": OUTLOOK_SELECT_FIELDS,
    }
    if received_ge_iso:
        args["received_date_time_ge"] = received_ge_iso
    if received_gt_iso:
        args["received_date_time_gt"] = received_gt_iso
    return args


def outlook_messages_from_response(
    raw_response: dict[str, Any],
) -> tuple[list[dict[str, Any]], str | None]:
    """Extract ``(messages, error)`` from an ``OUTLOOK_OUTLOOK_LIST_MESSAGES`` response.

    Mirrors ``_composio_gmail_messages``'s contract:
      * ``error`` is ``None`` on success (including a legitimately empty page).
      * ``error`` is a short string when Composio reports ``successful: false``,
        so the caller can distinguish a transient failure from "no more mail"
        and retry rather than terminating the backfill with zero results.

    Composio nests the Graph payload under ``data`` / ``response_data`` at
    varying depths; the list lives at ``…value``. We walk the known wrappers
    the same way the Gmail extractor does.
    """
    if not isinstance(raw_response, dict):
        return [], "non-dict response"

    if raw_response.get("successful") is False:
        err = raw_response.get("error")
        if not err:
            data = raw_response.get("data")
            if isinstance(data, dict):
                err = data.get("message") or data.get("error")
        return [], str(err or "composio reported successful=false")[:300]

    # Walk to the dict that holds ``value`` (the Graph message list).
    payload: Any = raw_response
    for _ in range(4):
        if not isinstance(payload, dict):
            break
        if "value" in payload:
            break
        nxt = payload.get("data")
        if nxt is None:
            nxt = payload.get("response_data")
        if nxt is None:
            break
        payload = nxt

    if not isinstance(payload, dict):
        return [], None
    messages = payload.get("value")
    if not isinstance(messages, list):
        messages = []
    return [m for m in messages if isinstance(m, dict)], None


def _outlook_address(obj: Any) -> str:
    """Flatten a Graph recipient/sender (``{emailAddress:{address,name}}``)."""
    if isinstance(obj, dict):
        ea = obj.get("emailAddress")
        if isinstance(ea, dict):
            return str(ea.get("address") or "").strip()
        return str(obj.get("address") or "").strip()
    return str(obj or "").strip()


def _outlook_recipients(msg: dict[str, Any]) -> str:
    to = msg.get("toRecipients")
    if not isinstance(to, list):
        return ""
    addrs = [a for a in (_outlook_address(r) for r in to) if a]
    return ", ".join(addrs)


def outlook_msg_to_email(msg: dict[str, Any]) -> dict[str, Any]:
    """Map one Graph message to the profiler shape used in onboard.json.

    Identical key set to the direct-Gmail ``fetch_email_metadata`` and the
    Composio ``_composio_msg_to_email`` output, so the behavioural profiler
    (``src/profiler/features.py``) and the Opus stages stay provider-blind.
    """
    sender = _outlook_address(msg.get("from") or msg.get("sender"))
    domain = sender.split("@")[-1].strip() if "@" in sender else "unknown"
    return {
        "from": sender,
        "to": _outlook_recipients(msg),
        "subject": str(msg.get("subject") or ""),
        "date": str(msg.get("receivedDateTime") or msg.get("sentDateTime") or ""),
        "snippet": str(msg.get("bodyPreview") or ""),
        "domain": domain or "unknown",
    }


def outlook_msg_to_flat(msg: dict[str, Any]) -> dict[str, Any]:
    """Map one Graph message to the flat shape the composio parser understands.

    The existing ``parsers.composio`` parser reads ``id`` / ``from`` / ``to`` /
    ``subject`` / ``date`` / ``snippet`` / ``threadId`` — so producing those
    keys here means Outlook backfill events flow through that parser with no
    parser change. Provider/mailbox provenance is stamped by the ingesting
    activity (stream_type + metadata), not here.
    """
    return {
        "id": str(msg.get("id") or ""),
        "from": _outlook_address(msg.get("from") or msg.get("sender")),
        "to": _outlook_recipients(msg),
        "subject": str(msg.get("subject") or ""),
        "date": str(msg.get("receivedDateTime") or msg.get("sentDateTime") or ""),
        "snippet": str(msg.get("bodyPreview") or ""),
        "threadId": str(msg.get("conversationId") or ""),
    }
