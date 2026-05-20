"""Issue, SweepResult, and FixLogEntry dataclasses."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum


class Severity(str, Enum):
    CRITICAL = "CRITICAL"
    WARNING = "WARNING"
    INFO = "INFO"


# --- Structural issue codes ---

class IssueCode(str, Enum):
    # Frontmatter
    MISSING_REQUIRED_FIELD = "FM001"
    INVALID_TYPE_VALUE = "FM002"
    INVALID_STATUS_VALUE = "FM003"
    INVALID_FIELD_TYPE = "FM004"
    # Directory
    WRONG_DIRECTORY = "DIR001"
    # Links
    BROKEN_WIKILINK = "LINK001"
    UNLINKED_BODY_ENTITY = "LINK002"
    # Orphan
    ORPHANED_RECORD = "ORPHAN001"
    # Stub
    STUB_RECORD = "STUB001"
    # Duplicate
    DUPLICATE_NAME = "DUP001"
    # Semantic (agent-detected)
    GARBAGE_CONTENT = "SEM001"
    UNCONTEXTUALIZABLE = "SEM002"
    EMPTY_CONVERSATION = "SEM003"
    FLOATING_TASK = "SEM004"
    VAGUE_NOTE = "SEM005"
    DUPLICATE_SEMANTIC = "SEM006"


SEVERITY_MAP: dict[IssueCode, Severity] = {
    IssueCode.MISSING_REQUIRED_FIELD: Severity.CRITICAL,
    IssueCode.INVALID_TYPE_VALUE: Severity.CRITICAL,
    IssueCode.INVALID_STATUS_VALUE: Severity.WARNING,
    IssueCode.INVALID_FIELD_TYPE: Severity.WARNING,
    IssueCode.WRONG_DIRECTORY: Severity.WARNING,
    IssueCode.BROKEN_WIKILINK: Severity.CRITICAL,
    IssueCode.UNLINKED_BODY_ENTITY: Severity.WARNING,
    IssueCode.ORPHANED_RECORD: Severity.WARNING,
    IssueCode.STUB_RECORD: Severity.INFO,
    IssueCode.DUPLICATE_NAME: Severity.INFO,
    IssueCode.GARBAGE_CONTENT: Severity.CRITICAL,
    IssueCode.UNCONTEXTUALIZABLE: Severity.WARNING,
    IssueCode.EMPTY_CONVERSATION: Severity.WARNING,
    IssueCode.FLOATING_TASK: Severity.WARNING,
    IssueCode.VAGUE_NOTE: Severity.INFO,
    IssueCode.DUPLICATE_SEMANTIC: Severity.INFO,
}


@dataclass
class Issue:
    code: IssueCode
    severity: Severity
    file: str  # relative path
    message: str
    detail: str = ""
    suggested_fix: str = ""

    def to_dict(self) -> dict:
        return {
            "code": self.code.value,
            "severity": self.severity.value,
            "file": self.file,
            "message": self.message,
            "detail": self.detail,
            "suggested_fix": self.suggested_fix,
        }

    @classmethod
    def from_dict(cls, d: dict) -> Issue:
        return cls(
            code=IssueCode(d["code"]),
            severity=Severity(d["severity"]),
            file=d["file"],
            message=d["message"],
            detail=d.get("detail", ""),
            suggested_fix=d.get("suggested_fix", ""),
        )


@dataclass
class SweepResult:
    sweep_id: str
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    files_scanned: int = 0
    files_skipped: int = 0
    issues_found: int = 0
    issues_by_severity: dict[str, int] = field(default_factory=dict)
    files_fixed: int = 0
    files_deleted: int = 0
    agent_invoked: bool = False
    structural_only: bool = False
    issues: list[Issue] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "sweep_id": self.sweep_id,
            "timestamp": self.timestamp,
            "files_scanned": self.files_scanned,
            "files_skipped": self.files_skipped,
            "issues_found": self.issues_found,
            "issues_by_severity": self.issues_by_severity,
            "files_fixed": self.files_fixed,
            "files_deleted": self.files_deleted,
            "agent_invoked": self.agent_invoked,
            "structural_only": self.structural_only,
            "issues": [i.to_dict() for i in self.issues],
        }

    @classmethod
    def from_dict(cls, d: dict) -> SweepResult:
        issues = [Issue.from_dict(i) for i in d.get("issues", [])]
        return cls(
            sweep_id=d["sweep_id"],
            timestamp=d.get("timestamp", ""),
            files_scanned=d.get("files_scanned", 0),
            files_skipped=d.get("files_skipped", 0),
            issues_found=d.get("issues_found", 0),
            issues_by_severity=d.get("issues_by_severity", {}),
            files_fixed=d.get("files_fixed", 0),
            files_deleted=d.get("files_deleted", 0),
            agent_invoked=d.get("agent_invoked", False),
            structural_only=d.get("structural_only", False),
            issues=issues,
        )


@dataclass
class FixLogEntry:
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    sweep_id: str = ""
    action: str = ""  # "fixed", "deleted", "flagged", "skipped"
    file: str = ""
    issue_code: str = ""
    detail: str = ""

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp,
            "sweep_id": self.sweep_id,
            "action": self.action,
            "file": self.file,
            "issue_code": self.issue_code,
            "detail": self.detail,
        }

    @classmethod
    def from_dict(cls, d: dict) -> FixLogEntry:
        return cls(**d)
