"""Decision pattern extraction — turn principal's notes into proposals.

Every Delegate / Defer / Delete / Do click on the Desk writes a
``decision/<ts>-<short>.md`` record that often carries a short note
("settle it, file under May expenses", "don't reply, just file",
"defer until after Madrid"). Across enough decisions the same phrases
recur on the same matters — those are nascent standing rules.

This activity runs daily, groups the principal's recent decisions by
matter_ref, and for any matter that's accumulated three or more
decisions in the lookback window asks the clerk to extract the
recurring reasoning. Each pattern lands as a
``decision_pattern/<ts>-<short>.md`` vault record with
``status: proposed`` so the principal can review and accept on /study
or /instincts. Once accepted they can become real standing rules
("expenses always filed by month") or instincts ("Slack billing →
auto-update card").

No-op-safe: if the lookback yields fewer than three decisions per
matter the activity returns without calling the clerk.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config

logger = logging.getLogger("decision-patterns")


MIN_DECISIONS_PER_MATTER = 2
LOOKBACK_DAYS = 14


def _http() -> httpx.AsyncClient:
    cfg = load_config()
    api_key = os.environ.get("AAS_API_KEY", "")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    return httpx.AsyncClient(
        base_url=cfg.alfred_ctrl_url, headers=headers, timeout=60.0
    )


_PATTERN_PROMPT = """You are Alfred, the principal's agentic butler. Looking back at the principal's recent decisions on the matter "{matter_name}", find recurring patterns in their reasoning.

Recent decisions (most recent first):

{decisions_block}

Identify up to 3 patterns. A pattern is a *rule the principal seems to be applying without saying so out loud*. Examples of good patterns:

- "Always files Slack receipts under the cash-flow matter, never under marketing"
- "Defers anything from Zoom on Friday afternoons"
- "Delegates payment-confirmation emails to Alfred without instructions; trusts the default flow"

A pattern is NOT just "principal usually clicks delete on X" — that's a behaviour, not a rule. The rule is the *implicit reasoning* underneath. Be specific. Use concrete vocabulary from the actual notes.

Emit STRICT JSON, no preamble:

{{
  "patterns": [
    {{
      "rule": "<the implicit rule, 1 sentence, in Alfred's voice>",
      "evidence": "<which decisions / notes you drew it from, ≤2 sentences>",
      "proposed_action": "<what would change if you adopted this as a standing rule, ≤1 sentence>"
    }}
  ]
}}

If there are no patterns clear enough to be worth surfacing, emit `{{"patterns": []}}` and don't strain for content.
"""


@activity.defn
async def extract_decision_patterns() -> dict[str, Any]:
    """Group recent decisions by matter, ask clerk to find recurring rules."""
    since_iso = (
        datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)
    ).isoformat()

    async with _http() as client:
        resp = await client.get(
            f"/api/v1/decisions?since={since_iso}&limit=500",
        )
        resp.raise_for_status()
        decisions = resp.json().get("decisions", []) or []

    # Group by matter_ref. Drop decisions without one — there's no
    # meaningful grouping signal there.
    by_matter: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for d in decisions:
        matter_ref = d.get("matter_ref")
        if not isinstance(matter_ref, str) or not matter_ref.strip():
            continue
        if matter_ref == "null":
            continue
        by_matter[matter_ref].append(d)

    # Filter to matters with enough decisions to find a pattern.
    eligible = {
        m: ds for m, ds in by_matter.items()
        if len(ds) >= MIN_DECISIONS_PER_MATTER
    }
    if not eligible:
        logger.info(
            "decision_patterns: no matters with ≥%d recent decisions",
            MIN_DECISIONS_PER_MATTER,
        )
        return {"matters_checked": 0, "patterns_written": 0}

    # Lazy-import clerk so the worker registration stays fast.
    from src.activities.clerk import _call_clerk
    from src.utils.vault_client import VaultClient

    cfg = load_config()
    vault = VaultClient(cfg)
    patterns_written = 0

    try:
        for matter_ref, ds in eligible.items():
            matter_name = matter_ref.removeprefix("matter/").removesuffix(".md")
            # Build a compact decision block; only the parts the clerk
            # needs to reason about (intent, note, source_headline).
            lines = []
            for d in ds:
                intent = str(d.get("intent") or "")
                note = str(d.get("note") or "").strip()
                headline = str(d.get("source_headline") or "").strip()
                created = str(d.get("created") or "")[:10]
                if note:
                    lines.append(
                        f"- {created} · {intent} · {headline or '(no headline)'} — note: \"{note}\""
                    )
                else:
                    lines.append(
                        f"- {created} · {intent} · {headline or '(no headline)'}"
                    )
            decisions_block = "\n".join(lines)
            prompt = _PATTERN_PROMPT.format(
                matter_name=matter_name,
                decisions_block=decisions_block,
            )
            try:
                result = await _call_clerk(prompt)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "decision_patterns: clerk failed for %s: %s",
                    matter_ref, exc,
                )
                continue
            if not isinstance(result, dict):
                continue
            patterns = result.get("patterns")
            if not isinstance(patterns, list) or not patterns:
                continue
            # Write each pattern as a proposed decision_pattern record.
            for p in patterns:
                if not isinstance(p, dict):
                    continue
                rule = str(p.get("rule") or "").strip()
                if not rule:
                    continue
                evidence = str(p.get("evidence") or "").strip()
                proposed_action = str(p.get("proposed_action") or "").strip()
                now_iso = datetime.now(timezone.utc).isoformat()
                ts = now_iso.replace(":", "-").replace(".", "-")[:19] + "Z"
                short = hashlib.sha256(
                    f"{matter_ref}\x00{rule}".encode("utf-8")
                ).hexdigest()[:8]
                name = f"decision_pattern/{ts}-{short}.md"
                fm_lines = [
                    "---",
                    'type: "decision_pattern"',
                    f'created: "{now_iso}"',
                    f'matter_ref: {json.dumps(matter_ref)}',
                    f'rule: {json.dumps(rule)}',
                    f'evidence: {json.dumps(evidence)}',
                    f'proposed_action: {json.dumps(proposed_action)}',
                    f'decisions_seen: {len(ds)}',
                    f'lookback_days: {LOOKBACK_DAYS}',
                    'status: "proposed"',
                    "---",
                    "",
                    f"# Pattern proposal: {rule}",
                    "",
                    f"Drawn from {len(ds)} recent decisions on `{matter_ref}` over the last {LOOKBACK_DAYS} days.",
                    "",
                    f"**Evidence:** {evidence}" if evidence else "",
                    f"**If adopted:** {proposed_action}" if proposed_action else "",
                ]
                content = "\n".join([line for line in fm_lines if line != ""]) + "\n"
                try:
                    await vault.write_record(
                        record_type="decision_pattern",
                        name=name.removeprefix("decision_pattern/"),
                        content=content,
                    )
                    patterns_written += 1
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "decision_patterns: write failed for %s: %s",
                        matter_ref, exc,
                    )
    finally:
        await vault.close()

    logger.info(
        "decision_patterns: checked %d matters, wrote %d proposed patterns",
        len(eligible), patterns_written,
    )
    return {
        "matters_checked": len(eligible),
        "patterns_written": patterns_written,
    }
