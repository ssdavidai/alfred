"""F33b — the daily brief is a built-in, so Opus must not generate it as
a chore opportunity (which created the duplicate morning_briefing chore).

A deterministic post-validation filter drops any opportunity that
re-implements the whole-life daily/morning/evening brief. It must NOT
drop a legitimate per-matter digest (e.g. weekly-acme-digest) — only the
brief itself.
"""
from __future__ import annotations

from src.activities.onboarding_v3 import _is_brief_opportunity


def _opp(**kw):
    base = {"id": "x", "name": "X", "description": "", "tags": []}
    base.update(kw)
    return base


def test_morning_briefing_id_is_a_brief():
    assert _is_brief_opportunity(_opp(id="morning-briefing", name="Morning briefing"))


def test_daily_brief_name_is_a_brief():
    assert _is_brief_opportunity(_opp(id="start-of-day", name="Daily brief"))


def test_evening_digest_brief_tag_is_a_brief():
    assert _is_brief_opportunity(
        _opp(id="evening-wrap", name="Evening wrap-up", tags=["briefing"])
    )


def test_per_matter_digest_is_not_a_brief():
    # A scoped digest about ONE matter is a legitimate chore, not the
    # whole-life brief.
    assert not _is_brief_opportunity(
        _opp(id="weekly-acme-digest", name="Weekly Acme Consulting digest",
             tags=["digest", "acme"])
    )


def test_subscription_watcher_is_not_a_brief():
    assert not _is_brief_opportunity(
        _opp(id="watch-subscriptions", name="Watch subscriptions",
             tags=["financial"])
    )
