"""One-shot voicer for already-written needs-attention records.

Reads every pending needs_attention/*.md record in the vault, calls the
clerk LLM with a SOUL-anchored prompt, and patches the record's
frontmatter with display_headline + display_body. Idempotent — records
that already have both fields are skipped.

Run inside a tenant container:
    docker exec -it compose-alfred-learn-1 python -m scripts.backfill_voice_needs_attention
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import sys

import httpx

from src.config import load_config
from src.utils.vault_client import VaultClient

logger = logging.getLogger("backfill-voice")
logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")


# Inline clerk caller — mirrors src.activities.clerk._call_clerk but with
# a longer spawn timeout (180s vs 60s). The default 60s clips legitimate
# spawns on a warming-up workers gateway (the in-tree implementation
# trips a ReadTimeout when the gateway takes ~80-120s to allocate a
# subagent; the workers logs confirm those allocations *do* succeed
# eventually). Self-contained here so the fix doesn't touch the shared
# library used by all activities.
async def _call_clerk_voice(prompt: str) -> dict | None:
    cfg = load_config()
    token = cfg.gateway_token()
    base = cfg.openclaw_workers_gateway_url
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=180.0) as client:
        spawn = await client.post(
            f"{base}/tools/invoke",
            headers=headers,
            json={
                "tool": "sessions_spawn",
                "args": {
                    "task": prompt,
                    "agentId": cfg.clerk_agent_id,
                    "mode": "run",
                    "cleanup": "auto",
                    "sandbox": "inherit",
                    "runTimeoutSeconds": 180,
                },
            },
        )
        spawn.raise_for_status()
        session_key = None
        for item in spawn.json().get("result", {}).get("content", []):
            if isinstance(item, dict) and item.get("type") == "text":
                try:
                    inner = json.loads(item["text"])
                    session_key = inner.get("childSessionKey")
                except (json.JSONDecodeError, KeyError):
                    pass
        if not session_key:
            return None

    async with httpx.AsyncClient(timeout=90.0) as client:
        for _ in range(40):
            await asyncio.sleep(8)
            try:
                hist = await client.post(
                    f"{base}/tools/invoke",
                    headers=headers,
                    json={
                        "tool": "sessions_history",
                        "args": {"sessionKey": session_key, "limit": 5},
                    },
                )
                if hist.status_code != 200:
                    continue
                data = hist.json()
            except Exception:  # noqa: BLE001
                continue
            messages: list = []
            for item in data.get("result", {}).get("content", []):
                if isinstance(item, dict) and item.get("type") == "text":
                    try:
                        messages = json.loads(item["text"]).get("messages", [])
                    except (json.JSONDecodeError, TypeError):
                        pass
            for msg in messages:
                if msg.get("role") != "assistant":
                    continue
                c = msg.get("content", "")
                text = c if isinstance(c, str) else " ".join(
                    p.get("text", "") for p in c
                    if isinstance(p, dict) and p.get("type") == "text"
                )
                if not text.strip():
                    continue
                try:
                    return json.loads(text.strip())
                except json.JSONDecodeError:
                    m = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", text)
                    if m:
                        try:
                            return json.loads(m.group(1).strip())
                        except json.JSONDecodeError:
                            pass
                    m = re.search(r"\{[\s\S]*\}", text)
                    if m:
                        try:
                            return json.loads(m.group(0))
                        except json.JSONDecodeError:
                            pass
                    return None
    return None


VOICE_PROMPT = """You are Alfred, the principal's agentic butler.

A signal already passed through the upstream extractor and produced a "needs attention" card. You now have to write the two surface fields Sir actually reads on his desk: `display_headline` and `display_body`. The card itself, plus its source quote, is below.

Voice — grounded in SOUL.md:

- Genuinely helpful, not performatively helpful. No "Great question!", no "I noticed…!", no apologies. Skip filler.
- Have an opinion. Suggest the thing. If there's a real tradeoff, name it in a phrase, then recommend.
- Proactive: frame what happened as you noticing on Sir's behalf and what you'd suggest doing. First person sparingly ("I'd update the card", "I'd skip this").
- Concise. Headline ≤ 9 words, fragment OK, verb-driven. Body 1-2 sentences, ≤ 240 chars total. Em dashes welcome.
- Refer to Sir as "you" in the body.
- No jargon, no decision codes, no confidence scores, no record IDs.

