"""B9 — onboarding seeds an enriched, interlinked vault knowledge graph.

Two passes expand the F36 ``materialize_matter_entities`` stage:

- **Pass A** upgrades the bare matter-entity stub into a curator-schema
  record (description from the fact-substring + matter context, ``aliases``,
  ``org`` link, ``role``, ``person.base`` body embeds), idempotently — a
  pre-existing curator body is NEVER clobbered, only ``related`` is unioned.
- **Pass B** makes one batched workers-profile LLM call over
  ``onboard["facts"]`` that emits CANONICAL ``person``/``org``/``place``
  records (never ``project``/``location``/``observation``) with descriptions
  + person→org ties, for entities not already recorded.

Casing/dedup: ``"RJ Johnson"`` and ``"rj johnson"`` resolve to the same
``person/RJ Johnson.md``.
"""
from __future__ import annotations

import json
from typing import Any

import pytest

from src.activities.packs_opus import (
    _normalize_entity_name,
    _parse_entity_wikilink,
    _facts_mentioning,
    _union_related,
    materialize_matter_entities,
)


# ---------------------------------------------------------------------------
# Fake VaultClient — models the real ctrl-api list/exists/patch contract.
# ---------------------------------------------------------------------------

class _FakeVaultClient:
    """A fake that tracks records by ``<type>/<Name>.md`` path.

    ``record_exists`` and ``list_records`` mirror the real client: the
    typed listing returns ``{path, name, frontmatter}`` and existence is an
    exact path/slug match. ``patch_frontmatter_structured`` records the
    json_updates so tests can assert the backlink-union behaviour.
    """

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


def _install(monkeypatch, fake: _FakeVaultClient, llm=None,
             facts=None, kg_seed: str | None = None):
    """Wire the fake client + config + (optional) LLM and onboard.json."""
    monkeypatch.setattr(
        "src.activities.packs_opus.VaultClient", lambda *_a, **_k: fake)
    import src.config as cfg
    monkeypatch.setattr(
        cfg, "load_config",
        lambda: type("C", (), {"alfred_ctrl_url": "http://ctrl-test:3100"})())
    monkeypatch.setattr(
        "src.activities.packs_opus.load_config",
        lambda: type("C", (), {"alfred_ctrl_url": "http://ctrl-test:3100"})())
    # onboard.json reader → return facts (Pass B input).
    monkeypatch.setattr(
        "src.activities.packs_opus._read_onboard_json",
        lambda _p: {"facts": facts or []})
    if kg_seed is None:
        monkeypatch.delenv("ONBOARDING_KG_SEED", raising=False)
    else:
        monkeypatch.setenv("ONBOARDING_KG_SEED", kg_seed)
    # Pass B LLM: either a stub returning a JSON string, or one that raises.
    if llm is not None:
        monkeypatch.setattr("src.activities.packs_opus._call_clerk", llm)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def test_normalize_entity_name_title_cases():
    assert _normalize_entity_name("rj johnson") == "Rj Johnson"
    assert _normalize_entity_name("RJ Johnson") == "RJ Johnson"  # preserve caps
    # Both forms collapse to the same casefold key for dedup.
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


# ---------------------------------------------------------------------------
# Pass A — enrich matter-entity stubs
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_passA_enriches_stub_with_description_and_curator_fields(monkeypatch):
    """A missing matter-named person becomes an enriched curator-schema record:
    a real description (from the fact-substring + matter context) + base embed,
    NOT a bare 'Alfred will enrich this later' stub."""
    fake = _FakeVaultClient([
        _matter("acme-deal", ["[[person/Rami Khouri]]"],
                context="Negotiating the Acme partnership.")
    ])
    facts = [{"fact": "Rami Khouri is the co-founder of Acme Co and leads BD."}]
    _install(monkeypatch, fake, facts=facts, kg_seed="false")  # Pass B off

    result = await materialize_matter_entities("/tmp/onboard.json")

    person = [c for c in fake.written if c[1] == "Rami Khouri"][0]
    body = person[2]
    # Curator-schema frontmatter
    assert "type: person" in body
    assert "aliases:" in body
    assert "description:" in body
    # Real description derived from the fact substring (not the bare stub text)
    assert "Alfred will enrich this with context as it learns more" not in body
    assert "Rami Khouri" in body and "Acme" in body
    # Curator body embed so the dashboard base views work + curator adopts it
    assert "![[person.base#" in body
    # Matter backlink in related
    assert "[[matter/acme-deal]]" in body
    assert result["created"] >= 1


