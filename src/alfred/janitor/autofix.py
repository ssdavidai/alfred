"""Stage 1: Deterministic autofix — pure Python fixes without LLM.

Handles issue codes: FM001, FM002, FM003, FM004, LINK002 (direct fixes)
and DIR001, ORPHAN001, DUP001 (flag with janitor_note).
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from alfred.vault.mutation_log import log_mutation
from alfred.vault.ops import VaultError, vault_edit, vault_read
from alfred.vault.schema import (
    KNOWN_TYPES,
    LIST_FIELDS,
    NAME_FIELD_BY_TYPE,
    STATUS_BY_TYPE,
    TYPE_DIRECTORY,
)

from .issues import Issue, IssueCode
from .utils import get_logger

log = get_logger(__name__)


# Common typo/alias -> canonical type mappings
_TYPE_CORRECTIONS: dict[str, str] = {
    "persons": "person",
    "people": "person",
    "organisation": "org",
    "organization": "org",
    "organisations": "org",
    "organizations": "org",
    "company": "org",
    "projects": "project",
    "tasks": "task",
    "todo": "task",
    "todos": "task",
    "locations": "location",
    "place": "location",
    "notes": "note",
    "memo": "note",
    "decisions": "decision",
    "processes": "process",
    "workflow": "process",
    "events": "event",
    "accounts": "account",
    "assets": "asset",
    "conversations": "conversation",
    "chat": "conversation",
    "thread": "conversation",
    "runs": "run",
    "sessions": "session",
    "inputs": "input",
    "assumptions": "assumption",
    "constraints": "constraint",
    "contradictions": "contradiction",
    "syntheses": "synthesis",
}

# Common invalid -> valid status mappings (type-independent first pass)
_STATUS_CORRECTIONS: dict[str, str] = {
    "open": "active",
    "opened": "active",
    "closed": "completed",
    "complete": "completed",
    "finished": "completed",
    "done": "done",
    "pending": "todo",
    "in-progress": "active",
    "in_progress": "active",
    "wip": "active",
    "on-hold": "paused",
    "on_hold": "paused",
    "hold": "paused",
    "frozen": "paused",
    "canceled": "cancelled",
    "archived": "inactive",
    "archive": "inactive",
    "retired": "inactive",
    "new": "active",
    "started": "active",
    "waiting": "waiting",
    "resolved": "resolved",
    "stale": "inactive",
    "draft": "draft",
    "final": "final",
    "confirmed": "confirmed",
    "challenged": "challenged",
    "superseded": "superseded",
    "expired": "expired",
}


def _infer_type_from_directory(rel_path: str) -> str:
    """Infer record type from the file's parent directory."""
    parts = rel_path.replace("\\", "/").split("/")
    if len(parts) < 2:
        return ""
    parent_dir = parts[0]
    # Reverse lookup: directory -> type
    dir_to_type = {v: k for k, v in TYPE_DIRECTORY.items()}
    return dir_to_type.get(parent_dir, "")


def _name_from_filename(rel_path: str) -> str:
    """Extract a name from the filename stem."""
    return Path(rel_path).stem


def _created_from_mtime(vault_path: Path, rel_path: str) -> str:
    """Get file modification date as YYYY-MM-DD."""
    full_path = vault_path / rel_path
    try:
        mtime = full_path.stat().st_mtime
        return date.fromtimestamp(mtime).isoformat()
    except OSError:
        return date.today().isoformat()


def _correct_status(invalid_status: str, record_type: str) -> str | None:
    """Map an invalid status to the nearest valid one for the given type.

    Returns the corrected status, or None if no mapping found.
    """
    valid_statuses = STATUS_BY_TYPE.get(record_type, set())
    if not valid_statuses:
        return None

    normalized = invalid_status.lower().strip()

    # Direct match after normalization
    if normalized in valid_statuses:
        return normalized

    # Try the global correction table
    candidate = _STATUS_CORRECTIONS.get(normalized, "")
    if candidate in valid_statuses:
        return candidate

    # Type-specific heuristics: "closed" for tasks -> "done", for threads -> "closed"
    if record_type == "task" and normalized in {"closed", "complete", "finished"}:
        return "done"
    if record_type == "task" and normalized in {"pending", "new"}:
        return "todo"
    if record_type == "conversation" and normalized in {"closed", "done", "finished"}:
        return "resolved"
    if record_type == "project" and normalized in {"done", "finished"}:
        return "completed"

    return None


def _correct_type(invalid_type: str) -> str | None:
    """Map an invalid type to the nearest valid one.

    Returns the corrected type, or None if no mapping found.
    """
    normalized = invalid_type.lower().strip()
    if normalized in KNOWN_TYPES:
        return normalized
    return _TYPE_CORRECTIONS.get(normalized)


