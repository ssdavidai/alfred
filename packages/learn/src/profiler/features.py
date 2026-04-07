"""Email metadata feature extraction using tsfresh."""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pandas as pd
from tsfresh import extract_features
from tsfresh.feature_extraction import MinimalFCParameters

logger = logging.getLogger(__name__)

_BUSINESS_HOUR_START = 9
_BUSINESS_HOUR_END = 18
_MIN_EMAILS_FOR_TSFRESH = 50


def emails_to_dataframe(emails: list[dict]) -> pd.DataFrame:
    """Parse email dicts into a structured DataFrame.

    Expected input format (onboard.json):
        {from, to, subject, date, snippet, domain}

    Returns DataFrame with columns: timestamp, from_addr, from_domain,
    to_addr, subject, snippet, hour, dow, is_weekend, is_business_hours.
    """
    if not emails:
        return pd.DataFrame(
            columns=[
                "timestamp",
                "from_addr",
                "from_domain",
                "to_addr",
                "subject",
                "snippet",
                "hour",
                "dow",
                "is_weekend",
                "is_business_hours",
            ]
        )

    rows: list[dict[str, Any]] = []
    for email in emails:
        ts = _parse_date(email.get("date", ""))
        if ts is None:
            continue

        from_addr = str(email.get("from", "")).strip()
        from_domain = str(email.get("domain", "")).strip().lower()
        if not from_domain and "@" in from_addr:
            from_domain = from_addr.rsplit("@", 1)[-1].lower()

        rows.append(
            {
                "timestamp": ts,
                "from_addr": from_addr,
                "from_domain": from_domain,
                "to_addr": str(email.get("to", "")).strip(),
                "subject": str(email.get("subject", "")),
                "snippet": str(email.get("snippet", "")),
                "hour": ts.hour,
                "dow": ts.weekday(),
                "is_weekend": ts.weekday() >= 5,
                "is_business_hours": _BUSINESS_HOUR_START <= ts.hour < _BUSINESS_HOUR_END,
            }
        )

    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.sort_values("timestamp").reset_index(drop=True)
    return df


def extract_temporal_features(df: pd.DataFrame) -> pd.DataFrame:
    """Use tsfresh MinimalFCParameters on inter-email interval series.

    Groups by from_domain and computes features on the inter-email
    interval (in seconds). Returns one row per domain.

    If fewer than 50 emails, returns an empty DataFrame (graceful degradation).
    """
    if df.empty or len(df) < _MIN_EMAILS_FOR_TSFRESH:
        logger.info(
            "Skipping tsfresh: %d emails (need >= %d)",
            len(df),
            _MIN_EMAILS_FOR_TSFRESH,
        )
        return pd.DataFrame()

    interval_rows: list[dict[str, Any]] = []
    for domain, group in df.groupby("from_domain"):
        if len(group) < 2:
            continue
        sorted_ts = group["timestamp"].sort_values()
        intervals = sorted_ts.diff().dt.total_seconds().dropna()
        for i, val in enumerate(intervals):
            interval_rows.append(
                {"id": domain, "time": i, "value": val}
            )

    if not interval_rows:
        return pd.DataFrame()

    interval_df = pd.DataFrame(interval_rows)

    try:
        features = extract_features(
            interval_df,
            column_id="id",
            column_sort="time",
            default_fc_parameters=MinimalFCParameters(),
            disable_progressbar=True,
            n_jobs=1,
        )
        # Drop columns that are all NaN
        features = features.dropna(axis=1, how="all")
        return features
    except Exception:
        logger.exception("tsfresh extraction failed")
        return pd.DataFrame()


def extract_global_features(df: pd.DataFrame) -> dict:
    """Compute global summary statistics from the email DataFrame.

    Returns dict with: total_emails, unique_senders, unique_domains,
    date_range_days, avg_emails_per_day, peak_hour, peak_dow, busiest_domain.
    """
    if df.empty:
        return {
            "total_emails": 0,
            "unique_senders": 0,
            "unique_domains": 0,
            "date_range_days": 0,
            "avg_emails_per_day": 0.0,
            "peak_hour": 0,
            "peak_dow": 0,
            "busiest_domain": "",
        }

    total = len(df)
    unique_senders = df["from_addr"].nunique()
    unique_domains = df["from_domain"].nunique()

    ts_min = df["timestamp"].min()
    ts_max = df["timestamp"].max()
    date_range_days = max((ts_max - ts_min).days, 1)
    avg_per_day = total / date_range_days

    peak_hour = int(df["hour"].mode().iloc[0]) if not df["hour"].mode().empty else 0
    peak_dow = int(df["dow"].mode().iloc[0]) if not df["dow"].mode().empty else 0

    domain_counts = df["from_domain"].value_counts()
    busiest_domain = str(domain_counts.index[0]) if not domain_counts.empty else ""

    return {
        "total_emails": total,
        "unique_senders": unique_senders,
        "unique_domains": unique_domains,
        "date_range_days": date_range_days,
        "avg_emails_per_day": round(avg_per_day, 2),
        "peak_hour": peak_hour,
        "peak_dow": peak_dow,
        "busiest_domain": busiest_domain,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _parse_date(date_str: str) -> pd.Timestamp | None:
    """Robustly parse messy email date strings."""
    if not date_str:
        return None

    # Try pandas first — handles most RFC 2822, ISO 8601, etc.
    for fmt in (None, "mixed"):
        try:
            ts = pd.to_datetime(date_str, format=fmt, utc=True)
            if isinstance(ts, pd.Timestamp):
                return ts
        except (ValueError, TypeError):
            continue

    # Strip trailing parenthesized timezone names like "(PST)"
    import re

    cleaned = re.sub(r"\s*\([^)]*\)\s*$", "", date_str).strip()
    if cleaned != date_str:
        try:
            return pd.to_datetime(cleaned, utc=True)
        except (ValueError, TypeError):
            pass

    # Last resort: dateutil
    try:
        from dateutil import parser as du_parser

        dt = du_parser.parse(date_str, fuzzy=True)
        return pd.Timestamp(dt, tz="UTC") if dt.tzinfo is None else pd.Timestamp(dt).tz_convert("UTC")
    except Exception:
        logger.debug("Unparseable date: %s", date_str)
        return None
