"""Financial pattern detection from email metadata."""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from typing import Any

import pandas as pd

logger = logging.getLogger(__name__)

FINANCIAL_DOMAINS: list[str] = [
    "paypal.com",
    "stripe.com",
    "wise.com",
    "revolut.com",
    "mercury.com",
    "brex.com",
    "gusto.com",
    "facturapi.com",
    "polar.sh",
    "gumroad.com",
    "lemonsqueezy.com",
    "paddle.com",
]

SUBSCRIPTION_KEYWORDS: list[str] = [
    "subscription",
    "renewal",
    "invoice",
    "receipt",
    "payment",
    "billing",
    "charge",
    "statement",
    "expired",
    "declined",
    "failed",
]

_PAYMENT_ISSUE_KEYWORDS: dict[str, str] = {
    "failed": "failed",
    "declined": "declined",
    "expired": "expired",
    "unable to process": "failed",
    "payment unsuccessful": "failed",
    "card declined": "declined",
    "insufficient funds": "declined",
}


def detect_financial_patterns(df: pd.DataFrame) -> dict[str, Any]:
    """Detect financial and subscription patterns from email metadata.

    Returns dict with: detected_subscriptions, payment_services,
    financial_email_ratio, detected_merchants, payment_issues.
    """
    if df.empty:
        return _empty_financial()

    total_emails = len(df)

    # --- Identify financial emails ---
    financial_mask = _is_financial_email(df)
    financial_df = df[financial_mask]
    financial_ratio = len(financial_df) / total_emails if total_emails > 0 else 0.0

    # --- Payment services seen ---
    payment_services: list[str] = []
    for domain in FINANCIAL_DOMAINS:
        if df["from_domain"].str.contains(domain, case=False, regex=False).any():
            payment_services.append(domain)

    # --- Detected subscriptions ---
    detected_subscriptions = _detect_subscriptions(financial_df)

    # --- Detected merchants ---
    detected_merchants = _detect_merchants(financial_df)

    # --- Payment issues ---
    payment_issues = _detect_payment_issues(financial_df)

    return {
        "detected_subscriptions": detected_subscriptions,
        "payment_services": payment_services,
        "financial_email_ratio": round(financial_ratio, 4),
        "detected_merchants": detected_merchants,
        "payment_issues": payment_issues,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _empty_financial() -> dict[str, Any]:
    return {
        "detected_subscriptions": [],
        "payment_services": [],
        "financial_email_ratio": 0.0,
        "detected_merchants": [],
        "payment_issues": [],
    }


def _is_financial_email(df: pd.DataFrame) -> pd.Series:
    """Return boolean mask for emails that match financial patterns."""
    # Match by domain
    domain_match = df["from_domain"].str.lower().isin(
        [d.lower() for d in FINANCIAL_DOMAINS]
    )

    # Match by subject/snippet keywords
    combined_text = (
        df["subject"].str.lower().fillna("")
        + " "
        + df["snippet"].str.lower().fillna("")
    )
    keyword_pattern = "|".join(re.escape(kw) for kw in SUBSCRIPTION_KEYWORDS)
    keyword_match = combined_text.str.contains(keyword_pattern, regex=True, na=False)

    return domain_match | keyword_match


def _detect_subscriptions(financial_df: pd.DataFrame) -> list[dict[str, Any]]:
    """Detect recurring subscription patterns from financial emails."""
    if financial_df.empty:
        return []

    subscriptions: list[dict[str, Any]] = []
    for domain, group in financial_df.groupby("from_domain"):
        if not domain or len(group) < 2:
            continue

        count = len(group)
        sorted_ts = group["timestamp"].sort_values()

        # Estimate frequency from inter-email intervals
        if count >= 2:
            intervals = sorted_ts.diff().dt.days.dropna()
            median_interval = float(intervals.median()) if len(intervals) > 0 else 0

            if 25 <= median_interval <= 35:
                freq = "monthly"
            elif 6 <= median_interval <= 8:
                freq = "weekly"
            elif 12 <= median_interval <= 16:
                freq = "biweekly"
            elif 85 <= median_interval <= 100:
                freq = "quarterly"
            elif 350 <= median_interval <= 380:
                freq = "annual"
            else:
                freq = f"~{int(median_interval)} days"
        else:
            freq = "unknown"

        # Extract service name from sender
        service_name = _extract_service_name(domain, group)

        subscriptions.append(
            {
                "service": service_name,
                "domain": str(domain),
                "count": count,
                "frequency_estimate": freq,
            }
        )

    subscriptions.sort(key=lambda s: s["count"], reverse=True)
    return subscriptions


def _detect_merchants(financial_df: pd.DataFrame) -> list[dict[str, Any]]:
    """Detect unique merchants from financial emails."""
    if financial_df.empty:
        return []

    merchants: dict[str, dict[str, Any]] = {}
    for domain, group in financial_df.groupby("from_domain"):
        if not domain:
            continue

        name = _extract_service_name(domain, group)
        if name not in merchants:
            merchants[name] = {
                "name": name,
                "domain": str(domain),
                "count": len(group),
            }
        else:
            merchants[name]["count"] += len(group)

    result = sorted(merchants.values(), key=lambda m: m["count"], reverse=True)
    return result


def _detect_payment_issues(financial_df: pd.DataFrame) -> list[dict[str, Any]]:
    """Detect payment failures, declines, and expirations."""
    if financial_df.empty:
        return []

    issues: list[dict[str, Any]] = []
    for _, row in financial_df.iterrows():
        combined = (
            str(row.get("subject", "")).lower()
            + " "
            + str(row.get("snippet", "")).lower()
        )

        for keyword, issue_type in _PAYMENT_ISSUE_KEYWORDS.items():
            if keyword in combined:
                issues.append(
                    {
                        "domain": str(row["from_domain"]),
                        "subject_snippet": str(row.get("subject", ""))[:80],
                        "type": issue_type,
                    }
                )
                break  # One issue type per email

    return issues


def _extract_service_name(domain: str, group: pd.DataFrame) -> str:
    """Extract a human-readable service name from a domain."""
    domain_str = str(domain).lower()

    # Use the part before the TLD
    parts = domain_str.split(".")
    if len(parts) >= 2:
        name = parts[-2]
    else:
        name = parts[0]

    # Capitalize
    return name.capitalize()
