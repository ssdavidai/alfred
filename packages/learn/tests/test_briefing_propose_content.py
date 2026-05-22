"""P0-3 — the brief's Phase-1 propose prompt must feed the clerk the actual
signal/decision CONTENT, not just paths.

Old behaviour (briefing.py ~727-739): the propose prompt sent the clerk only
``{"kind": "signal", "path": <id>}`` — no headline, summary, body, or the
signal's own reasoning. The clerk judged "did this matter move?" blind →
mostly NO_CHANGE (live: 0 morning / 1 evening state-changes over 26 signals) →
thin "Where things stand", no matter how good the composition prompt is.

This test pins that the composed Phase-1 prompt for a matter with signals now
includes the signal content (headline + summary/body + reasoning), bounded.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

from src.activities import briefing as briefing_mod
from src.activities.briefing import propose_briefing_matter_update
from src.activities.state_mutator import ObservedWindow


_SIGNALS = {
    "sig-rayon": {
        "frontmatter": {
            "display_headline": "Rayon Pro subscription payment failed",
            "display_body": "Sir's Rayon Pro card was declined; renewal is at risk.",
            "reasoning": "Payment failure needs Sir's attention before the grace period ends.",
        },
        "body": "",
    },
}


async def _fake_read_signal_record(signal_ref: str, *, config: Any = None):
    return _SIGNALS.get(signal_ref)


class _FakeVault:
    def __init__(self, *_a: Any, **_kw: Any) -> None:
        pass

    async def read_record(self, path: str) -> dict[str, Any]:
        return {
            "frontmatter": {
                "intent": "delegate",
                "note": "Sir asked Alfred to chase the Rayon billing fix.",
            },
            "body": "",
        }

    async def close(self) -> None:
        return None


async def test_propose_prompt_includes_signal_content_not_just_paths():
    target = {"frontmatter": {"path": "matter/rayon-billing.md",
                              "current_state": "Billing stable."}, "body": ""}
    observed = ObservedWindow(
        start=briefing_mod._parse_iso_or_none("2026-05-22T05:00:00Z"),
        end=briefing_mod._parse_iso_or_none("2026-05-22T17:00:00Z"),
        signal_paths=["sig-rayon"],
        decision_paths=["decision/2026-05-22-rayon.md"],
        other_refs=[],
    )
    captured: dict[str, str] = {}

    async def _capture_clerk(prompt: str, raw: bool = False) -> str:
        captured["prompt"] = prompt
        return "NO_CHANGE"

    with patch("src.activities.briefing._call_clerk", new=_capture_clerk), \
         patch("src.activities.briefing.read_signal_record",
               new=AsyncMock(side_effect=_fake_read_signal_record)), \
         patch("src.activities.briefing.VaultClient", _FakeVault):
        await propose_briefing_matter_update(
            target=target, observed=observed,
            args={"slot": "morning", "prior_state": "Billing stable.",
                  "as_of": "2026-05-22T05:00:00Z", "matter_slug": "rayon-billing"},
        )

    prompt = captured.get("prompt", "")
    assert prompt, "clerk must have been called with a prompt"
    # The signal's CONTENT — not just its id/path — must reach the clerk.
    assert "Rayon Pro subscription payment failed" in prompt, (
        "signal headline missing from the propose prompt"
    )
    assert "card was declined" in prompt, "signal body/summary missing"
    assert "grace period ends" in prompt, "signal reasoning missing"
    # The decision's content must reach the clerk too.
    assert "chase the Rayon billing fix" in prompt, "decision note missing"
