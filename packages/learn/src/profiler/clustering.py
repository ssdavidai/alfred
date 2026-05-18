"""Behavioral clustering of email senders into priority tiers."""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

_MIN_SENDERS_FOR_HDBSCAN = 20

_AUTOMATED_DOMAIN_PATTERNS = [
    r"noreply",
    r"no-reply",
    r"notifications?",
    r"mailer",
    r"digest",
    r"newsletter",
    r"updates?",
    r"info@",
    r"support@",
    r"hello@",
    r"team@",
]

_UNSUBSCRIBE_KEYWORDS = [
    "unsubscribe",
    "opt out",
    "opt-out",
    "email preferences",
    "manage subscriptions",
    "stop receiving",
]


def cluster_senders(
    df: pd.DataFrame,
    temporal_features: pd.DataFrame | None = None,
) -> dict[str, dict[str, Any]]:
    """Cluster email senders using HDBSCAN on behavioral feature vectors.

    Per-sender features: email_count, recency_days, regularity (std of
    inter-email intervals in hours), has_threads (bool), avg_snippet_length.

    Returns {domain: {cluster_id, features}}.
    """
    if df.empty:
        return {}

    sender_features = _build_sender_features(df)
    if not sender_features:
        return {}

    domains = list(sender_features.keys())
    feature_matrix = np.array(
        [
            [
                sender_features[d]["email_count"],
                sender_features[d]["recency_days"],
                sender_features[d]["regularity"],
                float(sender_features[d]["has_threads"]),
                sender_features[d]["avg_snippet_length"],
            ]
            for d in domains
        ]
    )

    if len(domains) < _MIN_SENDERS_FOR_HDBSCAN:
        logger.info(
            "Skipping HDBSCAN: %d senders (need >= %d), using rule-based",
            len(domains),
            _MIN_SENDERS_FOR_HDBSCAN,
        )
        # Assign cluster_id = -1 (no cluster) for rule-based fallback
        for domain in domains:
            sender_features[domain]["cluster_id"] = -1
        return sender_features

    # Normalize features for clustering
    from sklearn.preprocessing import StandardScaler

    scaler = StandardScaler()
    scaled = scaler.fit_transform(feature_matrix)

    try:
        from hdbscan import HDBSCAN

        clusterer = HDBSCAN(
            min_cluster_size=max(3, len(domains) // 10),
            min_samples=2,
            metric="euclidean",
        )
        labels = clusterer.fit_predict(scaled)
    except Exception:
        logger.exception("HDBSCAN clustering failed, falling back to rule-based")
        for domain in domains:
            sender_features[domain]["cluster_id"] = -1
        return sender_features

    for i, domain in enumerate(domains):
        sender_features[domain]["cluster_id"] = int(labels[i])

    return sender_features


def assign_tiers(clusters: dict[str, dict[str, Any]], df: pd.DataFrame) -> dict[str, list[str]]:
    """Map clustered senders to priority tiers.

    Tiers:
    - inner_circle: high frequency + threads + recent
    - regular: moderate activity
    - service: high frequency + no threads + automated domain patterns
    - newsletter: periodic + unsubscribe keywords
    - noise: single/few + no threads

    Uses rule-based assignment for robustness (works with or without HDBSCAN).
    """
    tiers: dict[str, list[str]] = {
        "inner_circle": [],
        "regular": [],
        "service": [],
        "newsletter": [],
        "noise": [],
    }

    if not clusters:
        return tiers

    # Pre-compute per-domain snippet content for keyword detection
    domain_snippets: dict[str, str] = defaultdict(str)
    if not df.empty:
        for _, row in df.iterrows():
            domain_snippets[row["from_domain"]] += " " + str(row.get("snippet", ""))

    for domain, info in clusters.items():
        count = info.get("email_count", 0)
        recency = info.get("recency_days", 999)
        has_threads = info.get("has_threads", False)
        regularity = info.get("regularity", float("inf"))
        snippet_text = domain_snippets.get(domain, "").lower()

        is_automated = _is_automated_domain(domain)
        has_unsub = any(kw in snippet_text for kw in _UNSUBSCRIBE_KEYWORDS)

        # Classification rules (order matters)
        if has_unsub and not has_threads:
            tiers["newsletter"].append(domain)
        elif is_automated and not has_threads:
            tiers["service"].append(domain)
        elif count >= 10 and has_threads and recency <= 30:
            tiers["inner_circle"].append(domain)
        elif count >= 3 and recency <= 60:
            tiers["regular"].append(domain)
        elif count >= 5 and not has_threads:
            tiers["service"].append(domain)
        elif count <= 2 and not has_threads:
            tiers["noise"].append(domain)
        else:
            tiers["regular"].append(domain)

    # Sort each tier by email count descending
    for tier in tiers:
        tiers[tier].sort(
            key=lambda d: clusters.get(d, {}).get("email_count", 0),
            reverse=True,
        )

    return tiers


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _build_sender_features(df: pd.DataFrame) -> dict[str, dict[str, Any]]:
    """Build per-sender feature dict from email DataFrame."""
    now = df["timestamp"].max()
    features: dict[str, dict[str, Any]] = {}

    for domain, group in df.groupby("from_domain"):
        if not domain:
            continue

        count = len(group)
        sorted_ts = group["timestamp"].sort_values()
        recency_days = (now - sorted_ts.iloc[-1]).total_seconds() / 86400

        # Regularity: std of inter-email intervals in hours
        if count >= 2:
            intervals = sorted_ts.diff().dt.total_seconds().dropna() / 3600
            regularity = float(intervals.std()) if len(intervals) > 1 else 0.0
        else:
            regularity = 0.0

        # Thread detection: any Re: in subjects
        has_threads = group["subject"].str.contains(
            r"^(?:Re|Fwd|Fw)\s*:", case=False, regex=True
        ).any()

        avg_snippet_len = float(group["snippet"].str.len().mean()) if "snippet" in group.columns else 0.0

        features[str(domain)] = {
            "email_count": count,
            "recency_days": round(recency_days, 1),
            "regularity": round(regularity, 2),
            "has_threads": bool(has_threads),
            "avg_snippet_length": round(avg_snippet_len, 1),
        }

    return features


def _is_automated_domain(domain: str) -> bool:
    """Check if a domain or sender pattern looks automated."""
    domain_lower = domain.lower()
    for pattern in _AUTOMATED_DOMAIN_PATTERNS:
        if re.search(pattern, domain_lower):
            return True
    return False
