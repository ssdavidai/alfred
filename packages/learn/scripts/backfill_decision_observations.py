"""Backfill ``observation/`` records for historical decisions with no observation_path.

Companion to OBS-1 (deterministic decision→observation). Before that
change the clerk gate rejected ~97% of decisions — 247 decisions on
david produced only 7 observations. This script walks every decision
that has no ``side_effects.observation_path`` and synthesises the
missing observation deterministically, using the same fact / topic /
sender derivation as ``activities/decision_observations``.

Idempotent: skips decisions that already carry an observation_path.

USAGE
-----

Inside the alfred-learn container::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.backfill_decision_observations [--dry-run]

Flags::

    --dry-run     Print what would happen without writing.
    --batch-size  Log progress every N decisions (default 50).
    --verbose     DEBUG-level logging.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx


logger = logging.getLogger("backfill-decision-obs")


_INTENT_VERBS = {
    "delegate": "Delegated to Alfred",
    "defer": "Deferred",
    "done": "Closed",
    "take_mine": "Took personally",
    "noise": "Marked as noise",
    "approve": "Approved",
    "auto_dispatch": "Acted autonomously",
}


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


def _ctrl_url() -> str:
    return os.environ.get("ALFRED_CTRL_URL", "http://ctrl-api:3100")


def _auth() -> dict[str, str]:
    api_key = os.environ.get("AAS_API_KEY", "")
    if not api_key:
        raise RuntimeError("AAS_API_KEY unset")
    return {"Authorization": f"Bearer {api_key}"}


async def _resolve_sender(
    client: httpx.AsyncClient, source_record: str,
) -> str:
    """Sender resolution — delegate to the activity so the backfill
    schema stays in lockstep with the live writer. Imports here at
    call time rather than module top so the script can still load when
    the temporalio runtime isn't on path (activity decorator imports
    temporalio)."""
    from src.activities.decision_observations import (
        _resolve_sender_for_needs_attention,
    )
    return await _resolve_sender_for_needs_attention(client, source_record)


@dataclass
class Stats:
    decisions: int = 0
    already_observed: int = 0
    backfilled: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)


async def _run(args: argparse.Namespace) -> Stats:
    stats = Stats()
    async with httpx.AsyncClient(
        base_url=_ctrl_url(), timeout=30.0, headers=_auth(),
    ) as client:
        # ctrl-api /api/v1/decisions has paging; pull a large batch
        try:
            resp = await client.get("/api/v1/decisions?limit=500")
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            stats.errors += 1
            stats.error_messages.append(f"list decisions: {exc}"[:300])
            return stats
        decisions = resp.json().get("decisions", []) or []
        stats.decisions = len(decisions)
        logger.info("scanned %d decision records", len(decisions))

        for idx, d in enumerate(decisions):
            if idx and idx % args.batch_size == 0:
                logger.info(
                    "progress %d/%d backfilled=%d skipped=%d",
                    idx, len(decisions), stats.backfilled, stats.already_observed,
                )
            side_effects = d.get("side_effects") or {}
            existing_obs = (
                side_effects.get("observation_path")
                if isinstance(side_effects, dict)
                else None
            )
            if isinstance(existing_obs, str) and existing_obs.strip():
                stats.already_observed += 1
                continue

            intent = str(d.get("intent") or "").strip()
            source = str(d.get("source") or "").strip()
            note = str(d.get("note") or "").strip()
            headline = str(d.get("source_headline") or "").strip()
            matter_ref = str(d.get("matter_ref") or "").strip()
            decision_id = str(d.get("id") or d.get("name") or "")
            source_record = str(d.get("source_record") or "").strip()
            principal_actor = str(d.get("principal") or "principal").strip().lower() or "principal"

            verb = _INTENT_VERBS.get(intent, f"Decided ({intent})") if intent else "Decided"
            src_label = source or "unknown"
            fact_parts = [f"{verb} on {src_label}"]
            if headline:
                fact_parts.append(f"'{headline}'")
            if note:
                fact_parts.append(f"[note: {note}]")
            fact_clean = " ".join(fact_parts)
            topic = _derive_topic(source, intent, headline)

            sender = await _resolve_sender(client, source_record)
            subject = (
                "principal_via_alfred" if principal_actor in ("alfred", "agent") else "principal"
            )

            # Use the decision's own `created` timestamp so the backfilled
            # observation has the right chronological position.
            created_raw = str(d.get("created") or "").strip()
            try:
                now_dt = datetime.fromisoformat(created_raw.replace("Z", "+00:00"))
            except Exception:  # noqa: BLE001
                now_dt = datetime.now(timezone.utc)
            now_iso = now_dt.isoformat()
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
                'backfilled: true',
                "---",
                "",
                f"Backfilled from decision `decision/{decision_id}.md`.",
            ]
            content = "\n".join(fm_lines) + "\n"

            if args.dry_run:
                logger.debug("DRY-RUN would backfill %s", decision_id)
                stats.backfilled += 1
                continue

            try:
                w_resp = await client.post(
                    "/api/v1/vault/records",
                    json={
                        "type": "observation",
                        "name": name,
                        "content": content,
                    },
                )
                w_resp.raise_for_status()
                stats.backfilled += 1
            except httpx.HTTPError as exc:
                stats.errors += 1
                stats.error_messages.append(
                    f"write obs for {decision_id}: {exc}"[:300]
                )

    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    stats = asyncio.run(_run(args))
    print(f"decisions:          {stats.decisions}")
    print(f"already_observed:   {stats.already_observed}")
    print(f"backfilled:         {stats.backfilled}")
    print(f"errors:             {stats.errors}")
    if stats.error_messages:
        print("first errors:")
        for m in stats.error_messages[:5]:
            print(f"  - {m}")
    return 1 if stats.errors else 0


if __name__ == "__main__":
    sys.exit(main())
