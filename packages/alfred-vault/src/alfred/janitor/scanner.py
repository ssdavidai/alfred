"""Phase 1: Structural scanner — fast, deterministic checks."""

from __future__ import annotations

import re
from pathlib import Path

from alfred.vault.schema import (
    KNOWN_TYPES,
    LIST_FIELDS,
    NAME_FIELD_BY_TYPE,
    REQUIRED_FIELDS,
    STATUS_BY_TYPE,
    TYPE_DIRECTORY,
)

from .config import JanitorConfig
from .issues import Issue, IssueCode, Severity, SEVERITY_MAP
from .parser import VaultRecord, extract_wikilinks, parse_file, stripped_body_length
from .state import JanitorState
from .utils import compute_md5, get_logger

log = get_logger(__name__)


def _frontmatter_text(fm: dict) -> str:
    """Serialize frontmatter dict to a string for wikilink extraction."""
    import yaml
    return yaml.dump(fm, default_flow_style=False, allow_unicode=True)


def _build_stem_index(vault_path: Path, ignore_dirs: set[str]) -> dict[str, set[str]]:
    """Map stem names to file relative paths for wikilink resolution.

    E.g. "Eagle Farm" -> {"project/Eagle Farm.md"}
    Also maps full rel_path without .md: "project/Eagle Farm" -> {"project/Eagle Farm.md"}
    """
    index: dict[str, set[str]] = {}
    for md_file in vault_path.rglob("*.md"):
        rel = md_file.relative_to(vault_path)
        if any(part in ignore_dirs for part in rel.parts):
            continue
        rel_str = str(rel).replace("\\", "/")
        stem = md_file.stem

        # Map by stem name
        index.setdefault(stem, set()).add(rel_str)

        # Map by relative path without extension
        rel_no_ext = rel_str[:-3] if rel_str.endswith(".md") else rel_str
        index.setdefault(rel_no_ext, set()).add(rel_str)

    return index


def _build_inbound_index(
    vault_path: Path,
    all_files: dict[str, str],  # rel_path -> md5
    ignore_dirs: set[str],
) -> dict[str, set[str]]:
    """Map each file to the set of files that link TO it (inbound links).

    Returns {target_rel_path: {source_rel_path, ...}}.
    """
    inbound: dict[str, set[str]] = {}
    stem_index = _build_stem_index(vault_path, ignore_dirs)

    for rel_path in all_files:
        try:
            raw = (vault_path / rel_path).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        links = extract_wikilinks(raw)
        for target in links:
            # Resolve target to actual files
            resolved = stem_index.get(target, set())
            for resolved_path in resolved:
                inbound.setdefault(resolved_path, set()).add(rel_path)

    return inbound


def run_structural_scan(
    config: JanitorConfig,
    state: JanitorState,
) -> list[Issue]:
    """Run Phase 1 structural scan. Returns list of issues found."""
    vault_path = config.vault.vault_path
    ignore_dirs = set(config.vault.ignore_dirs)
    ignore_files = set(config.vault.ignore_files)

    # 1. Hash all .md files
    all_files: dict[str, str] = {}  # rel_path -> md5
    for md_file in vault_path.rglob("*.md"):
        rel = md_file.relative_to(vault_path)
        if any(part in ignore_dirs for part in rel.parts):
            continue
        if md_file.name in ignore_files:
            continue
        rel_str = str(rel).replace("\\", "/")
        if rel_str in state.ignored:
            continue
        try:
            all_files[rel_str] = compute_md5(md_file)
        except OSError:
            continue

    # 2. Determine which files to scan (changed or have open issues)
    files_to_scan: list[str] = []
    skipped = 0
    for rel_path, md5 in all_files.items():
        if state.should_scan(rel_path, md5):
            files_to_scan.append(rel_path)
        else:
            skipped += 1

    log.info(
        "scanner.scan_start",
        total_files=len(all_files),
        to_scan=len(files_to_scan),
        skipped=skipped,
    )

    # 3. Build indexes
    stem_index = _build_stem_index(vault_path, ignore_dirs)
    inbound_index = _build_inbound_index(vault_path, all_files, ignore_dirs)

    # 4. Build name index for duplicate detection
    name_by_type_dir: dict[str, list[tuple[str, str]]] = {}  # type_dir -> [(name, rel_path)]

    # 5. Per-file checks
    issues: list[Issue] = []

    for rel_path in files_to_scan:
        try:
            record = parse_file(vault_path, rel_path)
        except Exception as e:
            log.warning("scanner.parse_error", file=rel_path, error=str(e))
            issues.append(Issue(
                code=IssueCode.MISSING_REQUIRED_FIELD,
                severity=Severity.CRITICAL,
                file=rel_path,
                message=f"Failed to parse file: {e}",
            ))
            continue

        file_issues = _check_record(
            record, rel_path, stem_index, inbound_index,
            config, name_by_type_dir,
        )
        issues.extend(file_issues)

        # Update state for this file
        issue_codes = [i.code.value for i in file_issues]
        state.update_file(rel_path, all_files[rel_path], issue_codes)

    # 6. Clean up deleted files from state
    for rel_path in list(state.files.keys()):
        if rel_path not in all_files and rel_path not in state.ignored:
            state.remove_file(rel_path)

    log.info("scanner.scan_complete", issues=len(issues))
    return issues


