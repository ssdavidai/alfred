"""Distiller pipeline — multi-stage extraction with cross-learning meta-analysis.

Pass A — Per-source extraction:
  Stage 1: EXTRACT (LLM, per-source) — identify learnings, output JSON manifest
  Stage 2: DEDUP + MERGE (pure Python) — fuzzy dedup, cross-source merge
  Stage 3: CREATE (LLM, per-learning) — create well-formed vault records

Pass B — Cross-learning meta-analysis:
  Scan existing learnings for clusters, find contradictions/syntheses across
  records, create higher-order learning records that link the reasoning graph.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from alfred.vault.mutation_log import log_mutation, read_mutations
from alfred.vault.ops import VaultError, vault_edit

from .backends import VAULT_CLI_REFERENCE
from .backends.openclaw import _clear_agent_sessions, _sync_workspace_claude_md
from .candidates import (
    CandidateSignal,
    ExtractionBatch,
    ScoredCandidate,
    collect_existing_learns,
)
from .config import DistillerConfig
from .parser import VaultRecord, extract_wikilinks
from .utils import get_logger

log = get_logger(__name__)


# --- Stop words for title normalization ---

_STOP_WORDS = frozenset({
    "the", "a", "an", "is", "are", "was", "were", "of", "in", "on",
    "for", "to", "and", "or", "with", "that", "this", "be", "has",
    "have", "had", "do", "does", "did", "will", "would", "should",
    "could", "may", "might", "shall", "can",
})


# --- Data classes ---


@dataclass
class LearningSpec:
    """A deduplicated learning candidate ready for Stage 3 creation."""

    learn_type: str
    title: str
    confidence: str
    status: str
    claim: str
    evidence_excerpts: list[str] = field(default_factory=list)
    source_links: list[str] = field(default_factory=list)
    entity_links: list[str] = field(default_factory=list)
    project: str | None = None
    source_count: int = 1


@dataclass
class PipelineResult:
    """Result from the distiller pipeline."""

    success: bool = False
    candidates_processed: int = 0
    records_created: dict[str, int] = field(default_factory=dict)
    signals_saved: int = 0
    meta_records_created: int = 0
    summary: str = ""


# --- Extraction rules by source type (from SKILL.md section 3) ---

_EXTRACTION_RULES: dict[str, str] = {
    "conversation": (
        "- **Decisions:** Look for 'we agreed', 'let's go with', 'decided to', explicit choices\n"
        "- **Assumptions:** 'we're assuming', 'should be fine', implicit beliefs about timelines or outcomes\n"
        "- **Constraints:** 'we can't', 'regulation requires', 'budget limit', 'deadline is'\n"
        "- **Contradictions:** Disagreements between participants, conflicting information"
    ),
    "session": (
        "- **Decisions:** Check ## Outcome sections, action items that imply choices made\n"
        "- **Assumptions:** Context sections revealing beliefs the team operates on\n"
        "- **Synthesis:** Patterns across multiple sessions about the same project"
    ),
    "note": (
        "- **Assumptions:** Research notes revealing implicit beliefs\n"
        "- **Constraints:** Meeting notes mentioning limits, regulations, requirements\n"
        "- **Synthesis:** Ideas connecting multiple observations"
    ),
    "task": (
        "- **Assumptions:** Context fields revealing why a task exists\n"
        "- **Decisions:** Task outcomes that reflect choices made\n"
        "- **Constraints:** Blockers and dependencies revealing limits"
    ),
    "project": (
        "- **Assumptions:** `based_on` and `depends_on` fields revealing foundational beliefs\n"
        "- **Constraints:** `blocked_by` revealing limits\n"
        "- **Decisions:** Project scope and approach choices"
    ),
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load_stage_prompt(stage_file: str) -> str:
    """Load a stage prompt from the bundled skills directory."""
    from alfred._data import get_skills_dir

    prompt_path = get_skills_dir() / "vault-distiller" / "prompts" / stage_file
    if not prompt_path.exists():
        log.warning("pipeline.prompt_not_found", path=str(prompt_path))
        return ""
    return prompt_path.read_text(encoding="utf-8")


def _load_learn_type_schemas() -> str:
    """Load only the 5 learn-type reference templates."""
    from alfred._data import get_skills_dir

    refs_dir = get_skills_dir() / "vault-distiller" / "references"
    parts: list[str] = []
    for name in [
        "assumption.md", "constraint.md", "contradiction.md",
        "decision.md", "synthesis.md",
    ]:
        ref_path = refs_dir / name
        if ref_path.exists():
            content = ref_path.read_text(encoding="utf-8")
            parts.append(f"### {name}\n```\n{content}\n```")
    return "\n\n".join(parts)


def _load_single_learn_schema(learn_type: str) -> str:
    """Load one learn-type reference template."""
    from alfred._data import get_skills_dir

    refs_dir = get_skills_dir() / "vault-distiller" / "references"
    ref_path = refs_dir / f"{learn_type}.md"
    if ref_path.exists():
        return ref_path.read_text(encoding="utf-8")
    return f"(no schema found for {learn_type})"


def _normalize_title(title: str) -> str:
    """Normalize title for fuzzy matching."""
    words = re.sub(r"[^a-zA-Z0-9\s]", "", title.lower()).split()
    return " ".join(w for w in words if w not in _STOP_WORDS)


def _fuzzy_title_match(a: str, b: str) -> float:
    """Overlap coefficient (Simpson) between two normalized titles.

    Uses |A∩B| / min(|A|, |B|) which handles title length variation
    better than Jaccard — a short title that's a subset of a longer
    one still scores high.
    """
    tokens_a = set(_normalize_title(a).split())
    tokens_b = set(_normalize_title(b).split())
    if not tokens_a or not tokens_b:
        return 0.0
    intersection = tokens_a & tokens_b
    return len(intersection) / min(len(tokens_a), len(tokens_b))


def _format_candidate_signals(signals: CandidateSignal) -> str:
    """Format candidate signals as human-readable hints for the LLM."""
    parts: list[str] = []
    if signals.decision_keywords > 0:
        parts.append(f"- {signals.decision_keywords} decision keyword(s) detected")
    if signals.assumption_keywords > 0:
        parts.append(f"- {signals.assumption_keywords} assumption keyword(s) detected")
    if signals.constraint_keywords > 0:
        parts.append(f"- {signals.constraint_keywords} constraint keyword(s) detected")
    if signals.contradiction_keywords > 0:
        parts.append(f"- {signals.contradiction_keywords} contradiction keyword(s) detected")
    if signals.has_outcome:
        parts.append("- Has ## Outcome section")
    if signals.has_context:
        parts.append("- Has ## Context section")
    parts.append(f"- Body length: {signals.body_length} chars")
    parts.append(f"- Wikilink density: {signals.link_density} links")
    return "\n".join(parts) if parts else "(no significant signals)"


def _format_dedup_titles(learns: list[VaultRecord]) -> str:
    """Format existing learn titles compactly for Stage 1 dedup context."""
    if not learns:
        return "(no existing learning records)"
    lines: list[str] = []
    for rec in learns:
        title = (
            rec.frontmatter.get("name", "")
            or rec.frontmatter.get("subject", "")
            or Path(rec.rel_path).stem
        )
        lines.append(f"- [{rec.record_type}] {title}")
    return "\n".join(lines)


def _parse_extraction_manifest(stdout: str) -> list[dict]:
    """Extract JSON learning manifest from LLM stdout."""
    # Look for {"learnings": [...]} pattern
    for match in re.finditer(r'\{[^{}]*"learnings"\s*:\s*\[', stdout):
        start = match.start()
        depth = 0
        for i in range(start, len(stdout)):
            if stdout[i] == "{":
                depth += 1
            elif stdout[i] == "}":
                depth -= 1
                if depth == 0:
                    candidate = stdout[start : i + 1]
                    try:
                        data = json.loads(candidate)
                        if isinstance(data.get("learnings"), list):
                            return data["learnings"]
                    except json.JSONDecodeError:
                        continue
                    break

    # Fallback: try to parse entire stdout as JSON
    try:
        data = json.loads(stdout.strip())
        if isinstance(data.get("learnings"), list):
            return data["learnings"]
    except (json.JSONDecodeError, AttributeError):
        pass

    log.warning("pipeline.manifest_parse_failed", stdout_len=len(stdout))
    return []


async def _call_llm(
    prompt: str,
    config: DistillerConfig,
    session_path: str,
    stage_label: str,
) -> str:
    """Make an isolated OpenClaw call and return stdout."""
    oc = config.agent.openclaw
    session_id = f"distiller-{stage_label}-{uuid.uuid4().hex[:8]}"

    _clear_agent_sessions(oc.agent_id)
    _sync_workspace_claude_md(oc.agent_id, str(config.vault.vault_path))

    # Write prompt to a temp file and pass via reference to avoid
    # OSError: [Errno 7] Argument list too long when the prompt
    # (which includes full record content) exceeds the OS arg limit.
    prompt_file = None
    try:
        prompt_file = tempfile.NamedTemporaryFile(
            mode="w",
            prefix=f"alfred-distiller-{stage_label}-",
            suffix=".md",
            delete=False,
            encoding="utf-8",
        )
        prompt_file.write(prompt)
        prompt_file.close()
        prompt_path = prompt_file.name
    except OSError:
        log.error("pipeline.prompt_file_write_failed", stage=stage_label)
        return ""

    cmd = [
        oc.command, "agent", *oc.args,
        "--agent", oc.agent_id,
        "--session-id", session_id,
        "--message", f"Follow the instructions in {prompt_path}",
        "--local", "--json",
    ]

    env = {
        **os.environ,
        "ALFRED_VAULT_PATH": str(config.vault.vault_path),
        "ALFRED_VAULT_SCOPE": "distiller",
        "ALFRED_VAULT_SESSION": session_path,
    }

    log.info(
        "pipeline.llm_call",
        stage=stage_label,
        agent_id=oc.agent_id,
        session_id=session_id,
        prompt_file=prompt_path,
    )

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(),
            timeout=oc.timeout,
        )
    except asyncio.TimeoutError:
        log.error("pipeline.llm_timeout", stage=stage_label, timeout=oc.timeout)
        return ""
    except FileNotFoundError:
        log.error("pipeline.command_not_found", command=oc.command)
        return ""
    finally:
        # Clean up prompt temp file
        if prompt_file is not None:
            try:
                os.unlink(prompt_path)
            except OSError:
                pass

    raw = stdout_bytes.decode("utf-8", errors="replace")
    err = stderr_bytes.decode("utf-8", errors="replace")

    if proc.returncode != 0:
        log.warning(
            "pipeline.llm_nonzero_exit",
            stage=stage_label,
            code=proc.returncode,
            stderr=err[:500],
        )
        return raw

    log.info("pipeline.llm_completed", stage=stage_label, stdout_len=len(raw))
    return raw


# ---------------------------------------------------------------------------
# Pass A — Stage 1: Extract (LLM, per-source-record)
# ---------------------------------------------------------------------------


async def _stage1_extract(
    source: ScoredCandidate,
    existing_learns: list[VaultRecord],
    config: DistillerConfig,
    session_path: str,
) -> list[dict]:
    """Stage 1: Analyze one source record and return learning candidates as JSON."""
    template = _load_stage_prompt("stage1_extract.md")
    if not template:
        return []

    rec = source.record
    source_type = rec.record_type
    source_path_no_ext = rec.rel_path.removesuffix(".md")

    # Generate a unique temp file path for the manifest output.
    # The LLM will write its JSON manifest here instead of relying on stdout,
    # which is polluted by OpenClaw's agent conversation/reasoning output.
    manifest_path = f"/tmp/alfred-distiller-{uuid.uuid4().hex[:12]}-manifest.json"

    prompt = template.format(
        learn_type_schemas=_load_learn_type_schemas(),
        extraction_rules=_EXTRACTION_RULES.get(
            source_type, "(no specific rules for this type)"
        ),
        source_record_path=rec.rel_path,
        source_record_path_no_ext=source_path_no_ext,
        source_record_type=source_type,
        source_record_body=rec.body[:4000],
        source_record_frontmatter=json.dumps(
            rec.frontmatter, indent=2, default=str
        ),
        candidate_signals=_format_candidate_signals(source.signals),
        existing_learn_titles=_format_dedup_titles(existing_learns),
        vault_cli_reference=VAULT_CLI_REFERENCE,
        manifest_path=manifest_path,
    )

    safe_name = re.sub(
        r"[^a-zA-Z0-9_-]", "", Path(rec.rel_path).stem.replace(" ", "-")
    )[:30]
    stage_label = f"s1-{safe_name}"

    max_attempts = 3
    manifest: list[dict] = []

    for attempt in range(1, max_attempts + 1):
        # Generate a fresh manifest path per attempt so stale files can't
        # interfere — the path embedded in the prompt stays the same across
        # retries (it was already baked in above), but we still need to read
        # from the exact path the prompt references.
        stdout = await _call_llm(prompt, config, session_path, stage_label)

        # Primary: read manifest from the temp file the LLM was instructed to write
        try:
            manifest_text = Path(manifest_path).read_text(encoding="utf-8")
            manifest = _parse_extraction_manifest(manifest_text)
            if manifest:
                log.info(
                    "pipeline.s1_manifest_from_file",
                    source=rec.rel_path,
                    learnings=len(manifest),
                )
        except (OSError, UnicodeDecodeError) as exc:
            log.info(
                "pipeline.s1_manifest_file_missing",
                source=rec.rel_path,
                error=str(exc),
            )
        finally:
            # Clean up temp file
            try:
                os.unlink(manifest_path)
            except OSError:
                pass

        # Fallback: parse manifest from stdout if file read failed
        if not manifest and stdout:
            manifest = _parse_extraction_manifest(stdout)
            if manifest:
                log.info(
                    "pipeline.s1_manifest_from_stdout",
                    source=rec.rel_path,
                    learnings=len(manifest),
                )

        if manifest:
            break

        if attempt < max_attempts:
            log.warning(
                "pipeline.s1_manifest_retry",
                source=rec.rel_path,
                attempt=attempt,
                max_attempts=max_attempts,
            )

    log.info(
        "pipeline.s1_complete", source=rec.rel_path, learnings=len(manifest)
    )
    return manifest


def _save_distiller_signals(
    source_path: str,
    signals: CandidateSignal,
    vault_path: Path,
    session_path: str,
) -> bool:
    """Save distiller signals on the source record's frontmatter."""
    signal_parts: list[str] = []
    if signals.decision_keywords > 0:
        signal_parts.append(f"decision:{signals.decision_keywords}")
    if signals.assumption_keywords > 0:
        signal_parts.append(f"assumption:{signals.assumption_keywords}")
    if signals.constraint_keywords > 0:
        signal_parts.append(f"constraint:{signals.constraint_keywords}")
    if signals.contradiction_keywords > 0:
        signal_parts.append(f"contradiction:{signals.contradiction_keywords}")
    if signals.has_outcome:
        signal_parts.append("has_outcome")
    if signals.has_context:
        signal_parts.append("has_context")

    signals_str = ", ".join(signal_parts) if signal_parts else "none"

    try:
        vault_edit(
            vault_path,
            source_path,
            set_fields={"distiller_signals": signals_str},
        )
        log_mutation(session_path, "edit", source_path)
        return True
    except VaultError as e:
        log.warning(
            "pipeline.signals_save_failed", source=source_path, error=str(e)
        )
        return False


