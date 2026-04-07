"""Circadian rhythm and calendar pattern analysis."""

from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pandas as pd
from scipy.stats import entropy

logger = logging.getLogger(__name__)

_HOUR_LABELS = list(range(24))
_DOW_LABELS = list(range(7))
_DOW_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

# A (dow, hour) bin is "routine" if its count exceeds expected by this factor.
_ROUTINE_THRESHOLD = 2.5
_MIN_ROUTINE_COUNT = 3


def analyze_rhythm(df: pd.DataFrame) -> dict:
    """Analyze circadian and weekly activity patterns.

    Returns dict with: hourly_distribution, daily_distribution, peak_hours,
    quiet_hours, work_start_estimate, work_end_estimate, weekend_activity_ratio,
    regularity_score, detected_routines.
    """
    if df.empty:
        return _empty_rhythm()

    # --- Hourly distribution (24 floats, normalized) ---
    hour_counts = np.zeros(24, dtype=float)
    for h in df["hour"]:
        hour_counts[h] += 1
    total = hour_counts.sum()
    hourly_dist = (hour_counts / total).tolist() if total > 0 else [0.0] * 24

    # --- Daily distribution (7 floats, normalized) ---
    dow_counts = np.zeros(7, dtype=float)
    for d in df["dow"]:
        dow_counts[d] += 1
    daily_dist = (dow_counts / total).tolist() if total > 0 else [0.0] * 7

    # --- Peak / quiet hours ---
    sorted_hours = np.argsort(hour_counts)
    peak_hours = sorted_hours[-3:][::-1].tolist()
    quiet_hours = sorted_hours[:3].tolist()

    # --- Work start / end estimate ---
    work_start, work_end = _estimate_work_window(hour_counts)

    # --- Weekend activity ratio ---
    weekday_count = dow_counts[:5].sum()
    weekend_count = dow_counts[5:].sum()
    if weekday_count > 0:
        # Normalized: (weekend emails / 2 weekend days) vs (weekday emails / 5 weekday days)
        weekend_daily = weekend_count / 2
        weekday_daily = weekday_count / 5
        weekend_activity_ratio = round(float(weekend_daily / weekday_daily), 3) if weekday_daily > 0 else 0.0
    else:
        weekend_activity_ratio = 1.0 if weekend_count > 0 else 0.0

    # --- Regularity score (0-1 using entropy) ---
    regularity_score = _compute_regularity(hour_counts)

    # --- Detected routines ---
    detected_routines = _detect_routines(df, total)

    return {
        "hourly_distribution": hourly_dist,
        "daily_distribution": daily_dist,
        "peak_hours": peak_hours,
        "quiet_hours": quiet_hours,
        "work_start_estimate": work_start,
        "work_end_estimate": work_end,
        "weekend_activity_ratio": weekend_activity_ratio,
        "regularity_score": regularity_score,
        "detected_routines": detected_routines,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _empty_rhythm() -> dict:
    return {
        "hourly_distribution": [0.0] * 24,
        "daily_distribution": [0.0] * 7,
        "peak_hours": [],
        "quiet_hours": [],
        "work_start_estimate": 9,
        "work_end_estimate": 17,
        "weekend_activity_ratio": 0.0,
        "regularity_score": 0.0,
        "detected_routines": [],
    }


def _estimate_work_window(hour_counts: np.ndarray) -> tuple[int, int]:
    """Estimate work start/end by finding the sustained high-activity window.

    Uses a rolling sum over a 2-hour window to find transitions.
    """
    if hour_counts.sum() == 0:
        return 9, 17

    # Smooth with 2-hour rolling mean (circular)
    extended = np.concatenate([hour_counts, hour_counts[:2]])
    smoothed = np.convolve(extended, np.ones(3) / 3, mode="valid")[:24]

    threshold = smoothed.mean()
    above = smoothed >= threshold

    # Find first and last hour above threshold
    active_hours = np.where(above)[0]
    if len(active_hours) == 0:
        return 9, 17

    work_start = int(active_hours[0])
    work_end = int(active_hours[-1])

    # Clamp to reasonable range
    if work_end - work_start > 18:
        # Likely a split schedule; use the densest 10-hour window
        best_start = 0
        best_sum = 0
        for s in range(24):
            window_sum = sum(hour_counts[(s + h) % 24] for h in range(10))
            if window_sum > best_sum:
                best_sum = window_sum
                best_start = s
        work_start = best_start
        work_end = (best_start + 10) % 24

    return work_start, work_end


def _compute_regularity(hour_counts: np.ndarray) -> float:
    """Regularity score: 1 = very concentrated/regular, 0 = uniform.

    Uses normalized entropy: 1 - H(p) / H_max.
    """
    total = hour_counts.sum()
    if total == 0:
        return 0.0

    probs = hour_counts / total
    # Filter out zero-probability bins
    probs = probs[probs > 0]

    h = float(entropy(probs, base=2))
    h_max = np.log2(24)

    regularity = 1.0 - (h / h_max) if h_max > 0 else 0.0
    return round(max(0.0, min(1.0, regularity)), 3)


def _detect_routines(df: pd.DataFrame, total_emails: float) -> list[dict[str, Any]]:
    """Find (dow, hour) bins with significantly above-expected counts."""
    if total_emails < 20:
        return []

    # Build (dow, hour) histogram
    bins = np.zeros((7, 24), dtype=float)
    for _, row in df.iterrows():
        bins[row["dow"]][row["hour"]] += 1

    expected = total_emails / (7 * 24)
    routines: list[dict[str, Any]] = []

    for dow in range(7):
        for hour in range(24):
            count = bins[dow][hour]
            if count >= _MIN_ROUTINE_COUNT and count >= expected * _ROUTINE_THRESHOLD:
                period = _time_period(hour)
                routines.append(
                    {
                        "day": _DOW_NAMES[dow],
                        "hour": hour,
                        "pattern_description": (
                            f"{_DOW_NAMES[dow]} {period} activity "
                            f"({int(count)} emails at {hour:02d}:00)"
                        ),
                        "frequency": int(count),
                    }
                )

    # Sort by frequency descending
    routines.sort(key=lambda r: r["frequency"], reverse=True)
    return routines[:20]  # Cap at 20 routines


def _time_period(hour: int) -> str:
    if 5 <= hour < 9:
        return "early morning"
    if 9 <= hour < 12:
        return "morning"
    if 12 <= hour < 14:
        return "midday"
    if 14 <= hour < 17:
        return "afternoon"
    if 17 <= hour < 21:
        return "evening"
    return "late night"
