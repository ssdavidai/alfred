"""LLM-based category inference for unclustered transaction groups.

The TF-IDF + keyword pipeline tops out around 50-60% coverage on a
real household. The remaining 40-50% are individual contractor names,
single-occurrence merchants, and Hungarian phrases without anchor
English keywords. None of those are recoverable by name-token
clustering — but most of them are *trivial* for an LLM that knows
who Sir is and what Hungarian patika/orvosi/etterem mean.

This module sends batched cluster proposals (each with canonical
name + member name samples + dominant currency + account + amount
range) to Claude via the OpenClaw gateway's OpenAI-compatible
`/v1/chat/completions` endpoint, asks for a structured category +
tag + role per cluster, and returns the proposals merged in.

Design notes:
- Batched (50 clusters per prompt) to minimise round-trips.
- Uses /v1/chat/completions, not the heavier sessions_spawn pattern
  (which costs 30-180s per call). LLM inference here is one-shot
  classification, no tool use needed → fast path is correct.
- All LLM calls go through OpenClaw — never direct Anthropic per
  packages/learn/CLAUDE.md.
- Hard cap on prompt size (50 clusters × ~200 chars each ≈ 10k
  tokens). Caller is responsible for splitting bigger sets.
- Returns proposals in the same shape as cluster_transactions so
  the caller can merge them transparently.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx

logger = logging.getLogger(__name__)

LLM_BATCH_SIZE = 50
LLM_MODEL = os.environ.get("SURE_CLUSTER_LLM_MODEL", "x-ai/grok-4.1-fast")
LLM_TIMEOUT_SECONDS = float(os.environ.get("SURE_CLUSTER_LLM_TIMEOUT", "60"))


@dataclass
class LLMProposal:
    canonical_name: str
    proposed_category: str | None
    proposed_tag: str | None
    role: str
    confidence: float

    def asdict(self) -> dict[str, Any]:
        return {
            "canonical_name": self.canonical_name,
            "proposed_category": self.proposed_category,
            "proposed_tag": self.proposed_tag,
            "role": self.role,
            "confidence": self.confidence,
        }


def _build_prompt(
    clusters: list[dict[str, Any]],
    categories: list[str],
    tags: list[str],
) -> str:
    """Build a single-shot classification prompt for one batch."""
    blocks = []
    for c in clusters:
        members = c.get("member_names", [])[:3]
        blocks.append(
            f"- canonical: {c['canonical_name']!r}\n"
            f"  samples: {members}\n"
            f"  count: {c.get('txn_count', 0)}\n"
            f"  currency: {c.get('dominant_currency', '?')}  "
            f"account: {c.get('dominant_account', '?')}"
        )
    cats_csv = ", ".join(categories)
    tags_csv = ", ".join(tags) if tags else "(none)"
    return f"""You are categorising bank-feed transaction clusters for a Hungarian household personal-finance app.

For each cluster below, propose a category and (optionally) a tag and role.

Available categories (pick exactly one or null): {cats_csv}
Available tags (pick zero or one): {tags_csv}
Roles: merchant | transfer | income | fee | unknown

Rules:
- An individual person's name (e.g. "RANDAL ALAN JOHNSON") is usually income from a contractor or recurring payment from a relative — pick "Income" or "Transfers".
- Hungarian "patika" / "gyógyszertár" / "orvosi" → Healthcare.
- Hungarian "etterem" / "kebab" / "burger" / "pizza" / "pekseg" → Food & Drink.
- "fizetés" / "fizetõ" / "fizetoaut" / "Pm-abacus" → Income (salary).
- Internal account-to-account moves (Wise, Revolut, "Exchanged to", currency tickers, "Top-Up") → Transfers.
- Cashback / reward / "BALANCE-" / Revolut interest → Income.
- If genuinely ambiguous, return null category and role "unknown".

Return ONLY a JSON array, one object per cluster, in the SAME ORDER as the input. Schema:
[{{"canonical_name": "...", "proposed_category": "...", "proposed_tag": "..." or null, "role": "...", "confidence": 0.0-1.0}}]

