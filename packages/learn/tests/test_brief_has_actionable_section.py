"""Sir #1 — First Brief must have an actionable section, not pure prose.

Symptom: the very first brief Alfred delivers is eloquent future-tense
narration — "I should keep an eye on subscriptions", "I will learn the
rhythm of your week", "I'll pay attention to deliveries". Beautiful, but
useless: no time-anchored items, no concrete actions, no dollar amounts,
no replies awaited. The principal opens his Desk and reads a letter, not
a butler's day-plan.

Fix: reshape the brief composer prompt so the output has TWO sections:

  1. **Intro paragraph** — ONE paragraph of the existing narrative voice
     (was 5-7). Keep the warmth, lose the bloat.
  2. **"This week, on your plate:"** — a bulleted list of concrete
     time-anchored items the LLM must extract from the same facts the
     personalize/USER.md step uses. Each bullet: name, what, when.
     Minimum 3 bullets; if the facts truly don't support 3, the prompt
     still requires the LLM to surface the 3 most concrete it can find
     (a future-anchored deliverable counts).

Pinned contracts:

  * The prompt builder must include the literal "This week" section
    marker and the "name, what, when" bullet schema (golden-string
    assertion — the prompt itself is the source of truth).
  * A stubbed LLM that returns a conforming brief is persisted unchanged;
    a parse of that brief surfaces ≥3 bullets in the section. This
    guards against future drift where the prompt instructs the section
    but the post-processing strips it.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

import src.activities.onboarding_v3 as ov3


# ---------------------------------------------------------------------------
# Golden-string tests on the prompt template
# ---------------------------------------------------------------------------


def test_brief_prompt_requires_this_week_section():
    """The prompt must instruct the model to emit a 'This week' section."""
    prompt = ov3._build_brief_and_opportunities_prompt(
        user_md="Sir is the principal.",
        soul_md="Warm. Concrete. Never corporate.",
        fact_highlights=(
            "- Rayon subscription failed payment on May 20\n"
            "- Plex server license renews June 1 ($120)\n"
            "- Doctor follow-up scheduled May 28\n"
            "- Soft Murmur waiting on a roadmap reply"
        ),
        pattern_highlights="- pays subscriptions monthly",
        corrections_text="",
    )

    assert "This week" in prompt, (
        "prompt must require a 'This week' actionable section; current "
        "prompt produces eloquent future-tense narration with no "
        "time-anchored items"
    )


def test_brief_prompt_requires_name_what_when_schema():
    """Each bullet must follow the 'name, what, when' shape."""
    prompt = ov3._build_brief_and_opportunities_prompt(
        user_md="Sir.",
        soul_md="",
        fact_highlights="- some fact",
        pattern_highlights="",
        corrections_text="",
    )

    # Either explicit "name, what, when" or each-of-those words near a
    # bullet schema description. Conservative match: all three tokens
    # must co-occur in the actionable-section guidance.
    assert "name" in prompt and "what" in prompt and "when" in prompt, (
        "prompt must spell out the bullet schema (name, what, when) so "
        "the model produces a concrete day-plan, not narration"
    )


def test_brief_prompt_requires_minimum_three_bullets():
    """Minimum 3 actionable bullets — 'at least 3'."""
    prompt = ov3._build_brief_and_opportunities_prompt(
        user_md="Sir.",
        soul_md="",
        fact_highlights="- some fact",
        pattern_highlights="",
        corrections_text="",
    )

    # Looking for an explicit minimum — '3' or 'three' near the
    # actionable-section instructions.
    lowered = prompt.lower()
    assert ("at least 3" in lowered
            or "minimum 3" in lowered
            or "at least three" in lowered
            or "3-" in lowered  # "3-5 bullets"
            or "3 to" in lowered), (
        "prompt must require at least 3 bullets in the 'This week' section"
    )


def test_brief_prompt_reduces_intro_to_one_paragraph():
    """The intro paragraph constraint must be SHORTENED from the legacy 5-7."""
    prompt = ov3._build_brief_and_opportunities_prompt(
        user_md="Sir.",
        soul_md="",
        fact_highlights="- some fact",
        pattern_highlights="",
        corrections_text="",
    )

    # The legacy prompt asked for "5-7 paragraphs" of prose. The reshape
    # keeps only ONE paragraph of narrative + the bulleted section.
    # Defensive: legacy 5-7 must be gone; new shape must mention "one
    # paragraph" or similar.
    assert "5-7 paragraphs" not in prompt, (
        "legacy '5-7 paragraphs' instruction must be removed — the "
        "reshape keeps ONE intro paragraph + a bulleted action section"
    )
    lowered = prompt.lower()
    assert ("one paragraph" in lowered
            or "1 paragraph" in lowered
            or "single paragraph" in lowered
            or "one short paragraph" in lowered), (
        "prompt must instruct the model to write ONE intro paragraph "
        "(was 5-7); current shape will keep producing wall-of-prose briefs"
    )


# ---------------------------------------------------------------------------
# End-to-end: stubbed LLM returns a conforming brief, activity persists it
# ---------------------------------------------------------------------------


_CONFORMING_BRIEF = (
    "Sir, I have read your post and present your week below.\n\n"
    "**This week, on your plate:**\n\n"
    "- **Rayon (autopay)** — reply to billing with the updated card by "
    "Wednesday. Last attempt failed on Monday for $42.\n"
    "- **Plex license** — confirm or cancel the $120 annual renewal "
    "before June 1.\n"
    "- **Doctor follow-up** — Tuesday 10:00; bring the lab printout you "
    "saved Friday.\n"
    "- **Soft Murmur** — they are waiting on your roadmap reply since "
    "May 20; a one-paragraph response unblocks the call.\n\n"
    "At your disposal."
)

_CONFORMING_OPPORTUNITIES = [
    {
        "id": "watch-subscriptions",
        "name": "Watch subscriptions",
        "description": "Reviews recurring charges weekly and surfaces "
                       "failed payments.",
        "goal": "Catch failed charges before they cost the master money.",
        "trigger": {"kind": "cron", "hint": "weekly on Friday"},
        "data_sources": ["event", "matter"],
        "frequency_hint": "weekly",
        "notify_when": "when confidence of anomaly > 0.7",
        "tags": ["financial"],
    },
    {
        "id": "track-deliveries",
        "name": "Track deliveries",
        "description": "Watches shipping confirmations and surfaces "
                       "late or undeliverable packages.",
        "goal": "Catch undeliverable packages before they ship back.",
        "trigger": {"kind": "event", "hint": "on shipping email"},
        "data_sources": ["gmail"],
        "frequency_hint": "continuous",
        "notify_when": "delivery is >2 days late",
        "tags": ["personal"],
    },
    {
        "id": "remember-birthdays",
        "name": "Remember birthdays",
        "description": "Tracks family and close-friend birthdays.",
        "goal": "Make sure no birthday goes unmarked.",
        "trigger": {"kind": "cron", "hint": "daily at 7am"},
        "data_sources": ["matter"],
        "frequency_hint": "daily",
        "notify_when": "a birthday is within 7 days",
        "tags": ["personal"],
    },
]


def _bullet_count(brief: str) -> int:
    """Count top-level bullets in the brief (lines starting with '- ')."""
    return sum(1 for line in brief.splitlines() if line.lstrip().startswith("- "))


def test_conforming_brief_round_trip_has_three_bullets(monkeypatch, tmp_path):
    """A stubbed LLM that returns a conforming brief produces ≥3 bullets.

    Guards against future drift where the prompt requires the section but
    a post-processing step strips it. End-to-end: brief gets persisted
    intact, and a parse of the persisted brief shows the action section
    survived.
    """
    onboard_path = tmp_path / "onboard.json"
    onboard_path.write_text(json.dumps({
        "facts": [
            {"fact": "Rayon subscription failed payment May 20",
             "confidence": "high"},
            {"fact": "Plex renews June 1 ($120)",
             "confidence": "high"},
            {"fact": "Doctor follow-up May 28",
             "confidence": "high"},
            {"fact": "Soft Murmur awaiting roadmap reply",
             "confidence": "high"},
        ],
        "patterns": [],
        "user_md": "Sir.",
        "soul_md": "",
    }))

    captured_prompt = {}

    async def fake_llm(prompt, max_tokens=8192, **kw):
        captured_prompt["text"] = prompt
        return json.dumps({
            "brief": _CONFORMING_BRIEF,
            "opportunities": _CONFORMING_OPPORTUNITIES,
        })

    # Skip the vault write — we only care that brief_text was persisted
    # to onboard.json with the actionable section intact.
    class _NoopResp:
        status_code = 201

        @property
        def text(self):
            return ""

    class _NoopClient:
        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        async def post(self, *a, **kw):
            return _NoopResp()

    monkeypatch.setattr(ov3, "_call_llm", fake_llm)
    monkeypatch.setattr(ov3.httpx, "AsyncClient", _NoopClient)
    # _read/_write_onboard already work against the real file system.

    # activity.heartbeat needs a Temporal activity context that we don't
    # have here — stub it to a no-op so the test exercises the prompt
    # build + persistence path without dragging the Temporal worker in.
    monkeypatch.setattr(ov3.activity, "heartbeat", lambda *a, **k: None)

    result = asyncio.run(
        ov3.write_brief_and_opportunities_opus(str(onboard_path))
    )

    assert result.get("brief_length", 0) > 0
    persisted = json.loads(onboard_path.read_text())
    brief = persisted.get("brief", "")
    assert "This week" in brief, (
        f"brief lost its actionable section after persistence; "
        f"brief={brief[:200]!r}"
    )
    assert _bullet_count(brief) >= 3, (
        f"brief must carry at least 3 actionable bullets; "
        f"got {_bullet_count(brief)} in {brief!r}"
    )

    # Sanity: prompt actually carried the new instructions.
    assert "This week" in captured_prompt["text"]
