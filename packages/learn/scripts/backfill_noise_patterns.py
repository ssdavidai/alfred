"""Backfill ``signal_noise_pattern`` records for noise decisions that never got one.

Companion to the ctrl-api fix that added ``signal_noise_pattern`` to
``KNOWN_TYPES``. Before that fix, every ``decision/<ts>.md`` with
``intent: noise`` failed silently inside DecisionRouterWorkflow's
write_noise_pattern call — the POST hit 400 and the side_effect
recorded ``noise.pattern_failed`` (or just nothing). This script
walks those orphaned decisions and synthesises the missing pattern
records.

Logic mirrors ``activities/noise_patterns.write_noise_pattern`` but
runs as a one-shot script so we don't have to re-trigger the
DecisionRouterWorkflow on every stuck decision.

Idempotent: skips any decision whose side_effects already include
``noise_pattern_path``, OR whose pattern signature already exists on
disk.

USAGE
-----

Inside the alfred-learn container::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.backfill_noise_patterns [--dry-run]
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import httpx


logger = logging.getLogger("backfill-noise-patterns")


def _ctrl_url() -> str:
    return os.environ.get("ALFRED_CTRL_URL", "http://ctrl-api:3100")


def _auth() -> dict[str, str]:
    api_key = os.environ.get("AAS_API_KEY", "")
    if not api_key:
        raise RuntimeError("AAS_API_KEY unset")
    return {"Authorization": f"Bearer {api_key}"}


# Mirrors derive_signature in activities/noise_patterns.py — kept inline
# here so this script is self-contained and works against the
# already-shipped ctrl-api without requiring an alfred-learn refresh.
def _normalize_sender(s: str) -> str:
    if not s:
        return ""
    m = re.search(r"<([^>]+)>", s)
    if m:
        s = m.group(1)
    return s.strip().lower()


def derive_signature(event_fm: dict[str, Any]) -> dict[str, str]:
    source_type = str(event_fm.get("source_type") or event_fm.get("source") or "").lower()
    if source_type.startswith("composio-gmail") or source_type == "gmail":
        source_type = "gmail"
    elif source_type.startswith("composio-googlecalendar") or source_type == "gcal":
        source_type = "gcal"

    if source_type == "gmail":
        sender_raw = (
            event_fm.get("from") or event_fm.get("sender") or event_fm.get("From")
        )
        sender_norm = _normalize_sender(str(sender_raw or ""))
        if sender_norm:
            return {
                "kind": "gmail_sender",
                "value": sender_norm,
                "label": f"Gmail from {sender_norm}",
            }
    if source_type == "gcal":
        organiser = _normalize_sender(
            str(event_fm.get("organizer") or event_fm.get("organiser") or "")
        )
        title = str(event_fm.get("name") or event_fm.get("title") or "")
        title_norm = re.sub(r"[^\w\s]", "", title).strip().lower()
        title_keywords = " ".join(title_norm.split()[:3])
        if organiser or title_keywords:
            value = f"{organiser}|{title_keywords}".strip("|")
            return {
                "kind": "gcal_organiser_title",
                "value": value,
                "label": f"Calendar: {organiser or 'unknown'} / {title_keywords or 'unknown'}",
            }
    tags = event_fm.get("alfred_tags") or event_fm.get("topic_tags") or []
    first_tag = ""
    if isinstance(tags, list) and tags:
        first_tag = str(tags[0]).strip().lower()
    value = f"{source_type}|{first_tag}".strip("|")
    return {
        "kind": "source_type_topic",
        "value": value or source_type or "unknown",
        "label": f"{source_type or 'unknown'} / {first_tag or 'no-topic'}",
    }


@dataclass
class Stats:
    noise_decisions: int = 0
    already_patterned: int = 0
    no_source: int = 0
    no_event: int = 0
    duplicate_signature: int = 0
    patterns_written: int = 0
    errors: int = 0
    error_messages: list[str] = field(default_factory=list)


async def _run(args: argparse.Namespace) -> Stats:
    stats = Stats()
    seen_signatures: set[tuple[str, str]] = set()

    async with httpx.AsyncClient(
        base_url=_ctrl_url(), timeout=30.0, headers=_auth(),
    ) as client:
        # 1. Pull existing patterns so we don't double-write.
        try:
            resp = await client.get(
                "/api/v1/vault/list/signal_noise_pattern?preview=500"
            )
            resp.raise_for_status()
            for r in (resp.json().get("results") or []):
                fm = r.get("frontmatter") or {}
                sig = (
                    str(fm.get("signature_kind") or ""),
                    str(fm.get("signature_value") or ""),
                )
                if sig[0]:
                    seen_signatures.add(sig)
        except httpx.HTTPError as exc:
            logger.warning("existing pattern list failed: %s", exc)

        # 2. Pull noise decisions.
        try:
            d_resp = await client.get(
                "/api/v1/decisions?limit=500"
            )
            d_resp.raise_for_status()
        except httpx.HTTPError as exc:
            stats.errors += 1
            stats.error_messages.append(f"list decisions: {exc}"[:300])
            return stats
        decisions = d_resp.json().get("decisions", []) or []
        noise_decisions = [d for d in decisions if str(d.get("intent")) == "noise"]
        stats.noise_decisions = len(noise_decisions)
        logger.info("found %d noise decisions", len(noise_decisions))

        for d in noise_decisions:
            d_id = str(d.get("id") or d.get("name") or "")
            source_record = str(d.get("source_record") or "")
            side_effects = d.get("side_effects") or {}
            if isinstance(side_effects, dict) and side_effects.get("noise_pattern_path"):
                stats.already_patterned += 1
                continue
            if not source_record.startswith("needs_attention/"):
                stats.no_source += 1
                continue

            # Read the NA record to get source_event_path.
            try:
                na_resp = await client.get(
                    f"/api/v1/vault/records/{source_record}"
                )
                na_resp.raise_for_status()
                na_fm = na_resp.json().get("frontmatter") or {}
            except httpx.HTTPError as exc:
                stats.errors += 1
                stats.error_messages.append(f"read NA {source_record}: {exc}"[:200])
                continue
            event_path = str(na_fm.get("source_event_path") or "")
            if not event_path:
                stats.no_source += 1
                continue

            # Read the event for signature derivation.
            try:
                ev_resp = await client.get(
                    f"/api/v1/vault/records/{event_path}"
                )
                ev_resp.raise_for_status()
                event_fm = ev_resp.json().get("frontmatter") or {}
            except httpx.HTTPError as exc:
                stats.no_event += 1
                continue

            sig = derive_signature(event_fm)
            sig_key = (sig["kind"], sig["value"])
            if sig_key in seen_signatures:
                stats.duplicate_signature += 1
                continue
            seen_signatures.add(sig_key)

            now_iso = datetime.now(timezone.utc).isoformat()
            ts = now_iso.replace(":", "-").replace(".", "-")[:19] + "Z"
            short = hashlib.sha256(
                f"{sig['kind']}\x00{sig['value']}".encode("utf-8")
            ).hexdigest()[:8]
            name = f"{ts}-{short}"
            note = str(d.get("note") or "")
            fm_lines = [
                "---",
                'type: "signal_noise_pattern"',
                f'name: {json.dumps(sig["label"])}',
                f'created: "{now_iso}"',
                f'signature_kind: {json.dumps(sig["kind"])}',
                f'signature_value: {json.dumps(sig["value"])}',
                f'source_type: {json.dumps(str(event_fm.get("source_type") or event_fm.get("source") or ""))}',
                f'source_decision: "decision/{d_id}.md"',
                f'source_event_path: {json.dumps(event_path)}',
                f'note: {json.dumps(note) if note else "null"}',
                'training_strength: "hard"',
                'confidence: 1.0',
                'matches: 0',
                'status: "active"',
                'backfilled: true',
                "---",
                "",
                f"# Noise pattern: {sig['label']}",
                "",
                f"Principal marked `{source_record}` as noise at {d.get('created') or now_iso}.",
                f"Backfilled from decision `decision/{d_id}.md` after the KNOWN_TYPES fix.",
                f"Source event: `{event_path}`",
                f"Signature kind: `{sig['kind']}`",
                f"Signature value: `{sig['value']}`",
            ]
            content = "\n".join(fm_lines) + "\n"

            if args.dry_run:
                logger.info(
                    "DRY-RUN would write pattern kind=%s value=%s (decision=%s)",
                    sig["kind"], sig["value"], d_id,
                )
                stats.patterns_written += 1
                continue

            try:
                w_resp = await client.post(
                    "/api/v1/vault/records",
                    json={
                        "type": "signal_noise_pattern",
                        "name": name,
                        "content": content,
                    },
                )
                w_resp.raise_for_status()
                stats.patterns_written += 1
                logger.info(
                    "wrote pattern kind=%s value=%s (from decision=%s)",
                    sig["kind"], sig["value"], d_id,
                )
            except httpx.HTTPError as exc:
                stats.errors += 1
                stats.error_messages.append(
                    f"write pattern for {d_id}: {exc}"[:300]
                )

    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    stats = asyncio.run(_run(args))
    print(f"noise_decisions:    {stats.noise_decisions}")
    print(f"already_patterned:  {stats.already_patterned}")
    print(f"no_source:          {stats.no_source}")
    print(f"no_event:           {stats.no_event}")
    print(f"duplicate_sig:      {stats.duplicate_signature}")
    print(f"patterns_written:   {stats.patterns_written}")
    print(f"errors:             {stats.errors}")
    if stats.error_messages:
        print("first errors:")
        for m in stats.error_messages[:5]:
            print(f"  - {m}")
    return 1 if stats.errors else 0


if __name__ == "__main__":
    sys.exit(main())
