"""Tests for Alfred-as-a-Plane-user triggers (#536 B8).

Covers:

* ``detect_alfred_triggers`` pure function — 10+ cases for the
  mention/assignment/echo detector.
* Destructive-verb gate — 5 verbs force ``requires_approval=true``.
* Approval resolver — only the original requester can un-gate.
* Self-comment ledger + actor-id echo defense.
* End-to-end workflow flow with ``WorkflowEnvironment``:
    ``@alfred help me`` → spawn → pending entry → ``@alfred approved``
    from the same user → un-gates. Uses stubbed activities so no
    network / filesystem I/O happens.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from temporalio import activity
from temporalio.client import Client
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from src.activities.plane_alfred_triggers import (
    _DESTRUCTIVE_VERBS,
    _SELF_COMMENTS_CAP,
    _body_is_approval_for_alfred,
    _is_destructive,
    _load_pending,
    _load_self_comments,
    _mention_matches,
    _save_pending,
    _save_self_comments,
    detect_alfred_triggers,
    resolve_approval,
)
from src.workflows.plane_reverse_sync import (
    PlaneReverseSyncResult,
    PlaneReverseSyncWorkflow,
)


ALFRED_UID = "alfred-user-uuid-123"


# ---------------------------------------------------------------------------
# detect_alfred_triggers — pure function cases
# ---------------------------------------------------------------------------

def _evt_comment(
    body: str,
    *,
    issue_id: str = "iss-1",
    project_id: str = "proj-1",
    actor_id: str = "human-user-1",
    comment_id: str = "c-1",
) -> dict[str, Any]:
    """Build a webhook-shaped ``issue_comment created`` event."""
    return {
        "event": "issue_comment",
        "action": "created",
        "data": {
            "id": comment_id,
            "comment_html": body,
            "comment_stripped": body,
            "issue": issue_id,
            "project": project_id,
            "actor": {"id": actor_id, "email": f"{actor_id}@example.test"},
        },
    }


def _evt_issue(
    *,
    action: str = "created",
    issue_id: str = "iss-2",
    project_id: str = "proj-1",
    assignees: Optional[list[str]] = None,
    prev_assignees: Optional[list[str]] = None,
    actor_id: str = "human-boss-1",
    name: str = "Do the thing",
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": issue_id,
        "name": name,
        "project": project_id,
        "assignees": list(assignees or []),
        "actor": {"id": actor_id, "email": f"{actor_id}@example.test"},
    }
    evt: dict[str, Any] = {"event": "issue", "action": action, "data": data}
    if prev_assignees is not None:
        evt["activity"] = {"previous": {"assignees": list(prev_assignees)}}
        # Also store under old_data for parser resilience.
        evt["old_data"] = {"assignees": list(prev_assignees)}
    return evt


class TestMentionDetection:
    def test_plain_at_alfred_mention(self):
        t = detect_alfred_triggers(
            _evt_comment("@alfred can you help"),
            alfred_user_id=ALFRED_UID,
        )
        assert t is not None
        assert t["trigger_type"] == "mention"
        assert t["issue_id"] == "iss-1"
        assert t["requires_approval"] is False

    def test_mention_with_trailing_comma(self):
        t = detect_alfred_triggers(
            _evt_comment("@alfred, please do X"),
            alfred_user_id=ALFRED_UID,
        )
        assert t is not None
        assert t["trigger_type"] == "mention"

    def test_word_boundary_no_false_positive(self):
        """``@alfred123`` should NOT match — otherwise any username
        starting with 'alfred' would falsely trigger the butler."""
        t = detect_alfred_triggers(
            _evt_comment("see @alfred123 for the handoff"),
            alfred_user_id=ALFRED_UID,
        )
        assert t is None

    def test_case_insensitive_match(self):
        t = detect_alfred_triggers(
            _evt_comment("@ALFRED pick this up"),
            alfred_user_id=ALFRED_UID,
        )
        assert t is not None
        assert t["trigger_type"] == "mention"

    def test_plane_markup_form_matches(self):
        body = f"Hi @[Alfred](user_id={ALFRED_UID}), please triage."
        t = detect_alfred_triggers(
            _evt_comment(body),
            alfred_user_id=ALFRED_UID,
        )
        assert t is not None

    def test_plane_markup_wrong_user_id(self):
        body = "@[Alfred](user_id=someone-else) no thanks"
        t = detect_alfred_triggers(
            _evt_comment(body),
            alfred_user_id=ALFRED_UID,
        )
        assert t is None

    def test_self_comment_is_skipped_via_actor(self):
        """Comment authored by Alfred himself — echo defense layer 1."""
        t = detect_alfred_triggers(
            _evt_comment("@alfred update", actor_id=ALFRED_UID),
            alfred_user_id=ALFRED_UID,
        )
        assert t is None

    def test_self_comment_ledger_skips_even_if_actor_missing(self):
        """Echo defense layer 2: even if the actor id were wrong, the
        comment id in the ledger must still suppress the trigger."""
        evt = _evt_comment("@alfred recheck", comment_id="self-x")
        # Simulate payload that doesn't carry actor info.
        evt["data"].pop("actor", None)
        t = detect_alfred_triggers(
            evt,
            alfred_user_id=ALFRED_UID,
            self_comment_ids={"self-x"},
        )
        assert t is None

    def test_no_mention_no_trigger(self):
        t = detect_alfred_triggers(
            _evt_comment("general chatter, nothing to see"),
            alfred_user_id=ALFRED_UID,
        )
        assert t is None

    def test_non_created_comment_ignored(self):
        evt = _evt_comment("@alfred help")
        evt["action"] = "updated"
        t = detect_alfred_triggers(evt, alfred_user_id=ALFRED_UID)
        assert t is None


class TestAssignmentDetection:
    def test_new_issue_assigned_to_alfred_triggers(self):
        t = detect_alfred_triggers(
            _evt_issue(action="created", assignees=[ALFRED_UID]),
            alfred_user_id=ALFRED_UID,
        )
        assert t is not None
        assert t["trigger_type"] == "assignment"
        assert t["requires_approval"] is True

    def test_issue_update_adds_alfred_triggers(self):
        t = detect_alfred_triggers(
            _evt_issue(
                action="updated",
                assignees=[ALFRED_UID, "other-user"],
                prev_assignees=["other-user"],
            ),
            alfred_user_id=ALFRED_UID,
        )
        assert t is not None
        assert t["trigger_type"] == "assignment"

    def test_issue_update_alfred_already_assigned_does_not_retrigger(self):
        t = detect_alfred_triggers(
            _evt_issue(
                action="updated",
                assignees=[ALFRED_UID],
                prev_assignees=[ALFRED_UID],
            ),
            alfred_user_id=ALFRED_UID,
        )
        assert t is None

    def test_assignment_by_alfred_himself_does_not_trigger(self):
        """Echo defense: if Alfred (re-)assigns the issue to himself via
        the API, the webhook must not loop back to a new session."""
        t = detect_alfred_triggers(
            _evt_issue(
                action="updated",
                assignees=[ALFRED_UID],
                prev_assignees=[],
                actor_id=ALFRED_UID,
            ),
            alfred_user_id=ALFRED_UID,
        )
        assert t is None

    def test_issue_with_no_alfred_in_assignees(self):
        t = detect_alfred_triggers(
            _evt_issue(action="created", assignees=["other"]),
            alfred_user_id=ALFRED_UID,
        )
        assert t is None

    def test_cycle_event_ignored(self):
        t = detect_alfred_triggers(
            {"event": "cycle", "action": "created", "data": {"id": "c-1"}},
            alfred_user_id=ALFRED_UID,
        )
        assert t is None

    def test_non_dict_event(self):
        assert detect_alfred_triggers("not a dict", alfred_user_id=ALFRED_UID) is None  # type: ignore[arg-type]

    def test_issue_update_without_prior_state_does_not_trigger(self):
        """When the webhook omits prior assignees, the detector must
        NOT re-trigger on an ``issue updated`` event — we can't tell a
        fresh assignment from a title-change-on-already-assigned-issue.
        Err on the side of not spawning."""
        t = detect_alfred_triggers(
            _evt_issue(
                action="updated",
                assignees=[ALFRED_UID],
                prev_assignees=None,  # no activity/previous block
            ),
            alfred_user_id=ALFRED_UID,
        )
        assert t is None

    def test_no_alfred_user_id_no_assignment_trigger(self):
        """Without ``PLANE_ALFRED_USER_ID`` we can't identify the user's
        assignments — safer to no-op than fire."""
        t = detect_alfred_triggers(
            _evt_issue(action="created", assignees=["x"]),
            alfred_user_id="",
        )
        assert t is None


# ---------------------------------------------------------------------------
# Destructive-verb gate
# ---------------------------------------------------------------------------

class TestDestructiveVerbGate:
    def test_delete_gates(self):
        t = detect_alfred_triggers(
            _evt_comment("@alfred delete the staging env"),
            alfred_user_id=ALFRED_UID,
        )
        assert t is not None
        assert t["requires_approval"] is True

    def test_remove_gates(self):
        t = detect_alfred_triggers(
            _evt_comment("@alfred remove the old tasks"),
            alfred_user_id=ALFRED_UID,
        )
        assert t is not None
        assert t["requires_approval"] is True

    def test_drop_gates(self):
        t = detect_alfred_triggers(
            _evt_comment("@alfred drop the cache"),
            alfred_user_id=ALFRED_UID,
        )
        assert t is not None
        assert t["requires_approval"] is True

    def test_force_gates(self):
        t = detect_alfred_triggers(
            _evt_comment("@alfred force-close this sprint"),
            alfred_user_id=ALFRED_UID,
        )
        assert t is not None
        assert t["requires_approval"] is True

    def test_production_gates(self):
        t = detect_alfred_triggers(
            _evt_comment("@alfred sync this to production"),
            alfred_user_id=ALFRED_UID,
        )
        assert t is not None
        assert t["requires_approval"] is True

    def test_push_gates(self):
        t = detect_alfred_triggers(
            _evt_comment("@alfred push this to Plane"),
            alfred_user_id=ALFRED_UID,
        )
        assert t is not None
        assert t["requires_approval"] is True

    def test_benign_verb_does_not_gate(self):
        t = detect_alfred_triggers(
            _evt_comment("@alfred can you summarise the thread"),
            alfred_user_id=ALFRED_UID,
        )
        assert t is not None
        assert t["requires_approval"] is False

    def test_is_destructive_standalone(self):
        for verb in _DESTRUCTIVE_VERBS:
            assert _is_destructive(f"please {verb} it"), verb
        assert not _is_destructive("gentle ask")


# ---------------------------------------------------------------------------
# Mention-matching helper edge cases
# ---------------------------------------------------------------------------

class TestMentionMatches:
    def test_plain_mention(self):
        assert _mention_matches("hey @alfred", ALFRED_UID)

    def test_wordboundary(self):
        assert not _mention_matches("alfredian prose", ALFRED_UID)
        assert not _mention_matches("@alfredian prose", ALFRED_UID)

    def test_markup_with_matching_uid(self):
        body = f"please @[Alfred Butler](user_id={ALFRED_UID}) do it"
        assert _mention_matches(body, ALFRED_UID)

    def test_markup_with_other_uid(self):
        assert not _mention_matches(
            "@[Sir](user_id=someone-else) do it", ALFRED_UID
        )


# ---------------------------------------------------------------------------
# Approval resolver
# ---------------------------------------------------------------------------

class TestApprovalResolver:
    def test_approved_by_requester_un_gates(self):
        pending = {
            "iss-1": {
                "session_id": "sess-abc",
                "created_ts": 1,
                "requester_author_id": "human-boss-1",
                "trigger_type": "assignment",
                "project_id": "proj-1",
                "approved_ts": 0,
            }
        }
        entry = resolve_approval(
            comment_body="@alfred approved",
            comment_author_id="human-boss-1",
            pending=pending,
            issue_id="iss-1",
            alfred_user_id=ALFRED_UID,
        )
        assert entry is not None
        assert entry["session_id"] == "sess-abc"

    def test_approved_by_different_user_does_not_un_gate(self):
        pending = {
            "iss-1": {
                "session_id": "sess-abc",
                "created_ts": 1,
                "requester_author_id": "human-boss-1",
                "trigger_type": "mention",
                "project_id": "proj-1",
                "approved_ts": 0,
            }
        }
        entry = resolve_approval(
            comment_body="@alfred approved",
            comment_author_id="random-passerby",
            pending=pending,
            issue_id="iss-1",
            alfred_user_id=ALFRED_UID,
        )
        assert entry is None

    def test_non_approval_verb_does_not_un_gate(self):
        pending = {
            "iss-1": {
                "session_id": "sess-abc",
                "created_ts": 1,
                "requester_author_id": "human-boss-1",
                "trigger_type": "mention",
                "project_id": "proj-1",
                "approved_ts": 0,
            }
        }
        entry = resolve_approval(
            comment_body="@alfred still thinking",
            comment_author_id="human-boss-1",
            pending=pending,
            issue_id="iss-1",
            alfred_user_id=ALFRED_UID,
        )
        assert entry is None

    def test_no_pending_entry(self):
        entry = resolve_approval(
            comment_body="@alfred approved",
            comment_author_id="human-boss-1",
            pending={},
            issue_id="iss-1",
            alfred_user_id=ALFRED_UID,
        )
        assert entry is None

    def test_go_ahead_phrase_un_gates(self):
        pending = {
            "iss-2": {
                "session_id": "sess-2",
                "created_ts": 1,
                "requester_author_id": "boss-2",
                "trigger_type": "assignment",
                "project_id": "proj-2",
                "approved_ts": 0,
            }
        }
        entry = resolve_approval(
            comment_body="@alfred go ahead",
            comment_author_id="boss-2",
            pending=pending,
            issue_id="iss-2",
            alfred_user_id=ALFRED_UID,
        )
        assert entry is not None

    def test_ok_un_gates(self):
        pending = {
            "iss-3": {
                "session_id": "sess-3",
                "created_ts": 1,
                "requester_author_id": "boss-3",
                "trigger_type": "mention",
                "project_id": "proj-3",
                "approved_ts": 0,
            }
        }
        entry = resolve_approval(
            comment_body="@alfred ok",
            comment_author_id="boss-3",
            pending=pending,
            issue_id="iss-3",
            alfred_user_id=ALFRED_UID,
        )
        assert entry is not None


class TestApprovalBodyParse:
    def test_approved_after_mention(self):
        assert _body_is_approval_for_alfred("@alfred approved", ALFRED_UID)

    def test_go_after_mention(self):
        assert _body_is_approval_for_alfred("@alfred go", ALFRED_UID)

    def test_approval_after_punctuation(self):
        assert _body_is_approval_for_alfred("@alfred, approved", ALFRED_UID)

    def test_mention_without_approval(self):
        assert not _body_is_approval_for_alfred("@alfred please wait", ALFRED_UID)

    def test_approval_with_markup_mention(self):
        body = f"@[Alfred](user_id={ALFRED_UID}) approved"
        assert _body_is_approval_for_alfred(body, ALFRED_UID)


# ---------------------------------------------------------------------------
# Self-comment ledger I/O
# ---------------------------------------------------------------------------

class TestSelfCommentLedger:
    def test_round_trip(self, tmp_path: Path):
        p = tmp_path / "ledger.json"
        _save_self_comments(p, ["a", "b", "c"])
        assert _load_self_comments(p) == ["a", "b", "c"]

    def test_missing_file(self, tmp_path: Path):
        assert _load_self_comments(tmp_path / "nope.json") == []

    def test_corrupt_file(self, tmp_path: Path):
        p = tmp_path / "bad.json"
        p.write_text("not json")
        assert _load_self_comments(p) == []

    def test_cap_enforced(self, tmp_path: Path):
        p = tmp_path / "big.json"
        ids = [f"c-{i}" for i in range(_SELF_COMMENTS_CAP + 10)]
        _save_self_comments(p, ids)
        loaded = _load_self_comments(p)
        assert len(loaded) == _SELF_COMMENTS_CAP
        # Newest entries retained (FIFO from the tail).
        assert loaded[-1] == ids[-1]
        assert loaded[0] == ids[10]

    def test_legacy_dict_shape(self, tmp_path: Path):
        p = tmp_path / "legacy.json"
        p.write_text(json.dumps({"comments": ["x", "y"]}))
        assert _load_self_comments(p) == ["x", "y"]


class TestPendingApprovalsIO:
    def test_round_trip(self, tmp_path: Path):
        p = tmp_path / "pending.json"
        entries = {
            "iss-1": {
                "session_id": "s1",
                "created_ts": 123,
                "requester_author_id": "u1",
                "trigger_type": "assignment",
                "project_id": "p1",
                "approved_ts": 0,
            }
        }
        _save_pending(p, entries)
        loaded = _load_pending(p)
        assert loaded == entries

    def test_missing_file(self, tmp_path: Path):
        assert _load_pending(tmp_path / "nope.json") == {}


# ---------------------------------------------------------------------------
# Bootstrap-prompt enrichment (matter body + comment thread)
# ---------------------------------------------------------------------------

from src.activities.plane_alfred_triggers import (
    _build_prompt,
    _matter_slug_for_project,
    _format_comment_excerpt,
)


class TestBuildPromptEnrichment:
    """_build_prompt must inline the matter body + the issue's comment
    thread so the spawned agent has full context instead of waking up
    with only the triggering comment.
    """

    def _trigger(self, **overrides: Any) -> dict[str, Any]:
        base: dict[str, Any] = {
            "trigger_type": "mention",
            "issue_id": "iss-123",
            "project_id": "proj-1",
            "comment_body": "@alfred please ship this",
            "author_email": "sir@alfred.black",
            "author_id": "human-user-1",
            "requires_approval": False,
        }
        base.update(overrides)
        return base

    def test_matter_body_is_inlined(self):
        matter = {
            "path": "matter/alfred-platform.md",
            "frontmatter": {"name": "Alfred Platform Build"},
            "body": "This matter tracks the end-to-end build of the Alfred SaaS platform including SaaS control plane, tenant plane, and data plane.",
        }
        out = _build_prompt(
            self._trigger(),
            project_name="Alfred Platform",
            issue={"name": "ship it", "description_stripped": "do the thing"},
            matter=matter,
            alfred_user_id=ALFRED_UID,
        )
        assert "Related matter: Alfred Platform Build" in out
        assert "matter/alfred-platform.md" in out
        assert "end-to-end build of the Alfred SaaS platform" in out

    def test_matter_body_truncated_when_huge(self):
        matter = {
            "path": "matter/big.md",
            "frontmatter": {"name": "Big"},
            "body": "x" * 5000,
        }
        out = _build_prompt(
            self._trigger(),
            project_name="Big",
            issue={"name": "iss"},
            matter=matter,
            alfred_user_id=ALFRED_UID,
        )
        assert "[truncated]" in out
        # The original 5000-char body must not be inlined verbatim —
        # we cap at 1500 + the truncation marker.
        assert out.count("x") < 5000

    def test_no_matter_section_when_unmapped(self):
        out = _build_prompt(
            self._trigger(),
            project_name="Inbox",
            issue={"name": "ad-hoc", "description": ""},
            matter=None,
            alfred_user_id=ALFRED_UID,
        )
        assert "Related matter" not in out

    def test_comment_thread_rendered_oldest_to_newest(self):
        comments = [
            {
                "id": "c1",
                "created_at": "2026-04-24T09:00:00Z",
                "comment_stripped": "initial thought from Sir",
                "actor": {"id": "human-user-1", "email": "sir@alfred.black"},
            },
            {
                "id": "c2",
                "created_at": "2026-04-24T09:05:00Z",
                "comment_stripped": "some context reply",
                "actor": {"id": ALFRED_UID, "email": "alfred@alfred.black"},
            },
            {
                "id": "c3",
                "created_at": "2026-04-24T09:10:00Z",
                "comment_stripped": "@alfred please ship this",
                "actor": {"id": "human-user-1", "email": "sir@alfred.black"},
            },
        ]
        out = _build_prompt(
            self._trigger(),
            project_name="P",
            issue={"name": "i"},
            comments=comments,
            alfred_user_id=ALFRED_UID,
        )
        assert "Comment thread on this issue" in out
        # Newest-at-bottom ordering preserved within the thread section.
        # "please ship this" also appears in the triggering-comment line
        # earlier in the prompt, so compare within the thread section
        # (everything after "Comment thread on this issue:").
        thread_section = out[out.index("Comment thread on this issue"):]
        initial_pos = thread_section.index("initial thought from Sir")
        ship_pos = thread_section.index("please ship this")
        assert initial_pos < ship_pos
        # Alfred's own prior comment labelled as Alfred, not by email
        alfred_line = [ln for ln in out.splitlines() if "some context reply" in ln][0]
        assert "Alfred" in alfred_line
        # Sir's line labelled with his email
        sir_line = [ln for ln in out.splitlines() if "initial thought" in ln][0]
        assert "sir@alfred.black" in sir_line

    def test_long_thread_truncated_at_cap(self):
        # 25 comments — only the last _PROMPT_COMMENT_MAX (20) should be rendered
        comments = [
            {
                "id": f"c{i}",
                "created_at": f"2026-04-24T09:{i:02d}:00Z",
                "comment_stripped": f"body-{i}",
                "actor": {"id": "human-user-1"},
            }
            for i in range(25)
        ]
        out = _build_prompt(
            self._trigger(),
            project_name="P",
            issue={"name": "i"},
            comments=comments,
            alfred_user_id=ALFRED_UID,
        )
        assert "showing last 20 of 25" in out
        # First 5 comments (body-0..body-4) should have been dropped
        assert "body-0:" not in out and "body-4:" not in out
        # Last 5 should be present
        assert "body-24" in out and "body-20" in out

    def test_no_comments_section_when_empty(self):
        out = _build_prompt(
            self._trigger(),
            project_name="P",
            issue={"name": "i"},
            comments=[],
            alfred_user_id=ALFRED_UID,
        )
        assert "Comment thread" not in out


class TestFormatCommentExcerpt:
    def test_alfred_author_labelled_alfred(self):
        out = _format_comment_excerpt(
            {
                "comment_stripped": "acknowledged",
                "actor": {"id": ALFRED_UID, "email": "alfred@x.com"},
                "created_at": "2026-04-24T09:05:00Z",
            },
            alfred_user_id=ALFRED_UID,
        )
        assert "Alfred" in out
        assert "alfred@x.com" not in out  # prefer the name label

    def test_html_is_stripped(self):
        out = _format_comment_excerpt(
            {
                "comment_html": "<p>hello <strong>world</strong></p>",
                "actor": {"id": "u1"},
            },
            alfred_user_id=ALFRED_UID,
        )
        assert "<p>" not in out and "<strong>" not in out
        assert "hello world" in out

    def test_empty_body_returns_empty_string(self):
        out = _format_comment_excerpt(
            {"actor": {"id": "u1"}},
            alfred_user_id=ALFRED_UID,
        )
        assert out == ""


class TestMatterSlugForProject:
    def test_unmapped_returns_empty(self, tmp_path: Path, monkeypatch):
        monkeypatch.setenv("ALFRED_DATA_DIR", str(tmp_path))
        assert _matter_slug_for_project("nope") == ""

    def test_roundtrip(self, tmp_path: Path, monkeypatch):
        monkeypatch.setenv("ALFRED_DATA_DIR", str(tmp_path))
        # Cursor lives under state/ — same path plane_sync writes.
        cursor = tmp_path / "state" / "plane_sync_cursor.json"
        cursor.parent.mkdir(parents=True, exist_ok=True)
        cursor.write_text(json.dumps({
            "last_vault_mtime": 0,
            "project_map": {
                "alfred-platform": "proj-alfred-uuid",
                "__inbox__": "proj-inbox-uuid",
            },
            "issue_map": {},
        }))
        assert _matter_slug_for_project("proj-alfred-uuid") == "alfred-platform"
        # Inbox sentinel not returned as a matter
        assert _matter_slug_for_project("proj-inbox-uuid") == ""
        assert _matter_slug_for_project("") == ""


# ---------------------------------------------------------------------------
# Workflow end-to-end test with stubbed activities
# ---------------------------------------------------------------------------

_CALL_LOG: list[tuple[str, Any]] = []


def _reset() -> None:
    _CALL_LOG.clear()


def _stream_event(
    plane_event: str,
    action: str,
    data: dict[str, Any],
    *,
    event_id: Optional[str] = None,
) -> dict[str, Any]:
    return {
        "id": event_id or f"evt-{uuid.uuid4()}",
        "stream_id": "plane",
        "stream_type": "plane",
        "received_at": "2026-04-23T12:00:00Z",
        "source_ref": f"plane:{plane_event}:{data.get('id', 'x')}",
        "summary": f"Plane {plane_event} {action}",
        "raw": {
            "event": plane_event,
            "action": action,
            "data": data,
        },
    }


def _make_b8_stubs(
    *,
    events: list[dict[str, Any]],
    triggers_by_event: Optional[dict[str, Optional[dict[str, Any]]]] = None,
    spawn_success: bool = True,
    approval_outcome: Optional[dict[str, Any]] = None,
) -> tuple[list, dict[str, Any]]:
    """Stubs that exercise only the B8 code path. Reverse-sync activities
    that would hit the vault are stubbed to no-op so the workflow stays
    focused on the Alfred trigger logic."""
    triggers_by_event = triggers_by_event or {}
    state: dict[str, Any] = {
        "spawn_calls": [],
        "detect_calls": [],
        "approval_calls": [],
    }

    @activity.defn(name="plane_reverse_sync_is_enabled")
    async def stub_enabled() -> bool:
        return True

    @activity.defn(name="load_reverse_sync_state")
    async def stub_load_state() -> dict[str, Any]:
        return {
            "cursor": {"last_event_id": "", "last_event_ts": 0.0},
            "project_map": {},
            "issue_map": {},
            "outbound_signatures": {},
        }

    @activity.defn(name="save_reverse_sync_cursor")
    async def stub_save_cursor(cursor: dict[str, Any]) -> None:
        _CALL_LOG.append(("save_cursor", dict(cursor)))

    @activity.defn(name="fetch_plane_events")
    async def stub_fetch(since_id: str) -> list[dict[str, Any]]:
        return list(events)

    @activity.defn(name="fetch_plane_state_groups")
    async def stub_fetch_state_groups() -> dict[str, str]:
        return {}

    @activity.defn(name="check_loop_guards")
    async def stub_guards(
        plane_id: str,
        external_id: Optional[str],
        payload: dict[str, Any],
        sigs: dict[str, dict[str, Any]],
        now_ms: Optional[int] = None,
    ) -> dict[str, Any]:
        return {"skip": False, "reason": "", "hash": ""}

    @activity.defn(name="apply_plane_patch_to_vault")
    async def stub_apply(
        record_type: str,
        path: str,
        patch: dict[str, Any],
        inbound_hash: str,
    ) -> dict[str, Any]:
        return {"applied": False, "action": "noop", "reason": "stub"}

    @activity.defn(name="create_vault_task_from_plane_issue")
    async def stub_create(
        issue: dict[str, Any],
        matter_slug: Optional[str],
        state_groups_arg: Optional[dict[str, str]] = None,
    ) -> dict[str, Any]:
        return {"path": "task/stub.md", "slug": "stub", "plane_issue_id": issue.get("id")}

    @activity.defn(name="append_plane_comment_to_vault")
    async def stub_append(path: str, comment: dict[str, Any]) -> dict[str, Any]:
        return {"applied": False, "reason": "stub"}

    @activity.defn(name="archive_vault_record")
    async def stub_archive(path: str, record_type: str) -> dict[str, Any]:
        return {"applied": False, "reason": "stub"}

    @activity.defn(name="mark_plane_event_processed")
    async def stub_mark(event_id: str, vault_path: str, classification: str) -> None:
        pass

    @activity.defn(name="detect_alfred_plane_trigger")
    async def stub_detect(event_raw: dict[str, Any]) -> Optional[dict[str, Any]]:
        state["detect_calls"].append(dict(event_raw))
        # Route by a stable key — the first piece of data.id in the event.
        key = str((event_raw.get("data") or {}).get("id") or "")
        return triggers_by_event.get(key)

    @activity.defn(name="spawn_alfred_for_plane_trigger")
    async def stub_spawn(trigger: dict[str, Any]) -> dict[str, Any]:
        state["spawn_calls"].append(dict(trigger))
        if spawn_success:
            return {
                "spawned": True,
                "session_key": f"sess-{uuid.uuid4()}",
                "prompt_chars": 500,
                "requires_approval": bool(trigger.get("requires_approval")),
                "error": "",
            }
        return {
            "spawned": False,
            "session_key": "",
            "prompt_chars": 500,
            "requires_approval": bool(trigger.get("requires_approval")),
            "error": "stub_failure",
        }

    @activity.defn(name="resolve_plane_approval")
    async def stub_resolve(
        issue_id: str,
        comment_body: str,
        comment_author_id: str,
    ) -> dict[str, Any]:
        state["approval_calls"].append(
            {"issue_id": issue_id, "body": comment_body, "author": comment_author_id}
        )
        if approval_outcome is not None:
            return dict(approval_outcome)
        return {"approved": True, "session_id": "prev-sess", "reason": ""}

    stubs = [
        stub_enabled,
        stub_load_state,
        stub_save_cursor,
        stub_fetch,
        stub_fetch_state_groups,
        stub_guards,
        stub_apply,
        stub_create,
        stub_append,
        stub_archive,
        stub_mark,
        stub_detect,
        stub_spawn,
        stub_resolve,
    ]
    return stubs, state


async def _run_workflow(stubs: list) -> PlaneReverseSyncResult:
    async with await WorkflowEnvironment.start_time_skipping() as env:
        client: Client = env.client
        tq = f"plane-b8-test-{uuid.uuid4()}"
        worker = Worker(
            client,
            task_queue=tq,
            workflows=[PlaneReverseSyncWorkflow],
            activities=stubs,
        )
        async with worker:
            result = await client.execute_workflow(
                PlaneReverseSyncWorkflow.run,
                id=f"plane-b8-run-{uuid.uuid4()}",
                task_queue=tq,
            )
    return result


class TestWorkflowIntegration:
    def test_mention_triggers_spawn(self):
        _reset()
        mention_evt = _stream_event(
            "issue_comment",
            "created",
            {
                "id": "c-abc",
                "comment_html": "@alfred please help",
                "comment_stripped": "@alfred please help",
                "issue": "iss-xyz",
                "project": "proj-1",
                "actor": {"id": "human-1", "email": "h@x.test"},
            },
            event_id="evt-mention-1",
        )
        stubs, state = _make_b8_stubs(
            events=[mention_evt],
            triggers_by_event={
                "c-abc": {
                    "trigger_type": "mention",
                    "issue_id": "iss-xyz",
                    "project_id": "proj-1",
                    "comment_id": "c-abc",
                    "comment_body": "@alfred please help",
                    "author_id": "human-1",
                    "author_email": "h@x.test",
                    "requires_approval": False,
                },
            },
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.alfred_triggers_seen == 1
        assert result.alfred_sessions_spawned == 1
        assert result.alfred_spawns_failed == 0
        assert len(state["spawn_calls"]) == 1
        assert state["spawn_calls"][0]["trigger_type"] == "mention"

    def test_assignment_triggers_gated_spawn(self):
        _reset()
        assign_evt = _stream_event(
            "issue",
            "created",
            {
                "id": "iss-123",
                "name": "Book the venue",
                "project": "proj-1",
                "assignees": [ALFRED_UID],
                "actor": {"id": "boss", "email": "boss@x.test"},
            },
            event_id="evt-assign-1",
        )
        stubs, state = _make_b8_stubs(
            events=[assign_evt],
            triggers_by_event={
                "iss-123": {
                    "trigger_type": "assignment",
                    "issue_id": "iss-123",
                    "project_id": "proj-1",
                    "issue_data": {"name": "Book the venue"},
                    "author_id": "boss",
                    "author_email": "boss@x.test",
                    "requires_approval": True,
                },
            },
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.alfred_triggers_seen == 1
        assert result.alfred_sessions_spawned == 1
        call = state["spawn_calls"][0]
        assert call["requires_approval"] is True
        assert call["trigger_type"] == "assignment"

    def test_approval_trigger_resolves_pending(self):
        _reset()
        approve_evt = _stream_event(
            "issue_comment",
            "created",
            {
                "id": "c-approve",
                "comment_html": "@alfred approved",
                "comment_stripped": "@alfred approved",
                "issue": "iss-123",
                "project": "proj-1",
                "actor": {"id": "boss", "email": "boss@x.test"},
            },
            event_id="evt-approve-1",
        )
        stubs, state = _make_b8_stubs(
            events=[approve_evt],
            triggers_by_event={
                "c-approve": {
                    "trigger_type": "approval",
                    "issue_id": "iss-123",
                    "project_id": "proj-1",
                    "comment_id": "c-approve",
                    "comment_body": "@alfred approved",
                    "author_id": "boss",
                    "approved_session_id": "prev-sess",
                    "requires_approval": False,
                },
            },
            approval_outcome={"approved": True, "session_id": "prev-sess", "reason": ""},
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.alfred_triggers_seen == 1
        # Approval path does NOT spawn a new session.
        assert result.alfred_sessions_spawned == 0
        assert result.alfred_approvals_resolved == 1
        assert len(state["approval_calls"]) == 1
        assert state["approval_calls"][0]["issue_id"] == "iss-123"
        # No session spawn should be invoked.
        assert state["spawn_calls"] == []

    def test_no_trigger_no_spawn(self):
        _reset()
        # Event that looks like a noise comment with no mention.
        evt = _stream_event(
            "issue_comment",
            "created",
            {
                "id": "c-noise",
                "comment_html": "looks good, thanks",
                "comment_stripped": "looks good, thanks",
                "issue": "iss-noise",
                "project": "proj-1",
                "actor": {"id": "rando", "email": "r@x.test"},
            },
            event_id="evt-noise",
        )
        stubs, state = _make_b8_stubs(
            events=[evt],
            triggers_by_event={"c-noise": None},
        )
        result = asyncio.run(_run_workflow(stubs))

        assert result.alfred_triggers_seen == 0
        assert result.alfred_sessions_spawned == 0
        assert result.alfred_spawns_failed == 0
        assert state["spawn_calls"] == []

    def test_spawn_failure_records_counter(self):
        _reset()
        evt = _stream_event(
            "issue_comment",
            "created",
            {
                "id": "c-boom",
                "comment_html": "@alfred do it",
                "comment_stripped": "@alfred do it",
                "issue": "iss-boom",
                "project": "proj-1",
                "actor": {"id": "boss"},
            },
            event_id="evt-boom",
        )
        stubs, state = _make_b8_stubs(
            events=[evt],
            triggers_by_event={
                "c-boom": {
                    "trigger_type": "mention",
                    "issue_id": "iss-boom",
                    "project_id": "proj-1",
                    "comment_id": "c-boom",
                    "comment_body": "@alfred do it",
                    "author_id": "boss",
                    "requires_approval": False,
                },
            },
            spawn_success=False,
        )
        result = asyncio.run(_run_workflow(stubs))
        assert result.alfred_triggers_seen == 1
        assert result.alfred_sessions_spawned == 0
        assert result.alfred_spawns_failed == 1

    def test_end_to_end_mention_then_approval(self):
        """The critical flow: ``@alfred help`` → gated spawn → ``@alfred approved``
        resolves the same session."""
        _reset()
        # Round 1: gated mention.
        mention_evt = _stream_event(
            "issue_comment",
            "created",
            {
                "id": "c-gate",
                "comment_html": "@alfred please delete the draft",
                "comment_stripped": "@alfred please delete the draft",
                "issue": "iss-gate",
                "project": "proj-1",
                "actor": {"id": "boss"},
            },
            event_id="evt-gate-1",
        )
        stubs_1, state_1 = _make_b8_stubs(
            events=[mention_evt],
            triggers_by_event={
                "c-gate": {
                    "trigger_type": "mention",
                    "issue_id": "iss-gate",
                    "project_id": "proj-1",
                    "comment_id": "c-gate",
                    "comment_body": "@alfred please delete the draft",
                    "author_id": "boss",
                    "requires_approval": True,
                },
            },
        )
        r1 = asyncio.run(_run_workflow(stubs_1))
        assert r1.alfred_sessions_spawned == 1
        assert state_1["spawn_calls"][0]["requires_approval"] is True

        # Round 2: approval from the same user.
        _reset()
        approve_evt = _stream_event(
            "issue_comment",
            "created",
            {
                "id": "c-ok",
                "comment_html": "@alfred approved",
                "comment_stripped": "@alfred approved",
                "issue": "iss-gate",
                "project": "proj-1",
                "actor": {"id": "boss"},
            },
            event_id="evt-gate-2",
        )
        stubs_2, state_2 = _make_b8_stubs(
            events=[approve_evt],
            triggers_by_event={
                "c-ok": {
                    "trigger_type": "approval",
                    "issue_id": "iss-gate",
                    "project_id": "proj-1",
                    "comment_id": "c-ok",
                    "comment_body": "@alfred approved",
                    "author_id": "boss",
                    "approved_session_id": "prev-sess-for-gate",
                    "requires_approval": False,
                },
            },
            approval_outcome={
                "approved": True,
                "session_id": "prev-sess-for-gate",
                "reason": "",
            },
        )
        r2 = asyncio.run(_run_workflow(stubs_2))
        assert r2.alfred_approvals_resolved == 1
        assert r2.alfred_sessions_spawned == 0
        assert state_2["approval_calls"][0]["issue_id"] == "iss-gate"


class TestPlaneSyncCursorPath:
    """The matter-context lookup must read the SAME cursor file that
    plane_sync writes. The cursor lives at ``<alfred_data>/state/
    plane_sync_cursor.json``; a missing ``state/`` segment makes
    ``_matter_slug_for_project`` always miss → Plane-triggered Alfred
    sessions never get matter context.
    """

    def test_cursor_path_matches_plane_sync(self, monkeypatch, tmp_path):
        from src.activities import plane_alfred_triggers as pat
        from src.activities import plane_sync as ps

        # Pin both modules to the same alfred-data dir.
        monkeypatch.setattr(pat, "_alfred_data_dir", lambda: tmp_path)

        class _Cfg:
            alfred_data_dir = str(tmp_path)
        monkeypatch.setattr(ps, "load_config", lambda: _Cfg())

        assert pat._plane_sync_cursor_path() == ps._cursor_path(), (
            "triggers must resolve the cursor at plane_sync's path "
            f"(got {pat._plane_sync_cursor_path()} vs {ps._cursor_path()})"
        )

    def test_matter_slug_resolves_from_plane_sync_cursor(self, monkeypatch, tmp_path):
        from src.activities import plane_alfred_triggers as pat
        from src.activities import plane_sync as ps

        monkeypatch.setattr(pat, "_alfred_data_dir", lambda: tmp_path)

        class _Cfg:
            alfred_data_dir = str(tmp_path)
        monkeypatch.setattr(ps, "load_config", lambda: _Cfg())

        # Write a cursor where plane_sync actually puts it.
        cursor_path = ps._cursor_path()
        cursor_path.parent.mkdir(parents=True, exist_ok=True)
        cursor_path.write_text(json.dumps({
            "last_vault_mtime": 0.0,
            "project_map": {"the-pavilion": "prj-pav"},
            "issue_map": {},
        }))

        assert pat._matter_slug_for_project("prj-pav") == "the-pavilion"
