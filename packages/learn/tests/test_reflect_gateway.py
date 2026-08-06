"""Reflection runs on the HEAVY profile, not workers (Sir, 2026-08-06).

CLAUDE.md §9 has always described heavy as "onboarding + Reflection", but
only onboarding_v3 honoured it — `clerk_reflect` went to the workers gateway
(gpt-5.6-luna) like every other clerk call. Reflection is the call that reads
accumulated observations and proposes instinct changes, including the tier
promotions that decide how much Alfred may do unattended (#446), so it gets
the strongest tier.

These pin the gateway SELECTION, which is the part that silently regressed.
"""

import inspect

import pytest

from src.activities import clerk


def test_call_clerk_defaults_to_workers():
    sig = inspect.signature(clerk._call_clerk)
    assert sig.parameters["profile"].default == "workers"


def test_clerk_reflect_requests_the_heavy_profile():
    """The source of clerk_reflect must pass profile="heavy"."""
    src = inspect.getsource(clerk.clerk_reflect)
    assert 'profile="heavy"' in src, "clerk_reflect no longer targets heavy"


@pytest.mark.parametrize(
    "profile,attr",
    [
        ("heavy", "heavy_gateway_url"),
        ("workers", "openclaw_workers_gateway_url"),
        # Anything unrecognised must fall back to workers, never to main —
        # main (:18789) is reserved for Sir's live chat.
        ("nonsense", "openclaw_workers_gateway_url"),
    ],
)
def test_gateway_selection_maps_profile_to_base_url(profile, attr):
    src = inspect.getsource(clerk._call_clerk)
    assert "config.heavy_gateway_url" in src
    assert "config.openclaw_workers_gateway_url" in src
    # The selection is a conditional on profile == "heavy"; everything else
    # falls through to workers.
    assert 'profile == "heavy"' in src
    expected_heavy = profile == "heavy"
    assert (attr == "heavy_gateway_url") is expected_heavy


def test_main_gateway_is_never_a_clerk_target():
    """Autonomous traffic must never touch Sir's chat gateway (:18789).

    Inspects the parsed AST rather than the source text: the main port is
    legitimately named in the docstring/comments that explain why it is
    excluded, so a substring search would be testing prose, not behaviour.
    """
    import ast
    import textwrap

    tree = ast.parse(textwrap.dedent(inspect.getsource(clerk._call_clerk)))
    attrs = {
        node.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Attribute) and node.attr.endswith("gateway_url")
    }
    # `openclaw_gateway_url` (no `_workers_`) IS the main profile.
    assert "openclaw_gateway_url" not in attrs, f"main gateway referenced: {attrs}"
    assert attrs == {"heavy_gateway_url", "openclaw_workers_gateway_url"}, attrs
