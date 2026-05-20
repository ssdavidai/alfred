"""Temporal activity: run behavioral profiler on onboarding email data."""

from __future__ import annotations

import json
from typing import Any

from temporalio import activity

from src.profiler.output import build_profile


@activity.defn
async def run_behavioral_profiler(onboard_path: str) -> dict[str, Any]:
    """Analyze onboarding emails and build a behavioral profile.

    Reads emails from onboard.json, runs the profiler pipeline, writes
    the resulting profile back into onboard.json under the "profile" key,
    and returns a compact summary.
    """
    activity.heartbeat("reading onboard.json")

    with open(onboard_path, "r") as f:
        onboard_data: dict[str, Any] = json.load(f)

    emails: list[dict[str, Any]] = onboard_data.get("emails", [])
    if not emails:
        activity.logger.warning("No emails found in %s", onboard_path)
        return {
            "sender_tiers": 0,
            "patterns": 0,
            "anomalies": 0,
            "warnings": ["no emails in onboard.json"],
        }

    activity.heartbeat("building profile from %d emails" % len(emails))

    profile = build_profile(emails)

    activity.heartbeat("writing profile to onboard.json")

    onboard_data["profile"] = profile
    with open(onboard_path, "w") as f:
        json.dump(onboard_data, f, indent=2, default=str)

    # Build summary from profile data
    sender_tiers = len(profile.get("sender_tiers", {}))
    patterns = len(profile.get("rhythm", {}).get("detected_routines", []))
    anomalies = len(profile.get("financial", {}).get("payment_issues", []))
    warnings: list[str] = profile.get("warnings", [])

    activity.heartbeat("profiler complete")

    return {
        "sender_tiers": sender_tiers,
        "patterns": patterns,
        "anomalies": anomalies,
        "warnings": warnings,
    }
