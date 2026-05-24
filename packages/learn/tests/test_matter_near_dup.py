"""Matter near-dup slug dedup — live 2026-05-23: a packs-stage re-run
produced 9 → 18 matters because record_exists("matter", slug) only
matches EXACT slugs and the Opus prompt's matter names drift slightly
on each call. Concrete drift seen in vault:

  * 'NeoTerra / NTP client delivery'      vs 'NeoTerra/NTP client delivery'
  * 'Hungarian company and administration obligations'
                                          vs '... and personal administration'
  * 'Training and health optimization'    vs 'Training, Muay Thai, and ...'

Fix is a token-set overlap-coefficient check (≥ 0.7) layered on top of
the existing exact-slug check, computed against the existing matter
records' ``name`` fields.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities.packs_opus import (
    _MATTER_DEDUP_OVERLAP_THRESHOLD,
    _matter_near_dup_slug,
    generate_matter_pack_opus,
)


def test_threshold_is_documented_constant():
    assert _MATTER_DEDUP_OVERLAP_THRESHOLD == pytest.approx(0.7)


@pytest.mark.parametrize("candidate,existing,expect_hit", [
    # Exact-modulo-whitespace (NeoTerra — overlap = 1.0).
    ("NeoTerra / NTP client delivery", "NeoTerra/NTP client delivery", True),
    # Half-shared (Hungarian admin — overlap = 0.8).
    ("Hungarian company and administration obligations",
     "Hungarian company and personal administration", True),
    # Training + health + optimization shared (overlap = 1.0).
    ("Training and health optimization",
     "Training, Muay Thai, and health optimization", True),
    # Törökbálint / Young family / Alfred — all 0.8+.
    ("Törökbálint home infrastructure",
     "Törökbálint home works and household infrastructure", True),
    ("Young family and screenless household",
     "Young family, screens, and household attention", True),
    ("Alfred and Lumberjack operating system",
     "Alfred product and operating system", True),
    # Unrelated — overlap ≈ 0.
    ("Alfred product roadmap", "Hungarian administration", False),
    ("Robin nursery logistics", "Stripe weekly billing review", False),
])
def test_matter_near_dup_slug_pairs(candidate, existing, expect_hit):
    hit = _matter_near_dup_slug(candidate, [existing])
    assert (hit == existing) is expect_hit, (candidate, existing, hit)


def test_returns_first_match_when_multiple_and_handles_empty():
    assert _matter_near_dup_slug("Foo bar baz", []) is None
    existing = ["NeoTerra/NTP client delivery", "Stripe weekly review"]
    assert _matter_near_dup_slug(
        "NeoTerra / NTP client delivery", existing,
    ) == "NeoTerra/NTP client delivery"


def test_case_and_punctuation_insensitive():
    assert _matter_near_dup_slug(
        "NEOTERRA / NTP CLIENT DELIVERY!!!",
        ["neoterra/ntp client delivery"],
    ) == "neoterra/ntp client delivery"


# ---------------------------------------------------------------------------
# Integration — generate_matter_pack_opus uses the helper to skip writes.
# ---------------------------------------------------------------------------

_OPUS_TWO_NEAR_DUPS = json.dumps({
    "matters": [
        {
            "name": "NeoTerra / NTP client delivery",
            "category": "work", "status": "active",
            "description": "NeoTerra Property Group NTP client delivery.",
            "context": ("NeoTerra is Sir's largest client. The NTP work spans "
                        "delivery, billing, and weekly status syncs across the "
                        "rest of the quarter."),
            "open_questions": ["Q2 invoice"],
            "suggested_next_actions": ["Send weekly status"],
        },
        {
            "name": "Training and health optimization",
            "category": "personal", "status": "active",
            "description": "Strength + Muay Thai + recovery tracking.",
            "context": ("Sir runs a steady strength cadence plus Muay Thai. "
                        "Recovery and sleep are load-bearing for staying sharp "
                        "across long product weeks."),
            "open_questions": ["weekly volume"],
            "suggested_next_actions": ["log sessions"],
        },
    ],
})


class _FakeMatterClient:
    """VaultClient stand-in: exact-slug record_exists + list_records."""

    def __init__(self, existing):
        self.existing = existing
        self.written: list[tuple[str, str, str]] = []

    async def record_exists(self, rt, slug):
        return rt == "matter" and any(m.get("slug") == slug for m in self.existing)

    async def list_records(self, rt, **_):
        return list(self.existing) if rt == "matter" else []

    async def write_record(self, rt, slug, content):
        self.written.append((rt, slug, content))

    async def close(self): pass


def _run(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_t_near_dup")
    async def _w() -> dict:
        return await coro_factory()

    return asyncio.run(env.run(_w))


def _write_onboard(tmp_path: Path) -> str:
    p = tmp_path / "onboard.json"
    p.write_text(json.dumps({
        "facts": [{"category": "work", "fact": "NeoTerra is the client.",
                   "confidence": "high"}],
        "patterns": [{"name": "weekly", "description": "Friday status"}],
        "profile": {"summary": {}}, "key_identity_facts": [],
        "brief": "watching NeoTerra weekly",
    }))
    return str(p)


@pytest.mark.parametrize("existing_pair", [
    # Near-dup names (different slugs) — both must be skipped by the
    # token-set overlap check.
    [{"slug": "neoterrantp-client-delivery",
      "name": "NeoTerra/NTP client delivery"},
     {"slug": "training-muay-thai-and-health-optimization",
      "name": "Training, Muay Thai, and health optimization"}],
    # Exact slug match — record_exists fast-paths, never reaches Jaccard.
    [{"slug": "neoterra-ntp-client-delivery",
      "name": "NeoTerra / NTP client delivery"},
     {"slug": "training-and-health-optimization",
      "name": "Training and health optimization"}],
])
def test_rerun_skips_near_dup_matters(tmp_path, monkeypatch, existing_pair):
    monkeypatch.delenv("ALFRED_OPUS_PACKS_ENABLED", raising=False)
    fake = _FakeMatterClient(existing_pair)
    with patch("src.activities.packs_opus._call_llm",
               new=AsyncMock(return_value=_OPUS_TWO_NEAR_DUPS)), \
         patch("src.activities.packs_opus.VaultClient", return_value=fake):
        result = _run(lambda: generate_matter_pack_opus(_write_onboard(tmp_path)))

    assert result["created"] == 0, (result, fake.written)
    assert result["skipped_existing"] == 2, result
    assert fake.written == [], fake.written
