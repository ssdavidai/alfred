"""F36 (deterministic part) — onboarding materialises entity stubs +
backlinks for matter-named people/orgs.

F37 made the matter emit [[person/Name]] wikilinks; this post-pack stage
creates the *target* records (a minimal stub for any wikilink with no
record — a real graph node the curator enriches in Wave-5) and backlinks
the matter onto the entity's ``related``. Deterministic; no LLM.
"""
from __future__ import annotations

from typing import Any

import pytest
from temporalio.testing import ActivityEnvironment

from src.activities.packs_opus import (
    _parse_entity_wikilink,
    materialize_matter_entities,
)


async def _run_materialize(path: str = "/tmp/onboard.json"):
    """Run the activity inside an ActivityEnvironment so activity.heartbeat
    has a context (the real worker provides one)."""
    return await ActivityEnvironment().run(materialize_matter_entities, path)


class _FakeVaultClient:
    def __init__(self, matters, existing=None) -> None:
        self._matters = matters
        self.existing = existing or set()
        self.written: list = []
        self.patched: list = []

    async def list_records(self, record_type: str, **kw: Any):
        if record_type == "matter":
            return self._matters
        # Surface the existing entities as a typed listing, the way the real
        # ctrl-api does — B9's seeder caches this listing for existence checks.
        return [
            {"path": f"{t}/{n}.md", "name": n, "frontmatter": {"name": n}}
            for (t, n) in self.existing if t == record_type
        ]

    async def record_exists(self, record_type: str, slug: str) -> bool:
        return (record_type, slug) in self.existing

    async def write_record(self, record_type: str, name: str, content: str) -> str:
        self.written.append((record_type, name, content))
        self.existing.add((record_type, name))
        return f"{record_type}/{name}.md"

    async def patch_frontmatter_structured(self, path, scalar_updates=None,
                                           json_updates=None):
        self.patched.append((path, json_updates or {}))

    async def close(self):
        pass


def _matter(slug: str, persons: list[str], orgs: list[str] | None = None):
    return {"path": f"matter/{slug}.md", "frontmatter": {
        "related_persons": persons, "related_orgs": orgs or []}}


def _install(monkeypatch, fake: _FakeVaultClient):
    monkeypatch.setattr(
        "src.activities.packs_opus.VaultClient", lambda *_a, **_k: fake)
    import src.config as cfg
    monkeypatch.setattr(
        cfg, "load_config",
        lambda: type("C", (), {"alfred_ctrl_url": "http://ctrl-test:3100"})())


def test_parse_entity_wikilink():
    assert _parse_entity_wikilink("[[person/RJ Johnson]]") == ("person", "RJ Johnson")
    assert _parse_entity_wikilink("[[org/Acme Co]]") == ("org", "Acme Co")
    assert _parse_entity_wikilink("plain text") is None
    assert _parse_entity_wikilink("[[matter/x]]") is None  # only person/org


@pytest.mark.asyncio
async def test_creates_stubs_for_missing_person_and_org(monkeypatch):
    fake = _FakeVaultClient(
        [_matter("deal", ["[[person/Rami Khouri]]"], orgs=["[[org/Acme Co]]"])]
    )
    _install(monkeypatch, fake)
    result = await materialize_matter_entities("/tmp/onboard.json")
    written = [(t, n) for (t, n, _) in fake.written]
    assert ("person", "Rami Khouri") in written
    assert ("org", "Acme Co") in written
    assert result["created"] == 2
    # A new stub embeds the matter backlink in its related: frontmatter.
    person = [c for c in fake.written if c[1] == "Rami Khouri"][0]
    assert "[[matter/deal]]" in person[2]


@pytest.mark.asyncio
async def test_existing_entity_skipped_and_backlinked_via_patch(monkeypatch):
    fake = _FakeVaultClient(
        [_matter("deal", ["[[person/Zsolt Rapali]]"])],
        existing={("person", "Zsolt Rapali")},
    )
    _install(monkeypatch, fake)
    result = await materialize_matter_entities("/tmp/onboard.json")
    assert not fake.written  # already exists → no stub
    assert result["created"] == 0
    # ...but it still gets the backlink via a frontmatter patch.
    patches = [p for p in fake.patched if "person/Zsolt Rapali" in p[0]]
    assert patches and "[[matter/deal]]" in (patches[0][1].get("related") or [])


# ---------------------------------------------------------------------------
# B9 org-seeding gap (live): onboarding materialised 20 person but 0 org
# records. The cause: when a person carries an `org` tie (Pass A's
# matter org link, or Pass B's `org` field) but the org is never listed as a
# standalone entity, no org/<Name>.md record was ever created — only a
# dangling [[org/Name]] wikilink on the person. Fix: materialise the org
# symmetrically wherever a person→org tie names it.
# ---------------------------------------------------------------------------


def _install_passB(monkeypatch, fake, facts, entities):
    """Wire Pass B: facts present + a mocked _call_llm returning entities."""
    _install(monkeypatch, fake)
    monkeypatch.setattr(
        "src.activities.packs_opus._read_onboard_json",
        lambda _p: {"facts": facts},
    )

    async def fake_llm(prompt, max_tokens=8192, heartbeat_message=""):
        import json
        return json.dumps({"entities": entities})

    monkeypatch.setattr("src.activities.packs_opus._call_llm", fake_llm)
    monkeypatch.setenv("ONBOARDING_KG_SEED", "true")


@pytest.mark.asyncio
async def test_passB_person_org_tie_materialises_the_org(monkeypatch):
    """A person with org='NeoTerra' but NO standalone org entity must still
    yield an org/NeoTerra record — not just a dangling wikilink."""
    fake = _FakeVaultClient([])
    _install_passB(
        monkeypatch, fake,
        facts=[{"fact": "Works with NeoTerra on the grid project."}],
        entities=[{"type": "person", "name": "Dana Reyes",
                   "description": "Lead engineer.", "org": "NeoTerra"}],
    )
    await _run_materialize()
    written = [(t, n) for (t, n, _) in fake.written]
    assert ("person", "Dana Reyes") in written
    assert ("org", "NeoTerra") in written, (
        f"org tie must materialise an org record; got {written}"
    )


@pytest.mark.asyncio
async def test_passA_person_org_tie_materialises_the_org(monkeypatch):
    """Pass A: a matter naming a person AND an org ties the person to that
    org. The org must become a record, not only the person."""
    fake = _FakeVaultClient(
        [_matter("acq", ["[[person/Sam Vale]]"], orgs=["[[org/Banco Real]]"])]
    )
    _install(monkeypatch, fake)
    await _run_materialize()
    written = [(t, n) for (t, n, _) in fake.written]
    assert ("person", "Sam Vale") in written
    assert ("org", "Banco Real") in written
