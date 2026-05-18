"""Alfred-as-a-Plane-user triggers — #536 B8.

Turns @alfred mentions and issue assignments in Plane into openclaw
sessions on the tenant's main gateway. Alfred then acts on the issue
(optionally gated by an approval comment), posts a reply comment back
to Plane, and records the comment id in a self-comment ledger so his
own reply doesn't re-trigger him.

Two layers of echo defense are enforced:

1. ``author_id == PLANE_ALFRED_USER_ID`` — the Alfred user's own
   comments and assignee edits never trigger.
2. Self-comment ledger at ``/alfred-data/state/plane_self_comments.json``
   — every comment Alfred posts via ``PlaneClient.create_comment`` gets
   its id recorded. The trigger detector skips any event whose
   ``comment_id`` is in that set.

Approval gate:

* ``trigger_type == "assignment"`` always spawns with
  ``requires_approval=true``. Approval arrives via a later comment
  like ``@alfred go`` / ``@alfred approved`` / ``@alfred ok`` from the
  original assigner.
* ``trigger_type == "mention"`` spawns with ``requires_approval=true``
  whenever the comment body matches a destructive-verb pattern
  (delete / remove / drop / force / production / push). Otherwise the
  mention is autonomous.

Pending approvals live at
``/alfred-data/state/plane_pending_approvals.json`` keyed by Plane
issue id. An approval comment from the requesting user un-gates the
pending session; Alfred's next action is expected to reuse the same
session metadata.
"""
from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

import httpx
from temporalio import activity

from src.config import load_config
from src.utils.plane_client import PlaneClient
from src.utils.vault_client import VaultClient

logger = logging.getLogger("alfred-learn")


# ---------------------------------------------------------------------------
# On-disk state layout
# ---------------------------------------------------------------------------

_SELF_COMMENTS_RELATIVE = "state/plane_self_comments.json"
_PENDING_APPROVALS_RELATIVE = "state/plane_pending_approvals.json"
_PLANE_SYNC_CURSOR_RELATIVE = "plane_sync_cursor.json"

# Bootstrap-context caps. These bound prompt growth so a pathological
# issue (100+ comments, 50kb matter body) can't blow past the openclaw
# gateway's request size limit. Numbers chosen to comfortably fit the
# spawn prompt under ~8k tokens.
_PROMPT_MATTER_BODY_CHARS = 1500
_PROMPT_COMMENT_MAX = 20
_PROMPT_COMMENT_CHARS = 600

# Cap on the self-comment ledger. 500 is enough to cover many hours of
# activity without growing the file unbounded; entries are FIFO-evicted
# in insertion order.
_SELF_COMMENTS_CAP = 500

# Pending approvals auto-expire after this many seconds (24h) so a
# forgotten approval request doesn't pin state forever.
_PENDING_APPROVAL_TTL_S = 86_400

# Destructive / sensitive verb pattern. Word-boundary matches only so
# substrings like "production-" in a slug don't false-positive. Matched
# case-insensitively against the comment body.
_DESTRUCTIVE_VERBS = (
    "delete", "remove", "drop", "force", "production", "push",
)
_DESTRUCTIVE_RE = re.compile(
    r"\b(" + "|".join(re.escape(v) for v in _DESTRUCTIVE_VERBS) + r")\b",
    re.IGNORECASE,
)

# Approval verbs recognised in a follow-up comment. Any of these as a
# standalone token after @alfred un-gates a pending approval.
_APPROVAL_VERBS = ("approved", "approve", "go", "go ahead", "ok", "okay", "yes")


# ---------------------------------------------------------------------------
# File I/O helpers — atomic writes so concurrent workflow ticks don't
# corrupt the state files.
# ---------------------------------------------------------------------------

def _alfred_data_dir() -> Path:
    cfg = load_config()
    return Path(cfg.alfred_data_dir)


def _self_comments_path() -> Path:
    return _alfred_data_dir() / _SELF_COMMENTS_RELATIVE


def _pending_approvals_path() -> Path:
    return _alfred_data_dir() / _PENDING_APPROVALS_RELATIVE


def _plane_sync_cursor_path() -> Path:
    return _alfred_data_dir() / _PLANE_SYNC_CURSOR_RELATIVE


def _matter_slug_for_project(project_id: str) -> str:
    """Invert ``plane_sync_cursor.json::project_map`` to find the matter
    slug corresponding to ``project_id``. Returns "" when unmapped (e.g.
    Inbox project, a pre-sync project, or a sentinel). The cursor is
    maintained by ``plane_sync`` on every forward-sync tick; a missing
    cursor just means no sync has run yet on this tenant.
    """
    if not project_id:
        return ""
    path = _plane_sync_cursor_path()
    if not path.exists():
        return ""
    try:
        with path.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError, json.JSONDecodeError):
        return ""
    if not isinstance(raw, dict):
        return ""
    project_map = raw.get("project_map") or {}
    if not isinstance(project_map, dict):
        return ""
    for slug, pid in project_map.items():
        if str(pid) == str(project_id):
            # The sentinel slug used for the Inbox project is not a real
            # matter — skip it so we don't try to read matter/__inbox__.md.
            if slug.startswith("__") or slug.endswith("__"):
                return ""
            return str(slug)
    return ""


