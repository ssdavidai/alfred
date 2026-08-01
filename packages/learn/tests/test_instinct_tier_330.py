"""#330 — every instinct carries a promotion-ladder tier.

Live finding (home, 2026-07-20): 33/34 instinct records had NO tier and
the 34th carried "Approved" (not in the Asking/Confirming/Acting vocab),
so ReflectionWorkflow's promotion ladder had nothing valid to promote.
The template simply never emitted the field.
"""
from __future__ import annotations

from src.activities.vault import _build_instinct_content


class TestInstinctTier:
    def test_new_instinct_defaults_to_asking(self):
        content = _build_instinct_content({"name": "test-instinct"})
        assert "tier: Asking" in content

    def test_explicit_valid_tier_respected(self):
        content = _build_instinct_content(
            {"name": "t", "tier": "Confirming"}
        )
        assert "tier: Confirming" in content

    def test_invalid_tier_coerced_to_asking(self):
        """'Approved' was the live wrong value — never write vocab the
        ladder can't read."""
        content = _build_instinct_content({"name": "t", "tier": "Approved"})
        assert "tier: Asking" in content

    def test_reflection_prompt_teaches_the_ladder(self):
        import inspect

        from src.activities import clerk

        src = inspect.getsource(clerk.clerk_reflect)
        for token in ("Asking", "Confirming", "Acting", "DEMOTE"):
            assert token in src, f"ladder guidance missing: {token}"