# ---------------------------------------------------------------------------
# Pass A — Stage 2: Dedup + Merge (pure Python)
# ---------------------------------------------------------------------------


def _stage2_dedup_merge(
    all_manifests: dict[str, list[dict]],
    existing_learns: list[VaultRecord],
    dedup_threshold: float = 0.7,
) -> list[LearningSpec]:
    """Stage 2: Deduplicate and merge learning candidates across sources."""
    # Flatten all candidates
    raw_candidates: list[tuple[str, dict]] = []
    for source_path, manifest in all_manifests.items():
        for learning in manifest:
            raw_candidates.append((source_path, learning))

    if not raw_candidates:
        return []

    # Cross-source merge: group by (type, similar title)
    merged: list[dict] = []
    for _source_path, candidate in raw_candidates:
        learn_type = candidate.get("type", "")
        title = candidate.get("title", "")

        if not learn_type or not title:
            continue

        # Try to merge with an existing merged candidate
        matched = False
        for m in merged:
            if (
                m["type"] == learn_type
                and _fuzzy_title_match(title, m["title"]) >= dedup_threshold
            ):
                m["source_count"] += 1
                if candidate.get("evidence_excerpt"):
                    m["evidence_excerpts"].append(candidate["evidence_excerpt"])
                for sl in candidate.get("source_links", []):
                    # Defensively flatten: LLM may return [[links]] or [links]
                    if isinstance(sl, list):
                        for nested in sl:
                            if nested not in m["source_links"]:
                                m["source_links"].append(nested)
                    elif sl not in m["source_links"]:
                        m["source_links"].append(sl)
                for el in candidate.get("entity_links", []):
                    if isinstance(el, list):
                        for nested in el:
                            if nested not in m["entity_links"]:
                                m["entity_links"].append(nested)
                    elif el not in m["entity_links"]:
                        m["entity_links"].append(el)
                # Bump confidence when multiple sources agree
                if m["source_count"] >= 3 and m["confidence"] == "low":
                    m["confidence"] = "medium"
                elif m["source_count"] >= 2 and m["confidence"] == "medium":
                    m["confidence"] = "high"
                matched = True
                break

        if not matched:
            merged.append({
                "type": learn_type,
                "title": title,
                "confidence": candidate.get("confidence", "medium"),
                "status": candidate.get("status", "draft"),
                "claim": candidate.get("claim", ""),
                "evidence_excerpts": (
                    [candidate["evidence_excerpt"]]
                    if candidate.get("evidence_excerpt")
                    else []
                ),
                "source_links": list(candidate.get("source_links", [])),
                "entity_links": list(candidate.get("entity_links", [])),
                "project": candidate.get("project"),
                "source_count": 1,
            })

    # Existing learn dedup: skip candidates that match existing records
    existing_titles = [
        (
            rec.record_type,
            rec.frontmatter.get("name", "")
            or rec.frontmatter.get("subject", "")
            or Path(rec.rel_path).stem,
        )
        for rec in existing_learns
    ]

    specs: list[LearningSpec] = []
    for m in merged:
        is_dup = False
        for existing_type, existing_title in existing_titles:
            if (
                m["type"] == existing_type
                and _fuzzy_title_match(m["title"], existing_title) >= 0.8
            ):
                log.info(
                    "pipeline.s2_dedup_skip",
                    title=m["title"],
                    existing=existing_title,
                )
                is_dup = True
                break

        if not is_dup:
            specs.append(
                LearningSpec(
                    learn_type=m["type"],
                    title=m["title"],
                    confidence=m["confidence"],
                    status=m["status"],
                    claim=m["claim"],
                    evidence_excerpts=m["evidence_excerpts"],
                    source_links=m["source_links"],
                    entity_links=m["entity_links"],
                    project=m.get("project"),
                    source_count=m["source_count"],
                )
            )

    log.info(
        "pipeline.s2_complete",
        candidates=len(raw_candidates),
        merged=len(merged),
        after_dedup=len(specs),
    )
    return specs


