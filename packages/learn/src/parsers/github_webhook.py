"""GitHub webhook payload parser.

Extracts: event type (push/pull_request/issues), repo name, actor, summary.
"""

from __future__ import annotations

from datetime import datetime, timezone

from . import ParsedEvent


def parse(raw: dict) -> list[ParsedEvent]:
    """Parse a GitHub webhook payload into ParsedEvents."""
    # Determine event type from payload shape
    event_type = _detect_event_type(raw)
    repo = raw.get("repository", {})
    repo_name = repo.get("full_name", repo.get("name", "unknown"))
    sender = raw.get("sender", {}).get("login", "unknown")

    if event_type == "push":
        return _parse_push(raw, repo_name, sender)
    elif event_type == "pull_request":
        return _parse_pull_request(raw, repo_name, sender)
    elif event_type == "issues":
        return _parse_issue(raw, repo_name, sender)
    else:
        return _parse_generic(raw, event_type, repo_name, sender)


def _detect_event_type(raw: dict) -> str:
    """Detect the GitHub event type from payload shape."""
    if "commits" in raw and "head_commit" in raw:
        return "push"
    if "pull_request" in raw:
        return "pull_request"
    if "issue" in raw and "pull_request" not in raw.get("issue", {}):
        return "issues"
    if "release" in raw:
        return "release"
    if "comment" in raw:
        return "comment"
    return raw.get("action", "unknown")


def _parse_push(raw: dict, repo_name: str, sender: str) -> list[ParsedEvent]:
    """Parse a push event."""
    commits = raw.get("commits", [])
    ref = raw.get("ref", "")
    branch = ref.split("/")[-1] if "/" in ref else ref
    commit_count = len(commits)

    head_commit = raw.get("head_commit", {})
    head_message = head_commit.get("message", "").split("\n")[0] if head_commit else ""

    summary = f"{sender} pushed {commit_count} commit(s) to {repo_name}/{branch}"
    if head_message:
        summary += f": {head_message}"

    source_ref = head_commit.get("id", raw.get("after", ""))[:12]

    return [
        ParsedEvent(
            source_ref=f"github:push:{repo_name}:{source_ref}",
            summary=summary,
            raw=raw,
            event_type="github-push",
            received_at=head_commit.get("timestamp", datetime.now(timezone.utc).isoformat()),
            metadata={
                "repo": repo_name,
                "branch": branch,
                "actor": sender,
                "commit_count": commit_count,
                "head_sha": raw.get("after", ""),
            },
        )
    ]


def _parse_pull_request(raw: dict, repo_name: str, sender: str) -> list[ParsedEvent]:
    """Parse a pull_request event."""
    action = raw.get("action", "")
    pr = raw.get("pull_request", {})
    pr_number = pr.get("number", 0)
    pr_title = pr.get("title", "")

    summary = f"{sender} {action} PR #{pr_number} on {repo_name}: {pr_title}"

    return [
        ParsedEvent(
            source_ref=f"github:pr:{repo_name}:{pr_number}",
            summary=summary,
            raw=raw,
            event_type="github-pull-request",
            received_at=pr.get("updated_at", datetime.now(timezone.utc).isoformat()),
            metadata={
                "repo": repo_name,
                "actor": sender,
                "action": action,
                "pr_number": pr_number,
                "pr_title": pr_title,
                "pr_state": pr.get("state", ""),
                "base_branch": pr.get("base", {}).get("ref", ""),
                "head_branch": pr.get("head", {}).get("ref", ""),
            },
        )
    ]


def _parse_issue(raw: dict, repo_name: str, sender: str) -> list[ParsedEvent]:
    """Parse an issues event."""
    action = raw.get("action", "")
    issue = raw.get("issue", {})
    issue_number = issue.get("number", 0)
    issue_title = issue.get("title", "")

    summary = f"{sender} {action} issue #{issue_number} on {repo_name}: {issue_title}"

    return [
        ParsedEvent(
            source_ref=f"github:issue:{repo_name}:{issue_number}",
            summary=summary,
            raw=raw,
            event_type="github-issue",
            received_at=issue.get("updated_at", datetime.now(timezone.utc).isoformat()),
            metadata={
                "repo": repo_name,
                "actor": sender,
                "action": action,
                "issue_number": issue_number,
                "issue_title": issue_title,
                "issue_state": issue.get("state", ""),
                "labels": [l.get("name", "") for l in issue.get("labels", [])],
            },
        )
    ]


def _parse_generic(raw: dict, event_type: str, repo_name: str, sender: str) -> list[ParsedEvent]:
    """Parse a generic GitHub webhook event."""
    action = raw.get("action", "")
    summary = f"{sender} triggered {event_type}"
    if action:
        summary += f" ({action})"
    summary += f" on {repo_name}"

    return [
        ParsedEvent(
            source_ref=f"github:{event_type}:{repo_name}:{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
            summary=summary,
            raw=raw,
            event_type=f"github-{event_type}",
            received_at=datetime.now(timezone.utc).isoformat(),
            metadata={
                "repo": repo_name,
                "actor": sender,
                "action": action,
            },
        )
    ]
