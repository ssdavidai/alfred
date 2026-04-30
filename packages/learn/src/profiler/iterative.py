"""Iterative multi-pass clustering loop for Sure transactions.

Single-pass `cluster_transactions()` plateaus around 50-60% coverage on
a real Hungarian household. The remaining transactions are individual
contractor names, single-occurrence merchants, and Hungarian phrases
without anchor English keywords. Pure name-token clustering can't
recover those — but a multi-pass loop combining keyword rules,
behavioural co-occurrence, and an LLM fallback typically pushes past
80%.

Pipeline per iteration:

  1. **Keyword pass** — `cluster_transactions()` over the residual
     unmatched corpus. Word-TFIDF + agglomerative cosine + the built-in
     keyword rulebook. Cheap, deterministic.

  2. **Behavioural pass** — `behavioural_groups()` over the residual.
     Catches same-account/same-amount/monthly-cadence patterns that
     name-clustering misses. Returns proposals with role but no
     category — the LLM pass fills those in.

  3. **LLM pass** (optional, gated by `use_llm`) — sends the unmatched
     groups (canonical + samples + currency + account) to Claude via
     OpenClaw `/v1/chat/completions`, asks for category + tag + role
     per group. Highest-impact step on real data.

After each iteration we mark transactions as *covered* if they belong
to any proposal with a non-null category, then re-run the passes on
the residual. The loop stops when:

  - coverage >= `target_coverage` (default 0.80), OR
  - newly-matched count < `progress_threshold` (default 5) — no
    further iteration would help, OR
  - iteration count >= `max_iterations` (default 5).

Returns the union of all proposals across all iterations, deduplicated
by canonical name (keeping the highest-confidence one).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from src.profiler.transaction_clustering import (
    ClusterProposal,
    behavioural_groups,
    cluster_transactions,
)
from src.profiler.llm_inference import infer_categories_for_clusters

logger = logging.getLogger(__name__)


@dataclass
class IterationStats:
    iteration: int
    keyword_proposals: int
    behavioural_proposals: int
    llm_proposals: int
    matched_in_iteration: int
    cumulative_matched: int
    cumulative_coverage_percent: float


@dataclass
class IterativeResult:
    proposals: list[ClusterProposal]
    stats: list[IterationStats] = field(default_factory=list)
    final_coverage_percent: float = 0.0
    total_input_count: int = 0
    final_matched_count: int = 0
    stopped_reason: str = ""

    def asdict(self) -> dict[str, Any]:
        return {
            "proposals": [p.asdict() for p in self.proposals],
            "stats": [
                {
                    "iteration": s.iteration,
                    "keyword_proposals": s.keyword_proposals,
                    "behavioural_proposals": s.behavioural_proposals,
                    "llm_proposals": s.llm_proposals,
                    "matched_in_iteration": s.matched_in_iteration,
                    "cumulative_matched": s.cumulative_matched,
                    "cumulative_coverage_percent": s.cumulative_coverage_percent,
                }
                for s in self.stats
            ],
            "input_count": self.total_input_count,
            "matched_txns": self.final_matched_count,
            "coverage_percent": self.final_coverage_percent,
            "stopped_reason": self.stopped_reason,
        }


def _txn_id_set_for_proposal(p: ClusterProposal) -> set[str]:
    return {t for t in p.member_txn_ids if t}


def _merge_proposals(
    existing: list[ClusterProposal],
    new: list[ClusterProposal],
) -> list[ClusterProposal]:
    """Union by canonical_name (case-insensitive). Keep highest confidence."""
    by_key: dict[str, ClusterProposal] = {}
    for p in existing + new:
        key = p.canonical_name.strip().lower()
        if not key:
            continue
        prev = by_key.get(key)
        if prev is None or p.confidence > prev.confidence:
            by_key[key] = p
    out = list(by_key.values())
    out.sort(key=lambda p: -p.txn_count)
    return out


async def iterative_cluster(
    txns: list[dict[str, Any]],
    *,
    target_coverage: float = 0.80,
    max_iterations: int = 5,
    progress_threshold: int = 5,
    use_behavioural: bool = True,
    use_llm: bool = True,
    min_group_size: int = 2,
    similarity_threshold: float = 0.4,
    available_categories: list[str] | None = None,
    available_tags: list[str] | None = None,
    llm_base_url: str | None = None,
    llm_token: str | None = None,
    llm_model: str | None = None,
) -> IterativeResult:
    """Run multi-pass iterative clustering.

    Args:
        txns: input transactions list.
        target_coverage: stop early if coverage hits this.
        max_iterations: hard cap.
        progress_threshold: stop if a single iteration matches fewer
            than this many new transactions.
        use_behavioural: enable Pass 2 (account+amount+cadence).
        use_llm: enable Pass 3 (LLM category inference).
        min_group_size: drop alias groups smaller than this in Pass 1.
        similarity_threshold: cosine threshold for Pass 1 alias merging.
        available_categories: tenant's category names (required if
            use_llm=True).
        available_tags: tenant's tag names (optional).
        llm_base_url, llm_token, llm_model: OpenClaw config (required
            if use_llm=True).

    Returns:
        IterativeResult — the union of proposals across all iterations
        plus per-iteration stats.
    """
    result = IterativeResult(
        proposals=[],
        total_input_count=len(txns),
    )
    if not txns:
        result.stopped_reason = "empty_input"
        return result

    if use_llm and (
        not llm_base_url or not llm_token or not available_categories
    ):
        logger.warning(
            "LLM pass disabled — missing base_url/token/categories"
        )
        use_llm = False

    covered_ids: set[str] = set()

    for iteration in range(1, max_iterations + 1):
        residual = [t for t in txns if (t.get("id") or "") not in covered_ids]
        if not residual:
            result.stopped_reason = "no_residual"
            break

        # --- Pass 1: keyword + word-TFIDF ---
        kw_props = cluster_transactions(
            residual,
            similarity_threshold=similarity_threshold,
            min_group_size=min_group_size,
        )
        kw_count = sum(1 for p in kw_props if p.proposed_category)

        # --- Pass 2: behavioural co-occurrence ---
        bh_props: list[ClusterProposal] = []
        if use_behavioural:
            bh_props = behavioural_groups(residual)
        bh_count = len(bh_props)

        # --- Pass 3: LLM category inference for unclustered groups ---
        llm_proposal_count = 0
        llm_updates: list[ClusterProposal] = []
        if use_llm:
            unmatched_groups = [
                p for p in (kw_props + bh_props) if not p.proposed_category
            ]
            unmatched_groups = [p for p in unmatched_groups if p.txn_count >= 2]
            if unmatched_groups:
                try:
                    raw_props = await infer_categories_for_clusters(
                        [p.asdict() for p in unmatched_groups],
                        available_categories=available_categories or [],
                        available_tags=available_tags or [],
                        base_url=llm_base_url or "",
                        token=llm_token or "",
                        model=llm_model or "x-ai/grok-4.1-fast",
                    )
                except Exception:
                    logger.exception("LLM pass failed; continuing")
                    raw_props = []
                # Build a name → updated-proposal map
                upd_by_name = {p.canonical_name.lower(): p for p in raw_props}
                for orig in unmatched_groups:
                    upd = upd_by_name.get(orig.canonical_name.lower())
                    if not upd or not upd.proposed_category:
                        continue
                    enriched = ClusterProposal(
                        canonical_name=orig.canonical_name,
                        pattern_keyword=orig.pattern_keyword,
                        proposed_category=upd.proposed_category,
                        proposed_tag=upd.proposed_tag,
                        role=upd.role or orig.role,
                        member_names=orig.member_names,
                        txn_count=orig.txn_count,
                        total_volume_huf=orig.total_volume_huf,
                        dominant_currency=orig.dominant_currency,
                        dominant_account=orig.dominant_account,
                        monthly_regularity=orig.monthly_regularity,
                        confidence=min(0.85, max(orig.confidence, upd.confidence)),
                        member_txn_ids=orig.member_txn_ids,
                    )
                    llm_updates.append(enriched)
                llm_proposal_count = len(llm_updates)

        # --- Merge into running set, recompute covered_ids ---
        all_iter_props = kw_props + bh_props + llm_updates
        result.proposals = _merge_proposals(result.proposals, all_iter_props)

        prev_covered = len(covered_ids)
        for p in result.proposals:
            if p.proposed_category:
                covered_ids |= _txn_id_set_for_proposal(p)
        new_matches = len(covered_ids) - prev_covered

        coverage_pct = round(100.0 * len(covered_ids) / len(txns), 2)
        result.stats.append(
            IterationStats(
                iteration=iteration,
                keyword_proposals=kw_count,
                behavioural_proposals=bh_count,
                llm_proposals=llm_proposal_count,
                matched_in_iteration=new_matches,
                cumulative_matched=len(covered_ids),
                cumulative_coverage_percent=coverage_pct,
            )
        )

        if coverage_pct >= target_coverage * 100:
            result.stopped_reason = "target_coverage_reached"
            break
        if iteration > 1 and new_matches < progress_threshold:
            result.stopped_reason = "no_progress"
            break
    else:
        result.stopped_reason = "max_iterations"

    result.final_matched_count = len(covered_ids)
    result.final_coverage_percent = (
        round(100.0 * len(covered_ids) / len(txns), 2) if txns else 0.0
    )
    return result


def iterative_cluster_sync(*args: Any, **kwargs: Any) -> IterativeResult:
    """Synchronous wrapper for iterative_cluster (for the CLI)."""
    return asyncio.run(iterative_cluster(*args, **kwargs))
