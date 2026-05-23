"""Phase 2 / Lane II — Commit 4: instinct caps at BOTH seeding paths.

Per C-OB4 every instinct written during onboarding (observation_count=0)
must:
  * tier: Asking
  * discretion_threshold >= 0.7
  * confidence_score absent OR <= 0.4
  * status: unconfirmed

The live 2026-05-23 fixture has 9 instincts at confidence 0.86-0.91 with
no tier/status caps — the LLM-stamped confidence let the discretion
gate authorise autonomy at 0 observations, the premature-trust bug
GENERATORS.md §7 calls out.

Two generators need the cap:
  * packs.generate_instinct_pack — rule-based, 4 canned + per-domain
  * packs_opus.generate_instinct_pack_opus — Opus-generated

Per-domain heuristics in the rule-based path must be SKIPPED at
obs=0 (a 'route-<tier>-<domain>' stub from sender-tier discovery has
zero observation grounding to lean on).
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from temporalio import activity
from temporalio.testing import ActivityEnvironment

from src.activities import packs as packs_mod
from src.activities import packs_opus
from src.activities.packs_opus import _apply_unearned_caps
from src.activities.packs import generate_instinct_pack


# ---------------------------------------------------------------------------
# _apply_unearned_caps — pure unit
# ---------------------------------------------------------------------------


def test_apply_caps_floors_confidence() -> None:
    instinct = {
        "name": "escalate-payment-failures",
        "confidence_score": 0.95,
    }
    _apply_unearned_caps(instinct)
    assert instinct["confidence_score"] <= 0.4


def test_apply_caps_sets_asking_tier() -> None:
    instinct = {"name": "foo", "tier": "Acting"}
    _apply_unearned_caps(instinct)
    assert instinct["tier"] == "Asking"


def test_apply_caps_sets_unconfirmed_status() -> None:
    instinct = {"name": "foo", "status": "active"}
    _apply_unearned_caps(instinct)
    assert instinct["status"] == "unconfirmed"


def test_apply_caps_sets_high_discretion_threshold() -> None:
    instinct = {"name": "foo"}
    _apply_unearned_caps(instinct)
    # >= 0.7 per C-OB4 (no autonomy until earned).
    assert instinct["discretion_threshold"] >= 0.7


def test_apply_caps_preserves_other_fields() -> None:
    instinct = {
        "name": "x",
        "description": "stays",
        "input_patterns": {"sender_domains": ["a.com"]},
        "routing_rule": {"destination_type": "stream"},
        "rationale": "stays",
    }
    _apply_unearned_caps(instinct)
    assert instinct["description"] == "stays"
    assert instinct["input_patterns"]["sender_domains"] == ["a.com"]
    assert instinct["routing_rule"]["destination_type"] == "stream"
    assert instinct["rationale"] == "stays"


# ---------------------------------------------------------------------------
# Rule-based generator — packs.generate_instinct_pack
# ---------------------------------------------------------------------------


class _FakeVaultClient:
    def __init__(self) -> None:
        self.written: list[tuple[str, str, str]] = []

    async def search_records(self, *_a: Any, **_k: Any) -> list[Any]:
        return []

    async def record_exists(self, *_a: Any, **_k: Any) -> bool:
        return False

    async def write_record(self, record_type: str, slug: str, content: str) -> str:
        self.written.append((record_type, slug, content))
        return f"{record_type}/{slug}.md"

    async def close(self) -> None:  # pragma: no cover
        pass


def _install(monkeypatch: pytest.MonkeyPatch, fake: _FakeVaultClient) -> None:
    monkeypatch.setattr(packs_mod, "VaultClient", lambda *_a, **_k: fake)
    import src.config as cfg
    monkeypatch.setattr(
        cfg, "load_config",
        lambda: type("C", (), {"alfred_ctrl_url": "http://t:3100"})(),
    )


def _run(coro_factory):
    env = ActivityEnvironment()

    @activity.defn(name="_test_caps_wrapper")
    async def _wrap() -> Any:
        return await coro_factory()

    return asyncio.run(env.run(_wrap))


def _onboard_with_tiers(tmp_path: Path) -> str:
    data = {
        "profile": {
            "sender_tiers": {
                # Canned-branch fuel
                "noise": [
                    {"domain": "ci.example.com", "address": "a@ci.example.com",
                     "count": 50},
                ],
                # Per-domain branch fuel — 3 senders on one domain in an
                # uncovered tier (the live source of route-<tier>-<domain>
                # stubs). Pre-fix would write a per-domain instinct.
                "professional": [
                    {"domain": "neoterra.example", "address": f"p{i}@neoterra.example",
                     "count": 20} for i in range(4)
                ],
            },
            "financial": {"payment_issues": []},
        },
    }
    p = tmp_path / "onboard.json"
    p.write_text(json.dumps(data))
    return str(p)


def test_rule_based_per_domain_branch_is_skipped(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """At obs=0, the per-domain instinct branch in
    ``packs.generate_instinct_pack`` (route-<tier>-<domain>) must NOT
    write. Only the canned instincts may seed."""
    fake = _FakeVaultClient()
    _install(monkeypatch, fake)
    path = _onboard_with_tiers(tmp_path)

    _run(lambda: generate_instinct_pack(path))

    domain_stubs = [
        slug for (_, slug, _) in fake.written
        if slug.startswith("route-professional-")
    ]
    assert domain_stubs == [], (
        f"per-domain branch fired at obs=0: {domain_stubs}"
    )


def test_rule_based_canned_instincts_carry_caps(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    """The 4 canned instincts that DO seed must carry the C-OB4 caps in
    their frontmatter. Parse what was written."""
    import re as _re
    import yaml as _yaml

    fake = _FakeVaultClient()
    _install(monkeypatch, fake)
    path = _onboard_with_tiers(tmp_path)

    _run(lambda: generate_instinct_pack(path))

    canned = [(slug, content) for (_, slug, content) in fake.written]
    assert canned, "rule-based generator wrote 0 instincts (regression)"

    for slug, content in canned:
        m = _re.match(r"^---\n(.*?)\n---\n", content, _re.DOTALL)
        assert m, f"no frontmatter in {slug}"
        fm = _yaml.safe_load(m.group(1)) or {}
        conf = fm.get("confidence_score")
        if conf is not None:
            assert float(conf) <= 0.4, (
                f"{slug} has unearned confidence {conf} (cap <= 0.4)"
            )
        assert str(fm.get("tier", "")).lower() == "asking", (
            f"{slug} not Asking tier: {fm.get('tier')!r}"
        )
        assert str(fm.get("status", "")).lower() == "unconfirmed", (
            f"{slug} not unconfirmed: {fm.get('status')!r}"
        )
        threshold = fm.get("discretion_threshold")
        assert threshold is not None and float(threshold) >= 0.7, (
            f"{slug} threshold missing/too low: {threshold!r}"
        )


# ---------------------------------------------------------------------------
# Opus generator — _build_rich_instinct_content respects the caps
# ---------------------------------------------------------------------------


def test_opus_built_record_carries_caps_after_apply() -> None:
    """After ``_apply_unearned_caps``, ``_build_rich_instinct_content``
    must render the same caps into the frontmatter (parse and assert).
    """
    import re as _re
    import yaml as _yaml

    instinct = {
        "name": "escalate-payment-failures",
        "description": "Surface payment failures urgently.",
        "rationale": "Payments under stress need a human eye.",
        "input_patterns": {"sender_domains": ["stripe.com"],
                            "subject_keywords": ["failed"]},
        "routing_rule": {"destination_type": "task",
                          "destination": "urgent"},
        "confidence_score": 0.95,
        "status": "active",
    }
    _apply_unearned_caps(instinct)
    content = packs_opus._build_rich_instinct_content(instinct)

    m = _re.match(r"^---\n(.*?)\n---\n", content, _re.DOTALL)
    assert m, content[:200]
    fm = _yaml.safe_load(m.group(1)) or {}
    assert str(fm.get("tier")).lower() == "asking"
    assert str(fm.get("status")).lower() == "unconfirmed"
    assert float(fm.get("confidence_score", 1.0)) <= 0.4
    assert float(fm.get("discretion_threshold", 0.0)) >= 0.7


def test_apply_caps_handles_missing_keys_idempotently() -> None:
    """A second application is a no-op (idempotent)."""
    instinct = {"name": "x"}
    _apply_unearned_caps(instinct)
    snapshot = dict(instinct)
    _apply_unearned_caps(instinct)
    assert instinct == snapshot
