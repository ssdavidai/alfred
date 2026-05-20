"""Extraction orchestrator — two-phase scan + agent extraction pipeline.

For OpenClaw backends, uses a multi-stage pipeline (pipeline.py):
  Pass A: EXTRACT (LLM per-source) → DEDUP (Python) → CREATE (LLM per-learning)
  Pass B: Cross-learning meta-analysis (contradictions, syntheses across records)

For other backends, falls back to the legacy single-LLM-call approach.
"""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import datetime, timezone
from pathlib import Path

from alfred.vault.mutation_log import append_to_audit_log, cleanup_session_file, create_session_file, read_mutations

from .backends import (
    BaseBackend,
    BackendResult,
    build_extraction_prompt,
    format_existing_learns,
    format_source_records,
)
from .backends.cli import ClaudeBackend
from .backends.http import ZoBackend
from .backends.openclaw import OpenClawBackend
from .candidates import (
    ExtractionBatch,
    ScoredCandidate,
    collect_existing_learns,
    group_by_project,
    scan_candidates,
)
from .config import DistillerConfig
from .parser import parse_file
from .pipeline import run_meta_analysis, run_pipeline
from .state import DistillerState, ExtractionLogEntry, RunResult
from .utils import compute_md5, get_logger

log = get_logger(__name__)


def _use_pipeline(config: DistillerConfig) -> bool:
    """Check if the multi-stage pipeline should be used (OpenClaw backend only)."""
    return config.agent.backend == "openclaw"


def _load_skill(skills_dir: Path) -> str:
    """Load SKILL.md and all reference templates into a single text block."""
    skill_path = skills_dir / "vault-distiller" / "SKILL.md"
    if not skill_path.exists():
        log.warning("daemon.skill_not_found", path=str(skill_path))
        return ""

    parts: list[str] = [skill_path.read_text(encoding="utf-8")]

    refs_dir = skills_dir / "vault-distiller" / "references"
    if refs_dir.is_dir():
        for ref_file in sorted(refs_dir.glob("*.md")):
            content = ref_file.read_text(encoding="utf-8")
            parts.append(
                f"\n---\n### Reference Template: {ref_file.name}\n```\n{content}\n```"
            )

    return "\n".join(parts)


def _create_backend(config: DistillerConfig) -> BaseBackend:
    """Instantiate the configured backend."""
    backend_name = config.agent.backend
    if backend_name == "claude":
        return ClaudeBackend(config.agent.claude)
    elif backend_name == "zo":
        return ZoBackend(config.agent.zo)
    elif backend_name == "openclaw":
        return OpenClawBackend(config.agent.openclaw)
    else:
        raise ValueError(f"Unknown backend: {backend_name}")


def snapshot_vault(
    vault_path: Path, ignore_dirs: list[str] | None = None
) -> dict[str, str]:
    """Capture SHA-256 checksums of all .md files in the vault."""
    ignore = set(ignore_dirs or [])
    checksums: dict[str, str] = {}

    for md_file in vault_path.rglob("*.md"):
        rel = md_file.relative_to(vault_path)
        if any(part in ignore for part in rel.parts):
            continue
        try:
            content = md_file.read_bytes()
            checksums[str(rel).replace("\\", "/")] = hashlib.sha256(
                content
            ).hexdigest()
        except OSError:
            continue

    return checksums


def diff_vault(
    before: dict[str, str],
    after: dict[str, str],
) -> tuple[list[str], list[str], list[str]]:
    """Compare two vault snapshots. Returns (created, modified, deleted)."""
    created: list[str] = []
    modified: list[str] = []
    deleted: list[str] = []

    for path, checksum in after.items():
        if path not in before:
            created.append(path)
        elif before[path] != checksum:
            modified.append(path)

    for path in before:
        if path not in after:
            deleted.append(path)

    return created, modified, deleted


def _get_project_description(
    vault_path: Path, project_name: str | None
) -> str:
    """Try to read project description from the vault."""
    if not project_name:
        return ""
    project_file = vault_path / "project" / f"{project_name}.md"
    if project_file.exists():
        try:
            rec = parse_file(vault_path, f"project/{project_name}.md")
            return rec.frontmatter.get("description", "")
        except Exception:
            pass
    return ""


def _build_batches(
    config: DistillerConfig,
    candidates: list[ScoredCandidate],
    vault_path: Path,
) -> list[ExtractionBatch]:
    """Group candidates into extraction batches with dedup context."""
    groups = group_by_project(candidates)
    batches: list[ExtractionBatch] = []

    for project_name, group_candidates in groups.items():
        # Cap batch size
        batch_candidates = group_candidates[: config.extraction.max_sources_per_batch]

        # Collect existing learns for dedup
        existing = collect_existing_learns(
            vault_path,
            config.vault.ignore_dirs,
            config.extraction.learn_types,
            project_name,
        )

        batches.append(
            ExtractionBatch(
                project=project_name,
                source_records=batch_candidates,
                existing_learns=existing,
            )
        )

    return batches


