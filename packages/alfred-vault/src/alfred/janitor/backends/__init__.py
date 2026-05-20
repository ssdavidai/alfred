"""Backend base class and shared types."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from ..issues import Issue
from ..utils import get_logger

log = get_logger(__name__)


@dataclass
class BackendResult:
    """Result from agent fix invocation."""
    success: bool = False
    summary: str = ""
    files_changed: list[str] = field(default_factory=list)


VAULT_CLI_REFERENCE = """
## Vault CLI Reference

Use `alfred vault` commands via Bash. Never access the filesystem directly.
All commands output JSON to stdout.

```bash
# Read a record
alfred vault read "person/John Smith.md"

# Search by glob or grep
alfred vault search --glob "person/*.md"
alfred vault search --grep "Eagle Farm"

# List all records of a type
alfred vault list person

# Edit a record (set or append frontmatter fields)
alfred vault edit "person/John Smith.md" --set status=inactive
alfred vault edit "task/My Task.md" --set 'janitor_note="FM001 — needs review"'

# Delete a record (garbage only)
alfred vault delete "note/garbage.md"
```
"""


def build_sweep_prompt(
    skill_text: str,
    issue_report: str,
    affected_records: str,
    vault_path: str,
) -> str:
    """Assemble the full prompt sent to any backend for fix mode."""
    return f"""{skill_text}

---

## Vault Access

Use `alfred vault` commands. Never access the filesystem directly.

{VAULT_CLI_REFERENCE}

---

## Issue Report

The following issues were detected by the structural scanner. Fix what you can,
flag what requires human judgment.

{issue_report}

---

## Affected Records

{affected_records}

---

Fix the issues listed above. For each file:
1. Read the file using `alfred vault read "<path>"`
2. Apply the appropriate fix using `alfred vault edit "<path>" --set field=value`
3. If the fix requires human judgment, add a `janitor_note` frontmatter field instead
4. If the file is garbage, use `alfred vault delete "<path>"`

When done, output a structured summary:
- FIXED: count
- FLAGGED: count (janitor_note added)
- SKIPPED: count (no action needed)
- DELETED: count (garbage removed)

Then list each action taken, one per line:
ACTION | file_path | issue_code | detail"""


def build_issue_report(issues: list[Issue]) -> str:
    """Format issues into a readable report for the agent."""
    if not issues:
        return "No issues found."

    lines: list[str] = []
    # Group by file
    by_file: dict[str, list[Issue]] = {}
    for issue in issues:
        by_file.setdefault(issue.file, []).append(issue)

    for filepath in sorted(by_file.keys()):
        file_issues = by_file[filepath]
        lines.append(f"### {filepath}")
        for issue in file_issues:
            lines.append(
                f"- **{issue.code.value}** [{issue.severity.value}] {issue.message}"
            )
            if issue.detail:
                lines.append(f"  Detail: {issue.detail}")
            if issue.suggested_fix:
                lines.append(f"  Suggested fix: {issue.suggested_fix}")
        lines.append("")

    return "\n".join(lines)


class BaseBackend(ABC):
    """Abstract base for all agent backends."""

    @abstractmethod
    async def process(
        self,
        skill_text: str,
        issue_report: str,
        affected_records: str,
        vault_path: str,
    ) -> BackendResult:
        """Send issue report to the agent and return fix summary."""
        ...