def autofix_issues(
    issues: list[Issue],
    vault_path: Path,
    session_path: str,
) -> tuple[list[str], list[str], list[str]]:
    """Apply deterministic fixes to structural issues.

    Returns (fixed_files, flagged_files, skipped_files).
    Each list contains relative paths of affected files.
    """
    fixed: list[str] = []
    flagged: list[str] = []
    skipped: list[str] = []

    # Group issues by file for efficient processing
    by_file: dict[str, list[Issue]] = {}
    for issue in issues:
        by_file.setdefault(issue.file, []).append(issue)

    for rel_path, file_issues in by_file.items():
        file_fixed = False
        file_flagged = False

        for issue in file_issues:
            result = _apply_fix(issue, rel_path, vault_path, session_path)
            if result == "fixed":
                file_fixed = True
            elif result == "flagged":
                file_flagged = True

        if file_fixed:
            fixed.append(rel_path)
        elif file_flagged:
            flagged.append(rel_path)
        else:
            skipped.append(rel_path)

    log.info(
        "autofix.complete",
        fixed=len(fixed),
        flagged=len(flagged),
        skipped=len(skipped),
    )
    return fixed, flagged, skipped


def _apply_fix(
    issue: Issue,
    rel_path: str,
    vault_path: Path,
    session_path: str,
) -> str:
    """Apply a single fix. Returns 'fixed', 'flagged', or 'skipped'."""
    code = issue.code

    if code == IssueCode.MISSING_REQUIRED_FIELD:
        return _fix_missing_field(issue, rel_path, vault_path, session_path)
    if code == IssueCode.INVALID_TYPE_VALUE:
        return _fix_invalid_type(issue, rel_path, vault_path, session_path)
    if code == IssueCode.INVALID_STATUS_VALUE:
        return _fix_invalid_status(issue, rel_path, vault_path, session_path)
    if code == IssueCode.INVALID_FIELD_TYPE:
        return _fix_invalid_field_type(issue, rel_path, vault_path, session_path)
    if code == IssueCode.WRONG_DIRECTORY:
        return _flag_issue(issue, rel_path, vault_path, session_path)
    if code == IssueCode.ORPHANED_RECORD:
        return _flag_issue(issue, rel_path, vault_path, session_path)
    if code == IssueCode.DUPLICATE_NAME:
        return _flag_issue(issue, rel_path, vault_path, session_path)

    if code == IssueCode.UNLINKED_BODY_ENTITY:
        return _fix_unlinked_body_entity(issue, rel_path, vault_path, session_path)

    # Issue codes handled by later stages (LINK001, STUB001) or not autofix-able
    return "skipped"


def _fix_missing_field(
    issue: Issue,
    rel_path: str,
    vault_path: Path,
    session_path: str,
) -> str:
    """FM001: Fix missing required fields by inference."""
    msg = issue.message.lower()
    set_fields: dict = {}

    try:
        record = vault_read(vault_path, rel_path)
        fm = record["frontmatter"]
    except VaultError:
        log.warning("autofix.read_failed", file=rel_path)
        return "skipped"

    if "missing required field: type" in msg:
        inferred = _infer_type_from_directory(rel_path)
        if inferred:
            set_fields["type"] = inferred
            log.info("autofix.infer_type", file=rel_path, type=inferred)
        else:
            return "skipped"

    if "missing required field: created" in msg:
        created = _created_from_mtime(vault_path, rel_path)
        set_fields["created"] = created
        log.info("autofix.infer_created", file=rel_path, created=created)

    if "missing title field" in msg:
        rec_type = fm.get("type", "") or set_fields.get("type", "")
        title_field = NAME_FIELD_BY_TYPE.get(rec_type, "name")
        name = _name_from_filename(rel_path)
        set_fields[title_field] = name
        log.info("autofix.infer_name", file=rel_path, field=title_field, name=name)

    if not set_fields:
        return "skipped"

    try:
        vault_edit(vault_path, rel_path, set_fields=set_fields)
        log_mutation(session_path, "edit", rel_path)
        log.info("autofix.fm001_fixed", file=rel_path, fields=list(set_fields.keys()))
        return "fixed"
    except VaultError as e:
        log.warning("autofix.fm001_failed", file=rel_path, error=str(e))
        return "skipped"