def recompute_source_md5s(
    batch_source_records: list[ScoredCandidate],
    vault_path: Path,
    state: DistillerState,
) -> None:
    """Re-read source file MD5s after pipeline writes and update state.

    The pipeline may write distiller_signals/distiller_learnings back into
    source file frontmatter, changing the file's MD5. Without this refresh
    the stored MD5 would be stale, causing the file to re-qualify as a
    candidate on the next run (infinite loop).
    """
    for sc in batch_source_records:
        full_path = vault_path / sc.record.rel_path
        if not full_path.exists():
            continue
        try:
            fresh_md5 = compute_md5(full_path)
        except OSError:
            continue
        if fresh_md5 != sc.md5:
            state.update_file(sc.record.rel_path, fresh_md5)
            log.debug(
                "extraction.md5_refreshed",
                path=sc.record.rel_path,
                old_md5=sc.md5[:8],
                new_md5=fresh_md5[:8],
            )


async def run_extraction(
    config: DistillerConfig,
    state: DistillerState,
    skills_dir: Path,
    project_filter: str | None = None,
) -> RunResult:
    """Run a complete extraction: Phase 1 scan + Phase 2 agent extraction."""
    run_id = str(uuid.uuid4())[:8]
    timestamp = datetime.now(timezone.utc).isoformat()
    vault_path = config.vault.vault_path

    log.info("extraction.start", run_id=run_id)

    # Phase 1: Scan candidates
    candidates = scan_candidates(
        vault_path=vault_path,
        ignore_dirs=config.vault.ignore_dirs,
        ignore_files=config.vault.ignore_files,
        source_types=config.extraction.source_types,
        threshold=config.extraction.candidate_threshold,
        distilled_files=state.get_distilled_md5s(),
        project_filter=project_filter,
    )

    result = RunResult(
        run_id=run_id,
        timestamp=timestamp,
        candidates_found=len(candidates),
    )

    if not candidates:
        log.info("extraction.no_candidates", run_id=run_id)
        state.add_run(result)
        state.save()
        return result

    # Phase 2: Build batches and extract
    batches = _build_batches(config, candidates, vault_path)
    result.batches = len(batches)

    if _use_pipeline(config):
        # Multi-stage pipeline for OpenClaw backend
        session_path = create_session_file()
        any_created = False

        for batch in batches:
            log.info(
                "extraction.pipeline_invoke",
                run_id=run_id,
                project=batch.project or "(ungrouped)",
                sources=len(batch.source_records),
            )

            pipeline_result = await run_pipeline(
                batch=batch,
                config=config,
                session_path=session_path,
            )

            result.candidates_processed += pipeline_result.candidates_processed

            # Merge records_created counts
            for lt, count in pipeline_result.records_created.items():
                result.records_created[lt] = (
                    result.records_created.get(lt, 0) + count
                )
                any_created = True

            # Update source file states
            mutations = read_mutations(session_path)
            created = mutations["files_created"]
            source_paths = [sc.record.rel_path for sc in batch.source_records]

            for f in created:
                learn_type = "unknown"
                for lt in config.extraction.learn_types:
                    if f.startswith(f"{lt}/"):
                        learn_type = lt
                        break

                state.add_log_entry(
                    ExtractionLogEntry(
                        timestamp=datetime.now(timezone.utc).isoformat(),
                        run_id=run_id,
                        action="created",
                        learn_type=learn_type,
                        learn_file=f,
                        source_files=source_paths,
                        detail=f"Pipeline: {batch.project or 'ungrouped'} batch",
                    )
                )

            for sc in batch.source_records:
                learn_paths = [
                    f
                    for f in created
                    if any(f.startswith(f"{lt}/") for lt in config.extraction.learn_types)
                ]
                state.update_file(sc.record.rel_path, sc.md5, learn_paths)

            # Refresh MD5s after pipeline may have written back to source files
            recompute_source_md5s(batch.source_records, vault_path, state)

            if not pipeline_result.success:
                log.error(
                    "extraction.pipeline_failed",
                    run_id=run_id,
                    summary=pipeline_result.summary[:500],
                )

        # Pass B: Cross-learning meta-analysis (runs once after all batches)
        if any_created:
            log.info("extraction.passb_start", run_id=run_id)
            meta_created = await run_meta_analysis(config, session_path)
            if meta_created > 0:
                result.records_created["meta"] = meta_created

        # Final audit and cleanup
        mutations = read_mutations(session_path)
        audit_mutations = {
            "files_created": mutations["files_created"],
            "files_modified": mutations["files_modified"],
            "files_deleted": mutations["files_deleted"],
        }
        audit_path = str(Path(config.state.path).parent / "vault_audit.log")
        append_to_audit_log(audit_path, "distiller", audit_mutations, detail=run_id)
        cleanup_session_file(session_path)

    else:
        # Legacy path for Claude and Zo backends
        skill_text = _load_skill(skills_dir)
        if not skill_text:
            log.warning("extraction.no_skill", msg="No SKILL.md found — skipping agent")
            state.add_run(result)
            state.save()
            return result

        backend = _create_backend(config)
        use_mutation_log = isinstance(backend, (ClaudeBackend, OpenClawBackend))

        for batch in batches:
            project_desc = _get_project_description(vault_path, batch.project)

            prompt = build_extraction_prompt(
                skill_text=skill_text,
                vault_path=str(vault_path),
                project_name=batch.project,
                project_description=project_desc,
                existing_learns_formatted=format_existing_learns(batch.existing_learns),
                source_records_formatted=format_source_records(batch.source_records),
            )

            session_path = None
            if use_mutation_log:
                session_path = create_session_file()
                backend.env_overrides = {
                    "ALFRED_VAULT_PATH": str(vault_path),
                    "ALFRED_VAULT_SCOPE": "distiller",
                    "ALFRED_VAULT_SESSION": session_path,
                }
            else:
                before = snapshot_vault(vault_path, config.vault.ignore_dirs)

            log.info(
                "extraction.agent_invoke",
                run_id=run_id,
                project=batch.project or "(ungrouped)",
                sources=len(batch.source_records),
            )

            agent_result = await backend.process(
                prompt=prompt,
                vault_path=str(vault_path),
            )

            if use_mutation_log and session_path:
                mutations = read_mutations(session_path)
                created = mutations["files_created"]
                modified = mutations["files_modified"]
                deleted = mutations["files_deleted"]
                cleanup_session_file(session_path)
            else:
                after = snapshot_vault(vault_path, config.vault.ignore_dirs)
                created, modified, deleted = diff_vault(before, after)

            audit_mutations = {"files_created": created, "files_modified": modified, "files_deleted": deleted}
            audit_path = str(Path(config.state.path).parent / "vault_audit.log")
            append_to_audit_log(audit_path, "distiller", audit_mutations, detail=run_id)

            result.candidates_processed += len(batch.source_records)

            source_paths = [sc.record.rel_path for sc in batch.source_records]
            for f in created:
                learn_type = "unknown"
                for lt in config.extraction.learn_types:
                    if f.startswith(f"{lt}/"):
                        learn_type = lt
                        break

                result.records_created[learn_type] = (
                    result.records_created.get(learn_type, 0) + 1
                )

                state.add_log_entry(
                    ExtractionLogEntry(
                        timestamp=datetime.now(timezone.utc).isoformat(),
                        run_id=run_id,
                        action="created",
                        learn_type=learn_type,
                        learn_file=f,
                        source_files=source_paths,
                        detail=f"Extracted from {batch.project or 'ungrouped'} batch",
                    )
                )

            for sc in batch.source_records:
                learn_paths = [
                    f
                    for f in created
                    if any(f.startswith(f"{lt}/") for lt in config.extraction.learn_types)
                ]
                state.update_file(sc.record.rel_path, sc.md5, learn_paths)

            # Refresh MD5s after agent may have written back to source files
            recompute_source_md5s(batch.source_records, vault_path, state)

            if not agent_result.success:
                log.error(
                    "extraction.agent_failed",
                    run_id=run_id,
                    summary=agent_result.summary[:500],
                )

    log.info(
        "extraction.complete",
        run_id=run_id,
        candidates=len(candidates),
        processed=result.candidates_processed,
        records_created=sum(result.records_created.values()),
    )

    state.add_run(result)
    state.save()
    return result