def _check_record(
    record: VaultRecord,
    rel_path: str,
    stem_index: dict[str, set[str]],
    inbound_index: dict[str, set[str]],
    config: JanitorConfig,
    name_by_type_dir: dict[str, list[tuple[str, str]]],
) -> list[Issue]:
    """Run all structural checks on a single record."""
    issues: list[Issue] = []
    fm = record.frontmatter

    # FM001: Missing required fields
    for req in REQUIRED_FIELDS:
        if not fm.get(req):
            issues.append(Issue(
                code=IssueCode.MISSING_REQUIRED_FIELD,
                severity=Severity.CRITICAL,
                file=rel_path,
                message=f"Missing required field: {req}",
                suggested_fix=f"Add '{req}' to frontmatter",
            ))

    # Check name/subject field
    rec_type = fm.get("type", "")
    title_field = NAME_FIELD_BY_TYPE.get(rec_type, "name")
    if rec_type and not fm.get(title_field) and not fm.get("name"):
        issues.append(Issue(
            code=IssueCode.MISSING_REQUIRED_FIELD,
            severity=Severity.CRITICAL,
            file=rel_path,
            message=f"Missing title field: {title_field} (or name)",
            suggested_fix=f"Set '{title_field}' from filename stem",
        ))

    # FM002: Invalid type
    if rec_type and rec_type not in KNOWN_TYPES:
        issues.append(Issue(
            code=IssueCode.INVALID_TYPE_VALUE,
            severity=Severity.CRITICAL,
            file=rel_path,
            message=f"Unknown type: '{rec_type}'",
            detail=f"Known types: {', '.join(sorted(KNOWN_TYPES))}",
        ))

    # FM003: Invalid status
    status = fm.get("status", "")
    if rec_type and status and rec_type in STATUS_BY_TYPE:
        valid = STATUS_BY_TYPE[rec_type]
        if valid and status not in valid:
            issues.append(Issue(
                code=IssueCode.INVALID_STATUS_VALUE,
                severity=Severity.WARNING,
                file=rel_path,
                message=f"Invalid status '{status}' for type '{rec_type}'",
                detail=f"Valid: {', '.join(sorted(valid))}",
                suggested_fix=f"Change to nearest valid status",
            ))

    # FM004: Field type checks (lists that should be lists)
    for field_name in LIST_FIELDS:
        val = fm.get(field_name)
        if val is not None and not isinstance(val, list):
            # Special case: some types use project as a string, not list
            if field_name == "project" and isinstance(val, str):
                continue
            issues.append(Issue(
                code=IssueCode.INVALID_FIELD_TYPE,
                severity=Severity.WARNING,
                file=rel_path,
                message=f"Field '{field_name}' should be a list, got {type(val).__name__}",
                suggested_fix=f"Wrap value in a list: [{val!r}]",
            ))

    # DIR001: Wrong directory
    if rec_type in TYPE_DIRECTORY:
        expected_dir = TYPE_DIRECTORY[rec_type]
        parts = rel_path.replace("\\", "/").split("/")
        if len(parts) > 1 and parts[0] != expected_dir:
            # Allow date-organized paths (YYYY/MM/DD)
            if not (len(parts[0]) == 4 and parts[0].isdigit()):
                issues.append(Issue(
                    code=IssueCode.WRONG_DIRECTORY,
                    severity=Severity.WARNING,
                    file=rel_path,
                    message=f"Type '{rec_type}' expected in '{expected_dir}/', found in '{parts[0]}/'",
                    suggested_fix=f"Move to {expected_dir}/",
                ))

    # LINK001: Broken wikilinks
    for target in record.wikilinks:
        # Skip Dataview base view references (e.g. "person.base#Decisions")
        if ".base" in target:
            continue
        resolved = stem_index.get(target, set())
        if not resolved:
            issues.append(Issue(
                code=IssueCode.BROKEN_WIKILINK,
                severity=Severity.CRITICAL,
                file=rel_path,
                message=f"Broken wikilink: [[{target}]]",
                suggested_fix="Fix target path or create missing record",
            ))

    # LINK002: Entity wikilinks in body but not in any frontmatter field
    # Obsidian Bases' file.hasLink(this.file) only checks frontmatter links,
    # so body-only entity links won't appear in base view tables.
    _entity_dirs = set(TYPE_DIRECTORY.values())
    fm_text = _frontmatter_text(record.frontmatter)
    fm_link_targets = set(extract_wikilinks(fm_text))
    body_links = set(extract_wikilinks(record.body))
    missing_from_fm = []
    for link in body_links - fm_link_targets:
        if "/" not in link:
            continue
        link_dir = link.split("/", 1)[0]
        if link_dir not in _entity_dirs:
            continue
        # Skip self-references
        rel_no_ext = rel_path[:-3] if rel_path.endswith(".md") else rel_path
        if link == rel_no_ext:
            continue
        # Only flag if the target actually exists
        if stem_index.get(link):
            missing_from_fm.append(link)
    if missing_from_fm:
        issues.append(Issue(
            code=IssueCode.UNLINKED_BODY_ENTITY,
            severity=Severity.WARNING,
            file=rel_path,
            message=f"{len(missing_from_fm)} entity link(s) in body but not in frontmatter",
            detail=", ".join(sorted(missing_from_fm)[:5]),
            suggested_fix="Add to related: frontmatter array",
        ))

    # ORPHAN001: Orphaned record (no inbound links)
    exempt_dirs = set(config.sweep.orphan_exempt_dirs)
    parts = rel_path.replace("\\", "/").split("/")
    first_dir = parts[0] if len(parts) > 1 else ""
    if first_dir not in exempt_dirs:
        inbound = inbound_index.get(rel_path, set())
        if not inbound and rec_type:
            issues.append(Issue(
                code=IssueCode.ORPHANED_RECORD,
                severity=Severity.WARNING,
                file=rel_path,
                message="No inbound wikilinks from any other record",
            ))

    # STUB001: Stub record
    body_len = stripped_body_length(record.body)
    if body_len < config.sweep.stub_body_threshold_chars and rec_type:
        issues.append(Issue(
            code=IssueCode.STUB_RECORD,
            severity=Severity.INFO,
            file=rel_path,
            message=f"Stub body ({body_len} chars after stripping embeds)",
            suggested_fix="Flesh out body content",
        ))

    # DUP001: Duplicate name in same type directory
    if rec_type in TYPE_DIRECTORY:
        type_dir = TYPE_DIRECTORY[rec_type]
        name = fm.get("name", "") or fm.get("subject", "")
        if name:
            key = type_dir
            existing = name_by_type_dir.setdefault(key, [])
            for existing_name, existing_path in existing:
                if existing_name.lower() == name.lower() and existing_path != rel_path:
                    issues.append(Issue(
                        code=IssueCode.DUPLICATE_NAME,
                        severity=Severity.INFO,
                        file=rel_path,
                        message=f"Duplicate name '{name}' — also at {existing_path}",
                        suggested_fix="Merge or differentiate records",
                    ))
                    break
            existing.append((name, rel_path))

    return issues
