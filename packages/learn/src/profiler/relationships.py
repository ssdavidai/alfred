"""Communication dynamics: response times, thread depth, reciprocity."""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

_RE_PREFIX = re.compile(r"^(?:Re|Fwd|Fw)\s*:\s*", re.IGNORECASE)


def analyze_relationships(df: pd.DataFrame) -> dict:
    """Analyze communication dynamics across all senders.

    Returns dict with: top_correspondents, response_time_stats,
    thread_depth_stats, communication_style, reciprocity_scores.
    """
    if df.empty:
        return _empty_relationships()

    # --- Thread depth ---
    thread_depths = df["subject"].apply(_thread_depth)
    thread_depth_mean = float(thread_depths.mean()) if len(thread_depths) > 0 else 0.0
    thread_depth_max = int(thread_depths.max()) if len(thread_depths) > 0 else 0

    # --- Response times (match Re: subjects within same domain) ---
    response_times = _compute_response_times(df)

    if response_times:
        rt_array = np.array(response_times)
        rt_mean = float(np.mean(rt_array))
        rt_median = float(np.median(rt_array))
        rt_p95 = float(np.percentile(rt_array, 95))
    else:
        rt_mean = rt_median = rt_p95 = 0.0

    # --- Communication style ---
    communication_style = _classify_style(rt_median, response_times)

    # --- Per-domain response times ---
    domain_rt: dict[str, list[float]] = defaultdict(list)
    for rt_entry in _compute_response_times_per_domain(df):
        domain_rt[rt_entry["domain"]].append(rt_entry["hours"])

    # --- Top correspondents ---
    domain_counts = df.groupby("from_domain").agg(
        email_count=("from_domain", "size"),
        first_sender=("from_addr", "first"),
    ).sort_values("email_count", ascending=False)

    top_correspondents: list[dict[str, Any]] = []
    for domain, row in domain_counts.head(20).iterrows():
        avg_rt = round(np.mean(domain_rt[domain]), 2) if domain in domain_rt else None
        top_correspondents.append(
            {
                "name": _extract_name(row["first_sender"]),
                "domain": str(domain),
                "email_count": int(row["email_count"]),
                "avg_response_time_hours": avg_rt,
            }
        )

    # --- Reciprocity scores ---
    reciprocity_scores = _compute_reciprocity(df)

    return {
        "top_correspondents": top_correspondents,
        "response_time_stats": {
            "mean_hours": round(rt_mean, 2),
            "median_hours": round(rt_median, 2),
            "p95_hours": round(rt_p95, 2),
        },
        "thread_depth_stats": {
            "mean": round(thread_depth_mean, 2),
            "max": thread_depth_max,
        },
        "communication_style": communication_style,
        "reciprocity_scores": reciprocity_scores,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _empty_relationships() -> dict:
    return {
        "top_correspondents": [],
        "response_time_stats": {"mean_hours": 0.0, "median_hours": 0.0, "p95_hours": 0.0},
        "thread_depth_stats": {"mean": 0.0, "max": 0},
        "communication_style": "sparse",
        "reciprocity_scores": {},
    }


def _thread_depth(subject: str) -> int:
    """Count Re:/Fwd: nesting levels in a subject line."""
    depth = 0
    s = str(subject).strip()
    while _RE_PREFIX.match(s):
        s = _RE_PREFIX.sub("", s, count=1).strip()
        depth += 1
    return depth


def _normalize_subject(subject: str) -> str:
    """Strip all Re:/Fwd: prefixes for thread matching."""
    s = str(subject).strip()
    while _RE_PREFIX.match(s):
        s = _RE_PREFIX.sub("", s, count=1).strip()
    return s.lower().strip()


def _compute_response_times(df: pd.DataFrame) -> list[float]:
    """Find reply pairs by matching Re: subjects and compute response times in hours."""
    if df.empty:
        return []

    # Group emails by normalized subject
    subject_groups: dict[str, list[tuple[pd.Timestamp, str]]] = defaultdict(list)
    for _, row in df.iterrows():
        norm = _normalize_subject(row["subject"])
        if norm:
            subject_groups[norm].append((row["timestamp"], row["from_domain"]))

    response_times: list[float] = []
    for entries in subject_groups.values():
        if len(entries) < 2:
            continue
        # Sort by time
        sorted_entries = sorted(entries, key=lambda x: x[0])
        for i in range(1, len(sorted_entries)):
            prev_ts, prev_domain = sorted_entries[i - 1]
            curr_ts, curr_domain = sorted_entries[i]
            # Only count as response if different sender domain
            if prev_domain != curr_domain:
                delta_hours = (curr_ts - prev_ts).total_seconds() / 3600
                if 0 < delta_hours < 168:  # Cap at 1 week
                    response_times.append(delta_hours)

    return response_times


def _compute_response_times_per_domain(df: pd.DataFrame) -> list[dict]:
    """Like _compute_response_times but tagged per domain."""
    if df.empty:
        return []

    subject_groups: dict[str, list[tuple[pd.Timestamp, str]]] = defaultdict(list)
    for _, row in df.iterrows():
        norm = _normalize_subject(row["subject"])
        if norm:
            subject_groups[norm].append((row["timestamp"], row["from_domain"]))

    results: list[dict] = []
    for entries in subject_groups.values():
        if len(entries) < 2:
            continue
        sorted_entries = sorted(entries, key=lambda x: x[0])
        for i in range(1, len(sorted_entries)):
            prev_ts, prev_domain = sorted_entries[i - 1]
            curr_ts, curr_domain = sorted_entries[i]
            if prev_domain != curr_domain:
                delta_hours = (curr_ts - prev_ts).total_seconds() / 3600
                if 0 < delta_hours < 168:
                    results.append({"domain": curr_domain, "hours": delta_hours})

    return results


def _classify_style(median_rt: float, response_times: list[float]) -> str:
    """Classify communication style based on median response time."""
    if not response_times:
        return "sparse"
    if median_rt < 1.0:
        return "responsive"
    if median_rt < 8.0:
        return "batched"
    if median_rt < 24.0:
        return "selective"
    return "sparse"


def _compute_reciprocity(df: pd.DataFrame) -> dict[str, float]:
    """Per-domain sent ratio (emails from domain / total emails involving domain).

    Since we only have inbox data, sent_ratio is approximated by thread
    participation: if a domain appears in many threads (Re: subjects), the
    user is likely replying, so reciprocity is higher.
    """
    if df.empty:
        return {}

    domain_total: dict[str, int] = defaultdict(int)
    domain_threaded: dict[str, int] = defaultdict(int)

    for _, row in df.iterrows():
        domain = row["from_domain"]
        domain_total[domain] += 1
        if _thread_depth(row["subject"]) > 0:
            domain_threaded[domain] += 1

    reciprocity: dict[str, float] = {}
    for domain in domain_total:
        total = domain_total[domain]
        threaded = domain_threaded[domain]
        # Higher thread ratio implies more back-and-forth
        reciprocity[domain] = round(threaded / total, 3) if total > 0 else 0.0

    return reciprocity


def _extract_name(from_addr: str) -> str:
    """Extract display name from email address string.

    Handles formats like: 'John Doe <john@example.com>' or 'john@example.com'
    """
    addr = str(from_addr).strip()
    if "<" in addr:
        name = addr.split("<")[0].strip().strip('"').strip("'")
        if name:
            return name
    if "@" in addr:
        return addr.split("@")[0]
    return addr
