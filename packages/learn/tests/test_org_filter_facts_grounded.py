"""Phase 2 / Lane II — Commit 3: orgs must be facts-grounded, not domains.

Current live result on the 2026-05-23 fixture: exactly ONE org record,
``org/github.com.md`` — a domain, not a company. Meanwhile
``onboard.json["facts"]`` names NeoTerra, Stylers Group, Keller
Williams, Wise, Mercury, Gránit Bank, Revolut Business, Krio Intézet,
etc. The wikilink-derived org branch in
``packs_opus.materialize_matter_entities`` was treating the
``[[org/<domain>]]`` link the matter pack emits as an authoritative org
name.

The fix: every org name materialised during onboarding must pass
``_org_name_is_plausible(name, facts_corpus)``:
  * a TLD-ending name (``github.com``, ``stripe.io``) is allowed ONLY
    if the same name string appears in the facts corpus;
  * a non-TLD proper name passes unconditionally.

These tests prove the helper + its wiring.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest
from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities.packs_opus import (
    _create_or_merge_entity,
    _org_name_is_plausible,
)


# ---------------------------------------------------------------------------
# _org_name_is_plausible — pure unit
# ---------------------------------------------------------------------------


def test_rejects_bare_domain_not_in_facts() -> None:
    facts = "We use GitHub for source control. Stripe handles billing."
    # 'github.com' as a literal org name: not in the facts corpus (which
    # says 'GitHub', not 'github.com') → rejected.
    assert _org_name_is_plausible("github.com", facts) is False
    assert _org_name_is_plausible("stripe.io", facts) is False
    assert _org_name_is_plausible("acme.net", facts) is False


def test_accepts_domain_if_named_verbatim_in_facts() -> None:
    """If the facts corpus literally names the domain (e.g. a fact says
    'github.com is the principal's primary repo host'), accept it."""
    facts = "github.com is where the team lives day to day."
    assert _org_name_is_plausible("github.com", facts) is True


def test_accepts_proper_company_name() -> None:
    facts = "NeoTerra Property Group is a consulting client."
    assert _org_name_is_plausible("NeoTerra Property Group", facts) is True
    # Also accept when facts is empty — proper-name pass-through.
    assert _org_name_is_plausible("Stylers Group", "") is True
    assert _org_name_is_plausible("Keller Williams", "") is True


def test_accepts_proper_name_case_insensitive_match() -> None:
    """The facts may say 'neoterra property group' (lowercased) — match
    case-insensitively so casing drift doesn't strip a real org."""
    facts = "Worked with neoterra property group on H1 strategy."
    assert _org_name_is_plausible("NeoTerra Property Group", facts) is True


def test_rejects_empty_or_whitespace() -> None:
    assert _org_name_is_plausible("", "any facts") is False
    assert _org_name_is_plausible("   ", "any facts") is False


# ---------------------------------------------------------------------------
# Wired path — _create_or_merge_entity respects facts_corpus for orgs
# ---------------------------------------------------------------------------


class _FakeVaultClient:
    def __init__(self) -> None:
        self.written: list[tuple[str, str]] = []
        self.patched: list = []

    async def record_exists(self, *_a: Any, **_k: Any) -> bool:
        return False

    async def write_record(self, record_type: str, name: str, content: str) -> str:
        self.written.append((record_type, name))
        return f"{record_type}/{name}.md"

    async def patch_frontmatter_structured(self, *_a: Any, **_k: Any) -> None:
        self.patched.append(_a)

    async def close(self) -> None:  # pragma: no cover
        pass


def _run(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_test_org_filter_wrapper")
    async def _wrap() -> Any:
        return await coro_factory()

    return asyncio.run(env.run(_wrap))


def test_create_or_merge_entity_drops_domain_org_when_not_in_facts() -> None:
    """The live failure: a matter said ``[[org/github.com]]``, materialize
    walked the wikilink and called ``_create_or_merge_entity`` with
    ``name='github.com'``. With ``facts_corpus`` not naming the domain
    literally, the write must NOT happen.
    """
    fake = _FakeVaultClient()

    async def _go() -> str:
        return await _create_or_merge_entity(
            fake,  # type: ignore[arg-type]
            record_type="org",
            name="github.com",
            backlinks=["[[matter/alfred-black-platform]]"],
            description="A domain.",
            existing_fm={},
            facts_corpus="No mention of the domain literally.",
        )

    outcome = _run(_go)

    assert outcome == "skipped"
    assert fake.written == []


def test_create_or_merge_entity_writes_real_company_in_facts() -> None:
    fake = _FakeVaultClient()
    facts = "NeoTerra Property Group is the consulting client of record."

    async def _go() -> str:
        return await _create_or_merge_entity(
            fake,  # type: ignore[arg-type]
            record_type="org",
            name="NeoTerra Property Group",
            backlinks=[],
            description="A consulting client.",
            existing_fm={},
            facts_corpus=facts,
        )

    outcome = _run(_go)

    assert outcome == "created"
    # _normalize_entity_name keeps the proper Title-Case name intact.
    assert any(t == "org" for (t, _) in fake.written)
    assert any("NeoTerra" in n for (_, n) in fake.written)


def test_create_or_merge_entity_drops_org_when_facts_corpus_missing() -> None:
    """No facts_corpus passed → the helper defaults to '' so a TLD-named
    org without grounding still gets rejected. (Defensive: a caller
    that forgets to thread the corpus must NOT silently allow junk.)
    """
    fake = _FakeVaultClient()

    async def _go() -> str:
        return await _create_or_merge_entity(
            fake,  # type: ignore[arg-type]
            record_type="org",
            name="stripe.io",
            backlinks=[],
            description="A domain.",
            existing_fm={},
        )

    outcome = _run(_go)
    assert outcome == "skipped"
    assert fake.written == []


def test_create_or_merge_entity_proper_name_writes_without_facts() -> None:
    """A proper-named org with no facts_corpus passed still writes —
    the gate only triggers on TLD-shaped names."""
    fake = _FakeVaultClient()

    async def _go() -> str:
        return await _create_or_merge_entity(
            fake,  # type: ignore[arg-type]
            record_type="org",
            name="Acme Co",
            backlinks=[],
            description="A company.",
            existing_fm={},
        )

    outcome = _run(_go)
    assert outcome == "created"
    assert any(t == "org" for (t, _) in fake.written)


# ---------------------------------------------------------------------------
# Integration: materialize_matter_entities builds facts_corpus from
# onboard.json and the live junk org disappears.
# ---------------------------------------------------------------------------


def test_materialize_drops_github_dot_com_org_writes_neoterra() -> None:
    """End-to-end-ish: a matter naming both a domain org and a real one,
    with facts that mention the real one. After materialize:
    * org/github.com is NOT written;
    * org/NeoTerra is written.
    """
    from src.activities.packs_opus import materialize_matter_entities

    matters = [
        {
            "path": "matter/alfred-black-platform.md",
            "frontmatter": {
                "related_persons": [],
                "related_orgs": [
                    "[[org/github.com]]",
                    "[[org/NeoTerra Property Group]]",
                ],
            },
        },
    ]

    class _MaterializeFake:
        def __init__(self) -> None:
            self.written: list[tuple[str, str]] = []

        async def list_records(self, record_type: str, **_k: Any):
            if record_type == "matter":
                return matters
            return []

        async def record_exists(self, *_a: Any, **_k: Any) -> bool:
            return False

        async def write_record(self, record_type: str, name: str, content: str) -> str:
            self.written.append((record_type, name))
            return f"{record_type}/{name}.md"

        async def patch_frontmatter_structured(self, *_a: Any, **_k: Any) -> None:
            pass

        async def close(self) -> None:  # pragma: no cover
            pass

    fake = _MaterializeFake()

    import src.activities.packs_opus as po
    import src.config as cfg
    from unittest.mock import patch as _patch

    onboard_data = {
        "facts": [
            {"fact": "NeoTerra Property Group is the principal's consulting client."},
            {"fact": "Stylers Group owns the property development pipeline."},
        ],
    }

    async def _go() -> dict[str, Any]:
        return await materialize_matter_entities("/tmp/onboard.json")

    # ONBOARDING_KG_SEED off so we only exercise Pass A.
    with _patch.object(po, "VaultClient", lambda *_a, **_k: fake), \
         _patch.object(po, "_read_onboard_json", lambda _p: onboard_data), \
         _patch.object(cfg, "load_config",
                       lambda: type("C", (), {"alfred_ctrl_url": "http://test:3100"})()), \
         _patch.dict("os.environ", {"ONBOARDING_KG_SEED": "false"}, clear=False):
        _run(_go)

    org_names = [n for (t, n) in fake.written if t == "org"]
    # Must NOT include the domain.
    assert "github.com" not in [n.lower() for n in org_names], (
        f"materialize wrote a domain-only org: {org_names}"
    )
    # MUST include the facts-grounded real company.
    assert any("neoterra" in n.lower() for n in org_names), (
        f"materialize dropped NeoTerra; got: {org_names}"
    )