# ---------------------------------------------------------------------------
# Pass A — Stage 3: Create (LLM, per-learning)
# ---------------------------------------------------------------------------


async def _stage3_create(
    spec: LearningSpec,
    config: DistillerConfig,
    session_path: str,
) -> str | None:
    """Stage 3: Create one learning record. Returns path of created record."""
    template = _load_stage_prompt("stage3_create.md")
    if not template:
        return None

    schema = _load_single_learn_schema(spec.learn_type)
    evidence = (
        "\n\n".join(f"> {e}" for e in spec.evidence_excerpts)
        if spec.evidence_excerpts
        else "(no direct excerpts)"
    )
    source_links_str = (
        ", ".join(spec.source_links) if spec.source_links else "(none)"
    )
    entity_links_str = (
        ", ".join(spec.entity_links) if spec.entity_links else "(none)"
    )
    project_str = (
        f"[[project/{spec.project}]]" if spec.project else "(none)"
    )

    # YAML-formatted values for frontmatter
    source_links_yaml = (
        json.dumps(spec.source_links) if spec.source_links else "[]"
    )
    project_yaml = (
        f'["[[project/{spec.project}]]"]' if spec.project else "[]"
    )

    prompt = template.format(
        learn_type=spec.learn_type,
        learn_type_schema=schema,
        title=spec.title,
        confidence=spec.confidence,
        status=spec.status,
        claim=spec.claim,
        evidence_excerpts=evidence,
        source_links=source_links_str,
        source_links_yaml=source_links_yaml,
        entity_links=entity_links_str,
        project=project_str,
        project_yaml=project_yaml,
        vault_cli_reference=VAULT_CLI_REFERENCE,
    )

    safe_name = re.sub(
        r"[^a-zA-Z0-9_-]", "", spec.title.replace(" ", "-")
    )[:30]
    stage_label = f"s3-{spec.learn_type}-{safe_name}"

    # Snapshot created files before this call
    before_created = set(read_mutations(session_path).get("files_created", []))

    # Filesystem snapshot fallback: the mutation log may not be written when
    # the agent runs in a separate container (openclaw) that doesn't have
    # ALFRED_VAULT_SESSION set.  We diff the learn-type directory instead.
    vault_dir = config.vault.vault_path
    learn_dir = vault_dir / spec.learn_type
    before_files = set(learn_dir.glob("*.md")) if learn_dir.is_dir() else set()

    await _call_llm(prompt, config, session_path, stage_label)

    # Check what's new — first try the mutation log
    after_created = set(read_mutations(session_path).get("files_created", []))
    new_created = after_created - before_created

    for path in new_created:
        if path.startswith(f"{spec.learn_type}/"):
            log.info("pipeline.s3_created", path=path, type=spec.learn_type)
            return path

    # If the type directory doesn't match exactly, accept any new learn-type file
    for path in new_created:
        log.info("pipeline.s3_created", path=path, type=spec.learn_type)
        return path

    # Fallback: filesystem diff (handles cross-container agent writes)
    if learn_dir.is_dir():
        after_files = set(learn_dir.glob("*.md"))
        new_files = after_files - before_files
        for f in new_files:
            rel = f.relative_to(vault_dir)
            log.info("pipeline.s3_created_via_fs_diff", path=str(rel), type=spec.learn_type)
            return str(rel)

    log.warning("pipeline.s3_no_record_created", title=spec.title)
    return None


