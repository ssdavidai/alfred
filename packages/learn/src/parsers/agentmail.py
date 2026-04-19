"""AgentMail webhook payload parser.

Handles `message.received` payloads delivered by the SaaS webhook receiver
via /api/v1/streams/ingest. See packages/saas/app/src/server/agentmailReceiver.ts
for the dispatch shape — this parser reads whatever is in `raw` and normalizes
to a ParsedEvent.

Note: `from_` on AgentMail messages has a trailing underscore (Python keyword
avoidance on their side — we preserve it).
"""

from __future__ import annotations

from datetime import datetime, timezone

from . import ParsedEvent


def parse(raw: dict) -> list[ParsedEvent]:
    """Parse an AgentMail message.received payload into a ParsedEvent.

    Accepts either the full message object (raw dict from AgentMail) or an
    envelope `{"raw": message, "body_text": ..., ...}` as written by the
    saas dispatcher.
    """
    # Unwrap if wrapped by the saas dispatcher
    if "raw" in raw and isinstance(raw["raw"], dict) and "message_id" in raw["raw"]:
        msg = raw["raw"]
        body_text = raw.get("body_text") or msg.get("extracted_text") or msg.get("text") or ""
    else:
        msg = raw
        body_text = msg.get("extracted_text") or msg.get("text") or ""

    message_id = msg.get("message_id", "")
    subject = msg.get("subject", "")
    from_list = msg.get("from_") or []
    sender = from_list[0] if isinstance(from_list, list) and from_list else ""
    to_list = msg.get("to") or []
    cc_list = msg.get("cc") or []
    bcc_list = msg.get("bcc") or []
    thread_id = msg.get("thread_id", "")
    received_at = (
        msg.get("timestamp")
        or msg.get("created_at")
        or datetime.now(timezone.utc).isoformat()
    )

    preview = msg.get("preview") or body_text[:200]
    summary = f"{sender}: {subject}" if sender and subject else (subject or preview[:120])

    attachments_meta = [
        {
            "attachment_id": a.get("attachment_id"),
            "filename": a.get("filename"),
            "content_type": a.get("content_type"),
            "size": a.get("size"),
            "inline": bool(a.get("inline")),
        }
        for a in (msg.get("attachments") or [])
    ]

    return [
        ParsedEvent(
            source_ref=f"agentmail:{message_id}",
            summary=summary,
            raw=msg,
            event_type="email",
            received_at=str(received_at),
            metadata={
                "from": sender,
                "to": to_list,
                "cc": cc_list,
                "bcc": bcc_list,
                "subject": subject,
                "thread_id": thread_id,
                "message_id": message_id,
                "in_reply_to": msg.get("in_reply_to", ""),
                "references": msg.get("references", []),
                "inbox_id": msg.get("inbox_id", ""),
                "preview": preview,
                "body_text": body_text,
                "attachments": attachments_meta,
            },
        ),
    ]