def test_union_related_preserves_existing_and_dedups():
    # ctrl json_set REPLACES, so the union must happen client-side.
    assert _union_related(["[[org/Foo]]"], ["[[matter/deal]]"]) == [
        "[[org/Foo]]", "[[matter/deal]]"]
    # No duplicate when the link is already present (casefold).
    assert _union_related(["[[matter/Deal]]"], ["[[matter/deal]]"]) == [
        "[[matter/Deal]]"]
    # Scalar existing value is tolerated.
    assert _union_related("[[org/Foo]]", ["[[matter/deal]]"]) == [
        "[[org/Foo]]", "[[matter/deal]]"]
    assert _union_related(None, ["[[matter/deal]]"]) == ["[[matter/deal]]"]


@pytest.mark.asyncio
async def test_passA_does_not_clobber_existing_curator_body(monkeypatch):
    """A pre-existing (curator-authored) record body is NEVER overwritten —
    only its ``related`` is unioned with the matter backlink via a patch, and
    the existing related entries SURVIVE (not replaced)."""
    fake = _FakeVaultClient(
        [_matter("acme-deal", ["[[person/Zsolt Rapali]]"])],
        records={"person": {"Zsolt Rapali": {
            "frontmatter": {"name": "Zsolt Rapali", "related": ["[[org/Foo]]"]},
            "body": "CURATOR AUTHORED — do not touch",
        }}},
    )
    _install(monkeypatch, fake, facts=[], kg_seed="false")

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
    """When the matter also wikilinks an org, an enriched new person record
    carries an ``org: "[[org/<Name>]]"`` tie so person→org edges resolve."""
    fake = _FakeVaultClient([
        _matter("acme-deal", ["[[person/Rami Khouri]]"], orgs=["[[org/Acme Co]]"],
                context="Rami Khouri runs Acme Co.")
    ])
    facts = [{"fact": "Rami Khouri is the founder of Acme Co."}]
    _install(monkeypatch, fake, facts=facts, kg_seed="false")

    await materialize_matter_entities("/tmp/onboard.json")
    person = [c for c in fake.written if c[1] == "Rami Khouri"][0]
    assert "org: '[[org/Acme Co]]'" in person[2] or 'org: "[[org/Acme Co]]"' in person[2] \
        or "[[org/Acme Co]]" in person[2]


# ---------------------------------------------------------------------------
# Pass B — seed the rest of the fact corpus
# ---------------------------------------------------------------------------

def _llm_returning(payload: dict):
    async def _stub(prompt, *a, **k):
        return json.dumps(payload)
    return _stub


@pytest.mark.asyncio
async def test_passB_seeds_canonical_person_and_org(monkeypatch):
    """Facts → canonical person/org records with person→org ties; existing
    records are skipped; only person/org/place are ever written."""
    fake = _FakeVaultClient(matters=[])
    facts = [
        {"fact": "Miguel Ortiz is the user's accountant at Ortiz & Co."},
        {"fact": "The user banks with Acme Bank."},
    ]
    llm = _llm_returning({"entities": [
        {"type": "person", "name": "Miguel Ortiz",
         "description": "The user's accountant.", "org": "Ortiz & Co",
         "role": "Accountant"},
        {"type": "org", "name": "Ortiz & Co", "description": "Accounting firm."},
        {"type": "org", "name": "Acme Bank", "description": "The user's bank."},
    ]})
    _install(monkeypatch, fake, llm=llm, facts=facts, kg_seed="true")

    result = await materialize_matter_entities("/tmp/onboard.json")

    written = {(t, n) for (t, n, _) in fake.written}
    assert ("person", "Miguel Ortiz") in written
    assert ("org", "Ortiz & Co") in written
    assert ("org", "Acme Bank") in written
    # person→org tie present.
    person = [c for c in fake.written if c[1] == "Miguel Ortiz"][0]
    assert "[[org/Ortiz & Co]]" in person[2]
    assert result.get("seeded", 0) >= 3


@pytest.mark.asyncio
async def test_passB_never_emits_noncanonical_type(monkeypatch):
    """An LLM that returns project/location/observation must be filtered:
    only canonical person/org/place get written."""
    fake = _FakeVaultClient(matters=[])
    facts = [{"fact": "Works on the Phoenix project in Berlin."}]
    llm = _llm_returning({"entities": [
        {"type": "project", "name": "Phoenix", "description": "A project."},
        {"type": "location", "name": "Berlin", "description": "A city."},
        {"type": "observation", "name": "Nope", "description": "demoted."},
        {"type": "place", "name": "Berlin Office", "description": "HQ."},
    ]})
    _install(monkeypatch, fake, llm=llm, facts=facts, kg_seed="true")

    await materialize_matter_entities("/tmp/onboard.json")
    types = {t for (t, _, _) in fake.written}
    assert "project" not in types
    assert "location" not in types
    assert "observation" not in types
    # The canonical place survives.
    assert ("place", "Berlin Office") in {(t, n) for (t, n, _) in fake.written}


