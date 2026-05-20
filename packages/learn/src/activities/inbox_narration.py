"""Live butler narration of the principal's inbox during onboarding.

A single cheap-model pass over a spread sample of the real fetched emails
produces ~20 dry, butler-style one-liners. They are written into
``onboard.json["narration"]``; the onboarding "reading the room" screen reveals
them progressively so it feels like Alfred is reading and commenting on the
inbox live. One call, not a loop — cheap and fast.

The call goes through **Hermes** (via ``clerk._call_clerk`` → the workers
gateway), NOT direct to a provider: it obeys the gateway contract, runs on the
configured workers model, and — using a stable ``onboarding`` session key —
the run accrues into Hermes' session context, so the runtime is already warmed
on the principal's life by the time onboarding finishes.

Privacy: the lines are derived from the principal's OWN inbox and shown only to
the principal on their own onboarding screen. The model sees the sender domain
+ subject (not full addresses) and is told to avoid quoting names.
"""
from __future__ import annotations

import json
import logging
import re

from src.activities.clerk import _call_clerk

logger = logging.getLogger("alfred-learn")

# Stable Hermes session key so the onboarding work threads into one session.
_ONBOARDING_SESSION = "onboarding"
_SAMPLE = 22

_PROMPT = """You are Alfred — a wry, impeccably-mannered British butler — seeing your principal's email inbox for the very first time. Below is a real sample of their recent mail (sender domain + subject only).

For EACH item, write ONE short remark to yourself, as if narrating aloud while sorting the morning post: dry, perceptive, a touch snarky, but always affectionate and discreet — never cynical, never mean. Max 14 words. Refer to senders by role or company, never invent or quote a person's name. No email addresses, no quote marks.

Return ONLY a JSON array of objects in the SAME order, each: {{"line": "..."}}.

Mail:
{emails}
"""


def _spread_sample(emails: list[dict], n: int) -> list[dict]:
    """Pick n items spread evenly across the list (variety over recency)."""
    if len(emails) <= n:
        return list(emails)
    step = len(emails) / n
    return [emails[int(i * step)] for i in range(n)]


async def generate_inbox_narration(emails: list[dict]) -> list[dict]:
    """Return a list of ``{"line": str, "domain": str}`` butler remarks.

    Best-effort: returns ``[]`` on any failure (gateway error, bad JSON) so it
    can never break the onboarding fetch it hangs off of.
    """
    if not emails:
        return []

    sample = _spread_sample(emails, _SAMPLE)
    listing = "\n".join(
        f"{i + 1}. from={(e.get('domain') or e.get('from', '') or 'unknown')[:50]} "
        f"subject={(e.get('subject') or '(no subject)')[:90]}"
        for i, e in enumerate(sample)
    )
    prompt = _PROMPT.format(emails=listing)

    try:
        # Through Hermes' workers gateway, scoped to the onboarding session.
        out_text = await _call_clerk(
            prompt, raw=True, agent_id=_ONBOARDING_SESSION
        )
    except Exception as e:  # noqa: BLE001 — never break onboarding on narration
        logger.warning("inbox_narration: gateway call failed: %s", e)
        return []

    raw = out_text if isinstance(out_text, str) else json.dumps(out_text)
    match = re.search(r"\[.*\]", raw, re.DOTALL)
    if not match:
        logger.warning("inbox_narration: no JSON array in model output")
        return []
    try:
        arr = json.loads(match.group(0))
    except json.JSONDecodeError:
        logger.warning("inbox_narration: model output was not valid JSON")
        return []

    result: list[dict] = []
    for i, item in enumerate(arr):
        line = (item.get("line") if isinstance(item, dict) else str(item) or "").strip()
        if not line:
            continue
        src = sample[i] if i < len(sample) else {}
        result.append({"line": line[:160], "domain": src.get("domain", "")})
    logger.info("inbox_narration: generated %d butler lines via Hermes", len(result))
    return result