CLUSTERS:
{chr(10).join(blocks)}

Your entire response must be a valid JSON array. No prose, no markdown, no explanation."""


async def _post_chat(
    base_url: str,
    token: str,
    prompt: str,
    model: str = LLM_MODEL,
    timeout_s: float = LLM_TIMEOUT_SECONDS,
) -> str:
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 4000,
        "temperature": 0.1,
    }
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        resp = await client.post(
            f"{base_url.rstrip('/')}/v1/chat/completions",
            headers=headers,
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError(f"empty completion: {data}")
    msg = choices[0].get("message", {})
    content = msg.get("content", "")
    if not isinstance(content, str):
        raise RuntimeError(f"non-string completion content: {content!r}")
    return content


def _parse_response(raw: str, expected: list[dict[str, Any]]) -> list[LLMProposal]:
    """Parse the LLM's JSON-array response into proposals.

    Tolerant of preamble/postscript noise and codeblock wrappers.
    Maps responses back to inputs by canonical_name (in case the LLM
    reorders the list).
    """
    text = raw.strip()
    # Strip markdown code-block fences
    if text.startswith("```"):
        text = text.strip("`")
        # Drop the language tag line if present
        if "\n" in text:
            text = text.split("\n", 1)[1]
    # Find the first '[' and last ']' to peel off any prose preamble
    start = text.find("[")
    end = text.rfind("]")
    if start >= 0 and end > start:
        text = text[start : end + 1]
    items = json.loads(text)
    if not isinstance(items, list):
        raise ValueError("LLM did not return a JSON array")

    out_by_name: dict[str, LLMProposal] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("canonical_name") or "").strip()
        if not name:
            continue
        out_by_name[name.lower()] = LLMProposal(
            canonical_name=name,
            proposed_category=item.get("proposed_category") or None,
            proposed_tag=item.get("proposed_tag") or None,
            role=str(item.get("role") or "unknown"),
            confidence=float(item.get("confidence") or 0.0),
        )

    # Re-order to match input
    ordered: list[LLMProposal] = []
    for c in expected:
        key = str(c.get("canonical_name") or "").strip().lower()
        if key in out_by_name:
            ordered.append(out_by_name[key])
    return ordered


async def infer_categories_for_clusters(
    clusters: list[dict[str, Any]],
    *,
    available_categories: list[str],
    available_tags: list[str],
    base_url: str,
    token: str,
    model: str = LLM_MODEL,
    batch_size: int = LLM_BATCH_SIZE,
) -> list[LLMProposal]:
    """Run LLM inference over unclustered groups, return one proposal per group.

    Args:
        clusters: list of cluster dicts (from cluster_transactions). Only
            those with a missing/None proposed_category should be passed —
            this function does NOT filter; the caller controls scope.
        available_categories: list of valid category NAMES on this tenant.
        available_tags: list of valid tag names (or empty list).
        base_url: OpenClaw gateway URL (e.g. http://openclaw:18789).
        token: gateway bearer token.
        model: LLM model to use; defaults to grok-4.1-fast (fast,
            relatively cheap, OpenAI-compatible).
        batch_size: clusters per LLM call.

    Returns:
        Flat list of LLMProposal — one per input cluster (or empty
        list on total failure). Caller is responsible for merging
        these back into cluster proposals.
    """
    if not clusters:
        return []

    out: list[LLMProposal] = []
    for i in range(0, len(clusters), batch_size):
        batch = clusters[i : i + batch_size]
        prompt = _build_prompt(batch, available_categories, available_tags)
        try:
            raw = await _post_chat(base_url, token, prompt, model=model)
            parsed = _parse_response(raw, batch)
            out.extend(parsed)
        except (httpx.HTTPError, json.JSONDecodeError, ValueError, RuntimeError) as e:
            logger.warning(
                "LLM cluster inference batch %d-%d failed: %s",
                i,
                i + len(batch),
                e,
            )
            # Skip the batch; don't let one bad call sink the whole run.
            continue
    return out
