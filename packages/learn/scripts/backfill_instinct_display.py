"""Backfill ``display_name`` + ``display_body`` on instincts.

Each instinct record currently has structured fields (``description``,
``rule``, ``action``, ``input_patterns``, ``intent_key``) but no
principal-facing surface:

* **display_name** — a short, human title (≤ 50 chars) used in row
  headers on ``/instincts``.
* **display_body** — markdown-formatted contextual explanation of
  what the pattern does and why it matters, surfaced when the row is
  expanded.

Sir's feedback (2026-05-13): the page currently shows the kebab slug
("escalate-payment-failures-and-billing"), which is truncated and
machine-y. The slug → title-case heuristic in the frontend is a
placeholder; this script writes the canonical fields once via clerk.

Idempotent — skips instincts that already have both fields. Re-run
with ``--force`` to overwrite.

USAGE
-----

Inside the alfred-learn container::

    docker exec compose-alfred-learn-1 \\
        python -m scripts.backfill_instinct_display [--dry-run] [--force]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import httpx

from src.activities.clerk import _call_clerk


logger = logging.getLogger("backfill-instinct-display")


def _ctrl_url() -> str:
    return os.environ.get("ALFRED_CTRL_URL", "http://ctrl-api:3100")


def _auth() -> dict[str, str]:
    api_key = os.environ.get("AAS_API_KEY", "")
    if not api_key:
        raise RuntimeError("AAS_API_KEY unset")
    return {"Authorization": f"Bearer {api_key}"}


def _build_prompt(fm: dict[str, Any]) -> str:
    """Compose a clerk prompt that returns JSON {display_name, display_body}.

    Feeds it everything we have on the instinct so the prose is grounded
    in real fields, not invented.
    """
    description = str(fm.get("description") or "").strip()
    rule = str(fm.get("rule") or "").strip()
    action = str(fm.get("action") or "").strip()
    intent = str(fm.get("intent_key") or "").strip()
    sender_key = str(fm.get("sender_key") or "").strip()

    input_patterns = fm.get("input_patterns") or {}
    if not isinstance(input_patterns, dict):
        input_patterns = {}
    domains = list(input_patterns.get("sender_domains") or [])[:12]
    keywords = list(input_patterns.get("subject_keywords") or [])[:12]
    input_types = list(input_patterns.get("input_types") or [])

    alfred_tags = list(fm.get("alfred_tags") or [])[:8]

    fields_block = []
    if description:
        fields_block.append(f"- description: {description}")
    if rule:
        fields_block.append(f"- rule: {rule}")
    if action:
        fields_block.append(f"- action: {action}")
    if intent:
        fields_block.append(f"- intent: {intent}")
    if sender_key:
        fields_block.append(f"- sender_key: {sender_key}")
    if domains:
        fields_block.append(f"- sender_domains: {', '.join(domains)}")
    if keywords:
        fields_block.append(f"- subject_keywords: {', '.join(keywords)}")
    if input_types:
        fields_block.append(f"- input_types: {', '.join(input_types)}")
    if alfred_tags:
        fields_block.append(f"- alfred_tags: {', '.join(alfred_tags)}")

    fields_text = "\n".join(fields_block) or "(no structured fields)"

    return (
        "You are writing principal-facing labels for one of Alfred's instincts "
        "(learned patterns). An instinct is a rule about how to handle inbound "
        "events.\n\n"
        "From the structured fields below, produce:\n"
        "  • display_name: a short, human title for the row. ≤ 50 chars. "
        "Sentence case. No trailing period. Imperative or descriptive — "
        "e.g. \"Escalate payment failures\", \"Suppress newsletter noise\", "
        "\"Surface family-health threads\". Avoid jargon like \"input pattern\".\n"
        "  • display_body: a 60-140 word markdown explanation answering "
        "\"what does this pattern do, and why?\". Address the principal as "
        "\"you\" / \"your\". Use **bold** sparingly for the action verb. "
        "Mention concrete senders or keywords where they help. End with a "
        "sentence explaining the *why* — what would go wrong without the "
        "pattern, or why the principal would want this routed this way.\n\n"
        "Structured fields:\n"
        f"{fields_text}\n\n"
        "Respond with ONLY a JSON object of shape "
        '{"display_name": "...", "display_body": "..."}. No prose around it.'
    )


def _parse_response(raw: Any) -> tuple[str, str]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return "", ""
    if not isinstance(raw, dict):
        return "", ""
    name = str(raw.get("display_name") or "").strip().strip('"').strip("'")
    body = str(raw.get("display_body") or "").strip()
    # Truncate name to 50 chars; if longer, prefer cutting at a space.
    if len(name) > 50:
        cut = name[:50].rsplit(" ", 1)[0]
        name = (cut or name[:50]).rstrip(",;-")
    return name, body


@dataclass
class Stats:
    instincts: int = 0
    already_done: int = 0
    written: int = 0
    failures: int = 0
    skipped_deprecated: int = 0
    errors: list[str] = field(default_factory=list)


async def _run(args: argparse.Namespace) -> Stats:
    stats = Stats()
    async with httpx.AsyncClient(
        base_url=_ctrl_url(), timeout=120.0, headers=_auth(),
    ) as client:
        r = await client.get("/api/v1/vault/list/instinct?preview=0")
        r.raise_for_status()
        instincts = r.json().get("results", []) or []
        stats.instincts = len(instincts)
        logger.info("found %d instincts", len(instincts))

        for idx, inst in enumerate(instincts):
            path = str(inst.get("path") or "")
            fm = inst.get("frontmatter") or {}
            if not path or not isinstance(fm, dict):
                continue

            status = str(fm.get("status") or "").lower()
            if status in ("deprecated", "merged"):
                stats.skipped_deprecated += 1
                continue

            has_name = bool(str(fm.get("display_name") or "").strip())
            has_body = bool(str(fm.get("display_body") or "").strip())
            if has_name and has_body and not args.force:
                stats.already_done += 1
                continue

            logger.info(
                "[%d/%d] %s  (name=%s body=%s)",
                idx + 1, len(instincts), path,
                "✓" if has_name else "·",
                "✓" if has_body else "·",
            )

            prompt = _build_prompt(fm)
            try:
                raw = await _call_clerk(prompt)
            except Exception as exc:  # noqa: BLE001
                stats.failures += 1
                stats.errors.append(f"clerk {path}: {str(exc)[:160]}")
                logger.warning("clerk failed for %s: %s", path, exc)
                if args.sleep > 0:
                    await asyncio.sleep(args.sleep)
                continue

            name, body = _parse_response(raw)
            if not name or not body:
                stats.failures += 1
                stats.errors.append(f"parse {path}: empty fields")
                logger.warning(
                    "parse failure for %s: name=%r body_len=%d",
                    path, name, len(body),
                )
                if args.sleep > 0:
                    await asyncio.sleep(args.sleep)
                continue

            logger.info("  → name: %s", name)
            logger.debug("  → body (%d chars): %s", len(body), body[:200])

            if args.dry_run:
                if args.sleep > 0:
                    await asyncio.sleep(args.sleep)
                continue

            try:
                pr = await client.patch(
                    f"/api/v1/vault/records/{quote(path, safe='')}",
                    json={"json_set": {"display_name": name, "display_body": body}},
                )
                pr.raise_for_status()
                stats.written += 1
            except httpx.HTTPError as exc:
                stats.failures += 1
                stats.errors.append(f"patch {path}: {str(exc)[:160]}")
                logger.warning("patch failed for %s: %s", path, exc)

            if args.sleep > 0:
                await asyncio.sleep(args.sleep)

    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--force", action="store_true",
        help="Overwrite display_name/display_body even when already set.",
    )
    parser.add_argument(
        "--sleep", type=float, default=1.0,
        help="Seconds to sleep between clerk calls (default 1.0).",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    stats = asyncio.run(_run(args))
    print(f"instincts:           {stats.instincts}")
    print(f"already_done:        {stats.already_done}")
    print(f"skipped_deprecated:  {stats.skipped_deprecated}")
    print(f"written:             {stats.written}")
    print(f"failures:            {stats.failures}")
    if stats.errors:
        print("first errors:")
        for m in stats.errors[:5]:
            print(f"  - {m}")
    return 1 if stats.failures and not args.dry_run else 0


if __name__ == "__main__":
    sys.exit(main())
