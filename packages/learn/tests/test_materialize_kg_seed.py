"""B9 (Pass A) — onboarding enriches matter-entity stubs into curator-schema
records, idempotently.

The F36 stage materialised bare stubs ("Alfred will enrich this later"). Pass A
upgrades each matter-named entity into a real curator-schema record (description
from the fact-substring + matter context, ``aliases``, ``org`` tie, ``role``,
``person.base`` body embeds), so it is interchangeable with a curator-authored
record. Idempotent: a pre-existing curator body is NEVER clobbered — only
``related`` is UNIONED (ctrl json_set replaces, so the union is client-side).

(Pass B — LLM corpus seeding — is covered in a follow-up commit.)
"""
from __future__ import annotations

from typing import Any

import pytest

from src.activities.packs_opus import (
    _facts_mentioning,
    _normalize_entity_name,
    _parse_entity_wikilink,
    _union_related,
    materialize_matter_entities,
)


# ---------------------------------------------------------------------------
# Fake VaultClient — models the real ctrl-api list/exists/patch contract.
# ---------------------------------------------------------------------------

class _FakeVaultClient:
    def __init__(self, matters=None, records=None) -> None:
        # records: {type: {Name: {"frontmatter": {...}, "body": "..."}}}
        self._matters = matters or []
        self._records: dict[str, dict[str, dict]] = records or {}
        self.written: list[tuple[str, str, str]] = []
        self.patched: list[tuple[str, dict]] = []

    async def list_records(self, record_type: str, **kw: Any):
        if record_type == "matter":
            return self._matters
        recs = self._records.get(record_type, {})
        return [
            {
                "path": f"{record_type}/{name}.md",
                "name": rec.get("frontmatter", {}).get("name", name),
                "frontmatter": rec.get("frontmatter", {}),
            }
            for name, rec in recs.items()
        ]

    async def record_exists(self, record_type: str, slug: str) -> bool:
        recs = self._records.get(record_type, {})
        target = f"{record_type}/{slug}.md"
        for name, rec in recs.items():
            if name == slug or f"{record_type}/{name}.md" == target:
                return True
        return False

    async def write_record(self, record_type: str, name: str, content: str) -> str:
        self.written.append((record_type, name, content))
        self._records.setdefault(record_type, {})[name] = {
            "frontmatter": {"name": name}, "body": content,
        }
        return f"{record_type}/{name}.md"

    async def patch_frontmatter_structured(self, path, scalar_updates=None,
                                           json_updates=None):
        self.patched.append((path, json_updates or {}))

    async def close(self):
        pass


def _matter(slug: str, persons: list[str], orgs: list[str] | None = None,
            context: str = "", name: str = ""):
    return {"path": f"matter/{slug}.md", "frontmatter": {
        "name": name or slug,
        "context": context,
        "description": context,
        "related_persons": persons,
        "related_orgs": orgs or [],
    }}


def _install(monkeypatch, fake: _FakeVaultClient, facts=None):
    monkeypatch.setattr(
        "src.activities.packs_opus.VaultClient", lambda *_a, **_k: fake)
    monkeypatch.setattr(
        "src.activities.packs_opus.load_config",
        lambda: type("C", (), {"alfred_ctrl_url": "http://ctrl-test:3100"})())
    monkeypatch.setattr(
        "src.activities.packs_opus._read_onboard_json",
        lambda _p: {"facts": facts or []})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def test_normalize_entity_name_title_cases():
    assert _normalize_entity_name("rj johnson") == "Rj Johnson"
    assert _normalize_entity_name("RJ Johnson") == "RJ Johnson"  # preserve caps
    assert (_normalize_entity_name("rj johnson").casefold()
            == _normalize_entity_name("RJ JOHNSON").casefold())


def test_parse_entity_wikilink_still_works():
    assert _parse_entity_wikilink("[[person/Rami Khouri]]") == ("person", "Rami Khouri")
    assert _parse_entity_wikilink("[[org/Acme Co]]") == ("org", "Acme Co")
    assert _parse_entity_wikilink("plain") is None


def test_facts_mentioning_substring():
    facts = [
        {"fact": "Rami Khouri is a co-founder at Acme Co"},
        {"fact": "Trains Muay Thai weekly"},
        {"fact": "Met with rami khouri about the deal"},
    ]
    hits = _facts_mentioning(facts, "Rami Khouri")
    assert len(hits) == 2  # case-insensitive substring
    assert "Muay Thai" not in " ".join(hits)


