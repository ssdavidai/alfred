"""CLI entry: cluster Sure transactions and emit proposals as JSON.

Usage:
    python -m src.cli.sure_cluster < txns.json > proposals.json

Reads a JSON list of transaction dicts (as returned by Sure's
GET /api/v1/sure/transactions) on stdin. Writes a JSON object on
stdout:

    {
      "proposals": [ClusterProposal, ...],
      "stats": [...iteration stats...] OR {input_count, ...},
      "input_count": int,
      "matched_txns": int,
      "coverage_percent": float,
      "stopped_reason": "..."   (only in iterative mode)
    }

Exit code is 0 on success, 1 on input error. The wrapper (ctrl-api)
distinguishes by parsing the JSON.

Modes:
- Default (--iterative=true): runs the multi-pass loop in
  src.profiler.iterative until coverage >= target or no progress.
  Pass 3 (LLM) is enabled if OpenClaw gateway env vars are present.
- Single-pass (--iterative=false): the original
  cluster_transactions() one-shot. Faster, no LLM.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from typing import Any

from src.profiler.transaction_clustering import (
    cluster_transactions,
    proposals_to_dicts,
)
from src.profiler.iterative import iterative_cluster

logger = logging.getLogger(__name__)


def _parse_bool(s: str) -> bool:
    return s.lower() in ("1", "true", "yes", "on")


def _read_token() -> str:
    """Read the gateway token from the configured file, or return ''."""
    path = os.environ.get(
        "OPENCLAW_GATEWAY_TOKEN_FILE",
        "/alfred-data/.gateway-token",
    )
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Cluster Sure transactions.")
    parser.add_argument(
        "--iterative",
        type=_parse_bool,
        default=True,
        help="Run the multi-pass iterative loop (default: true).",
    )
    parser.add_argument(
        "--similarity-threshold",
        type=float,
        default=0.4,
        help="Cosine distance threshold for TF-IDF alias merging.",
    )
    parser.add_argument(
        "--min-group-size",
        type=int,
        default=2,
        help="Drop alias groups smaller than this.",
    )
    parser.add_argument(
        "--target-coverage",
        type=float,
        default=0.80,
        help="Iterative: stop once coverage hits this (default: 0.80).",
    )
    parser.add_argument(
        "--max-iterations",
        type=int,
        default=5,
        help="Iterative: hard cap on iterations (default: 5).",
    )
    parser.add_argument(
        "--use-llm",
        type=_parse_bool,
        default=True,
        help="Iterative: enable Pass 3 LLM category inference.",
    )
    parser.add_argument(
        "--use-behavioural",
        type=_parse_bool,
        default=True,
        help="Iterative: enable Pass 2 behavioural co-occurrence.",
    )
    parser.add_argument(
        "--llm-top-n",
        type=int,
        default=30,
        help="Iterative: cap LLM Pass 3 to the N largest unknown groups per iteration.",
    )
    parser.add_argument(
        "--llm-min-group-size",
        type=int,
        default=3,
        help="Iterative: skip LLM Pass 3 for groups with fewer than this many txns.",
    )
    parser.add_argument(
        "--llm-model",
        default=os.environ.get("SURE_CLUSTER_LLM_MODEL", "openclaw"),
        help=(
            "OpenClaw model identifier ('openclaw' for default agent, or "
            "'openclaw/<agentId>'). Arbitrary upstream IDs are rejected by "
            "the gateway."
        ),
    )
    parser.add_argument(
        "--available-categories",
        default=os.environ.get("SURE_CLUSTER_CATEGORIES", ""),
        help="Comma-separated category names (passed to the LLM prompt).",
    )
    parser.add_argument(
        "--available-tags",
        default=os.environ.get("SURE_CLUSTER_TAGS", ""),
        help="Comma-separated tag names (passed to the LLM prompt).",
    )
    parser.add_argument(
        "--input",
        default="-",
        help="Path to txns JSON, or '-' for stdin.",
    )
    parser.add_argument(
        "--output",
        default="-",
        help="Path to write proposals JSON, or '-' for stdout.",
    )
    args = parser.parse_args(argv)

    try:
        if args.input == "-":
            data = json.load(sys.stdin)
        else:
            with open(args.input) as f:
                data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        sys.stderr.write(f"sure_cluster: failed to read input: {e}\n")
        return 1

    txns: list[dict[str, Any]]
    if isinstance(data, list):
        txns = data
    elif isinstance(data, dict) and "transactions" in data:
        txns = data["transactions"]
    else:
        sys.stderr.write(
            "sure_cluster: input must be a list or {transactions: [...]}\n"
        )
        return 1

    if args.iterative:
        cats = [c.strip() for c in args.available_categories.split(",") if c.strip()]
        tags = [t.strip() for t in args.available_tags.split(",") if t.strip()]
        token = _read_token()
        base_url = os.environ.get(
            "OPENCLAW_GATEWAY_URL", "http://openclaw:18789"
        )
        result = asyncio.run(
            iterative_cluster(
                txns,
                target_coverage=args.target_coverage,
                max_iterations=args.max_iterations,
                use_behavioural=args.use_behavioural,
                use_llm=args.use_llm and bool(token) and bool(cats),
                similarity_threshold=args.similarity_threshold,
                min_group_size=args.min_group_size,
                llm_top_n=args.llm_top_n,
                llm_min_group_size=args.llm_min_group_size,
                available_categories=cats,
                available_tags=tags,
                llm_base_url=base_url,
                llm_token=token,
                llm_model=args.llm_model,
            )
        )
        output = result.asdict()
    else:
        proposals = cluster_transactions(
            txns,
            similarity_threshold=args.similarity_threshold,
            min_group_size=args.min_group_size,
        )
        matched_txns = sum(p.txn_count for p in proposals if p.proposed_category)
        output = {
            "proposals": proposals_to_dicts(proposals),
            "stats": {
                "input_count": len(txns),
                "proposals": len(proposals),
                "matched_txns": matched_txns,
                "coverage_percent": round(100.0 * matched_txns / max(len(txns), 1), 2),
            },
            "input_count": len(txns),
            "matched_txns": matched_txns,
            "coverage_percent": round(100.0 * matched_txns / max(len(txns), 1), 2),
        }

    payload = json.dumps(output, ensure_ascii=False)
    if args.output == "-":
        sys.stdout.write(payload)
    else:
        with open(args.output, "w") as f:
            f.write(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
