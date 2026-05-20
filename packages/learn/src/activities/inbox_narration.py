"""Live butler narration during onboarding — the "reading the room" theatre.

Onboarding is a ~12-14 min pipeline (fetch → facts → patterns → personalize →
brief → packs). At each stage we make ONE cheap pass through Hermes that turns
that stage's REAL data into a batch of dry, butler-style one-liners, tagged with
the stage. The frontend drips them out one at a time (~5s, jittered) and shows a
"where Alfred is" act indicator driven by the real stage — so the screen feels
alive the whole way through, narrating actual work on the principal's life.

All calls go through **Hermes** (``clerk._call_clerk`` → the workers gateway)
with a stable ``onboarding`` session key, so the runs obey the gateway contract,
use the configured workers model, and accrue into one Hermes session that warms
the runtime on the principal as onboarding happens.

Privacy: every line is derived from the principal's OWN data and shown only to
them. The model gets domains/subjects/fact-text (not full addresses) and is told
never to invent or quote a name.

Best-effort throughout: any failure returns ``[]`` so narration can never break
the onboarding pipeline it hangs off of.
"""
from __future__ import annotations

import json
import logging
import re

from src.activities.clerk import _call_clerk

logger = logging.getLogger("alfred-learn")

# Stable Hermes session key so the onboarding work threads into one session.
_ONBOARDING_SESSION = "onboarding"
_EMAIL_SAMPLE = 36


def _spread_sample(items: list, n: int) -> list:
    """Pick n items spread evenly across the list (variety over recency)."""
    if len(items) <= n:
        return list(items)
    step = len(items) / n
    return [items[int(i * step)] for i in range(n)]


async def _narrate(prompt: str) -> list[str]:
    """One Hermes pass → a list of butler one-liners. Best-effort → []."""
    try:
        out = await _call_clerk(prompt, raw=True, agent_id=_ONBOARDING_SESSION)
    except Exception as e:  # noqa: BLE001 — never break onboarding on narration
        logger.warning("narration: gateway call failed: %s", e)
        return []
    raw = out if isinstance(out, str) else json.dumps(out)
    match = re.search(r"\[.*\]", raw, re.DOTALL)
    if not match:
        return []
    try:
        arr = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    lines: list[str] = []
    for item in arr:
        line = (item.get("line") if isinstance(item, dict) else str(item) or "").strip()
        if line:
            lines.append(line[:180])
    return lines


def _build_prompt(framing: str, material: str, count: int) -> str:
    return f"""You are Alfred — a wry, impeccably-mannered British butler — narrating quietly to yourself as you {framing}.

Write about {count} short remarks: dry, perceptive, a touch snarky, but always affectionate and discreet — never cynical, never mean. Each ≤ 14 words. Refer to people by role or relation (the founder, the sister, a vendor), never invent or quote a name. Vary them — most are observations; a few may be tiny running summaries (e.g. "So far: a founder, a father, a fighter."). No quote marks, no numbering.

Return ONLY a JSON array of objects, each {{"line": "..."}}.

Material:
{material}
"""


async def generate_stage_narration(
    stage: str, material: str, count: int, framing: str
) -> list[dict]:
    """Generic per-stage narration → list of ``{"stage", "line"}`` dicts."""
    if not material.strip():
        return []
    lines = await _narrate(_build_prompt(framing, material, count))
    out = [{"stage": stage, "line": ln} for ln in lines]
    logger.info("narration[%s]: generated %d butler lines via Hermes", stage, len(out))
    return out


# --- Per-stage entry points ------------------------------------------------


async def generate_inbox_narration(emails: list[dict]) -> list[dict]:
    """Stage ``email`` — narrate the real inbox as Alfred sorts the post."""
    if not emails:
        return []
    sample = _spread_sample(emails, _EMAIL_SAMPLE)
    material = "\n".join(
        f"- from {(e.get('domain') or e.get('from', '') or 'unknown')[:50]}: "
        f"{(e.get('subject') or '(no subject)')[:90]}"
        for e in sample
    )
    out = await generate_stage_narration(
        "email", material, len(sample),
        "sort your new principal's morning post for the very first time",
    )
    # Attach the sender domain best-effort (1:1 by index) for the UI label.
    for i, item in enumerate(out):
        if i < len(sample):
            item["domain"] = sample[i].get("domain", "")
    return out


async def generate_facts_narration(facts: list[dict], key_facts: list[dict]) -> list[dict]:
    """Stage ``facts`` — narrate working out who the principal is."""
    sample = _spread_sample(facts, 28)
    material = "\n".join(
        f"- ({f.get('category', '?')}) {str(f.get('fact', f))[:120]}" for f in sample
    )
    if key_facts:
        material += "\n\nThe defining ones:\n" + "\n".join(
            f"- {k.get('display', k.get('field', ''))}: {k.get('value', '')}"
            for k in key_facts[:12]
        )
    return await generate_stage_narration(
        "facts", material, 30, "piece together who this person actually is",
    )


async def generate_patterns_narration(patterns: list) -> list[dict]:
    """Stage ``patterns`` — narrate spotting the rhythms of their life."""
    sample = _spread_sample(patterns, 24)
    material = "\n".join(
        f"- {str(p.get('pattern', p.get('description', p)) if isinstance(p, dict) else p)[:140]}"
        for p in sample
    )
    return await generate_stage_narration(
        "patterns", material, 24, "notice the recurring rhythms and habits in their days",
    )


async def generate_personalize_narration(key_facts: list[dict]) -> list[dict]:
    """Stage ``personalize`` — narrate composing soul / profile / memory / tools."""
    who = "; ".join(
        f"{k.get('display', k.get('field', ''))}: {k.get('value', '')}"
        for k in (key_facts or [])[:10]
    ) or "what you've learned of them"
    material = (
        f"You now compose, in turn: their profile (USER.md), your own guiding "
        f"soul/principles (SOUL.md), your working memory (MEMORY.md), and your "
        f"toolbox (TOOLS.md). You are tailoring yourself to: {who}."
    )
    return await generate_stage_narration(
        "personalize", material, 30,
        "write up your understanding and shape yourself to this particular person",
    )
