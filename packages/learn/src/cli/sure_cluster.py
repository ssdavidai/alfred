"""CLI entry: cluster Sure transactions and emit proposals as JSON.

Usage:
    python -m src.cli.sure_cluster < txns.json > proposals.json

Reads a JSON list of transaction dicts (as returned by Sure's
GET /api/v1/sure/transactions) on stdin. Writes a JSON object on
stdout:

    {
      "proposals": [ClusterProposal, ...],
      "stats": {
        "input_count": int,
        "alias_groups": int,
        "proposals": int,
        "matched_txns": int,
        "coverage_percent": float
      }
    }

Exit code is 0 on success, 1 on input error. The wrapper (ctrl-api)
distinguishes by parsing the JSON.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from typing import Any

from src.profiler.transaction_clustering import (
    cluster_transactions,
    proposals_to_dicts,
)

logger = logging.getLogger(__name__)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Cluster Sure transactions.")
    parser.add_argument(
        "--similarity-threshold",
        type=float,
        default=0.4,
        help="Cosine distance threshold for TF-IDF alias merging (lower=stricter).",
    )
    parser.add_argument(
        "--min-group-size",
        type=int,
        default=2,
        help="Drop alias groups smaller than this.",
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
            "coverage_percent": round(
                100.0 * matched_txns / max(len(txns), 1), 2
            ),
        },
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
