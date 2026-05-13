"""Extract observations from decisions — close the training loop.

Sir's Progressive Autonomy thesis: every Desk click is data. The
former implementation (clerk-gated extractor) rejected ~97% of
decisions as "not an observable fact" — 247 decisions on david
produced 7 observations. That defeats the loop: the intuition engine
has almost nothing to learn from.

This module now produces **one observation per decision,
deterministically.** No LLM gate. The decision IS the lesson:
* the gesture itself (intent)
* on a known source (source_kind)
* about a specific thing (source_headline)
* with optional context (note)
* tied to a matter (matter_ref)
* and, when traceable through needs_attention → signal, an underlying
  ``sender`` for clustering.

The observation schema matches the canonical Option A shape: type,
name, created, subject, fact, topic, source_kind, source_path,
matter_ref, sender, intent, confidence, status.

The pattern-proposal acceptor (formerly ``adopt_instinct_from_pattern``
in this file) lives in decision_router.py now as a side-effect on
intent=delegate when source=pattern_proposal — see OBS-5.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
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


# The old clerk-gated observation prompt lived here. Removed because
# every decision now becomes an observation deterministically — the
# clerk gate was filtering out 97% of decisions and starving the
# intuition engine. See the new ``extract_observation_from_decision``
# below for the deterministic builder.


# Verb labels used in the deterministic fact sentence. Stable, human-
# readable, and what the clusterer keys on when it later groups
# observations by intent — keep the values short and predictable, not
# user-facing prose.
_INTENT_VERBS = {
    "delegate": "Delegated to Alfred",
    "defer": "Deferred",
    "done": "Closed",
    "take_mine": "Took personally",
    "noise": "Marked as noise",
    "approve": "Approved",
    "auto_dispatch": "Acted autonomously",
}


# Topic heuristic — keep it short and stable so observations of the
# same source-kind/intent combination cluster. The PatternDetection
# clusterer uses (subject, topic, sender) as its primary signature.
def _derive_topic(source: str, intent: str, headline: str) -> str:
    if source == "needs_attention":
        if intent == "noise":
            return "inbound-noise"
        if intent == "delegate":
            return "delegate-to-alfred"
        if intent == "defer":
            return "defer-attention"
        if intent in ("done", "take_mine"):
            return "handle-attention"
        return "attention-decision"
    if source == "approval":
        return "approval-response"
    if source == "pattern_proposal":
        return "pattern-approval" if intent in ("delegate", "approve") else "pattern-rejection"
    if source == "to_do":
        return "todo-followthrough"
    if source == "judgment":
        return "judgment-acknowledgement"
    return f"{source or 'unknown'}-{intent or 'decision'}"


async def _resolve_sender_for_needs_attention(
    client: httpx.AsyncClient, source_record: str,
) -> str:
    """Best-effort: chase decision → needs_attention → signal →
    stream_event and run the same sender extractor the signal-side
    observations use.

    The signal record's frontmatter is LLM-extracted and does NOT
    carry a structured ``raw.from`` — it stores the rendered email
    headers inside ``raw_quote`` (a string) plus a
    ``source_event_path`` pointing at the upstream stream_event. The
    stream_event frontmatter is where the structured sender info
    actually lives, and where we already have a battle-tested
    extractor (signal_observations._extract_sender_from_event).
    Reuse it here so OBS-1 + OBS-2 stay in lockstep.

    Cheap and cached by the in-process mtime cache. Returns "" if any
    step fails — sender is optional on the observation.
    """
    if not source_record.startswith("needs_attention/"):
        return ""
    try:
        resp = await client.get(f"/api/v1/vault/records/{source_record}")
        if resp.status_code >= 400:
            return ""
        na_fm = (resp.json().get("frontmatter") or {})
    except Exception:  # noqa: BLE001
        return ""
    sig_path = str(na_fm.get("source_signal_path") or "").strip()
    if not sig_path:
        return ""
    try:
        sig_resp = await client.get(f"/api/v1/vault/records/{sig_path}")
        if sig_resp.status_code >= 400:
            return ""
        sig_fm = (sig_resp.json().get("frontmatter") or {})
    except Exception:  # noqa: BLE001
        return ""

    # First try the (rare) structured fields on the signal itself, in
    # case a future signal writer emits them — cheap and harmless.
    raw = sig_fm.get("raw") or {}
    if isinstance(raw, dict):
        for k in ("from", "From", "sender", "from_email", "organizer", "organiser"):
            v = raw.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    for k in ("from", "sender", "organizer", "organiser"):
        v = sig_fm.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()

    # Preferred source of truth: the upstream stream_event the signal
    # was extracted from. Read its frontmatter and apply the canonical
    # sender extractor.
    event_path = str(sig_fm.get("source_event_path") or "").strip()
    if event_path:
        try:
            evt_resp = await client.get(f"/api/v1/vault/records/{event_path}")
            if evt_resp.status_code < 400:
                evt_fm = (evt_resp.json().get("frontmatter") or {})
                if isinstance(evt_fm, dict):
                    from src.activities.signal_observations import (
                        _extract_sender_from_event,
                    )
                    sender = _extract_sender_from_event(evt_fm)
                    if sender:
                        return sender
        except Exception:  # noqa: BLE001
            pass  # fall through to raw_quote fallback

    # Fallback: parse the signal's own ``raw_quote`` string. The
    # signal-extract activity stores the rendered email/event preview
    # there (e.g. `**From**: "Acme" <a@example.com> **To**: ...`). Stream
    # events get purged after extraction (StreamEventPurgeWorkflow), so
    # for older decisions the stream_event lookup above 404s and this
    # fallback is the only way to recover the sender.
    return _sender_from_raw_quote(str(sig_fm.get("raw_quote") or ""))


# Matches the gmail-style "**From**: <stuff>" header that signal_extract
# embeds in raw_quote. Captures everything up to the next **Label** or
# the end of the line.
_RAW_QUOTE_FROM_RE = re.compile(
    r"\*\*From\*\*\s*:\s*(.+?)(?:\*\*To\*\*|\*\*Subject\*\*|\*\*Date\*\*|\n|$)",
    re.IGNORECASE,
)


def _sender_from_raw_quote(quote: str) -> str:
    """Extract the sender string from a signal_extract ``raw_quote``.

    The quote starts with template-emitted headers like
    ``**From**: "Acme HQ" <a@example.com> **To**: ...``. We pull the
    From: clause as a string. We deliberately do NOT canonicalise to
    ``org/...`` / ``person/...`` here — the clusterer normalises by
    casefold + namespace strip, so a raw "Acme HQ <a@example.com>"
    will bucket with an entity-resolved "org/Acme HQ" via
    ``_normalise_sender_key``.
    """
    if not quote:
        return ""
    m = _RAW_QUOTE_FROM_RE.search(quote)
    if not m:
        return ""
    val = m.group(1).strip().strip('"').strip()
    # Strip a trailing email-in-angle-brackets if present so the cluster
    # key collapses senders that show with and without a display name.
    val = re.sub(r"\s*<[^>]+>$", "", val).strip().strip('"').strip()
    return val[:120]


@activity.defn
async def extract_observation_from_decision(
    decision: dict[str, Any],
) -> dict[str, Any]:
    """Deterministically derive an observation from a decision.

    Every decision becomes an observation. No LLM gate; the gesture
    itself is the lesson. The returned shape is unchanged from the
    legacy clerk-gated version so the single caller in
    decision_router.py (route_decision) continues to stamp
    ``side_effects["observation_path"]`` correctly:

      success → {"observation_path": "<path>", "fact": <str>, "topic": <str>}
      vault-write failure → {"observation_path": None, "reason": "<...>"}

    There is no longer a "thin decision" return path — every decision
    produces a record. The fact sentence is deterministic from
    (intent, source, headline, note). If the decision's source is a
    needs_attention card, we follow the back-pointer to the underlying
    signal to enrich the ``sender`` field for clustering.
    """
    intent = str(decision.get("intent") or "").strip()
    source = str(decision.get("source") or "").strip()
    note = str(decision.get("note") or "").strip()
    headline = str(decision.get("source_headline") or "").strip()
    matter_ref = str(decision.get("matter_ref") or "").strip()
    decision_id = str(decision.get("id") or "")
    source_record = str(decision.get("source_record") or "").strip()
    principal_actor = str(decision.get("principal") or "principal").strip().lower() or "principal"

    # Build the fact sentence deterministically. Schema:
    #   "<verb> on <source_kind> '<headline>' [note: <note>]"
    verb = _INTENT_VERBS.get(intent, f"Decided ({intent})") if intent else "Decided"
    src_label = source or "unknown"
    fact_parts = [f"{verb} on {src_label}"]
    if headline:
        fact_parts.append(f"'{headline}'")
    if note:
        fact_parts.append(f"[note: {note}]")
    fact_clean = " ".join(fact_parts)

    topic = _derive_topic(source, intent, headline)

    # Enrich with sender when traceable. Cheap and cached.
    sender = ""
    try:
        async with _http() as client:
            sender = await _resolve_sender_for_needs_attention(client, source_record)
    except Exception as exc:  # noqa: BLE001
        # Sender is optional; an enrichment failure must not block
        # the observation write.
        logger.debug("extract_observation: sender enrichment skipped: %s", exc)

    # The subject says "who is the observation about". Autonomous
    # instinct-fired decisions carry principal=alfred (set by
    # signal_router in OBS-6); record that distinction so the clusterer
    # can separate "what Sir does" from "what Alfred did on Sir's
    # behalf" — both feed learning, but in different ways.
    subject = (
        "principal_via_alfred" if principal_actor in ("alfred", "agent") else "principal"
    )

    now_iso = datetime.now(timezone.utc).isoformat()
    ts = now_iso.replace(":", "-").replace(".", "-")[:19] + "Z"
    short = hashlib.sha256(
        f"{decision_id}\x00{fact_clean}".encode("utf-8")
    ).hexdigest()[:8]
    name = f"{ts}-{short}"
    name_label = fact_clean if len(fact_clean) <= 90 else fact_clean[:87] + "..."

    fm_lines = [
        "---",
        'type: "observation"',
        f"name: {json.dumps(name_label)}",
        f'created: "{now_iso}"',
        f"subject: {json.dumps(subject)}",
        f"fact: {json.dumps(fact_clean)}",
        f"topic: {json.dumps(topic)}",
        'source_kind: "decision"',
        f'source_path: "decision/{decision_id}.md"',
        f"matter_ref: {json.dumps(matter_ref) if matter_ref else 'null'}",
        f"intent: {json.dumps(intent) if intent else 'null'}",
        f"sender: {json.dumps(sender) if sender else 'null'}",
        "confidence: 1.0",
        'status: "open"',
        "---",
        "",
        f"Extracted from decision `decision/{decision_id}.md` at {now_iso}.",
    ]
    content = "\n".join(line for line in fm_lines if line != "") + "\n"

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
        "extract_observation: decision=%s -> %s (intent=%s sender=%s)",
        decision_id, path, intent, sender or "-",
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