def test_union_related_preserves_existing_and_dedups():
    # ctrl json_set REPLACES, so the union must happen client-side.
    assert _union_related(["[[org/Foo]]"], ["[[matter/deal]]"]) == [
        "[[org/Foo]]", "[[matter/deal]]"]
    assert _union_related(["[[matter/Deal]]"], ["[[matter/deal]]"]) == [
        "[[matter/Deal]]"]
    assert _union_related("[[org/Foo]]", ["[[matter/deal]]"]) == [
        "[[org/Foo]]", "[[matter/deal]]"]
    assert _union_related(None, ["[[matter/deal]]"]) == ["[[matter/deal]]"]


# ---------------------------------------------------------------------------
# Pass A — enrich matter-entity stubs
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_passA_enriches_stub_with_description_and_curator_fields(monkeypatch):
    fake = _FakeVaultClient([
        _matter("acme-deal", ["[[person/Rami Khouri]]"],
                context="Negotiating the Acme partnership.")
    ])
    facts = [{"fact": "Rami Khouri is the co-founder of Acme Co and leads BD."}]
    _install(monkeypatch, fake, facts=facts)

    result = await materialize_matter_entities("/tmp/onboard.json")

    person = [c for c in fake.written if c[1] == "Rami Khouri"][0]
    body = person[2]
    assert "type: person" in body
    assert "aliases:" in body
    assert "description:" in body
    assert "Alfred will enrich this with context as it learns more" not in body
    assert "Rami Khouri" in body and "Acme" in body
    assert "![[person.base#" in body
    assert "[[matter/acme-deal]]" in body
    assert result["created"] >= 1


@pytest.mark.asyncio
async def test_passA_does_not_clobber_existing_curator_body(monkeypatch):
    fake = _FakeVaultClient(
        [_matter("acme-deal", ["[[person/Zsolt Rapali]]"])],
        records={"person": {"Zsolt Rapali": {
            "frontmatter": {"name": "Zsolt Rapali", "related": ["[[org/Foo]]"]},
            "body": "CURATOR AUTHORED — do not touch",
        }}},
    )
    _install(monkeypatch, fake, facts=[])

    result = await materialize_matter_entities("/tmp/onboard.json")

    # No write_record for an existing entity → body preserved.
    assert all(n != "Zsolt Rapali" for (_, n, _) in fake.written)
    assert result["created"] == 0
    # Backlink applied via patch with the existing link UNIONED, not replaced.
    patches = [p for p in fake.patched if "person/Zsolt Rapali" in p[0]]
    assert patches
    related = patches[0][1].get("related") or []
    assert "[[matter/acme-deal]]" in related
    assert "[[org/Foo]]" in related  # the curator's existing link survives


@pytest.mark.asyncio
async def test_passA_person_org_tie_when_org_known(monkeypatch):
    fake = _FakeVaultClient([
        _matter("acme-deal", ["[[person/Rami Khouri]]"], orgs=["[[org/Acme Co]]"],
                context="Rami Khouri runs Acme Co.")
    ])
    facts = [{"fact": "Rami Khouri is the founder of Acme Co."}]
    _install(monkeypatch, fake, facts=facts)

    await materialize_matter_entities("/tmp/onboard.json")
    person = [c for c in fake.written if c[1] == "Rami Khouri"][0]
    assert "[[org/Acme Co]]" in person[2]


@pytest.mark.asyncio
async def test_passA_idempotent_existing_entity_only_relinks(monkeypatch):
    """Casefold existence: an existing 'RJ Johnson' is recognised even when
    the matter wikilink target is lowercase — no duplicate, only a relink."""
    fake = _FakeVaultClient(
        [_matter("deal", ["[[person/rj johnson]]"])],
        records={"person": {"RJ Johnson": {
            "frontmatter": {"name": "RJ Johnson"}, "body": "existing"}}},
    )
    _install(monkeypatch, fake, facts=[])
    result = await materialize_matter_entities("/tmp/onboard.json")
    assert all(t != "person" or n.casefold() != "rj johnson"
               for (t, n, _) in fake.written)
    assert result["created"] == 0