@pytest.mark.asyncio
async def test_passB_skips_existing_records(monkeypatch):
    """An entity that already has a record is not re-created in Pass B."""
    fake = _FakeVaultClient(
        matters=[],
        records={"person": {"Miguel Ortiz": {
            "frontmatter": {"name": "Miguel Ortiz"}, "body": "existing"}}},
    )
    facts = [{"fact": "Miguel Ortiz is the accountant."}]
    llm = _llm_returning({"entities": [
        {"type": "person", "name": "Miguel Ortiz", "description": "Accountant."},
    ]})
    _install(monkeypatch, fake, llm=llm, facts=facts, kg_seed="true")

    await materialize_matter_entities("/tmp/onboard.json")
    assert all(n != "Miguel Ortiz" for (_, n, _) in fake.written)


@pytest.mark.asyncio
async def test_passB_disabled_by_flag(monkeypatch):
    """ONBOARDING_KG_SEED=false → no Pass B LLM call, no corpus seeding."""
    fake = _FakeVaultClient(matters=[])
    facts = [{"fact": "Miguel Ortiz is the accountant."}]
    called = {"n": 0}

    async def _llm(prompt, *a, **k):
        called["n"] += 1
        return json.dumps({"entities": [
            {"type": "person", "name": "Miguel Ortiz", "description": "x"}]})

    _install(monkeypatch, fake, llm=_llm, facts=facts, kg_seed="false")
    result = await materialize_matter_entities("/tmp/onboard.json")
    assert called["n"] == 0
    assert result.get("seeded", 0) == 0


@pytest.mark.asyncio
async def test_passB_llm_failure_does_not_crash(monkeypatch):
    """A Pass B LLM error must degrade gracefully — never crash the activity.
    Pass A's deterministic work must still complete."""
    fake = _FakeVaultClient([
        _matter("deal", ["[[person/Rami Khouri]]"], context="A deal."),
    ])
    facts = [{"fact": "Rami Khouri is involved."}]

    async def _boom(prompt, *a, **k):
        raise RuntimeError("workers gateway 402")

    _install(monkeypatch, fake, llm=_boom, facts=facts, kg_seed="true")
    result = await materialize_matter_entities("/tmp/onboard.json")
    # Pass A still ran (the matter-named person got a record).
    assert any(n == "Rami Khouri" for (_, n, _) in fake.written)
    # Pass B no-op'd cleanly.
    assert result.get("seeded", 0) == 0


@pytest.mark.asyncio
async def test_passB_caps_entities(monkeypatch):
    """A runaway corpus is bounded by the entity cap."""
    fake = _FakeVaultClient(matters=[])
    facts = [{"fact": f"Person{i} exists."} for i in range(200)]
    entities = [{"type": "person", "name": f"Person{i}",
                 "description": f"d{i}."} for i in range(200)]
    _install(monkeypatch, fake, llm=_llm_returning({"entities": entities}),
             facts=facts, kg_seed="true")
    monkeypatch.setenv("ONBOARDING_KG_SEED_CAP", "10")

    await materialize_matter_entities("/tmp/onboard.json")
    assert len(fake.written) <= 10


# ---------------------------------------------------------------------------
# Casing / dedup
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_casing_dedup_against_existing_record(monkeypatch):
    """An existing 'RJ Johnson' record means a Pass B 'rj johnson' entity must
    NOT create a duplicate — casefold existence check unifies them."""
    fake = _FakeVaultClient(
        matters=[],
        records={"person": {"RJ Johnson": {
            "frontmatter": {"name": "RJ Johnson"}, "body": "existing"}}},
    )
    facts = [{"fact": "rj johnson is a contact."}]
    llm = _llm_returning({"entities": [
        {"type": "person", "name": "rj johnson", "description": "A contact."},
    ]})
    _install(monkeypatch, fake, llm=llm, facts=facts, kg_seed="true")

    await materialize_matter_entities("/tmp/onboard.json")
    # No new RJ Johnson / rj johnson record created.
    assert all(t != "person" or n.casefold() != "rj johnson"
               for (t, n, _) in fake.written)
