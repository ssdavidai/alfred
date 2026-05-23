"""Tests for C-OB3 ``seed_day_one_desk_cards`` (Commit 3, Lane II).

Activity reads matters from /vault, ranks by time-anchor closeness in
the body, writes 2-3 needs_attention cards for the most time-critical
matters. Idempotent via ``onboard["day_one_desk_seeded"]``.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities.desk_seed import (
    _extract_first_suggested_actions,
    _find_time_anchor,
    _rank_matters_by_time_anchor,
    seed_day_one_desk_cards,
)


def _run_activity(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_test_wrapper")
    async def _wrapper() -> dict:
        return await coro_factory()

    return asyncio.run(env.run(_wrapper))


# Phase 0 golden fixture mirror: Kondorosi (next Wednesday → rank 0),
# Founder (May 30 / Q3 2026 → rank 1), NeoTerra (vague — dropped).
_KONDOROSI_BODY = (
    "# Kondorosi út property purchase\n\n## Context\n\n"
    "David is purchasing a flat at Kondorosi út 8/B. The purchase agreement "
    "draft was received on May 22, 2026, and contract signing is planned "
    "for next Wednesday.\n\n## Suggested next actions\n\n"
    "- Confirm independent legal review is completed before Wednesday's signing\n"
    "- Build a closing milestone tracker covering legal, financing, and notary\n"
    "- Map out total capital outlay including transfer tax and notary fees\n"
)
_NEOTERRA_BODY = (
    "# NeoTerra consulting engagement\n\n## Context\n\n"
    "NeoTerra is an Australian property company. The engagement is the "
    "anchor revenue source. Calls are 7 AM CEST weekly.\n\n"
    "## Suggested next actions\n\n"
    "- Track NeoTerra invoicing and payment cycle through the Kft transition\n"
    "- Document the Ken AI system architecture so continuity is not memory-bound\n"
)
_FOUNDER_BODY = (
    "# Founder transition: Kft setup and compliance\n\n## Context\n\n"
    "Szabostuban Kft was registered six weeks ago. The first VAT filing is "
    "due by Q3 2026, with NAV registration required by May 30 as well.\n\n"
    "## Suggested next actions\n\n"
    "- File the NAV registration by May 30 to avoid late penalties\n"
    "- Schedule the Q3 2026 VAT filing deadline reminder\n"
)


def _rec(name: str, slug: str, body: str) -> dict:
    return {
        "path": f"matter/{slug}.md",
        "frontmatter": {"name": name, "type": "matter", "status": "active"},
        "body": body,
    }


# -------------------------------------------------------------------- helpers


class TestTimeAnchorDetection:
    def test_finds_next_weekday_phrase(self):
        a = _find_time_anchor(_KONDOROSI_BODY)
        assert a is not None and a.rank == 0
        assert "wednesday" in a.text.lower()

    def test_finds_explicit_date(self):
        a = _find_time_anchor(_FOUNDER_BODY)
        assert a is not None and a.rank in (0, 1)

    def test_returns_none_for_vague_body(self):
        assert _find_time_anchor(_NEOTERRA_BODY) is None


class TestSuggestedActionsExtraction:
    def test_first_two_actions_extracted(self):
        actions = _extract_first_suggested_actions(_KONDOROSI_BODY, max_count=2)
        assert len(actions) == 2
        assert actions[0].startswith("Confirm independent legal review")
        assert actions[1].startswith("Build a closing milestone tracker")

    def test_missing_section_returns_empty(self):
        assert _extract_first_suggested_actions(
            "# No actions here\n\nJust prose.\n", max_count=2,
        ) == []


class TestRanking:
    def test_kondorosi_outranks_neoterra(self):
        ranked = _rank_matters_by_time_anchor([
            _rec("NeoTerra engagement", "neoterra", _NEOTERRA_BODY),
            _rec("Kondorosi purchase", "kondorosi", _KONDOROSI_BODY),
            _rec("Founder transition", "founder", _FOUNDER_BODY),
        ])
        slugs = [m["path"].split("/", 1)[1].rsplit(".", 1)[0] for m in ranked]
        assert slugs[0] == "kondorosi", slugs
        assert "neoterra" not in slugs


# ------------------------------------------------------------- activity tests


def _onboard_path(tmp_path: Path, payload: dict | None = None) -> str:
    path = tmp_path / "onboard.json"
    path.write_text(json.dumps(payload or {}))
    return str(path)


def _vault_patches(matters: list[dict], writes: list[dict]):
    async def _list_records(self, record_type, status=None, limit=100):
        if record_type != "matter":
            return []
        return [
            {"slug": m["path"].split("/", 1)[1].rsplit(".", 1)[0],
             "path": m["path"], "name": m["frontmatter"]["name"]}
            for m in matters
        ]

    async def _read_record(self, path):
        for m in matters:
            if m["path"] == path:
                return m
        raise FileNotFoundError(path)

    async def _write_record(self, record_type, name, content):
        writes.append({"type": record_type, "name": name, "content": content})
        return f"{record_type}/{name}.md"

    async def _close(self):
        return None

    return [
        patch("src.activities.desk_seed.VaultClient.list_records",
              new=_list_records),
        patch("src.activities.desk_seed.VaultClient.read_record",
              new=_read_record),
        patch("src.activities.desk_seed.VaultClient.write_record",
              new=_write_record),
        patch("src.activities.desk_seed.VaultClient.close", new=_close),
    ]


def _run_with_vault(matters, tmp_path, monkeypatch, *, onboard_payload=None):
    monkeypatch.setenv("AAS_API_KEY", "test-token")
    writes: list[dict] = []
    patches = _vault_patches(matters, writes)
    for p in patches:
        p.start()
    try:
        result = _run_activity(
            lambda: seed_day_one_desk_cards(
                _onboard_path(tmp_path, onboard_payload)
            )
        )
    finally:
        for p in patches:
            p.stop()
    return result, writes


_FULL_MATTERS = [
    _rec("Kondorosi út property purchase",
         "kondorosi-t-property-purchase", _KONDOROSI_BODY),
    _rec("NeoTerra consulting engagement",
         "neoterra-consulting-engagement", _NEOTERRA_BODY),
    _rec("Founder transition Kft setup",
         "founder-transition-kft-setup", _FOUNDER_BODY),
]


class TestSeedDayOneDeskCards:
    def test_seeds_2_to_3_cards_with_correct_shape(self, tmp_path, monkeypatch):
        """3 matters (2 time-anchored, 1 vague) → 2-3 needs_attention
        cards; Kondorosi card carries the Wednesday anchor; every card
        has the C-OB3 frontmatter (source / matter_ref / display_*
        / onboarding_seed + day_one tags)."""
        result, writes = _run_with_vault(_FULL_MATTERS, tmp_path, monkeypatch)
        assert 2 <= result.get("seeded", 0) <= 3, result
        assert 2 <= len(writes) <= 3, writes
        assert all(w["type"] == "needs_attention" for w in writes), writes

        kondorosi = [w for w in writes if "kondorosi" in w["content"].lower()]
        assert len(kondorosi) == 1, [w["name"] for w in writes]
        assert "wednesday" in kondorosi[0]["content"].lower()

        for w in writes:
            content = w["content"]
            for required in (
                "source: onboarding_seed",
                "source_matter_ref:",
                "matter/",
                "display_headline:",
                "display_body:",
            ):
                assert required in content, content[:400]
            assert "onboarding_seed" in content and "day_one" in content

    def test_returns_zero_when_zero_matters_input(
        self, tmp_path, monkeypatch,
    ):
        """0 matters in → 0 cards out. The Day-1 fallback (Gap 2) must
        not invent cards from nothing — it only fires when matters exist
        but none happen to be time-anchored."""
        result, writes = _run_with_vault([], tmp_path, monkeypatch)
        assert result.get("seeded", -1) == 0
        assert writes == []

    def test_skips_when_already_seeded(self, tmp_path, monkeypatch):
        result, writes = _run_with_vault(
            _FULL_MATTERS, tmp_path, monkeypatch,
            onboard_payload={"day_one_desk_seeded": True},
        )
        assert result == {"seeded": 0, "skipped": "already_seeded"}
        assert writes == []
