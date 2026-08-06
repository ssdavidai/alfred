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


def effective_threshold(instinct: dict[str, Any]) -> float:
    """The instinct's effective discretion bar (#445).

    SINGLE source of truth for the raise-only override rule. Previously
    this logic existed twice — here and in
    ``signal_actions._instinct_threshold`` — with only the latter wired
    into the live router, so the tested copy was not the running copy.
    ``_instinct_threshold`` now delegates here.

    Accepts either a bare frontmatter mapping or a full record dict with
    a ``frontmatter`` key.
    """
    fm = instinct.get("frontmatter")
    if not isinstance(fm, dict):
        fm = instinct

    obs_raw = fm.get("live_observation_count")
    if obs_raw is None:
        obs_raw = fm.get("observation_count", 0)
    try:
        obs_count = int(obs_raw)
    except (TypeError, ValueError):
        obs_count = 0
    earned = get_discretion_threshold(max(obs_count, 0))

    explicit = fm.get("discretion_threshold")
    if explicit is not None:
        try:
            f = float(explicit)
        except (TypeError, ValueError):
            f = None
        # ``f == f`` rejects NaN, which would make every comparison False.
        if f is not None and f == f and f >= 0.0:
            # Raise-only: an explicit override may only make the bar
            # stricter, never looser than what observations earned.
            return max(earned, min(f, 1.0))
    return earned


def should_route_autonomously(
    score: float,
    instinct: dict[str, Any],
) -> bool:
    """Determine if the score clears the instinct's discretion bar.

    The observation-earned bar is a **floor**: an explicit
    ``discretion_threshold`` may only *raise* the bar (lower trust /
    keep the instinct more cautious), never authorize autonomy beyond
    what the live observation count has earned. So the effective bar is
    the STRICTER (higher) of the obs-count formula and any explicit
    override. An instinct with <5 observations therefore sits at the
    Asking bar (0.95) regardless of a seeded threshold, and never
    auto-routes until it earns more observations.

    Prefers the ctrl-api-enriched ``live_observation_count`` (the same
    decision-sourced count the badge uses) over the stored snapshot.

    NOTE (#445): this answers "does the score clear the numeric bar", NOT
    "may this instinct act autonomously". The promotion-ladder tier is a
    separate, stricter ceiling enforced in
    ``signal_actions.route_signal_action`` — an ``Asking`` instinct never
    routes to the agent no matter what this returns.
    """
    return score >= effective_threshold(instinct)


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
