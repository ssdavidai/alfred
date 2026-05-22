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

from src.activities.packs_opus import (
    _parse_entity_wikilink,
    materialize_matter_entities,
)


class _FakeVaultClient:
    def __init__(self, matters, existing=None) -> None:
        self._matters = matters
        self.existing = existing or set()
        self.written: list = []
        self.patched: list = []

    async def list_records(self, record_type: str, **kw: Any):
        return self._matters if record_type == "matter" else []

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
