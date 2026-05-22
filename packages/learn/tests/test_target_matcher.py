"""Regression tests for the signal→matter/task target matcher (P0-1).

Old matcher: ``difflib.SequenceMatcher`` char-ratio between the LLM
``target_hint`` and matter/task **slugs**, floor 0.30 ("barely better than
chance"). Live: 30/33 signals unbound; of 3 bound, only 1 correct — e.g.
"Rayon … payment failed" bound to ``matter/family-planning…`` @0.3168 (a wrong
binding, strictly worse than none). These tests pin the desired behaviour of
the deterministic token/entity matcher: prefer-None over a wrong guess, and
bind on real name/entity-token overlap. Pure-Python, no LLM, no ctrl-api.
"""
from __future__ import annotations

from typing import Any

from src.activities import signals as S


def _rec(kind: str, slug: str, name: str, **fm: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"name": name}
    base.update(fm)
    return {"path": f"{kind}/{slug}.md", "frontmatter": base}


class _StubClient:
    def __init__(self, matters: list[dict], tasks: list[dict]) -> None:
        self._m, self._t = matters, tasks

    async def list_records(self, kind: str, limit: int | None = None):
        return list(self._m if kind == "matter" else self._t if kind == "task" else [])


_FAMILY = _rec("matter", "family-planning-young-family-support",
               "Family Planning & Young-Family Support", key_people=["Dana"])
_FITNESS = _rec("matter", "fitness-regimen", "Fitness Regimen")
_HOME = _rec("matter", "home-upgrades", "Home Upgrades")
_BILLING = _rec("matter", "rayon-billing", "Rayon Subscription & Billing",
                aliases=["Rayon", "Rayon Pro"])
_MAT_TASK = _rec("task", "follow-up-with-mat-aleixo", "Follow up with Mat Aleixo",
                 key_people=["Mat Aleixo"])


async def test_weak_char_match_no_longer_binds_wrong_matter() -> None:
    """"Rayon … payment failed" must NOT bind to family-planning (no billing matter)."""
    client = _StubClient([_FAMILY, _FITNESS, _HOME], [])
    resolved = await S._resolve_target(
        "Rayon Pro plan payment failed update payment method", "matter", client=client)
    assert resolved["target_path"] is None, resolved


async def test_peptide_hint_does_not_bind_unrelated_task() -> None:
    """"peptide market opportunity" must not bind to "Follow up with Mat Aleixo"."""
    client = _StubClient([], [_MAT_TASK])
    resolved = await S._resolve_target(
        "Explore the peptide market opportunity", "task", client=client)
    assert resolved["target_path"] is None, resolved


async def test_name_token_match_binds_correct_matter() -> None:
    """A hint sharing real tokens with the matter name/aliases binds to it."""
    client = _StubClient([_FAMILY, _FITNESS, _HOME, _BILLING], [])
    resolved = await S._resolve_target(
        "Rayon subscription billing problem", "matter", client=client)
    assert resolved["target_path"] == "matter/rayon-billing.md", resolved
    assert resolved["target_confidence"] >= S.TARGET_MATCH_FLOOR


async def test_entity_token_match_binds_correct_task() -> None:
    """A hint naming the task's key_person binds to that task."""
    client = _StubClient([], [_MAT_TASK])
    resolved = await S._resolve_target(
        "Follow up with Mat Aleixo about the deck", "task", client=client)
    assert resolved["target_path"] == "task/follow-up-with-mat-aleixo.md", resolved


def test_floor_raised_above_chance() -> None:
    assert S.TARGET_MATCH_FLOOR >= 0.45