# ---------------------------------------------------------------------------
# Pass B — Cross-learning meta-analysis
# ---------------------------------------------------------------------------


def _find_analysis_clusters(
    learns: list[VaultRecord],
    min_cluster_size: int = 3,
) -> list[dict]:
    """Find clusters of related learnings for cross-analysis.

    Groups by shared project and by learn type (cross-project).
    """
    clusters: list[dict] = []

    # Group by project
    by_project: dict[str, list[VaultRecord]] = {}
    for rec in learns:
        proj = rec.frontmatter.get("project", [])
        proj_list = proj if isinstance(proj, list) else [proj] if proj else []
        for p in proj_list:
            links = extract_wikilinks(str(p))
            for link in links:
                name = link.split("/", 1)[1] if "/" in link else link
                by_project.setdefault(name, []).append(rec)

    for project_name, project_learns in by_project.items():
        if len(project_learns) >= min_cluster_size:
            clusters.append({
                "label": f"Project: {project_name}",
                "project": project_name,
                "records": project_learns,
            })

    # Group by learn type (vault-wide cross-project analysis)
    already_clustered: set[str] = set()
    for c in clusters:
        for r in c["records"]:
            already_clustered.add(r.rel_path)

    by_type: dict[str, list[VaultRecord]] = {}
    for rec in learns:
        by_type.setdefault(rec.record_type, []).append(rec)

    for learn_type, type_learns in by_type.items():
        unclustered = [
            r for r in type_learns if r.rel_path not in already_clustered
        ]
        if len(unclustered) >= min_cluster_size:
            clusters.append({
                "label": f"Type: {learn_type} (cross-project)",
                "project": None,
                "records": unclustered,
            })

    log.info("pipeline.passb_clusters", clusters=len(clusters))
    return clusters


