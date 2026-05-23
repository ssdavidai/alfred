"""Phase 2 / Lane II — Commit 2: filter non-human / truncated persons at
materialize.

Two helpers gate the person-write path inside
``packs_opus._create_or_merge_entity``:

* ``_is_plausible_human_name(name)`` — rejects per the C-OB1 ruleset
  (Notifications? suffix, '@', TLD substring, single capitalised token).
* ``_dedupe_truncated_persons(existing_names, candidate)`` — collapses
  a prefix/truncation pair onto the longer name when token-overlap >=
  0.65.

These tests prove the filter rejects the live junk (Github
Notifications, david@szabostuban.com, David Szabo-St ⊂ David
Szabo-Stuban) and accepts real humans (RJ Johnson).
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest
from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities import packs_opus
from src.activities.packs_opus import (
    _create_or_merge_entity,
    _dedupe_truncated_persons,
    _is_plausible_human_name,
)


# ---------------------------------------------------------------------------
# _is_plausible_human_name — pure unit
# ---------------------------------------------------------------------------


def test_rejects_notifications_suffix() -> None:
    assert _is_plausible_human_name("Github Notifications") is False
    assert _is_plausible_human_name("github notification") is False
    assert _is_plausible_human_name("Acme Notifications") is False


def test_rejects_email_address() -> None:
    assert _is_plausible_human_name("david@szabostuban.com") is False
    assert _is_plausible_human_name("foo@bar") is False


def test_rejects_tld_substring() -> None:
    # Any TLD-shaped substring → not a human.
    for bad in (
        "github.com", "stripe.io", "Acme.net", "example.org",
        "openai.ai", "vercel.co", "alfred.so",
    ):
        assert _is_plausible_human_name(bad) is False, bad


def test_rejects_single_capitalized_token() -> None:
    """A bare first name with no surname token is a truncation candidate.
    Live evidence: 'Github' (truncated from 'Github Notifications').
    """
    assert _is_plausible_human_name("Github") is False
    assert _is_plausible_human_name("david") is False
    assert _is_plausible_human_name("X") is False


def test_accepts_two_capitalized_tokens() -> None:
    """The live happy path — 'RJ Johnson', 'Dana Reyes', the hyphenated
    'David Szabo-Stuban'.
    """
    assert _is_plausible_human_name("RJ Johnson") is True
    assert _is_plausible_human_name("Dana Reyes") is True
    # 'David Szabo-Stuban' tokenises to {David, Szabo, Stuban} via the
    # hyphen → multiple cap tokens.
    assert _is_plausible_human_name("David Szabo-Stuban") is True


def test_accepts_unicode_diacritic_name() -> None:
    """Eszter Szabó-Stubán → real human."""
    assert _is_plausible_human_name("Eszter Szabó-Stubán") is True


# ---------------------------------------------------------------------------
# _dedupe_truncated_persons — pure unit
# ---------------------------------------------------------------------------


def test_dedupe_returns_existing_when_candidate_is_prefix() -> None:
    """'David Szabo-St' is a tokenwise subset of 'David Szabo-Stuban' →
    merge onto the longer existing name.
    """
    existing = ["David Szabo-Stuban", "Sam Lee"]
    canonical = _dedupe_truncated_persons(existing, "David Szabo-St")
    assert canonical == "David Szabo-Stuban"


def test_dedupe_returns_candidate_when_it_is_longer() -> None:
    """Existing has the truncated version; candidate is the full name.
    The candidate wins (new write proceeds; merge logic handles the
    older record).
    """
    existing = ["David Szabo-St"]
    canonical = _dedupe_truncated_persons(existing, "David Szabo-Stuban")
    # Candidate name itself is returned; caller can then patch existing.
    assert canonical == "David Szabo-Stuban"


def test_dedupe_returns_none_for_unrelated() -> None:
    existing = ["Sam Lee", "Pat Singh"]
    assert _dedupe_truncated_persons(existing, "Dana Reyes") is None


def test_dedupe_does_not_collapse_distinct_people() -> None:
    """'David Smith' and 'David Jones' share only 'david' → overlap 0.33 →
    NOT collapsed."""
    existing = ["David Smith"]
    assert _dedupe_truncated_persons(existing, "David Jones") is None


# ---------------------------------------------------------------------------
# _create_or_merge_entity — wired filter
# ---------------------------------------------------------------------------


class _FakeVaultClient:
    def __init__(self) -> None:
        self.written: list[tuple[str, str]] = []
        self.patched: list = []

    async def record_exists(self, record_type: str, name: str) -> bool:
        return False

    async def write_record(self, record_type: str, name: str, content: str) -> str:
        self.written.append((record_type, name))
        return f"{record_type}/{name}.md"

    async def patch_frontmatter_structured(self, path, scalar_updates=None,
                                           json_updates=None) -> None:
        self.patched.append((path, json_updates or {}))

    async def close(self) -> None:  # pragma: no cover
        pass


def _run(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_test_person_filter_wrapper")
    async def _wrap() -> Any:
        return await coro_factory()

    return asyncio.run(env.run(_wrap))


def test_create_or_merge_entity_rejects_notifications_person() -> None:
    fake = _FakeVaultClient()

    async def _go() -> str:
        return await _create_or_merge_entity(
            fake,  # type: ignore[arg-type]
            record_type="person",
            name="Github Notifications",
            backlinks=["[[matter/alfred-black-platform]]"],
            description="Source of GitHub CI emails.",
            existing_fm={},
        )

    outcome = _run(_go)

    assert outcome == "skipped"
    assert fake.written == []


def test_create_or_merge_entity_rejects_email_as_person() -> None:
    fake = _FakeVaultClient()

    async def _go() -> str:
        return await _create_or_merge_entity(
            fake,  # type: ignore[arg-type]
            record_type="person",
            name="david@szabostuban.com",
            backlinks=[],
            description="The principal's email.",
            existing_fm={},
        )

    outcome = _run(_go)
    assert outcome == "skipped"
    assert fake.written == []


def test_create_or_merge_entity_writes_for_real_human() -> None:
    fake = _FakeVaultClient()

    async def _go() -> str:
        return await _create_or_merge_entity(
            fake,  # type: ignore[arg-type]
            record_type="person",
            name="RJ Johnson",
            backlinks=["[[matter/deal]]"],
            description="Counterparty on a deal.",
            existing_fm={},
        )

    outcome = _run(_go)

    assert outcome == "created"
    assert ("person", "RJ Johnson") in fake.written


def test_create_or_merge_entity_collapses_truncated_person() -> None:
    """The existing cache already has 'David Szabo-Stuban'. A second write
    for 'David Szabo-St' must be merged onto the existing record (no
    duplicate written, backlink unioned via the existing-path branch).
    """
    fake = _FakeVaultClient()
    existing_fm: dict[str, dict[str, Any]] = {
        "david szabo-stuban": {
            "name": "David Szabo-Stuban",
            "related": ["[[matter/old]]"],
        },
    }

    async def _go() -> str:
        return await _create_or_merge_entity(
            fake,  # type: ignore[arg-type]
            record_type="person",
            name="David Szabo-St",
            backlinks=["[[matter/new]]"],
            description="Trunc.",
            existing_fm=existing_fm,
        )

    outcome = _run(_go)

    # Must NOT write a duplicate 'David Szabo-St' record.
    assert fake.written == []
    # Should have merged onto the canonical name → patch fired.
    assert outcome == "merged"
    assert any("David Szabo-Stuban" in p[0] for p in fake.patched), (
        f"expected a patch onto David Szabo-Stuban; got {fake.patched}"
    )


def test_create_or_merge_entity_does_not_filter_orgs() -> None:
    """The person filter must NOT touch org writes (orgs have their own
    filter in commit 3)."""
    fake = _FakeVaultClient()

    async def _go() -> str:
        return await _create_or_merge_entity(
            fake,  # type: ignore[arg-type]
            record_type="org",
            name="github.com",  # would fail the person TLD test, but irrelevant for org here
            backlinks=[],
            description="An org.",
            existing_fm={},
        )

    outcome = _run(_go)

    assert outcome == "created"
    # The org write proceeded; _normalize_entity_name title-cases the leading
    # token but the gate did NOT reject — that's the whole point.
    assert any(t == "org" for (t, _) in fake.written), (
        f"org write was filtered out; got {fake.written}"
    )
