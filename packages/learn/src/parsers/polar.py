"""Polar payment webhook parser.

Extracts: event type, amount, customer, summary.
"""

from __future__ import annotations

from datetime import datetime, timezone

from . import ParsedEvent


def parse(raw: dict) -> list[ParsedEvent]:
    """Parse a Polar webhook payload into ParsedEvents."""
    event_type = raw.get("type", raw.get("event", "unknown"))

    # Polar webhooks have a data object containing the payload
    data = raw.get("data", raw)

    # Extract common fields
    amount = data.get("amount", data.get("amount_total", 0))
    currency = data.get("currency", "usd")
    customer = _extract_customer(data)

    # Format amount for display (cents to dollars)
    amount_display = f"${amount / 100:.2f} {currency.upper()}" if amount else ""

    # Build summary based on event type
    summary = _build_summary(event_type, customer, amount_display, data)

    # Source ref
    event_id = raw.get("id", data.get("id", ""))
    if not event_id:
        event_id = f"polar-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"

    return [
        ParsedEvent(
            source_ref=f"polar:{event_id}",
            summary=summary,
            raw=raw,
            event_type=f"polar-{event_type}",
            received_at=raw.get("created_at", data.get("created_at", datetime.now(timezone.utc).isoformat())),
            metadata={
                "event_type": event_type,
                "amount": amount,
                "currency": currency,
                "customer_name": customer.get("name", ""),
                "customer_email": customer.get("email", ""),
                "product_name": data.get("product", {}).get("name", ""),
                "subscription_id": data.get("subscription_id", data.get("id", "")),
            },
        )
    ]


def _extract_customer(data: dict) -> dict:
    """Extract customer info from various Polar payload shapes."""
    # Direct customer object
    customer = data.get("customer", {})
    if isinstance(customer, dict) and customer:
        return customer

    # User object (older format)
    user = data.get("user", {})
    if isinstance(user, dict) and user:
        return {
            "name": user.get("username", user.get("name", "")),
            "email": user.get("email", ""),
        }

    # Email at top level
    if data.get("customer_email") or data.get("email"):
        return {
            "name": data.get("customer_name", ""),
            "email": data.get("customer_email", data.get("email", "")),
        }

    return {"name": "", "email": ""}


def _build_summary(event_type: str, customer: dict, amount_display: str, data: dict) -> str:
    """Build a human-readable summary from event type and data."""
    name = customer.get("name", customer.get("email", "unknown"))
    product = data.get("product", {}).get("name", "")

    if "subscription" in event_type:
        action = event_type.replace("subscription.", "").replace("_", " ")
        summary = f"Subscription {action}: {name}"
        if product:
            summary += f" — {product}"
        if amount_display:
            summary += f" ({amount_display})"
        return summary

    if "payment" in event_type or "order" in event_type:
        summary = f"Payment from {name}"
        if amount_display:
            summary += f": {amount_display}"
        if product:
            summary += f" for {product}"
        return summary

    # Generic
    summary = f"Polar {event_type}: {name}"
    if amount_display:
        summary += f" ({amount_display})"
    return summary
