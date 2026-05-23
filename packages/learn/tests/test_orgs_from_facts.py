"""Gap 3 — deterministic facts → org extraction (no LLM, no timeout).

Live 2026-05-23: Pass B (LLM) hit StartToClose at 180s; org count = 0
despite 1635 facts naming NeoTerra/Stylers/Wise/Mercury/Gránit Bank/
Ugly Code LLC/Szabó-Stubán Kft. Pass A.5 runs BEFORE Pass B so orgs
materialise even when the LLM times out.
"""
from __future__ import annotations

import asyncio
from unittest.mock import patch as _patch

import pytest
from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities.packs_opus import _extract_org_candidates_from_facts


def _names(*facts: str) -> list[str]:
    return [c["name"] for c in _extract_org_candidates_from_facts(
        [{"fact": f} for f in facts])]


@pytest.mark.parametrize("fact,must_contain", [
    ("NeoTerra Property Group is a client.", ["NeoTerra Property Group"]),
    ("Wise Business and Gránit Bank are banks.",
     ["Wise Business", "Gránit Bank"]),
    # Unicode-safe — sister to Lane I b8d3830.
    ("Szabó-Stubán Kft is the Hungarian entity.", ["Szabó-Stubán Kft"]),
    ("Ugly Code LLC, registered through Firstbase.", ["Ugly Code LLC"]),
])
def test_extracts_expected_orgs(fact, must_contain):
    n = _names(fact)
    for e in must_contain:
        assert e in n, (e, n)


def test_does_not_return_pure_domain_mentions():
    n = _names("github.com sent a notification.")
    assert "github.com" not in [x.lower() for x in n], n


def test_dedupes_repeated_mentions():
    n = _names(*["NeoTerra Property Group is real."] * 5)
    assert len([x for x in n if "NeoTerra" in x]) == 1, n


def test_empty_or_blank_facts_returns_empty():
    assert _extract_org_candidates_from_facts([]) == [] \
        == _extract_org_candidates_from_facts([{"fact": ""}])


def test_materialize_writes_orgs_when_pass_b_times_out():
    """E2E: matters have no related_orgs; facts name 5 orgs; Pass B
    raises TimeoutError. Pass A.5 materialises ≥ 4 anyway."""
    from src.activities.packs_opus import materialize_matter_entities

    matters = [{"path": "matter/x.md",
                "frontmatter": {"related_persons": [], "related_orgs": []}}]
    onboard = {"facts": [{"fact": t} for t in (
        "NeoTerra Property Group is the client.",
        "Stylers Group owns the pipeline.",
        "Wise Business and Mercury are the corporate banks.",
        "Gránit Bank handles the forint accounts.",
        "Revolut Business funds day-to-day expenses.",
    )]}

    class _F:
        def __init__(self): self.w: list[tuple[str, str]] = []
        async def list_records(self, t, **_k):
            return matters if t == "matter" else []
        async def record_exists(self, *_a, **_k): return False
        async def write_record(self, t, n, _c):
            self.w.append((t, n)); return f"{t}/{n}.md"
        async def patch_frontmatter_structured(self, *_a, **_k): pass
        async def close(self): pass

    fake = _F()

    async def _llm_timeout(*_a, **_k):
        raise asyncio.TimeoutError("simulated 180s StartToClose")

    import src.activities.packs_opus as po
    import src.config as cfg

    env = ActivityEnvironment()

    @activity.defn(name="_t_orgs_facts")
    async def _w() -> dict:
        return await materialize_matter_entities("/tmp/onboard.json")

    with _patch.object(po, "VaultClient", lambda *_a, **_k: fake), \
         _patch.object(po, "_read_onboard_json", lambda _p: onboard), \
         _patch.object(po, "_call_llm", _llm_timeout), \
         _patch.object(cfg, "load_config",
                       lambda: type("C", (), {"alfred_ctrl_url": "http://t"})()):
        asyncio.run(env.run(_w))

    orgs = [n.lower() for (t, n) in fake.w if t == "org"]
    hits = sum(1 for k in ("neoterra", "stylers", "wise", "mercury", "gránit")
               if any(k in n for n in orgs))
    assert hits >= 4, (hits, orgs)