def _atomic_write(path: Path, payload: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_str = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    tmp = Path(tmp_str)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
        os.replace(tmp, path)
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _load_self_comments(path: Path) -> list[str]:
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if isinstance(raw, list):
            return [str(x) for x in raw if isinstance(x, (str, int))]
        if isinstance(raw, dict):
            # Backwards-compat: accept {"comments": [...]} shape too.
            inner = raw.get("comments")
            if isinstance(inner, list):
                return [str(x) for x in inner if isinstance(x, (str, int))]
        return []
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        logger.warning(
            "plane_alfred_triggers: self-comments ledger unreadable (%s) — empty",
            exc,
        )
        return []


def _save_self_comments(path: Path, ids: list[str]) -> None:
    if len(ids) > _SELF_COMMENTS_CAP:
        ids = ids[-_SELF_COMMENTS_CAP:]
    payload = json.dumps(ids, separators=(",", ":"))
    _atomic_write(path, payload)


def _load_pending(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            return {}
        clean: dict[str, dict[str, Any]] = {}
        for k, v in raw.items():
            if not isinstance(v, dict):
                continue
            clean[str(k)] = {
                "session_id": str(v.get("session_id") or ""),
                "created_ts": int(v.get("created_ts") or 0),
                "requester_author_id": str(v.get("requester_author_id") or ""),
                "trigger_type": str(v.get("trigger_type") or ""),
                "approved_ts": int(v.get("approved_ts") or 0),
                "project_id": str(v.get("project_id") or ""),
            }
        return clean
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        logger.warning(
            "plane_alfred_triggers: pending-approvals file unreadable (%s) — empty",
            exc,
        )
        return {}


def _save_pending(path: Path, entries: dict[str, dict[str, Any]]) -> None:
    payload = json.dumps(entries, sort_keys=True, separators=(",", ":"))
    _atomic_write(path, payload)


def _prune_expired_pending(
    entries: dict[str, dict[str, Any]], now_ms: int
) -> dict[str, dict[str, Any]]:
    ttl_ms = _PENDING_APPROVAL_TTL_S * 1000
    alive: dict[str, dict[str, Any]] = {}
    for k, v in entries.items():
        created = int(v.get("created_ts") or 0)
        if now_ms - created <= ttl_ms:
            alive[k] = v
    return alive


# ---------------------------------------------------------------------------
# Pure-function trigger detection — the B8 entry point into the event
# dispatcher. Exported for tests; the workflow calls the activity wrapper
# below so all I/O paths (env lookup) stay off the workflow thread.
# ---------------------------------------------------------------------------

_MENTION_WORD_RE = re.compile(r"(?i)(?<![\w])@alfred(?![\w])")
# Plane's internal markup for a user mention: @[Alfred](user_id=<uuid>)
_MENTION_MARKUP_RE = re.compile(
    r"@\[[^\]]+\]\(\s*user_id\s*=\s*([^\s\)]+)\s*\)",
    re.IGNORECASE,
)


def _mention_matches(
    body: str, alfred_user_id: str
) -> bool:
    """True iff ``body`` @-mentions Alfred by name OR by user-mention markup.

    * Word-boundary ``@alfred`` is case-insensitive. ``@alfred123`` or
      ``alfredian`` do NOT match — we only fire on the token ``@alfred``.
    * The Plane markup form ``@[Alfred](user_id=<uuid>)`` matches only
      when the embedded user_id equals ``alfred_user_id``.
    """
    if not isinstance(body, str):
        return False
    if _MENTION_WORD_RE.search(body):
        return True
    if alfred_user_id:
        for m in _MENTION_MARKUP_RE.finditer(body):
            uid = m.group(1).strip().strip('"').strip("'")
            if uid == alfred_user_id:
                return True
    return False


def _assignees(data: dict[str, Any]) -> list[str]:
    """Best-effort extraction of assignee user ids from an issue payload.

    Plane payloads vary by version — sometimes ``assignees`` is a list
    of uuid strings, sometimes a list of ``{id, ...}`` dicts.
    """
    raw = data.get("assignees") or data.get("assignee_ids") or []
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        if isinstance(item, str):
            out.append(item)
        elif isinstance(item, dict) and item.get("id"):
            out.append(str(item["id"]))
    return out


def _previous_assignees(event: dict[str, Any]) -> list[str]:
    """Previous-assignee set from an ``issue updated`` webhook.

    Plane sends the prior state in a few shapes across versions. We
    check all of them and return ``[]`` when nothing looks like prior
    state (Plane hasn't carried the prior assignees yet → safer to
    trigger on the first assignment-looking payload than to
    permanently suppress).

      * ``event.activity.previous.assignees`` (webhook v3+)
      * ``event.previous_data.assignees`` (webhook v2)
      * ``event.old_data.assignees``     (some self-hosted builds)
    """
    # Nested under activity.previous
    activity_block = event.get("activity")
    if isinstance(activity_block, dict):
        prev = activity_block.get("previous") or activity_block.get("old_data")
        if isinstance(prev, dict):
            val = prev.get("assignees") or prev.get("assignee_ids") or []
            out = _coerce_user_id_list(val)
            if out or isinstance(val, list):
                return out

    # Flat shapes
    for key in ("previous_data", "old_data"):
        prev = event.get(key)
        if isinstance(prev, dict):
            val = prev.get("assignees") or prev.get("assignee_ids") or []
            out = _coerce_user_id_list(val)
            if out or isinstance(val, list):
                return out
    return []


def _coerce_user_id_list(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        if isinstance(item, str):
            out.append(item)
        elif isinstance(item, dict) and item.get("id"):
            out.append(str(item["id"]))
    return out


def _previous_assignees_with_presence(
    event: dict[str, Any],
) -> tuple[list[str], bool]:
    """Return ``(previous_assignees, prior_state_available)``.

    ``prior_state_available`` is True iff the webhook payload actually
    carried some prior-state block (even if it was an empty assignee
    list). Callers use this to distinguish "truly no previous
    assignees" from "we don't know". Without it, any ``issue updated``
    webhook that omits prior state would be treated as a fresh
    assignment and could double-spawn.
    """
    activity_block = event.get("activity")
    if isinstance(activity_block, dict):
        prev = activity_block.get("previous") or activity_block.get("old_data")
        if isinstance(prev, dict):
            val = prev.get("assignees")
            if val is None:
                val = prev.get("assignee_ids")
            if isinstance(val, list):
                return _coerce_user_id_list(val), True
    for key in ("previous_data", "old_data"):
        prev = event.get(key)
        if isinstance(prev, dict):
            val = prev.get("assignees")
            if val is None:
                val = prev.get("assignee_ids")
            if isinstance(val, list):
                return _coerce_user_id_list(val), True
    return [], False


def detect_alfred_triggers(
    event: dict[str, Any],
    *,
    alfred_user_id: str,
    self_comment_ids: Optional[set[str]] = None,
) -> Optional[dict[str, Any]]:
    """Return a trigger descriptor for ``event`` or None.

    ``event`` is the raw webhook payload as stored in the ``stream_type: "plane"``
    stream (i.e. the ``raw`` field of the stream event). It has the
    shape ``{"event": "issue_comment"|"issue", "action": "created"|"updated"|..., "data": {...}}``.

    ``alfred_user_id`` comes from ``PLANE_ALFRED_USER_ID`` — passed in so
    this function stays pure and workflow-safe.

    ``self_comment_ids`` (optional) is a set of comment ids Alfred has
    posted; any matching event is skipped.

    Returns ``None`` for anything that doesn't warrant a spawn.
    """
    if not isinstance(event, dict):
        return None
    plane_event = str(event.get("event") or "").lower()
    action = str(event.get("action") or "").lower()
    data = event.get("data")
    if not isinstance(data, dict):
        return None

    # Echo defense layer 1: actor id check.
    # Plane's webhook carries the actor under ``actor.id`` or
    # ``created_by`` / ``actor_id``. Match any of them.
    actor_id = _resolve_author_id(data)
    if alfred_user_id and actor_id and actor_id == alfred_user_id:
        return None

    # ── issue_comment created ────────────────────────────────────────
    if plane_event == "issue_comment" and action == "created":
        comment_id = str(data.get("id") or "")
        # Echo defense layer 2: self-comment ledger.
        if self_comment_ids and comment_id and comment_id in self_comment_ids:
            return None
        body = str(data.get("comment_stripped") or data.get("comment_html") or "")
        if not _mention_matches(body, alfred_user_id):
            return None
        issue_id = str(data.get("issue") or data.get("issue_id") or "")
        project_id = str(data.get("project") or data.get("project_id") or "")
        return {
            "trigger_type": "mention",
            "issue_id": issue_id,
            "project_id": project_id,
            "comment_id": comment_id,
            "comment_body": body,
            "author_id": actor_id,
            "author_email": _resolve_author_email(data),
            "requires_approval": _is_destructive(body),
        }

    # ── issue created/updated with Alfred in assignees ───────────────
    if plane_event == "issue" and action in {"created", "updated"}:
        assignees_now = _assignees(data)
        if not alfred_user_id or alfred_user_id not in assignees_now:
            return None

        if action == "updated":
            # Only fire once per assignment transition. If Alfred was
            # already an assignee on the previous state, this is a
            # subsequent edit (title change, priority tweak, …) and
            # must not re-trigger. When the webhook omits prior state
            # entirely, err on the side of NOT triggering — we can't
            # distinguish a title change on an already-assigned issue
            # from a fresh assignment, and double-spawning is worse
            # than a missed trigger (the user can always re-mention).
            prev, prev_known = _previous_assignees_with_presence(event)
            if not prev_known:
                return None
            if alfred_user_id in prev:
                return None

        return {
            "trigger_type": "assignment",
            "issue_id": str(data.get("id") or ""),
            "project_id": str(data.get("project") or data.get("project_id") or ""),
            "issue_data": data,
            "author_id": actor_id,
            "author_email": _resolve_author_email(data),
            # Every assignment starts gated — approval is a follow-up
            # comment from the assigner.
            "requires_approval": True,
        }

    return None


def _resolve_author_id(data: dict[str, Any]) -> str:
    """Best-effort actor id lookup. Plane uses various shapes across
    versions: ``actor.id``, ``created_by``, ``updated_by``, ``actor_id``.
    """
    actor = data.get("actor")
    if isinstance(actor, dict):
        uid = actor.get("id")
        if uid:
            return str(uid)
    for k in ("created_by", "updated_by", "actor_id", "author_id"):
        v = data.get(k)
        if v:
            return str(v)
    return ""


def _resolve_author_email(data: dict[str, Any]) -> str:
    actor = data.get("actor")
    if isinstance(actor, dict):
        em = actor.get("email") or actor.get("display_name")
        if em:
            return str(em)
    for k in ("actor_email", "created_by_email", "author_email"):
        v = data.get(k)
        if v:
            return str(v)
    return ""


def _is_destructive(body: str) -> bool:
    """True iff ``body`` contains a destructive-verb token."""
    if not isinstance(body, str):
        return False
    return bool(_DESTRUCTIVE_RE.search(body))


# ---------------------------------------------------------------------------
# Approval resolution helper
# ---------------------------------------------------------------------------

def _body_is_approval_for_alfred(body: str, alfred_user_id: str) -> bool:
    """True iff ``body`` looks like ``@alfred <approval verb>``.

    The mention can be plain ``@alfred`` or the user-mention markup
    form. The approval verb must appear within a small window after
    the mention to avoid matching innocuous prose that happens to
    contain "go" or "ok".
    """
    if not isinstance(body, str):
        return False

    # Find all mention spans (plain + markup).
    spans: list[int] = []
    for m in _MENTION_WORD_RE.finditer(body):
        spans.append(m.end())
    for m in _MENTION_MARKUP_RE.finditer(body):
        uid = m.group(1).strip().strip('"').strip("'")
        if uid == alfred_user_id or not alfred_user_id:
            spans.append(m.end())
    if not spans:
        return False

    lower = body.lower()
    for end in spans:
        # Consider the next 40 characters after the mention — enough
        # for "approved", "go ahead", or "ok please".
        tail = lower[end : end + 40]
        # Strip leading punctuation / whitespace.
        tail = re.sub(r"^[\s,:;\-—!?.]+", "", tail)
        for verb in _APPROVAL_VERBS:
            if tail.startswith(verb):
                # Require word boundary after the verb (either end of
                # tail or non-word char).
                after = tail[len(verb) : len(verb) + 1]
                if not after or not after.isalnum():
                    return True
    return False


def resolve_approval(
    *,
    comment_body: str,
    comment_author_id: str,
    pending: dict[str, dict[str, Any]],
    issue_id: str,
    alfred_user_id: str,
) -> Optional[dict[str, Any]]:
    """Decide whether a comment approves the pending session on ``issue_id``.

    Returns the pending entry (dict) if the comment matches an approval
    pattern AND the commenter is the original requester. Otherwise None.

    The caller is responsible for removing the entry from the pending
    map after un-gating.
    """
    entry = pending.get(str(issue_id))
    if not entry:
        return None
    if not comment_author_id:
        return None
    if entry.get("requester_author_id") != comment_author_id:
        return None
    if not _body_is_approval_for_alfred(comment_body, alfred_user_id):
        return None
    return entry


# ---------------------------------------------------------------------------
# Plane client lifecycle (module-local copy — avoids the plane_sync
# import which is fine but we want zero circular-import risk across
# these two modules).
# ---------------------------------------------------------------------------

def _plane_client_from_env() -> PlaneClient:
    return PlaneClient(
        base_url=os.environ.get("PLANE_API_BASE_URL") or os.environ.get("PLANE_API_URL"),
        token=os.environ.get("PLANE_API_TOKEN"),
        workspace_slug=os.environ.get("PLANE_WORKSPACE_SLUG"),
    )


# ---------------------------------------------------------------------------
# Activity: detect Alfred trigger from a single event (workflow-safe shim)
# ---------------------------------------------------------------------------

@activity.defn
async def detect_alfred_plane_trigger(
    event_raw: dict[str, Any],
) -> Optional[dict[str, Any]]:
    """Wrap ``detect_alfred_triggers`` as a Temporal activity.

    Keeps env var reads + self-comment I/O off the workflow thread.
    """
    alfred_user_id = os.environ.get("PLANE_ALFRED_USER_ID", "")
    if not alfred_user_id:
        # Without the Alfred user id there's no way to tell an assignment
        # from a human edit, and the mention check is much weaker. Do not
        # fire any trigger — safer to no-op than to spuriously spawn.
        return None

    self_ids = set(_load_self_comments(_self_comments_path()))

    result = detect_alfred_triggers(
        event_raw,
        alfred_user_id=alfred_user_id,
        self_comment_ids=self_ids,
    )

    # Handle approval comments separately — the trigger detector doesn't
    # mark them specially because they still look like @alfred mentions.
    # Caller inspects the returned dict; if the issue has a pending entry
    # AND the comment is an approval from the requester, we return a
    # synthetic "approval" trigger the workflow can route to un-gate.
    if result and result.get("trigger_type") == "mention":
        pending = _load_pending(_pending_approvals_path())
        approval = resolve_approval(
            comment_body=str(result.get("comment_body") or ""),
            comment_author_id=str(result.get("author_id") or ""),
            pending=pending,
            issue_id=str(result.get("issue_id") or ""),
            alfred_user_id=alfred_user_id,
        )
        if approval:
            return {
                "trigger_type": "approval",
                "issue_id": str(result.get("issue_id") or ""),
                "project_id": str(result.get("project_id") or "") or str(approval.get("project_id") or ""),
                "comment_id": str(result.get("comment_id") or ""),
                "comment_body": str(result.get("comment_body") or ""),
                "author_id": str(result.get("author_id") or ""),
                "approved_session_id": str(approval.get("session_id") or ""),
                "requires_approval": False,
            }

    return result


# ---------------------------------------------------------------------------
# Activity: spawn openclaw session for a Plane trigger
# ---------------------------------------------------------------------------

def _format_comment_excerpt(
    comment: dict[str, Any],
    *,
    alfred_user_id: str,
) -> str:
    """Render a single Plane comment as one inline paragraph for the
    bootstrap prompt. Strips HTML-ish tags roughly (Plane returns
    ``comment_html``; ``comment_stripped`` is plain text where
    available).
    """
    body = str(
        comment.get("comment_stripped")
        or comment.get("comment_html")
        or ""
    ).strip()
    if not body:
        return ""
    # Crude HTML tag stripper — Plane's ``comment_stripped`` is usually
    # plain text so this is a belt-and-braces defence for payloads that
    # skip it.
    body = re.sub(r"<[^>]+>", " ", body)
    body = re.sub(r"\s+", " ", body).strip()
    actor_id = _resolve_author_id(comment)
    actor_label = "Alfred" if alfred_user_id and actor_id == alfred_user_id \
        else str(
            _resolve_author_email(comment)
            or actor_id
            or "unknown"
        )
    ts = str(
        comment.get("created_at")
        or comment.get("updated_at")
        or ""
    )
    ts_short = ts[:19] if ts else ""
    prefix = f"[{ts_short}] {actor_label}" if ts_short else actor_label
    return f"- {prefix}: {body[:_PROMPT_COMMENT_CHARS]}"


def _build_prompt(
    trigger: dict[str, Any],
    *,
    project_name: str,
    issue: dict[str, Any],
    comments: Optional[list[dict[str, Any]]] = None,
    matter: Optional[dict[str, Any]] = None,
    alfred_user_id: str = "",
) -> str:
    """Compose the system/user prompt handed to the main openclaw agent.

    The prompt is intentionally deterministic + context-rich so the
    session transcript is reviewable in openclaw's history UI. The main
    agent's existing skill set (``alfred-vault-operations`` etc.) tells
    it how to call the vault/Plane MCP `self` tool.

    ``comments`` — the full Plane comment thread on this issue
    (oldest → newest). The triggering comment is typically the last
    entry; including prior comments lets Alfred reason with context
    from the conversation rather than reacting to a bare mention.

    ``matter`` — the vault matter record ``{path, frontmatter, body}``
    that the issue's project maps to. Giving Alfred the matter body
    means he enters the session already grounded in the broader
    initiative instead of having to fetch it mid-turn.
    """
    ttype = str(trigger.get("trigger_type") or "")
    issue_name = str(issue.get("name") or "").strip() or "(untitled)"
    description = str(issue.get("description_stripped") or issue.get("description") or "").strip()
    state_name = ""
    state = issue.get("state_detail") or issue.get("state")
    if isinstance(state, dict):
        state_name = str(state.get("name") or state.get("group") or "")
    elif isinstance(state, str):
        state_name = state
    priority = str(issue.get("priority") or "none")

    lines = [
        "You are being triggered from Plane.",
        f"Trigger type: {ttype}",
        f"Project: {project_name or '(unknown)'} (id: {trigger.get('project_id') or ''})",
        f"Issue: {issue_name} (id: {trigger.get('issue_id') or ''})",
    ]
    if description:
        lines.append(f"Issue description: {description[:2000]}")
    if state_name:
        lines.append(f"Current state: {state_name}")
    lines.append(f"Priority: {priority}")

    if ttype == "mention":
        author = str(trigger.get("author_email") or trigger.get("author_id") or "unknown")
        body = str(trigger.get("comment_body") or "").strip()
        lines.append(f'Triggering comment by {author}: "{body[:1500]}"')
    elif ttype == "assignment":
        author = str(trigger.get("author_email") or trigger.get("author_id") or "someone")
        lines.append(f"{author} has assigned this issue to you.")

    # ── Matter context ──────────────────────────────────────────────
    # The vault matter this issue's project maps to. Gives Alfred the
    # broader initiative context without a round-trip — e.g. the matter's
    # objective, stakeholders, constraints. Skipped for Inbox issues
    # (project isn't mapped to a matter) or when the matter read fails.
    if matter:
        m_fm = matter.get("frontmatter") or {}
        m_name = str(m_fm.get("name") or m_fm.get("title") or "").strip()
        m_body = str(matter.get("body") or "").strip()
        if m_body:
            excerpt = m_body[:_PROMPT_MATTER_BODY_CHARS]
            if len(m_body) > _PROMPT_MATTER_BODY_CHARS:
                excerpt = excerpt.rstrip() + " …[truncated]"
            lines.append("")
            header = f"Related matter: {m_name}" if m_name else "Related matter"
            lines.append(f"{header} (path: {matter.get('path') or ''})")
            lines.append(excerpt)

    # ── Comment thread ──────────────────────────────────────────────
    # Everything posted on this issue, oldest → newest, capped so the
    # prompt stays bounded. Alfred's own previous comments are labelled
    # so he can stay consistent with what he already committed to.
    if comments:
        ordered = list(comments)[-_PROMPT_COMMENT_MAX:]
        rendered = [
            _format_comment_excerpt(c, alfred_user_id=alfred_user_id)
            for c in ordered
        ]
        rendered = [r for r in rendered if r]
        if rendered:
            lines.append("")
            suffix = "" if len(comments) <= _PROMPT_COMMENT_MAX \
                else f" (showing last {_PROMPT_COMMENT_MAX} of {len(comments)})"
            lines.append(f"Comment thread on this issue{suffix}:")
            lines.extend(rendered)

    lines.append("")
    lines.append(
        "Your task: evaluate what action (if any) you should take. Use the "
        "self() MCP tool to read vault records, call ctrl-api endpoints, "
        "and update Plane via POST /api/v1/plane/... or the MCP self "
        "tool's Plane routes."
    )
    lines.append(
        "After acting, post a comment on the Plane issue summarizing what "
        "you did or asking for clarification. Use "
        '`self({endpoint: "/api/v1/plane/comment", method: "POST", '
        'body: {project_id, issue_id, text}})` — the ctrl-api side records '
        "the outgoing comment id in the self-comments ledger automatically "
        "so your reply will not re-trigger you."
    )
    if trigger.get("requires_approval"):
        lines.append("")
        lines.append(
            "IMPORTANT: this trigger is GATED. Do NOT take destructive or "
            "irreversible actions yet. Post a Plane comment stating the plan "
            "and ask for explicit approval. The requester can reply with "
            "`@alfred approved` (or `@alfred go ahead` / `@alfred ok`) to "
            "un-gate the work."
        )
    else:
        lines.append(
            "If the request would cause destructive or external side effects "
            "you have not already been explicitly approved for, pause and "
            "post a confirmation comment first."
        )
    return "\n".join(lines)


@activity.defn
async def spawn_alfred_for_plane_trigger(
    trigger: dict[str, Any],
) -> dict[str, Any]:
    """Spawn an openclaw main-gateway session for a Plane trigger.

    Uses the same ``sessions_spawn`` tool invocation pattern as
    ``clerk._call_clerk`` / ``tasks.execute_task`` — POST to
    ``/tools/invoke`` — BUT targets the MAIN gateway at
    ``config.openclaw_gateway_url`` (:18789) because the spawned session
    uses ``agentId: "main"``. The workers gateway rejects non-clerk
    agentIds.

    Fire-and-forget from the workflow's perspective: we wait for the
    spawn call to return (so we can capture the child session key) but
    do NOT poll ``sessions_history``. Alfred runs asynchronously; the
    reply comment on the Plane issue is what the human will see.

    Returns:
      ``{"spawned": bool, "session_key": str, "prompt_chars": int,
        "requires_approval": bool, "error": str}``
    """
    config = load_config()
    token = config.gateway_token()
    # MAIN gateway — this spawns agentId=main for user-facing Alfred.
    base = config.openclaw_gateway_url.rstrip("/")

    trigger = dict(trigger or {})
    issue_id = str(trigger.get("issue_id") or "")
    project_id = str(trigger.get("project_id") or "")
    requires_approval = bool(trigger.get("requires_approval"))

    # Best-effort full-context fetch. If Plane is temporarily unreachable
    # we still try to spawn with whatever we have in the trigger payload
    # — better to trigger a slightly-less-context session than to drop
    # the whole trigger on a transient Plane 500.
    project_name = ""
    issue_full: dict[str, Any] = dict(trigger.get("issue_data") or {})
    if issue_full and not issue_full.get("name") and not issue_full.get("description"):
        issue_full = {}
    comments: list[dict[str, Any]] = []
    if issue_id and project_id:
        plane = _plane_client_from_env()
        try:
            if not issue_full:
                try:
                    issue_full = await plane.get_issue(project_id, issue_id) or {}
                except httpx.HTTPError as exc:
                    activity.logger.warning(
                        "spawn_alfred_for_plane_trigger: get_issue failed %s: %s",
                        issue_id, exc,
                    )
                    issue_full = {}
            try:
                proj = await plane.get_project(project_id) or {}
                project_name = str(proj.get("name") or "")
            except httpx.HTTPError as exc:
                activity.logger.warning(
                    "spawn_alfred_for_plane_trigger: get_project failed %s: %s",
                    project_id, exc,
                )
            try:
                comments = await plane.list_issue_comments(project_id, issue_id) or []
            except httpx.HTTPError as exc:
                activity.logger.warning(
                    "spawn_alfred_for_plane_trigger: list_issue_comments "
                    "failed %s: %s",
                    issue_id, exc,
                )
                comments = []
        finally:
            await plane.close()

    # Matter context — look up this project's matter slug via the
    # forward-sync cursor's project_map, then read the matter record.
    # Anything that fails here just means the prompt ships without the
    # matter body section (not fatal).
    matter_record: Optional[dict[str, Any]] = None
    matter_slug = _matter_slug_for_project(project_id)
    if matter_slug:
        cfg = load_config()
        vault = VaultClient(cfg)
        try:
            matter_record = await vault.read_record(f"matter/{matter_slug}.md")
        except httpx.HTTPStatusError as exc:
            # 404 is expected for stale project_map entries; anything else
            # is worth surfacing but must not block the spawn.
            if exc.response.status_code != 404:
                activity.logger.warning(
                    "spawn_alfred_for_plane_trigger: matter read %s: %s",
                    matter_slug, exc,
                )
            matter_record = None
        except httpx.HTTPError as exc:
            activity.logger.warning(
                "spawn_alfred_for_plane_trigger: matter read network %s: %s",
                matter_slug, exc,
            )
            matter_record = None
        finally:
            await vault.close()

    alfred_user_id = os.environ.get("PLANE_ALFRED_USER_ID", "")
    prompt = _build_prompt(
        trigger,
        project_name=project_name,
        issue=issue_full,
        comments=comments,
        matter=matter_record,
        alfred_user_id=alfred_user_id,
    )

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    metadata = {
        "source": "plane",
        "trigger_type": str(trigger.get("trigger_type") or ""),
        "issue_id": issue_id,
        "project_id": project_id,
        "comment_id": str(trigger.get("comment_id") or ""),
        "requester_author_id": str(trigger.get("author_id") or ""),
        "requires_approval": requires_approval,
    }
    # ``metadata`` is a single top-level arg on sessions_spawn; nest it
    # under ``context`` for agents that prefer a named field.
    spawn_args: dict[str, Any] = {
        "task": prompt,
        "agentId": "main",
        "mode": "run",
        "cleanup": "auto",
        "sandbox": "inherit",
        "runTimeoutSeconds": 900,
        "metadata": metadata,
    }
    if requires_approval:
        # Surface the gate in a field the existing approval logic
        # (TaskRunnerWorkflow / Judgment) also checks.
        spawn_args["requires_approval"] = True

    session_key = ""
    error = ""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{base}/tools/invoke",
                headers=headers,
                json={"tool": "sessions_spawn", "args": spawn_args},
            )
            resp.raise_for_status()
            data = resp.json()
        for item in (data.get("result") or {}).get("content") or []:
            if isinstance(item, dict) and item.get("type") == "text":
                try:
                    inner = json.loads(item.get("text") or "{}")
                    if inner.get("childSessionKey"):
                        session_key = str(inner["childSessionKey"])
                        break
                except (json.JSONDecodeError, KeyError):
                    continue
    except httpx.HTTPError as exc:
        error = f"http_error: {exc}"
        activity.logger.warning(
            "spawn_alfred_for_plane_trigger: spawn POST failed: %s", exc,
        )
    except Exception as exc:  # noqa: BLE001
        error = f"unexpected: {exc}"
        activity.logger.warning(
            "spawn_alfred_for_plane_trigger: unexpected error: %s", exc,
        )

    spawned = bool(session_key) and not error

    # Record the pending-approval entry so a later @alfred approved can
    # resolve it. Only for actually-gated spawns.
    if spawned and requires_approval and issue_id:
        try:
            path = _pending_approvals_path()
            now_ms = int(time.time() * 1000)
            entries = _prune_expired_pending(_load_pending(path), now_ms)
            entries[issue_id] = {
                "session_id": session_key,
                "created_ts": now_ms,
                "requester_author_id": str(trigger.get("author_id") or ""),
                "trigger_type": str(trigger.get("trigger_type") or ""),
                "project_id": project_id,
                "approved_ts": 0,
            }
            _save_pending(path, entries)
        except Exception as exc:  # noqa: BLE001
            # Pending file failures must not break the spawn path.
            activity.logger.warning(
                "spawn_alfred_for_plane_trigger: pending save failed: %s", exc,
            )

    return {
        "spawned": spawned,
        "session_key": session_key,
        "prompt_chars": len(prompt),
        "requires_approval": requires_approval,
        "error": error,
    }


# ---------------------------------------------------------------------------
# Activity: resolve a pending approval
# ---------------------------------------------------------------------------

@activity.defn
async def resolve_plane_approval(
    issue_id: str,
    comment_body: str,
    comment_author_id: str,
) -> dict[str, Any]:
    """Un-gate the pending session for ``issue_id`` if the comment approves it.

    Returns ``{"approved": bool, "session_id": str, "reason": str}``.
    Removes the entry from the pending map on success so a second
    ``@alfred approved`` does not re-trigger anything.
    """
    alfred_user_id = os.environ.get("PLANE_ALFRED_USER_ID", "")
    path = _pending_approvals_path()
    entries = _load_pending(path)
    now_ms = int(time.time() * 1000)
    entries = _prune_expired_pending(entries, now_ms)

    entry = resolve_approval(
        comment_body=comment_body,
        comment_author_id=comment_author_id,
        pending=entries,
        issue_id=issue_id,
        alfred_user_id=alfred_user_id,
    )
    if not entry:
        # Persist any expiry-pruning we did above even if nothing approved.
        if entries != _load_pending(path):
            _save_pending(path, entries)
        return {"approved": False, "session_id": "", "reason": "no_matching_pending"}

    session_id = str(entry.get("session_id") or "")
    entries.pop(str(issue_id), None)
    _save_pending(path, entries)

    # Send a follow-up message to the existing session so the agent
    # knows it may proceed. Best-effort — if the gateway is unreachable
    # we still report approved=True because the pending-state change is
    # the source of truth; the agent's next action will pick it up.
    if session_id:
        try:
            config = load_config()
            token = config.gateway_token()
            # The pending session lives on the MAIN gateway — it was
            # spawned there with agentId=main.
            base = config.openclaw_gateway_url.rstrip("/")
            async with httpx.AsyncClient(timeout=20.0) as client:
                await client.post(
                    f"{base}/v1/sessions/message",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "sessionKey": session_id,
                        "message": (
                            "Approval received from the requester. You may now "
                            "proceed with the plan you posted. Confirm completion "
                            "with a Plane comment when done."
                        ),
                    },
                )
        except Exception as exc:  # noqa: BLE001
            activity.logger.warning(
                "resolve_plane_approval: follow-up message failed: %s", exc,
            )

    return {"approved": True, "session_id": session_id, "reason": ""}


# ---------------------------------------------------------------------------
# Activity: record a self-comment (called after PlaneClient.create_comment)
# ---------------------------------------------------------------------------

@activity.defn
async def record_alfred_self_comment(comment_id: str) -> None:
    """Append ``comment_id`` to the self-comment ledger.

    Safe to call with an empty id (no-op). Writes are atomic and FIFO-
    evicted above ``_SELF_COMMENTS_CAP`` so the file cannot grow
    unbounded.
    """
    cid = str(comment_id or "").strip()
    if not cid:
        return
    path = _self_comments_path()
    ids = _load_self_comments(path)
    if cid in ids:
        return
    ids.append(cid)
    _save_self_comments(path, ids)


@activity.defn
async def load_alfred_self_comments() -> list[str]:
    """Return the current self-comment ledger (read-only)."""
    return _load_self_comments(_self_comments_path())