def _fix_invalid_type(
    issue: Issue,
    rel_path: str,
    vault_path: Path,
    session_path: str,
) -> str:
    """FM002: Fix invalid type via mapping table."""
    try:
        record = vault_read(vault_path, rel_path)
        fm = record["frontmatter"]
    except VaultError:
        return "skipped"

    current_type = fm.get("type", "")
    corrected = _correct_type(current_type)

    if corrected:
        try:
            vault_edit(vault_path, rel_path, set_fields={"type": corrected})
            log_mutation(session_path, "edit", rel_path)
            log.info("autofix.fm002_fixed", file=rel_path, old=current_type, new=corrected)
            return "fixed"
        except VaultError as e:
            log.warning("autofix.fm002_failed", file=rel_path, error=str(e))
            return "skipped"

    # No mapping found -- flag for manual review
    return _flag_issue(issue, rel_path, vault_path, session_path)


def _fix_invalid_status(
    issue: Issue,
    rel_path: str,
    vault_path: Path,
    session_path: str,
) -> str:
    """FM003: Fix invalid status via mapping table."""
    try:
        record = vault_read(vault_path, rel_path)
        fm = record["frontmatter"]
    except VaultError:
        return "skipped"

    current_status = fm.get("status", "")
    rec_type = fm.get("type", "")

    corrected = _correct_status(current_status, rec_type)

    if corrected:
        try:
            vault_edit(vault_path, rel_path, set_fields={"status": corrected})
            log_mutation(session_path, "edit", rel_path)
            log.info(
                "autofix.fm003_fixed",
                file=rel_path,
                old=current_status,
                new=corrected,
            )
            return "fixed"
        except VaultError as e:
            log.warning("autofix.fm003_failed", file=rel_path, error=str(e))
            return "skipped"

    return _flag_issue(issue, rel_path, vault_path, session_path)


def _fix_invalid_field_type(
    issue: Issue,
    rel_path: str,
    vault_path: Path,
    session_path: str,
) -> str:
    """FM004: Wrap scalar in list for list fields."""
    try:
        record = vault_read(vault_path, rel_path)
        fm = record["frontmatter"]
    except VaultError:
        return "skipped"

    # Extract field name from message: "Field 'tags' should be a list..."
    field_name = ""
    for lf in LIST_FIELDS:
        if f"'{lf}'" in issue.message:
            field_name = lf
            break

    if not field_name:
        return "skipped"

    current_val = fm.get(field_name)
    if current_val is None or isinstance(current_val, list):
        return "skipped"

    try:
        vault_edit(vault_path, rel_path, set_fields={field_name: [current_val]})
        log_mutation(session_path, "edit", rel_path)
        log.info("autofix.fm004_fixed", file=rel_path, field=field_name)
        return "fixed"
    except VaultError as e:
        log.warning("autofix.fm004_failed", file=rel_path, error=str(e))
        return "skipped"


def _fix_unlinked_body_entity(
    issue: Issue,
    rel_path: str,
    vault_path: Path,
    session_path: str,
) -> str:
    """LINK002: Promote body entity wikilinks to related: frontmatter.

    Obsidian Bases' file.hasLink(this.file) only checks frontmatter links.
    Entity wikilinks in body text won't appear in base view tables unless
    they're also in a frontmatter field (related:, relationships:, etc.).
    """
    try:
        record = vault_read(vault_path, rel_path)
        fm = record["frontmatter"]
    except VaultError:
        return "skipped"

    # Parse the missing links from the issue detail
    if not issue.detail:
        return "skipped"

    missing_links = [link.strip() for link in issue.detail.split(",")]
    if not missing_links:
        return "skipped"

    # Get current related: array
    related = fm.get("related", [])
    if not isinstance(related, list):
        related = [related] if related else []

    # Extract existing link targets from related: to avoid duplicates
    import re
    existing = set()
    for item in related:
        if isinstance(item, str):
            m = re.search(r"\[\[([^\]|]+)", item)
            if m:
                existing.add(m.group(1))

    # Add missing links
    added = 0
    for link in missing_links:
        if link not in existing:
            related.append(f"[[{link}]]")
            existing.add(link)
            added += 1

    if added == 0:
        return "skipped"

    try:
        vault_edit(vault_path, rel_path, set_fields={"related": related})
        log_mutation(session_path, "edit", rel_path)
        log.info("autofix.link002_fixed", file=rel_path, added=added)
        return "fixed"
    except VaultError as e:
        log.warning("autofix.link002_failed", file=rel_path, error=str(e))
        return "skipped"


def _flag_issue(
    issue: Issue,
    rel_path: str,
    vault_path: Path,
    session_path: str,
) -> str:
    """Add a janitor_note to the record's frontmatter."""
    code = issue.code.value
    note_text = f"{code} -- {issue.message}"

    try:
        vault_edit(vault_path, rel_path, set_fields={"janitor_note": note_text})
        log_mutation(session_path, "edit", rel_path)
        log.info("autofix.flagged", file=rel_path, code=code)
        return "flagged"
    except VaultError as e:
        log.warning("autofix.flag_failed", file=rel_path, error=str(e))
        return "skipped"
