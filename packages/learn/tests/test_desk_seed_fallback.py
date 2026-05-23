"""Gap 2 — Day-1 Desk fallback when no time-anchored matters exist.

Live 2026-05-23 evidence: ``seed_day_one_desk_cards`` logged
``0 time-anchored matters in 9`` — the 9 Opus-generated matters were
THEMATIC, not time-critical. The Day-1 Desk MUST NOT be empty on first
onboard; a fallback ranks matters by activity_score / key_people count
and seeds the top 3.
"""
from __future__ import annotations

import logging

from src.activities.desk_seed import seed_day_one_desk_cards  # noqa: F401
from tests.test_desk_seed import _run_with_vault  # reuse fixtures


_THEMATIC_BODY = (
    "# Some thematic matter\n\n## Context\n\nA broad theme — no dates.\n"
)
_TIME_ANCHORED_BODY = (
    "# Kondorosi purchase\n\nContract signing planned for next Wednesday.\n"
)
_TIME_ANCHORED_BODY_2 = (
    "# NAV registration\n\nNAV registration required by May 30, 2026.\n"
)


def _m(slug: str, body: str = _THEMATIC_BODY,
       activity_score: float | None = None,
       key_people: list[str] | None = None) -> dict:
    fm: dict = {"name": slug.replace("-", " ").title(), "type": "matter"}
    if activity_score is not None:
        fm["activity_score"] = activity_score
    if key_people is not None:
        fm["key_people"] = key_people
    return {"path": f"matter/{slug}.md", "frontmatter": fm, "body": body}


def test_fallback_fires_with_9_themed_matters(tmp_path, monkeypatch):
    """9 thematic matters, 0 time-anchored → fallback MUST seed 3 cards."""
    matters = [_m(f"theme-{i}") for i in range(9)]
    result, writes = _run_with_vault(matters, tmp_path, monkeypatch)
    assert result.get("seeded") == 3, result
    assert len(writes) == 3
    assert all(w["type"] == "needs_attention" for w in writes)


def test_time_anchored_path_unchanged_when_some_anchored(tmp_path, monkeypatch):
    """7 thematic + 2 anchored → only the 2 anchored win; fallback OFF."""
    matters = [_m(f"theme-{i}") for i in range(7)]
    matters.append(_m("kondorosi", _TIME_ANCHORED_BODY))
    matters.append(_m("nav-reg", _TIME_ANCHORED_BODY_2))
    result, writes = _run_with_vault(matters, tmp_path, monkeypatch)
    assert result.get("seeded") == 2, result
    names_lower = " ".join(w["name"].lower() for w in writes)
    assert "kondorosi" in names_lower and "nav-reg" in names_lower


def test_fallback_card_is_c_ob3_compliant(tmp_path, monkeypatch):
    """Fallback cards still satisfy C-OB3: source / source_matter_ref /
    display_headline / display_body / tags [onboarding_seed, day_one]."""
    matters = [_m(f"theme-{i}") for i in range(5)]
    _result, writes = _run_with_vault(matters, tmp_path, monkeypatch)
    assert len(writes) == 3
    for w in writes:
        c = w["content"]
        for required in (
            "source: onboarding_seed", "source_matter_ref:", "matter/",
            "display_headline:", "display_body:",
            "tags: [onboarding_seed, day_one]",
        ):
            assert required in c, (required, c[:300])


def test_fallback_ranks_by_activity_score(tmp_path, monkeypatch):
    """Top N=3 by activity_score; ties broken by key_people, then index."""
    matters = [
        _m("low", activity_score=0.1),
        _m("highest", activity_score=0.9, key_people=["A", "B"]),
        _m("mid", activity_score=0.5),
        _m("hi", activity_score=0.7, key_people=["C"]),
        _m("zero", activity_score=0.0),
    ]
    _result, writes = _run_with_vault(matters, tmp_path, monkeypatch)
    assert len(writes) == 3
    names = " ".join(w["name"] for w in writes)
    assert "highest" in names and "hi" in names and "mid" in names


def test_fallback_log_line_emitted(tmp_path, monkeypatch, caplog):
    """Audit log MUST mention 0 time-anchored + fallback active + count."""
    matters = [_m(f"theme-{i}") for i in range(6)]
    with caplog.at_level(logging.INFO, logger="alfred-learn"):
        _run_with_vault(matters, tmp_path, monkeypatch)
    msg = "\n".join(r.message for r in caplog.records)
    assert "seed_day_one_desk_cards" in msg
    assert "0 time-anchored" in msg
    assert "fallback" in msg.lower()
    assert "3" in msg


def test_fallback_caps_at_available_matters(tmp_path, monkeypatch):
    """Only 2 matters → fallback seeds 2, not 3. No crash, no dupes."""
    matters = [_m("a"), _m("b")]
    result, writes = _run_with_vault(matters, tmp_path, monkeypatch)
    assert result.get("seeded") == 2, result
    assert len({w["name"] for w in writes}) == 2
