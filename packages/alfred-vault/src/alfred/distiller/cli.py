"""Subcommand implementations for the distiller CLI."""

from __future__ import annotations

import asyncio
from pathlib import Path

from .candidates import scan_candidates, group_by_project
from .config import DistillerConfig
from .daemon import run_extraction, run_watch
from .state import DistillerState
from .utils import get_logger

log = get_logger(__name__)


def _init_state(config: DistillerConfig) -> DistillerState:
    state = DistillerState(config.state.path, config.state.max_run_history)
    state.load()
    return state


def cmd_scan(config: DistillerConfig, skills_dir: Path, project: str | None = None) -> None:
    """Phase 1 only: identify candidates, print report. No agent invocation."""
    state = _init_state(config)

    candidates = scan_candidates(
        vault_path=config.vault.vault_path,
        ignore_dirs=config.vault.ignore_dirs,
        ignore_files=config.vault.ignore_files,
        source_types=config.extraction.source_types,
        threshold=config.extraction.candidate_threshold,
        distilled_files=state.get_distilled_md5s(),
        project_filter=project,
    )

    if not candidates:
        print("No candidates found.")
        return

    groups = group_by_project(candidates)

    print(f"\n=== Distiller Scan — {len(candidates)} candidates ===\n")

    for proj_name, group in sorted(groups.items(), key=lambda x: x[0] or ""):
        header = proj_name or "(ungrouped)"
        print(f"## {header} ({len(group)} records)")
        print(f"{'File':<60} {'Type':<15} {'Score':<8} {'Signals'}")
        print("-" * 110)

        for sc in group:
            signals_parts = []
            s = sc.signals
            if s.decision_keywords:
                signals_parts.append(f"dec:{s.decision_keywords}")
            if s.assumption_keywords:
                signals_parts.append(f"asm:{s.assumption_keywords}")
            if s.constraint_keywords:
                signals_parts.append(f"con:{s.constraint_keywords}")
            if s.contradiction_keywords:
                signals_parts.append(f"ctr:{s.contradiction_keywords}")
            if s.has_outcome:
                signals_parts.append("outcome")
            if s.has_context:
                signals_parts.append("context")

            signals_str = ", ".join(signals_parts) if signals_parts else "-"

            print(
                f"{sc.record.rel_path:<60} "
                f"{sc.record.record_type:<15} "
                f"{sc.score:<8.2f} "
                f"{signals_str}"
            )
        print()


def cmd_run(config: DistillerConfig, skills_dir: Path, project: str | None = None) -> None:
    """Full pipeline: scan + invoke agent to extract learnings."""
    state = _init_state(config)
    result = asyncio.run(run_extraction(config, state, skills_dir, project_filter=project))

    print(f"\n=== Extraction Run {result.run_id} — {result.timestamp} ===")
    print(f"Candidates found: {result.candidates_found}")
    print(f"Candidates processed: {result.candidates_processed}")
    print(f"Batches: {result.batches}")

    if result.records_created:
        print(f"\nRecords created:")
        for learn_type, count in sorted(result.records_created.items()):
            print(f"  {learn_type}: {count}")
        print(f"  Total: {sum(result.records_created.values())}")
    else:
        print("\nNo records created.")


def cmd_watch(config: DistillerConfig, skills_dir: Path) -> None:
    """Daemon mode — extract on interval."""
    state = _init_state(config)
    try:
        asyncio.run(run_watch(config, state, skills_dir))
    except KeyboardInterrupt:
        log.info("daemon.interrupted")
        print("\nStopped.")


def cmd_status(config: DistillerConfig) -> None:
    """Show last run, extraction counts, state summary."""
    state = _init_state(config)

    total_files = len(state.files)
    total_learns = sum(
        len(fs.learn_records_created) for fs in state.files.values()
    )

    # Count by learn type
    learn_counts: dict[str, int] = {}
    for fs in state.files.values():
        for lf in fs.learn_records_created:
            lt = lf.split("/")[0] if "/" in lf else "unknown"
            learn_counts[lt] = learn_counts.get(lt, 0) + 1

    print(f"=== Distiller Status ===")
    print(f"Tracked source files: {total_files}")
    print(f"Total learn records created: {total_learns}")
    print(f"Total runs recorded: {len(state.runs)}")
    print(f"Extraction log entries: {len(state.extraction_log)}")

    if learn_counts:
        print(f"\nLearn records by type:")
        for lt, count in sorted(learn_counts.items()):
            print(f"  {lt}: {count}")

    # Last run
    if state.runs:
        last = max(state.runs.values(), key=lambda r: r.timestamp)
        print(f"\nLast run: {last.run_id} at {last.timestamp}")
        print(f"  Candidates found: {last.candidates_found}")
        print(f"  Candidates processed: {last.candidates_processed}")
        if last.records_created:
            for lt, count in sorted(last.records_created.items()):
                print(f"  Created {lt}: {count}")

    # Recent extraction log
    if state.extraction_log:
        recent = state.extraction_log[-5:]
        print(f"\nRecent extractions:")
        for entry in recent:
            print(
                f"  [{entry.timestamp}] {entry.action} {entry.learn_type} "
                f"{entry.learn_file} — {entry.detail}"
            )


def cmd_history(config: DistillerConfig, limit: int = 10) -> None:
    """Show past extraction runs."""
    state = _init_state(config)

    if not state.runs:
        print("No run history.")
        return

    sorted_runs = sorted(
        state.runs.values(), key=lambda r: r.timestamp, reverse=True
    )
    shown = sorted_runs[:limit]

    print(f"=== Run History (last {len(shown)}) ===\n")
    print(
        f"{'ID':<10} {'Timestamp':<28} {'Candidates':<12} {'Processed':<12} {'Created':<10}"
    )
    print("-" * 75)
    for run in shown:
        total_created = sum(run.records_created.values())
        created_parts = ", ".join(
            f"{lt}:{c}" for lt, c in sorted(run.records_created.items())
        )
        created_str = created_parts if created_parts else "0"
        print(
            f"{run.run_id:<10} {run.timestamp:<28} "
            f"{run.candidates_found:<12} {run.candidates_processed:<12} "
            f"{created_str}"
        )
