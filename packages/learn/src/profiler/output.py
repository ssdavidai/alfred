"""Orchestrate all profiler sub-modules and produce structured profile."""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)


def build_profile(emails: list[dict]) -> dict[str, Any]:
    """Main entry point: run all profiler sub-modules and assemble a full profile.

    Each sub-module is wrapped in try/except. If any module fails, that section
    is replaced with an empty default, a warning is recorded, and the profile
    remains valid. This function NEVER crashes.

    Returns dict with: meta, global_features, sender_tiers, anomalies,
    engagement, rhythm, relationships, financial, summary, warnings.
    """
    start_time = time.monotonic()
    warnings: list[str] = []
    email_count = len(emails)

    # --- Parse emails into DataFrame ---
    df = _safe_call(
        "features.emails_to_dataframe",
        _import_and_call,
        "profiler.features",
        "emails_to_dataframe",
        emails,
        warnings=warnings,
    )
    if df is None:
        import pandas as pd

        df = pd.DataFrame()
        warnings.append("Email parsing failed completely; profile will be minimal")

    # --- Global features ---
    global_features = _safe_call(
        "features.extract_global_features",
        _import_and_call,
        "profiler.features",
        "extract_global_features",
        df,
        warnings=warnings,
        default={},
    )

    # --- Temporal features (tsfresh) ---
    temporal_features = _safe_call(
        "features.extract_temporal_features",
        _import_and_call,
        "profiler.features",
        "extract_temporal_features",
        df,
        warnings=warnings,
    )

    # --- Rhythm analysis ---
    rhythm = _safe_call(
        "rhythm.analyze_rhythm",
        _import_and_call,
        "profiler.rhythm",
        "analyze_rhythm",
        df,
        warnings=warnings,
        default={},
    )

    # --- Relationship analysis ---
    relationships = _safe_call(
        "relationships.analyze_relationships",
        _import_and_call,
        "profiler.relationships",
        "analyze_relationships",
        df,
        warnings=warnings,
        default={},
    )

    # --- Clustering ---
    clusters = _safe_call(
        "clustering.cluster_senders",
        _import_and_call,
        "profiler.clustering",
        "cluster_senders",
        df,
        temporal_features,
        warnings=warnings,
        default={},
    )

    sender_tiers = _safe_call(
        "clustering.assign_tiers",
        _import_and_call,
        "profiler.clustering",
        "assign_tiers",
        clusters or {},
        df,
        warnings=warnings,
        default={},
    )

    # --- Anomalies ---
    anomalies = _safe_call(
        "anomalies.detect_relationship_anomalies",
        _import_and_call,
        "profiler.anomalies",
        "detect_relationship_anomalies",
        df,
        sender_tiers or {},
        warnings=warnings,
        default=[],
    )

    # --- Engagement prediction ---
    engagement = _safe_call(
        "engagement.predict_engagement",
        _import_and_call,
        "profiler.engagement",
        "predict_engagement",
        df,
        warnings=warnings,
        default={},
    )

    # --- Financial patterns ---
    financial = _safe_call(
        "financial.detect_financial_patterns",
        _import_and_call,
        "profiler.financial",
        "detect_financial_patterns",
        df,
        warnings=warnings,
        default={},
    )

    # --- Build summary for Opus prompt injection ---
    summary = _build_summary(
        global_features or {},
        sender_tiers or {},
        relationships or {},
        rhythm or {},
        financial or {},
    )

    elapsed = round(time.monotonic() - start_time, 2)

    return {
        "meta": {
            "version": "1.0.0",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "email_count": email_count,
            "processing_time_seconds": elapsed,
        },
        "global_features": global_features or {},
        "sender_tiers": sender_tiers or {},
        "anomalies": anomalies or [],
        "engagement": engagement or {},
        "rhythm": rhythm or {},
        "relationships": relationships or {},
        "financial": financial or {},
        "summary": summary,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _import_and_call(module_name: str, func_name: str, *args: Any) -> Any:
    """Dynamically import a profiler sub-module and call a function."""
    import importlib

    # Support both absolute and relative module paths
    if not module_name.startswith("src."):
        try:
            mod = importlib.import_module(f"src.{module_name}")
        except ImportError:
            mod = importlib.import_module(module_name)
    else:
        mod = importlib.import_module(module_name)

    func = getattr(mod, func_name)
    return func(*args)


def _safe_call(
    label: str,
    func: Any,
    *args: Any,
    warnings: list[str],
    default: Any = None,
) -> Any:
    """Call a function, catching all exceptions.

    On failure, logs the error, appends a warning, and returns `default`.
    """
    try:
        return func(*args)
    except Exception as exc:
        logger.exception("Profiler module %s failed", label)
        warnings.append(f"{label}: {type(exc).__name__}: {exc}")
        return default


def _build_summary(
    global_features: dict,
    sender_tiers: dict,
    relationships: dict,
    rhythm: dict,
    financial: dict,
) -> dict[str, Any]:
    """Build a pre-computed summary dict optimized for Opus prompt injection.

    Contains: inner_circle, work_hours, communication_style, top_subscriptions,
    key_patterns.
    """
    # Inner circle names
    inner_domains = sender_tiers.get("inner_circle", [])
    top_correspondents = relationships.get("top_correspondents", [])
    name_map = {c["domain"]: c["name"] for c in top_correspondents if c.get("domain")}
    inner_circle = [name_map.get(d, d) for d in inner_domains[:10]]

    # Work hours
    work_start = rhythm.get("work_start_estimate", 9)
    work_end = rhythm.get("work_end_estimate", 17)
    work_hours = f"{work_start:02d}:00-{work_end:02d}:00"

    # Communication style
    communication_style = relationships.get("communication_style", "unknown")

    # Top subscriptions
    subs = financial.get("detected_subscriptions", [])
    top_subscriptions = [s["service"] for s in subs[:5]]

    # Key patterns (1-sentence descriptions)
    key_patterns: list[str] = []

    total = global_features.get("total_emails", 0)
    if total > 0:
        avg = global_features.get("avg_emails_per_day", 0)
        key_patterns.append(
            f"Processes ~{avg} emails/day across {global_features.get('unique_domains', 0)} domains"
        )

    regularity = rhythm.get("regularity_score", 0)
    if regularity > 0.5:
        key_patterns.append("Highly regular email schedule (concentrated activity windows)")
    elif regularity > 0.2:
        key_patterns.append("Moderately regular email patterns")
    else:
        key_patterns.append("Irregular/distributed email activity throughout the day")

    weekend_ratio = rhythm.get("weekend_activity_ratio", 0)
    if weekend_ratio > 0.8:
        key_patterns.append("Active on weekends at nearly the same rate as weekdays")
    elif weekend_ratio < 0.2:
        key_patterns.append("Minimal weekend email activity")

    service_count = len(sender_tiers.get("service", []))
    newsletter_count = len(sender_tiers.get("newsletter", []))
    if service_count + newsletter_count > 10:
        key_patterns.append(
            f"High automated email volume ({service_count} services, {newsletter_count} newsletters)"
        )

    return {
        "inner_circle": inner_circle,
        "work_hours": work_hours,
        "communication_style": communication_style,
        "top_subscriptions": top_subscriptions,
        "key_patterns": key_patterns,
    }