async def run_watch(
    config: DistillerConfig,
    state: DistillerState,
    skills_dir: Path,
) -> None:
    """Daemon mode — extract on interval until interrupted."""
    interval = config.extraction.interval_seconds
    deep_interval_hours = config.extraction.deep_interval_hours

    # Persist last deep extraction time across restarts
    if state.last_deep_extraction:
        try:
            last_deep = datetime.fromisoformat(state.last_deep_extraction)
        except (ValueError, TypeError):
            last_deep = datetime.min.replace(tzinfo=timezone.utc)
    else:
        last_deep = datetime.min.replace(tzinfo=timezone.utc)

    log.info(
        "daemon.starting",
        interval=interval,
        deep_interval_hours=deep_interval_hours,
    )

    while True:
        now = datetime.now(timezone.utc)
        hours_since_deep = (now - last_deep).total_seconds() / 3600

        try:
            if hours_since_deep >= deep_interval_hours:
                log.info("daemon.deep_extraction")
                await run_extraction(config, state, skills_dir)
                last_deep = now
                state.last_deep_extraction = now.isoformat()
                state.save()
            else:
                # Light pass — just scan, no agent invocation
                log.info("daemon.light_scan")
                candidates = scan_candidates(
                    vault_path=config.vault.vault_path,
                    ignore_dirs=config.vault.ignore_dirs,
                    ignore_files=config.vault.ignore_files,
                    source_types=config.extraction.source_types,
                    threshold=config.extraction.candidate_threshold,
                    distilled_files=state.get_distilled_md5s(),
                )
                if candidates:
                    log.info("daemon.pending_candidates", count=len(candidates))
        except Exception:
            log.exception("daemon.extraction_error")

        await asyncio.sleep(interval)
