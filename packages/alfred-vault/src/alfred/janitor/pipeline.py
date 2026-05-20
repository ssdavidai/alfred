"""3-stage janitor pipeline — replaces the monolithic single-LLM-call approach.

Stage 1: AUTOFIX (pure Python) — fix deterministic issues without LLM
Stage 2: LINK REPAIR (LLM, per-file) — fix broken wikilinks with candidate matching
Stage 3: ENRICH (LLM, per-file) — fill stub records from vault context + public facts
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .state import JanitorState

from alfred.vault.mutation_log import log_mutation
from alfred.vault.ops import VaultError, vault_read, vault_search

from .autofix import autofix_issues
from .backends import VAULT_CLI_REFERENCE
from .backends.openclaw import _clear_agent_sessions, _sync_workspace_claude_md
from .config import JanitorConfig
from .issues import Issue, IssueCode
from .parser import extract_wikilinks
from .utils import get_logger

log = get_logger(__name__)


@dataclass
class PipelineResult:
    """Result from the 3-stage janitor pipeline."""

    success: bool = False
    files_fixed: int = 0
    files_flagged: int = 0
    links_repaired: int = 0
    stubs_enriched: int = 0
    summary: str = ""


def _load_stage_prompt(stage_file: str) -> str:
    """Load a stage prompt from the bundled skills directory."""
    from alfred._data import get_skills_dir

    prompt_path = get_skills_dir() / "vault-janitor" / "prompts" / stage_file
    if not prompt_path.exists():
        log.warning("pipeline.prompt_not_found", path=str(prompt_path))
        return ""
    return prompt_path.read_text(encoding="utf-8")


def _load_type_schema(record_type: str) -> str:
    """Load the reference template for a specific record type."""
    from alfred._data import get_skills_dir

    refs_dir = get_skills_dir() / "vault-janitor" / "references"
    # Try exact match first, then learn-* prefix for learning types
    for candidate_name in [f"{record_type}.md", f"learn-{record_type}.md"]:
        candidate = refs_dir / candidate_name
        if candidate.exists():
            return candidate.read_text(encoding="utf-8")
    return f"(no schema reference found for type '{record_type}')"


async def _call_llm(
    prompt: str,
    config: JanitorConfig,
    session_path: str,
    stage_label: str,
) -> str:
    """Make an isolated OpenClaw call and return stdout.

    Handles session clearing, workspace sync, subprocess exec with
    --local --json, and timeout.
    """
    oc = config.agent.openclaw
    session_id = f"janitor-{stage_label}-{uuid.uuid4().hex[:8]}"

    _clear_agent_sessions(oc.agent_id)
    _sync_workspace_claude_md(oc.agent_id, str(config.vault.vault_path))

    cmd = [
        oc.command, "agent", *oc.args,
        "--agent", oc.agent_id,
        "--session-id", session_id,
        "--message", prompt,
        "--local", "--json",
    ]

    env = {
        **os.environ,
        "ALFRED_VAULT_PATH": str(config.vault.vault_path),
        "ALFRED_VAULT_SCOPE": "janitor",
        "ALFRED_VAULT_SESSION": session_path,
    }

    log.info(
        "pipeline.llm_call",
        stage=stage_label,
        agent_id=oc.agent_id,
        session_id=session_id,
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
# Stage 2: Link Repair (LLM for ambiguous cases)
# ---------------------------------------------------------------------------


def _find_link_candidates(
    broken_target: str,
    vault_path: Path,
    ignore_dirs: list[str],
) -> list[dict]:
    """Search the vault for records that might match a broken wikilink target."""
    candidates: list[dict] = []

    # Strategy 1: search by stem name (the last component of the target)
    stem = broken_target.split("/")[-1] if "/" in broken_target else broken_target
    results = vault_search(vault_path, grep_pattern=stem, ignore_dirs=ignore_dirs)
    for r in results:
        candidates.append(r)

    # Strategy 2: if the target has a directory prefix, try glob in that directory
    if "/" in broken_target:
        dir_part = broken_target.split("/")[0]
        glob = f"{dir_part}/*.md"
        glob_results = vault_search(vault_path, glob_pattern=glob, ignore_dirs=ignore_dirs)
        for r in glob_results:
            if r not in candidates:
                candidates.append(r)

    # Deduplicate by path
    seen: set[str] = set()
    unique: list[dict] = []
    for c in candidates:
        if c["path"] not in seen:
            seen.add(c["path"])
            unique.append(c)

    return unique


def _is_unambiguous_match(
    broken_target: str,
    candidates: list[dict],
) -> str | None:
    """If exactly one candidate matches unambiguously, return its wikilink path.

    Returns the wikilink-style path (without .md) or None if ambiguous.
    """
    if len(candidates) != 1:
        return None

    match = candidates[0]
    match_path = match["path"]
    match_stem = Path(match_path).stem
    target_stem = broken_target.split("/")[-1] if "/" in broken_target else broken_target

    # Unambiguous if the stem matches exactly (case-insensitive)
    if match_stem.lower() == target_stem.lower():
        return match_path.removesuffix(".md") if match_path.endswith(".md") else match_path

    return None


def _fix_link_in_python(
    file_path: str,
    broken_target: str,
    correct_target: str,
    vault_path: Path,
    session_path: str,
) -> bool:
    """Fix a broken wikilink directly in Python. Returns True on success."""
    try:
        record = vault_read(vault_path, file_path)
    except VaultError:
        return False

    fm = record["frontmatter"]
    body = record["body"]
    changed = False

    # Fix in body text
    old_link = f"[[{broken_target}]]"
    new_link = f"[[{correct_target}]]"
    if old_link in body:
        body = body.replace(old_link, new_link)
        changed = True

    # Fix in frontmatter values (wikilinks in string/list fields)
    for key, val in fm.items():
        if isinstance(val, str) and f"[[{broken_target}]]" in val:
            fm[key] = val.replace(f"[[{broken_target}]]", f"[[{correct_target}]]")
            changed = True
        elif isinstance(val, list):
            new_list = []
            for item in val:
                if isinstance(item, str) and f"[[{broken_target}]]" in item:
                    new_list.append(item.replace(f"[[{broken_target}]]", f"[[{correct_target}]]"))
                    changed = True
                else:
                    new_list.append(item)
            if changed:
                fm[key] = new_list

    if not changed:
        return False

    # Write the raw file directly since vault_edit doesn't support body replacement
    import frontmatter as fm_lib

    full_path = vault_path / file_path
    post = fm_lib.Post(body, **fm)
    full_path.write_text(fm_lib.dumps(post) + "\n", encoding="utf-8")
    log_mutation(session_path, "edit", file_path)

    return True


MAX_ISSUES_PER_SWEEP = 15  # Cap LLM calls per sweep to control cost


async def _stage2_link_repair(
    link_issues: list[Issue],
    config: JanitorConfig,
    session_path: str,
) -> int:
    """Stage 2: Repair broken wikilinks. Returns count of links repaired."""
    if not link_issues:
        return 0

    # Cap issues per sweep to prevent runaway cost
    if len(link_issues) > MAX_ISSUES_PER_SWEEP:
        log.warning(
            "pipeline.s2_capped",
            total=len(link_issues),
            processing=MAX_ISSUES_PER_SWEEP,
        )
        link_issues = link_issues[:MAX_ISSUES_PER_SWEEP]

    vault_path = config.vault.vault_path
    ignore_dirs = config.vault.ignore_dirs
    template = _load_stage_prompt("stage2_link_repair.md")
    repaired = 0

    for issue in link_issues:
        # Extract broken target from message: "Broken wikilink: [[target]]"
        match = re.search(r"\[\[([^\]]+)\]\]", issue.message)
        if not match:
            log.warning("pipeline.s2_no_target", file=issue.file, message=issue.message)
            continue
        broken_target = match.group(1)

        # Find candidates
        candidates = _find_link_candidates(broken_target, vault_path, ignore_dirs)

        # Try unambiguous Python fix first
        unambiguous = _is_unambiguous_match(broken_target, candidates)
        if unambiguous:
            if _fix_link_in_python(issue.file, broken_target, unambiguous, vault_path, session_path):
                log.info(
                    "pipeline.s2_fixed_python",
                    file=issue.file,
                    old=broken_target,
                    new=unambiguous,
                )
                repaired += 1
                continue

        # Ambiguous or no match -- send to LLM if we have candidates and a template
        if not template:
            log.warning("pipeline.s2_no_template", file=issue.file)
            continue

        candidates_text = _format_candidates(candidates)
        candidate_names = ", ".join(c.get("name", c["path"]) for c in candidates[:10])

        prompt = template.format(
            file_path=issue.file,
            broken_target=broken_target,
            candidates=candidates_text,
            candidate_names=candidate_names,
            vault_cli_reference=VAULT_CLI_REFERENCE,
        )

        safe_name = re.sub(r'[^a-zA-Z0-9_-]', '', broken_target.replace(' ', '-').replace('/', '-'))[:30]
        stage_label = f"s2-link-{safe_name}"

        # Snapshot file mtime before LLM call to detect actual changes.
        # The mutation log doesn't work cross-container (openclaw-wrapper
        # sends prompts via HTTP to the openclaw container which doesn't
        # have ALFRED_VAULT_SESSION), so we check the filesystem directly.
        target_path = config.vault.vault_path / issue.file
        before_mtime = target_path.stat().st_mtime if target_path.exists() else 0

        await _call_llm(prompt, config, session_path, stage_label)

        after_mtime = target_path.stat().st_mtime if target_path.exists() else 0
        if after_mtime > before_mtime:
            repaired += 1

        log.info("pipeline.s2_llm_repair", file=issue.file, target=broken_target)

    log.info("pipeline.s2_complete", repaired=repaired)
    return repaired


def _format_candidates(candidates: list[dict]) -> str:
    """Format candidate matches for the LLM prompt."""
    if not candidates:
        return "(no candidates found -- the target may need to be created or is a typo)"

    lines: list[str] = []
    for c in candidates[:15]:
        name = c.get("name", "")
        rec_type = c.get("type", "")
        status = c.get("status", "")
        path = c["path"]
        line = f"- **{path}** (name: {name}, type: {rec_type}"
        if status:
            line += f", status: {status}"
        line += ")"
        lines.append(line)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Stage 3: Enrich Stubs (LLM, per-file)
# ---------------------------------------------------------------------------


def _collect_linked_records(
    file_path: str,
    vault_path: Path,
    ignore_dirs: list[str],
) -> str:
    """Read all records that link to or from the given file.

    Returns a formatted text block with the content of linked records.
    """
    # Read the stub record to find outbound links
    try:
        record = vault_read(vault_path, file_path)
    except VaultError:
        return "(could not read stub record)"

    raw_text = ""
    full_path = vault_path / file_path
    try:
        raw_text = full_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        pass

    outbound_targets = set(extract_wikilinks(raw_text))

    # Find inbound links by searching for the stem name
    stem = Path(file_path).stem
    inbound_results = vault_search(vault_path, grep_pattern=re.escape(stem), ignore_dirs=ignore_dirs)

    # Collect all linked file paths
    linked_paths: set[str] = set()

    # Add inbound links
    for r in inbound_results:
        if r["path"] != file_path:
            linked_paths.add(r["path"])

    # Resolve outbound targets to file paths
    for target in outbound_targets:
        # Try with .md extension
        candidate = f"{target}.md"
        if (vault_path / candidate).exists():
            linked_paths.add(candidate)
        # Try as-is (might already have .md)
        if (vault_path / target).exists():
            linked_paths.add(target)

    # Read each linked record and format
    parts: list[str] = []
    for linked_path in sorted(linked_paths):
        try:
            linked_record = vault_read(vault_path, linked_path)
            fm_str = json.dumps(linked_record["frontmatter"], indent=2, default=str)
            body = linked_record["body"]
            # Truncate very long bodies
            if len(body) > 2000:
                body = body[:2000] + "\n... (truncated)"
            parts.append(f"### {linked_path}\n```yaml\n{fm_str}\n```\n{body}\n")
        except VaultError:
            parts.append(f"### {linked_path}\n(could not read)\n")

    if not parts:
        return "(no linked records found)"

    return "\n---\n".join(parts)


async def _stage3_enrich(
    stub_issues: list[Issue],
    config: JanitorConfig,
    session_path: str,
    state: "JanitorState | None" = None,
) -> int:
    """Stage 3: Enrich stub records. Returns count of stubs enriched.

    Issue #15: Caps stubs processed per sweep, prioritises newest stubs with
    more linked records, and skips stale files (too many failed attempts).
    """
    if not stub_issues:
        return 0

    vault_path = config.vault.vault_path
    ignore_dirs = config.vault.ignore_dirs
    max_stubs = config.sweep.max_stubs_per_sweep
    max_attempts = config.sweep.max_enrichment_attempts
    template = _load_stage_prompt("stage3_enrich.md")
    if not template:
        log.warning("pipeline.s3_no_template")
        return 0

    # Issue #15: filter out stale stubs (enrichment exhausted, content unchanged)
    if state is not None:
        filtered: list[Issue] = []
        for issue in stub_issues:
            if state.is_enrichment_stale(issue.file):
                log.debug(
                    "pipeline.s3_skip_stale",
                    file=issue.file,
                    msg="enrichment stale, skipping until content changes",
                )
                continue
            filtered.append(issue)
        stub_issues = filtered

    if not stub_issues:
        log.info("pipeline.s3_all_stale", msg="all stubs stale, nothing to enrich")
        return 0

    # Issue #15: sort stubs — newest first, then by linked-record count
    # (more links = better chance of successful enrichment from context)
    def _stub_sort_key(issue: Issue) -> tuple[str, int]:
        """Return (last_scanned DESC, -linked_count) for sorting."""
        last_scanned = ""
        linked_count = 0
        if state is not None and issue.file in state.files:
            last_scanned = state.files[issue.file].last_scanned
        # Count inbound+outbound links as a proxy for context richness
        try:
            raw_text = (vault_path / issue.file).read_text(encoding="utf-8")
            linked_count = len(extract_wikilinks(raw_text))
        except (OSError, UnicodeDecodeError):
            pass
        return (last_scanned, -linked_count)

    stub_issues.sort(key=_stub_sort_key, reverse=True)

    # Issue #15: cap to max_stubs_per_sweep to control token spend
    if len(stub_issues) > max_stubs:
        log.info(
            "pipeline.s3_capped",
            total=len(stub_issues),
            processing=max_stubs,
        )
        stub_issues = stub_issues[:max_stubs]

    enriched = 0

    for issue in stub_issues:
        file_path = issue.file

        # Read the stub record
        try:
            record = vault_read(vault_path, file_path)
        except VaultError:
            log.warning("pipeline.s3_read_failed", file=file_path)
            # Issue #15: count failed reads as enrichment attempts
            if state is not None:
                state.record_enrichment_attempt(file_path, max_attempts)
            continue

        fm = record["frontmatter"]
        record_type = fm.get("type", "")
        record_name = fm.get("name", "") or fm.get("subject", "") or Path(file_path).stem

        # Load the type-specific schema reference
        type_schema = _load_type_schema(record_type) if record_type else "(unknown type)"

        # Collect linked records for context
        linked_records = _collect_linked_records(file_path, vault_path, ignore_dirs)

        # Format current record content
        record_content = json.dumps(record, indent=2, default=str)

        prompt = template.format(
            file_path=file_path,
            record_type=record_type,
            record_name=record_name,
            record_content=record_content,
            type_schema=type_schema,
            linked_records=linked_records,
            vault_cli_reference=VAULT_CLI_REFERENCE,
        )

        safe_name = re.sub(r'[^a-zA-Z0-9_-]', '', record_name.replace(' ', '-'))[:30]
        stage_label = f"s3-enrich-{safe_name}"

        await _call_llm(prompt, config, session_path, stage_label)
        enriched += 1

        # Issue #15: track enrichment attempt in state
        if state is not None:
            state.record_enrichment_attempt(file_path, max_attempts)

        log.info("pipeline.s3_enriched", file=file_path, type=record_type)

    log.info("pipeline.s3_complete", enriched=enriched)
    return enriched


# ---------------------------------------------------------------------------
# Pipeline entry point
# ---------------------------------------------------------------------------


async def run_pipeline(
    issues: list[Issue],
    config: JanitorConfig,
    session_path: str,
    state: "JanitorState | None" = None,
) -> PipelineResult:
    """Run the 3-stage janitor pipeline on a list of issues.

    Args:
        issues: Issues detected by the structural scanner.
        config: Janitor configuration.
        session_path: Path to the mutation log session file.
        state: Optional janitor state for enrichment staleness tracking (issue #15).

    Returns:
        PipelineResult with success status and details.
    """
    result = PipelineResult()
    vault_path = config.vault.vault_path

    log.info("pipeline.start", issues=len(issues))

    # Partition issues by stage
    autofix_codes = {
        IssueCode.MISSING_REQUIRED_FIELD,
        IssueCode.INVALID_TYPE_VALUE,
        IssueCode.INVALID_STATUS_VALUE,
        IssueCode.INVALID_FIELD_TYPE,
        IssueCode.WRONG_DIRECTORY,
        IssueCode.ORPHANED_RECORD,
        IssueCode.DUPLICATE_NAME,
    }
    autofix_issues_list = [i for i in issues if i.code in autofix_codes]
    link_issues = [i for i in issues if i.code == IssueCode.BROKEN_WIKILINK]
    stub_issues = [i for i in issues if i.code == IssueCode.STUB_RECORD]

    # Stage 1: Autofix (pure Python)
    log.info("pipeline.s1_start", issues=len(autofix_issues_list))
    fixed, flagged, skipped = autofix_issues(
        autofix_issues_list,
        vault_path,
        session_path,
    )
    result.files_fixed = len(fixed)
    result.files_flagged = len(flagged)

    log.info(
        "pipeline.s1_complete",
        fixed=len(fixed),
        flagged=len(flagged),
        skipped=len(skipped),
    )

    # Stage 2: Link Repair (LLM for ambiguous, Python for unambiguous)
    log.info("pipeline.s2_start", issues=len(link_issues))
    result.links_repaired = await _stage2_link_repair(
        link_issues, config, session_path,
    )

    # Stage 3: Enrich stubs (LLM, per-file)
    # Issue #15: pass state for staleness tracking + cap enforcement
    log.info("pipeline.s3_start", issues=len(stub_issues))
    result.stubs_enriched = await _stage3_enrich(
        stub_issues, config, session_path, state=state,
    )

    result.success = True
    result.summary = (
        f"Autofix: {len(fixed)} fixed, {len(flagged)} flagged, {len(skipped)} skipped. "
        f"Links: {result.links_repaired} repaired. "
        f"Stubs: {result.stubs_enriched} enriched."
    )

    log.info(
        "pipeline.complete",
        fixed=result.files_fixed,
        flagged=result.files_flagged,
        links_repaired=result.links_repaired,
        stubs_enriched=result.stubs_enriched,
    )

    return result
