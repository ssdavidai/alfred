"""Extract observations from decisions, materialize instincts from
pattern proposals — the two activities that close the principal's
training loop.

The Desk is supposed to shrink. To make that happen, every click has
to be more than a one-off side effect — it has to leave training data
behind. Two activities here do that:

1. ``extract_observation_from_decision`` — runs after every Desk
   click (inside the DecisionRouterWorkflow's route_decision). Asks
   the clerk to distill the decision into a single ``fact about the
   principal'' and writes it as ``observation/<ts>.md`` so the
   existing intuition engine consumes it alongside observations from
   chat / voice / curator-processed events. The decision is the atom;
   the observation is the lesson.

2. ``adopt_instinct_from_pattern`` — runs when the principal clicks
   Delegate on a pattern-proposal card. Materializes the proposed
   rule as a real ``instinct/<ts>.md`` record (status=active) so the
   SignalRouterWorkflow's existing instinct matcher picks it up the
   next time a similar signal arrives. The pattern proposal itself
   gets flipped to status=adopted for the audit trail.

Both activities use httpx + ctrl-api routes; no new endpoints needed
on the ctrl-api side — the vault POST + PATCH routes already
exist.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from temporalio import activity

from src.config import load_config

logger = logging.getLogger("decision-observations")


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


_OBSERVATION_PROMPT = """You are Alfred, the principal's agentic butler.

The principal just made a decision on their Desk. Look at it and tell
me, in one sentence, what *fact about the principal* this decision
implies. The goal is to surface implicit preferences and rules so the
intuition engine can cluster them into instincts over time.

Decision details:

- intent: {intent}
- source type: {source}
- card headline: {headline}
- principal's note: {note}
- matter: {matter_ref}

Examples of good observations:

- "Principal categorizes recurring software subscriptions under the
  household cash-flow matter, not under marketing."
- "Principal defers calendar invites from sales prospects that arrive
  without a clear agenda."
- "Principal closes Zoom storage warnings without action until they
  reach 90% capacity."

Examples of BAD observations (skip these — emit null):

- "Principal clicked delete." (no rule, just behaviour)
- "Principal acted on the card." (vacuous)

If the decision is too thin (no note, generic source) to support a
real observation, emit `{{"fact": null}}` and don't strain.

Emit STRICT JSON, no preamble:

{{
  "fact": "<one sentence stating the implicit rule, or null>",
  "topic": "<2-5 word topic tag, like 'expense categorization', 'meeting filters', 'subscription noise'>"
}}
"""


@activity.defn
async def extract_observation_from_decision(
    decision: dict[str, Any],
) -> dict[str, Any]:
    """Turn a decision into an observation record consumable by the
    existing intuition engine.

    Returns ``{"observation_path": "observation/<ts>-<short>.md"}`` on
    write or ``{"observation_path": None, "reason": "..."}`` when the
    decision was too thin to support an observation.
    """
    intent = str(decision.get("intent") or "").strip()
    source = str(decision.get("source") or "").strip()
    note = str(decision.get("note") or "").strip()
    headline = str(decision.get("source_headline") or "").strip()
    matter_ref = str(decision.get("matter_ref") or "").strip()
    decision_id = str(decision.get("id") or "")

    # Skip totally thin decisions — no note, generic delete on a
    # source that doesn't carry headline context.
    if not note and not headline and source != "pattern_proposal":
        return {"observation_path": None, "reason": "no signal to extract"}

    prompt = _OBSERVATION_PROMPT.format(
        intent=intent or "(none)",
        source=source or "(none)",
        headline=headline or "(none)",
        note=note or "(none)",
        matter_ref=matter_ref or "(none)",
    )

    try:
        from src.activities.clerk import _call_clerk
        result = await _call_clerk(prompt)
    except Exception as exc:  # noqa: BLE001
        logger.warning("extract_observation: clerk failed: %s", exc)
        return {"observation_path": None, "reason": f"clerk error: {exc}"}

    if not isinstance(result, dict):
        return {"observation_path": None, "reason": "non-dict response"}

    fact = result.get("fact")
    if not isinstance(fact, str) or not fact.strip():
        return {"observation_path": None, "reason": "no observable fact"}
    topic = str(result.get("topic") or "").strip()
    fact_clean = fact.strip()

    # Write the observation record. The on-disk filename keeps the
    # canonical `<ts>-<short>` shape so chronological ordering works,
    # but the human-readable `name` field is the fact itself (truncated
    # to a sane vault-tree label). Without this, vault tree views show
    # the timestamp and the reader has to open the body to learn what
    # the observation says.
    now_iso = datetime.now(timezone.utc).isoformat()
    ts = now_iso.replace(":", "-").replace(".", "-")[:19] + "Z"
    short = hashlib.sha256(
        f"{decision_id}\x00{fact_clean}".encode("utf-8")
    ).hexdigest()[:8]
    name = f"{ts}-{short}"
    # Truncate fact for the name field — vault tree truncates anyway,
    # this just makes the on-disk frontmatter clean.
    name_label = fact_clean if len(fact_clean) <= 90 else fact_clean[:87] + "..."
    fm_lines = [
        "---",
        'type: "observation"',
        f'name: {json.dumps(name_label)}',
        f'created: "{now_iso}"',
        'subject: "principal"',
        f'fact: {json.dumps(fact_clean)}',
        f'topic: {json.dumps(topic)}',
        f'source_kind: "decision"',
        f'source_path: "decision/{decision_id}.md"',
        f'matter_ref: {json.dumps(matter_ref) if matter_ref else "null"}',
        'status: "open"',
        "---",
        "",
        # Body lists the source decision context. No redundant heading
        # repeating the fact — the frontmatter already carries it.
        f"Extracted from decision `decision/{decision_id}.md` at {now_iso}.",
        f"Topic: **{topic}**" if topic else "",
        "",
        "*Source decision details:*",
        f"- intent: {intent}",
        f"- source: {source}",
        f"- headline: {headline}" if headline else "",
        f"- note: {note}" if note else "",
        f"- matter: {matter_ref}" if matter_ref else "",
    ]
    content = "\n".join([line for line in fm_lines if line != ""]) + "\n"

    from src.utils.vault_client import VaultClient
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        path = await client.write_record(
            record_type="observation", name=name, content=content,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("extract_observation: vault write failed: %s", exc)
        return {"observation_path": None, "reason": f"write error: {exc}"}
    finally:
        await client.close()

    logger.info(
        "extract_observation: decision=%s -> %s (%s)",
        decision_id, path, topic or fact_clean[:40],
    )
    return {"observation_path": path, "fact": fact_clean, "topic": topic}


@activity.defn
async def adopt_instinct_from_pattern(
    pattern_path: str,
) -> dict[str, Any]:
    """Materialize a proposed decision_pattern as an active instinct.

    Called by the DecisionRouterWorkflow when the principal clicks
    Delegate on a pattern-proposal card on /desk. Writes an
    ``instinct/<ts>-<short>.md`` record with status=active, then
    PATCHes the originating decision_pattern to status=adopted so it
    drops out of future /api/v1/admin/pattern-proposals lists.
    """
    if not pattern_path or not pattern_path.startswith("decision_pattern/"):
        return {"ok": False, "reason": "bad pattern path"}
    async with _http() as client:
        # Read the pattern proposal.
        resp = await client.get(
            f"/api/v1/vault/records/{pattern_path}",
        )
        if resp.status_code >= 400:
            return {"ok": False, "reason": f"pattern read {resp.status_code}"}
        pattern = resp.json()
        fm = pattern.get("frontmatter") or {}
        rule = str(fm.get("rule") or "").strip()
        evidence = str(fm.get("evidence") or "").strip()
        proposed_action = str(fm.get("proposed_action") or "").strip()
        matter_ref = str(fm.get("matter_ref") or "").strip()

        if not rule:
            return {"ok": False, "reason": "pattern has no rule"}

        # Build the instinct record. Existing instinct records use a
        # natural-language `trigger` + `action` shape with status=active
        # for the matcher to pick them up. We keep the schema minimal
        # and let the intuition engine refine the trigger via its
        # normal LearningWorkflow pass.
        now_iso = datetime.now(timezone.utc).isoformat()
        ts = now_iso.replace(":", "-").replace(".", "-")[:19] + "Z"
        short = hashlib.sha256(
            f"{pattern_path}\x00{rule}".encode("utf-8")
        ).hexdigest()[:8]
        name = f"{ts}-{short}"
        fm_lines = [
            "---",
            'type: "instinct"',
            f'created: "{now_iso}"',
            f'rule: {json.dumps(rule)}',
            f'trigger: {json.dumps(rule)}',
            f'action: {json.dumps(proposed_action)}' if proposed_action else 'action: null',
            f'matter_ref: {json.dumps(matter_ref) if matter_ref else "null"}',
            'status: "active"',
            'source_kind: "pattern_adoption"',
            f'source_path: "{pattern_path}"',
            "---",
            "",
            f"# Instinct: {rule}",
            "",
            f"Adopted from pattern `{pattern_path}` at {now_iso}.",
            "",
            f"**When**: {rule}",
            f"**Then**: {proposed_action}" if proposed_action else "",
            "",
            f"*Evidence at adoption*: {evidence}" if evidence else "",
        ]
        content = "\n".join([line for line in fm_lines if line != ""]) + "\n"

    from src.utils.vault_client import VaultClient
    cfg = load_config()
    vault = VaultClient(cfg)
    try:
        instinct_path = await vault.write_record(
            record_type="instinct", name=name, content=content,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("adopt_instinct: write failed: %s", exc)
        return {"ok": False, "reason": f"write error: {exc}"}
    finally:
        await vault.close()

    # Mark the pattern proposal as adopted so it drops off /desk.
    async with _http() as client:
        await client.patch(
            f"/api/v1/vault/records/{pattern_path}",
            json={
                "set": {
                    "status": "adopted",
                    "adopted_at": datetime.now(timezone.utc).isoformat(),
                    "adopted_as": instinct_path,
                },
            },
        )

    logger.info(
        "adopt_instinct: %s -> %s (rule: %s)",
        pattern_path, instinct_path, rule[:60],
    )
    return {"ok": True, "instinct_path": instinct_path, "rule": rule}


@activity.defn
async def reject_pattern_proposal(pattern_path: str) -> dict[str, Any]:
    """Mark a pattern proposal as rejected.

    Called when the principal clicks Delete on a pattern-proposal
    card. Flips status=rejected so it stops surfacing on /desk and the
    next DecisionPatternsWorkflow run doesn't re-propose the same rule
    (the extraction prompt sees recently-rejected rules and avoids
    them).
    """
    if not pattern_path or not pattern_path.startswith("decision_pattern/"):
        return {"ok": False, "reason": "bad pattern path"}
    async with _http() as client:
        resp = await client.patch(
            f"/api/v1/vault/records/{pattern_path}",
            json={
                "set": {
                    "status": "rejected",
                    "rejected_at": datetime.now(timezone.utc).isoformat(),
                },
            },
        )
        if resp.status_code >= 400:
            return {"ok": False, "reason": f"patch {resp.status_code}"}
    logger.info("reject_pattern: %s", pattern_path)
    return {"ok": True}