def _format_cluster_for_llm(cluster: dict) -> str:
    """Format a cluster of learning records for the Pass B prompt."""
    lines: list[str] = []
    for rec in cluster["records"][:20]:
        fm = rec.frontmatter
        title = (
            fm.get("name", "")
            or fm.get("subject", "")
            or Path(rec.rel_path).stem
        )
        confidence = fm.get("confidence", "")
        status = fm.get("status", "")
        body_preview = rec.body[:500].strip()

        lines.append(f"### {rec.rel_path}")
        lines.append(
            f"- Type: {rec.record_type}, Status: {status}, Confidence: {confidence}"
        )
        lines.append(f"- Title: {title}")
        if body_preview:
            lines.append(f"```\n{body_preview}\n```")
        lines.append("")

    return "\n".join(lines)


async def run_meta_analysis(
    config: DistillerConfig,
    session_path: str,
) -> int:
    """Pass B: Cross-learning meta-analysis. Returns count of meta-records created."""
    vault_path = config.vault.vault_path
    learn_types = config.extraction.learn_types

    learns = collect_existing_learns(
        vault_path, config.vault.ignore_dirs, learn_types
    )
    if len(learns) < 3:
        log.info(
            "pipeline.passb_skip", reason="too_few_learns", count=len(learns)
        )
        return 0

    clusters = _find_analysis_clusters(learns)
    if not clusters:
        log.info("pipeline.passb_skip", reason="no_clusters")
        return 0

    template = _load_stage_prompt("passb_cross_analyze.md")
    if not template:
        return 0

    meta_created = 0

    for cluster in clusters:
        # Snapshot before
        before_created = set(
            read_mutations(session_path).get("files_created", [])
        )

        cluster_text = _format_cluster_for_llm(cluster)
        prompt = template.format(
            cluster_label=cluster["label"],
            cluster_records=cluster_text,
            cluster_size=len(cluster["records"]),
            vault_cli_reference=VAULT_CLI_REFERENCE,
        )

        safe_label = re.sub(
            r"[^a-zA-Z0-9_-]", "",
            cluster["label"].replace(" ", "-"),
        )[:30]
        stage_label = f"passb-{safe_label}"

        await _call_llm(prompt, config, session_path, stage_label)

        # Count new creations
        after_created = set(
            read_mutations(session_path).get("files_created", [])
        )
        new_created = after_created - before_created
        cluster_created = sum(
            1
            for path in new_created
            if any(path.startswith(f"{lt}/") for lt in learn_types)
        )
        meta_created += cluster_created

        log.info(
            "pipeline.passb_cluster_done",
            cluster=cluster["label"],
            created=cluster_created,
        )

    log.info("pipeline.passb_complete", meta_created=meta_created)
    return meta_created