Existing card fields (machine output, do not echo verbatim):

action_what: {action_what}
decision_reason: {decision_reason}
target_path: {target_path}
suggested_actor: {suggested_actor}

Source snippet from the original event:

```
{raw_quote}
```

Machine reasoning (router notes, paraphrase if useful):

```
{reasoning}
```

Emit STRICT JSON, no preamble, no code fences:

{{
  "display_headline": "<≤9 words, in Alfred's voice>",
  "display_body": "<1-2 sentences, ≤240 chars, in Alfred's voice — what happened + what you'd suggest>"
}}
"""


async def voice_one(client: VaultClient, rec_path: str) -> dict | None:
    """Fetch one needs-attention record, voice it, patch it back."""
    try:
        rec = await client.read_record(rec_path)
    except httpx.HTTPError as exc:
        logger.warning("%s: fetch failed: %s", rec_path, exc)
        return None
    fm = rec.get("frontmatter") or {}
    if (
        isinstance(fm.get("display_headline"), str)
        and fm["display_headline"].strip()
        and isinstance(fm.get("display_body"), str)
        and fm["display_body"].strip()
    ):
        logger.info("%s: already voiced, skipping", rec_path)
        return {"skipped": True}

    prompt = VOICE_PROMPT.format(
        action_what=str(fm.get("action_what") or "").strip() or "(no action text)",
        decision_reason=str(fm.get("decision_reason") or "").strip() or "(none)",
        target_path=str(fm.get("target_path") or "").strip() or "(none)",
        suggested_actor=str(fm.get("suggested_actor") or "").strip() or "(none)",
        raw_quote=str(fm.get("raw_quote") or "").strip() or "(empty)",
        reasoning=str(fm.get("reasoning") or "").strip() or "(none)",
    )

    result = None
    last_exc: Exception | None = None
    for attempt in range(3):
        if attempt:
            await asyncio.sleep(5 * attempt)
        try:
            result = await _call_clerk_voice(prompt)
            if result is not None:
                break
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            logger.info(
                "%s: clerk attempt %d failed (%s); retrying",
                rec_path, attempt + 1, type(exc).__name__,
            )
    if result is None:
        logger.warning(
            "%s: clerk failed after retries: %s (%s)",
            rec_path,
            last_exc,
            type(last_exc).__name__ if last_exc else "unknown",
        )
        return None

    if not isinstance(result, dict):
        logger.warning("%s: clerk returned non-dict: %r", rec_path, result)
        return None

    headline = str(result.get("display_headline") or "").strip()[:200]
    body = str(result.get("display_body") or "").strip()[:600]
    if not headline or not body:
        logger.warning("%s: clerk returned empty fields", rec_path)
        return None

    try:
        await client.patch_frontmatter(
            rec_path,
            {"display_headline": headline, "display_body": body},
        )
    except httpx.HTTPError as exc:
        logger.warning("%s: patch failed: %s", rec_path, exc)
        return None

    logger.info("%s: voiced — %r", rec_path, headline)
    return {"headline": headline, "body": body}


async def main() -> int:
    cfg = load_config()
    client = VaultClient(cfg)
    try:
        try:
            records = await client.list_records("needs_attention", status="pending")
        except httpx.HTTPError as exc:
            logger.error("list failed: %s", exc)
            return 2
        logger.info("found %d pending needs-attention records", len(records))
        ok = skipped = failed = 0
        for r in records:
            path = r.get("path") if isinstance(r, dict) else None
            if not path:
                continue
            out = await voice_one(client, path)
            if out is None:
                failed += 1
            elif out.get("skipped"):
                skipped += 1
            else:
                ok += 1
        logger.info(
            "backfill complete: voiced=%d skipped=%d failed=%d",
            ok, skipped, failed,
        )
        return 0 if failed == 0 else 1
    finally:
        await client.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
