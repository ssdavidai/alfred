"""Discretion thresholds — knowing when to act vs. when to ask.

Thresholds scale with evidence (observation count):

| Observations | Threshold | Butler equivalent                                    |
|--------------|-----------|------------------------------------------------------|
| < 5          | 0.95      | "I've barely seen this before, sir. Your guidance?"  |
| 5–9          | 0.90      | "I believe I know, but I'd rather confirm."          |
| 10–19        | 0.85      | "I'm fairly certain this goes here."                 |
| 20–49        | 0.80      | "I've seen this many times. Handling it."            |
| 50+          | 0.75      | "This is routine. Already done."                     |
"""

from __future__ import annotations

from typing import Any


def get_discretion_threshold(observation_count: int) -> float:
    """Calculate the discretion threshold based on observation count."""
    if observation_count < 5:
        return 0.95
    elif observation_count < 10:
        return 0.90
    elif observation_count < 20:
        return 0.85
    elif observation_count < 50:
        return 0.80
    else:
        return 0.75


def should_route_autonomously(
    score: float,
    instinct: dict[str, Any],
) -> bool:
    """Determine if the score exceeds the instinct's discretion threshold.

    Uses the instinct's own threshold if set, otherwise calculates from
    observation count.
    """
    threshold = instinct.get("discretion_threshold")
    if threshold is None:
        obs_count = instinct.get("observation_count", 0)
        threshold = get_discretion_threshold(obs_count)
    return score >= threshold


def format_discretion_level(observation_count: int) -> str:
    """Return a human-readable discretion level description."""
    threshold = get_discretion_threshold(observation_count)
    labels = {
        0.95: "Very cautious — will ask for guidance",
        0.90: "Cautious — prefers to confirm",
        0.85: "Confident — fairly certain",
        0.80: "Experienced — handles autonomously",
        0.75: "Routine — automatic handling",
    }
    return labels.get(threshold, f"Threshold: {threshold}")