# ---------------------------------------------------------------------------
# Pipeline entry point
# ---------------------------------------------------------------------------


async def run_pipeline(
    batch: ExtractionBatch,
    config: DistillerConfig,
    session_path: str,
) -> PipelineResult:
    """Run the multi-stage distiller pipeline on one extraction batch.

    Pass A: per-source extraction → dedup → create.
    """
    result = PipelineResult()
    vault_path = config.vault.vault_path

    log.info(
        "pipeline.start",
        project=batch.project,
        sources=len(batch.source_records),
    )

    # --- Pass A: Stage 1 — Extract per-source-record ---
    all_manifests: dict[str, list[dict]] = {}

    for source in batch.source_records:
        manifest = await _stage1_extract(
            source=source,
            existing_learns=batch.existing_learns,
            config=config,
            session_path=session_path,
        )
        all_manifests[source.record.rel_path] = manifest

        # Save distiller signals on the source record
        if _save_distiller_signals(
            source.record.rel_path,
            source.signals,
            vault_path,
            session_path,
        ):
            result.signals_saved += 1

        result.candidates_processed += 1

    # --- Pass A: Stage 2 — Dedup + Merge ---
    specs = _stage2_dedup_merge(
        all_manifests=all_manifests,
        existing_learns=batch.existing_learns,
    )

    # --- Pass A: Stage 3 — Create ---
    created_paths: list[str] = []
    for spec in specs:
        created_path = await _stage3_create(spec, config, session_path)
        if created_path:
            lt = spec.learn_type
            result.records_created[lt] = result.records_created.get(lt, 0) + 1
            created_paths.append(created_path)

    # Update source records with links to created learnings
    for source in batch.source_records:
        if created_paths:
            learn_links = [
                f"[[{p.removesuffix('.md')}]]" for p in created_paths
            ]
            try:
                vault_edit(
                    vault_path,
                    source.record.rel_path,
                    set_fields={"distiller_learnings": learn_links},
                )
                log_mutation(session_path, "edit", source.record.rel_path)
            except VaultError:
                pass

    result.success = True
    total_created = sum(result.records_created.values())
    type_summary = ", ".join(
        f"{t}: {c}" for t, c in result.records_created.items()
    )
    result.summary = (
        f"Processed {result.candidates_processed} sources, "
        f"created {total_created} records ({type_summary}), "
        f"saved signals on {result.signals_saved} sources"
    )

    log.info(
        "pipeline.complete",
        project=batch.project,
        processed=result.candidates_processed,
        created=total_created,
    )

    return result
