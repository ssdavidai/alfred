"""Relationship anomaly detection using Isolation Forest."""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

import numpy as np
import pandas as pd
from pyod.models.iforest import IForest

logger = logging.getLogger(__name__)

_CONTAMINATION = 0.05
_SCORE_THRESHOLD = 0.8
_BURST_MULTIPLIER = 3.0


def detect_relationship_anomalies(
    df: pd.DataFrame,
    sender_tiers: dict[str, list[str]],
) -> list[dict[str, Any]]:
    """Detect anomalous sender behavior using Isolation Forest.

    Anomaly types:
    - burst_contact: sudden spike in email volume
    - disappeared: was active, now silent
    - timing_shift: changed usual sending hours
    - volume_spike: 3x normal volume in recent period

    Returns list of {domain, anomaly_type, score, description}.
    Only returns anomalies with score > 0.8.
    """
    if df.empty:
        return []

    # Build per-sender behavior vectors
    sender_vectors, sender_domains = _build_behavior_vectors(df)
    if len(sender_domains) < 5:
        logger.info("Too few senders (%d) for anomaly detection", len(sender_domains))
        return []

    feature_matrix = np.array(sender_vectors)

    try:
        clf = IForest(
            contamination=_CONTAMINATION,
            random_state=42,
            n_estimators=100,
        )
        clf.fit(feature_matrix)
        scores = clf.decision_scores_
    except Exception:
        logger.exception("Isolation Forest fitting failed")
        return []

    # Normalize scores to 0-1 range
    if scores.max() > scores.min():
        norm_scores = (scores - scores.min()) / (scores.max() - scores.min())
    else:
        norm_scores = np.zeros_like(scores)

    anomalies: list[dict[str, Any]] = []
    for i, domain in enumerate(sender_domains):
        score = float(norm_scores[i])
        if score <= _SCORE_THRESHOLD:
            continue

        anomaly_type, description = _classify_anomaly(
            domain, df, feature_matrix[i], score
        )
        anomalies.append(
            {
                "domain": domain,
                "anomaly_type": anomaly_type,
                "score": round(score, 3),
                "description": description,
            }
        )

    # Sort by score descending
    anomalies.sort(key=lambda a: a["score"], reverse=True)
    return anomalies


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _build_behavior_vectors(
    df: pd.DataFrame,
) -> tuple[list[list[float]], list[str]]:
    """Build per-sender feature vectors for anomaly detection.

    Features per sender:
    - total_count
    - recent_count (last 7 days)
    - mean_hour
    - hour_std
    - mean_dow
    - recency_days
    - interval_mean (hours between emails)
    - interval_std
    """
    now = df["timestamp"].max()
    seven_days_ago = now - pd.Timedelta(days=7)

    vectors: list[list[float]] = []
    domains: list[str] = []

    for domain, group in df.groupby("from_domain"):
        if not domain or len(group) < 2:
            continue

        sorted_ts = group["timestamp"].sort_values()
        total_count = len(group)
        recent_count = len(group[group["timestamp"] >= seven_days_ago])
        mean_hour = float(group["hour"].mean())
        hour_std = float(group["hour"].std()) if total_count > 1 else 0.0
        mean_dow = float(group["dow"].mean())
        recency_days = (now - sorted_ts.iloc[-1]).total_seconds() / 86400

        intervals = sorted_ts.diff().dt.total_seconds().dropna() / 3600
        interval_mean = float(intervals.mean()) if len(intervals) > 0 else 0.0
        interval_std = float(intervals.std()) if len(intervals) > 1 else 0.0

        vectors.append(
            [
                total_count,
                recent_count,
                mean_hour,
                hour_std,
                mean_dow,
                recency_days,
                interval_mean,
                interval_std,
            ]
        )
        domains.append(str(domain))

    return vectors, domains


def _classify_anomaly(
    domain: str,
    df: pd.DataFrame,
    feature_vector: np.ndarray,
    score: float,
) -> tuple[str, str]:
    """Classify an anomaly by examining feature values.

    feature_vector indices:
    0=total_count, 1=recent_count, 2=mean_hour, 3=hour_std,
    4=mean_dow, 5=recency_days, 6=interval_mean, 7=interval_std
    """
    total_count = feature_vector[0]
    recent_count = feature_vector[1]
    hour_std = feature_vector[3]
    recency_days = feature_vector[5]
    interval_mean = feature_vector[6]

    # Check for volume spike: recent count >> expected
    if total_count > 0:
        expected_weekly = total_count / max(1, recency_days) * 7 if recency_days > 7 else total_count
        if recent_count > expected_weekly * _BURST_MULTIPLIER and recent_count > 5:
            return (
                "burst_contact",
                f"{domain}: {int(recent_count)} emails in last 7 days "
                f"vs ~{int(expected_weekly)} expected",
            )

    # Check for disappeared sender
    if total_count >= 10 and recency_days > 30:
        return (
            "disappeared",
            f"{domain}: {int(total_count)} historical emails but "
            f"silent for {int(recency_days)} days",
        )

    # Check for timing shift (high hour variance)
    if hour_std > 8:
        return (
            "timing_shift",
            f"{domain}: unusual sending time variance "
            f"(std={hour_std:.1f} hours)",
        )

    # Check for generic volume spike
    if recent_count > _BURST_MULTIPLIER * (total_count / max(recency_days, 1)) * 7:
        return (
            "volume_spike",
            f"{domain}: {int(recent_count)} recent emails, "
            f"{_BURST_MULTIPLIER}x above normal rate",
        )

    # Default
    return (
        "volume_spike",
        f"{domain}: anomalous behavior pattern (score={score:.2f})",
    )
