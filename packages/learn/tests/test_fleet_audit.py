"""Tests for the fleet audit activity + helpers.

The audit is the after-the-fact tripwire for the April 2026 tenant-a-vs-
Sir Composio user_id leak. These tests cover:

* owner-email resolution from env vs onboard.json vs nothing
* the streams scanner: empty file, owner-only, mismatch, malformed JSON
* the top-level activity: skip-without-owner, empty dir, mismatch found
"""
from __future__ import annotations

import json

import pytest
from temporalio.testing import ActivityEnvironment

from src.activities.fleet_audit import (
    _extract_self_attendee_email,
    _resolve_owner_email,
    _scan_jsonl_file,
    audit_streams_for_owner_mismatch,
    fleet_audit_is_enabled,
)


async def _run_audit(streams_dir: str) -> dict:
    env = ActivityEnvironment()
    return await env.run(audit_streams_for_owner_mismatch, streams_dir)


async def _run_flag() -> bool:
    env = ActivityEnvironment()
    return await env.run(fleet_audit_is_enabled)


# ---------------------------------------------------------------------------
# _resolve_owner_email
# ---------------------------------------------------------------------------

class TestResolveOwnerEmail:
    def test_env_takes_priority(self, monkeypatch, tmp_path):
        onboard = tmp_path / "onboard.json"
        onboard.write_text(json.dumps({"owner_email": "other@example.com"}))
        monkeypatch.setenv("OWNER_EMAIL", "Env@Example.com")
        monkeypatch.setenv("ONBOARD_JSON_PATH", str(onboard))

        email, source = _resolve_owner_email()
        assert email == "env@example.com"
        assert source == "env"

    def test_falls_back_to_onboard_owner_email(self, monkeypatch, tmp_path):
        onboard = tmp_path / "onboard.json"
        onboard.write_text(
            json.dumps({"owner_email": "sir@Example.com"})
        )
        monkeypatch.delenv("OWNER_EMAIL", raising=False)
        monkeypatch.setenv("ONBOARD_JSON_PATH", str(onboard))

        email, source = _resolve_owner_email()
        assert email == "sir@example.com"
        assert source == "onboard_json"

    def test_falls_back_to_nested_user_email(self, monkeypatch, tmp_path):
        onboard = tmp_path / "onboard.json"
        onboard.write_text(
            json.dumps({"user": {"email": "nested@example.com"}})
        )
        monkeypatch.delenv("OWNER_EMAIL", raising=False)
        monkeypatch.setenv("ONBOARD_JSON_PATH", str(onboard))

        email, source = _resolve_owner_email()
        assert email == "nested@example.com"
        assert source == "onboard_json"

    def test_no_env_and_no_onboard_file(self, monkeypatch, tmp_path):
        monkeypatch.delenv("OWNER_EMAIL", raising=False)
        monkeypatch.setenv(
            "ONBOARD_JSON_PATH", str(tmp_path / "nonexistent.json")
        )
        email, source = _resolve_owner_email()
        assert email == ""
        assert source == ""

    def test_malformed_onboard_json(self, monkeypatch, tmp_path):
        onboard = tmp_path / "onboard.json"
        onboard.write_text("not valid json {")
        monkeypatch.delenv("OWNER_EMAIL", raising=False)
        monkeypatch.setenv("ONBOARD_JSON_PATH", str(onboard))

        email, source = _resolve_owner_email()
        assert email == ""
        assert source == ""

    def test_onboard_json_without_email_fields(self, monkeypatch, tmp_path):
        onboard = tmp_path / "onboard.json"
        onboard.write_text(json.dumps({"stage": "done", "user_id": "123"}))
        monkeypatch.delenv("OWNER_EMAIL", raising=False)
        monkeypatch.setenv("ONBOARD_JSON_PATH", str(onboard))

        email, source = _resolve_owner_email()
        assert email == ""


# ---------------------------------------------------------------------------
# _extract_self_attendee_email
# ---------------------------------------------------------------------------

class TestExtractSelfAttendeeEmail:
    def test_finds_self_attendee(self):
        raw = {
            "attendees": [
                {"email": "other@example.com", "self": False},
                {"email": "Me@Example.com", "self": True},
            ],
        }
        assert _extract_self_attendee_email(raw) == "me@example.com"

    def test_no_attendees(self):
        assert _extract_self_attendee_email({"summary": "event"}) is None

    def test_attendees_not_list(self):
        assert _extract_self_attendee_email({"attendees": "nope"}) is None

    def test_no_self_flag(self):
        raw = {
            "attendees": [
                {"email": "a@example.com"},
                {"email": "b@example.com"},
            ],
        }
        assert _extract_self_attendee_email(raw) is None

    def test_raw_not_dict(self):
        assert _extract_self_attendee_email(None) is None
        assert _extract_self_attendee_email("string") is None

    def test_attendee_without_email(self):
        raw = {"attendees": [{"self": True}]}
        assert _extract_self_attendee_email(raw) is None


# ---------------------------------------------------------------------------
# _scan_jsonl_file
# ---------------------------------------------------------------------------

class TestScanJsonlFile:
    def test_empty_file(self, tmp_path):
        f = tmp_path / "composio-gmail.jsonl"
        f.write_text("")
        assert _scan_jsonl_file(str(f), "owner@example.com") == []

    def test_only_owner_events(self, tmp_path):
        f = tmp_path / "composio-calendar.jsonl"
        events = [
            {
                "source_ref": "evt-1",
                "raw": {
                    "attendees": [
                        {"email": "owner@example.com", "self": True},
                    ],
                },
            },
            {
                "source_ref": "evt-2",
                "raw": {
                    "attendees": [
                        {"email": "OWNER@example.com", "self": True},
                    ],
                },
            },
        ]
        f.write_text("\n".join(json.dumps(e) for e in events))
        assert _scan_jsonl_file(str(f), "owner@example.com") == []

    def test_single_mismatch(self, tmp_path):
        f = tmp_path / "composio-calendar.jsonl"
        events = [
            {
                "source_ref": "evt-ok",
                "raw": {
                    "attendees": [{"email": "owner@example.com", "self": True}],
                },
            },
            {
                "source_ref": "evt-leaked",
                "received_at": "2026-04-15T10:00:00Z",
                "raw": {
                    "attendees": [
                        {"email": "someone@else.com", "self": True},
                        {"email": "other@party.com"},
                    ],
                    "start": {"dateTime": "2026-04-15T10:00:00Z"},
                },
            },
        ]
        f.write_text("\n".join(json.dumps(e) for e in events))
        out = _scan_jsonl_file(str(f), "owner@example.com")

        assert len(out) == 1
        entry = out[0]
        assert entry["event_id"] == "evt-leaked"
        assert entry["self_email"] == "someone@else.com"
        assert entry["expected_email"] == "owner@example.com"
        assert entry["date"] == "2026-04-15T10:00:00Z"
        assert entry["line"] == 2

    def test_events_without_self_attendee_ignored(self, tmp_path):
        f = tmp_path / "composio-gmail.jsonl"
        events = [
            {
                "source_ref": "plain-gmail",
                "raw": {"subject": "Hi", "from": "a@b.com"},
            },
            {
                "source_ref": "group-cal",
                "raw": {
                    "attendees": [
                        {"email": "a@b.com"},
                        {"email": "c@d.com"},
                    ],
                },
            },
        ]
        f.write_text("\n".join(json.dumps(e) for e in events))
        assert _scan_jsonl_file(str(f), "owner@example.com") == []

    def test_malformed_line_logged_and_skipped(self, tmp_path, caplog):
        import logging
        caplog.set_level(logging.WARNING)
        f = tmp_path / "composio-calendar.jsonl"
        good = json.dumps({
            "source_ref": "evt-1",
            "raw": {
                "attendees": [{"email": "stranger@example.com", "self": True}],
            },
        })
        f.write_text(f"{good}\n{{not valid\n{good}\n")

        out = _scan_jsonl_file(str(f), "owner@example.com")
        # Two valid mismatches, malformed line skipped.
        assert len(out) == 2
        # Lines are 1-indexed; bad JSON was at line 2.
        assert {entry["line"] for entry in out} == {1, 3}
        # A warning was logged.
        assert any(
            "malformed JSON" in rec.message for rec in caplog.records
        )

    def test_blank_lines_skipped(self, tmp_path):
        f = tmp_path / "composio-gmail.jsonl"
        good = json.dumps({
            "source_ref": "evt-1",
            "raw": {
                "attendees": [{"email": "stranger@example.com", "self": True}],
            },
        })
        f.write_text(f"\n\n{good}\n\n")
        out = _scan_jsonl_file(str(f), "owner@example.com")
        assert len(out) == 1
        assert out[0]["event_id"] == "evt-1"

    def test_nonexistent_file_returns_empty(self, tmp_path):
        missing = tmp_path / "not-there.jsonl"
        assert _scan_jsonl_file(str(missing), "owner@example.com") == []


# ---------------------------------------------------------------------------
# audit_streams_for_owner_mismatch — top-level activity
# ---------------------------------------------------------------------------

class TestAuditStreamsActivity:
    async def test_no_owner_email_returns_not_audited(
        self, monkeypatch, tmp_path,
    ):
        monkeypatch.delenv("OWNER_EMAIL", raising=False)
        monkeypatch.setenv(
            "ONBOARD_JSON_PATH", str(tmp_path / "missing.json"),
        )
        out = await _run_audit(str(tmp_path))
        assert out["status"] == "no_owner_email_configured"
        assert out["total_mismatches"] == 0
        assert out["mismatches_by_file"] == {}

    async def test_no_streams_dir(self, monkeypatch, tmp_path):
        monkeypatch.setenv("OWNER_EMAIL", "owner@example.com")
        out = await _run_audit(str(tmp_path / "does-not-exist"))
        assert out["status"] == "no_streams_dir"
        assert out["files_scanned"] == 0
        assert out["owner_email"] == "owner@example.com"
        assert out["owner_source"] == "env"

    async def test_empty_streams_dir_returns_green(self, monkeypatch, tmp_path):
        monkeypatch.setenv("OWNER_EMAIL", "owner@example.com")
        streams = tmp_path / "streams"
        streams.mkdir()
        out = await _run_audit(str(streams))
        assert out["status"] == "ok"
        assert out["files_scanned"] == 0
        assert out["total_mismatches"] == 0
        assert out["mismatches_by_file"] == {}

    async def test_detects_mismatch_in_composio_file(
        self, monkeypatch, tmp_path,
    ):
        monkeypatch.setenv("OWNER_EMAIL", "david@example.com")
        streams = tmp_path / "streams"
        streams.mkdir()

        # Calendar file: mixed legit + leak.
        calendar = streams / "composio-calendar.jsonl"
        calendar.write_text("\n".join([
            json.dumps({
                "source_ref": "evt-david-own",
                "raw": {
                    "attendees": [
                        {"email": "david@example.com", "self": True},
                    ],
                },
            }),
            json.dumps({
                "source_ref": "evt-leaked-from-tenant-a",
                "received_at": "2026-04-15T10:00:00Z",
                "raw": {
                    "attendees": [
                        {"email": "tenant-a@example.com", "self": True},
                    ],
                    "start": {"dateTime": "2026-04-15T10:00:00Z"},
                },
            }),
        ]))

        # Gmail file: ignored by scan since none have self attendees.
        gmail = streams / "composio-gmail.jsonl"
        gmail.write_text(json.dumps({
            "source_ref": "em-1",
            "raw": {"subject": "Hi", "from": "a@b.com"},
        }) + "\n")

        # Non-composio file — not picked up by the glob.
        noise = streams / "agentmail.jsonl"
        noise.write_text(json.dumps({
            "source_ref": "noise",
            "raw": {
                "attendees": [{"email": "noise@z.com", "self": True}],
            },
        }) + "\n")

        out = await _run_audit(str(streams))
        assert out["status"] == "ok"
        assert out["owner_email"] == "david@example.com"
        assert out["files_scanned"] == 2  # only composio-*.jsonl
        assert out["total_mismatches"] == 1

        assert "composio-calendar.jsonl" in out["mismatches_by_file"]
        entries = out["mismatches_by_file"]["composio-calendar.jsonl"]
        assert len(entries) == 1
        assert entries[0]["event_id"] == "evt-leaked-from-tenant-a"
        assert entries[0]["self_email"] == "tenant-a@example.com"
        assert entries[0]["expected_email"] == "david@example.com"

    async def test_malformed_jsonl_doesnt_crash(self, monkeypatch, tmp_path):
        monkeypatch.setenv("OWNER_EMAIL", "owner@example.com")
        streams = tmp_path / "streams"
        streams.mkdir()
        f = streams / "composio-calendar.jsonl"
        f.write_text(
            "{ not valid json\n"
            + json.dumps({
                "source_ref": "evt-ok",
                "raw": {
                    "attendees": [
                        {"email": "stranger@example.com", "self": True},
                    ],
                },
            }) + "\n"
        )
        out = await _run_audit(str(streams))
        assert out["status"] == "ok"
        assert out["total_mismatches"] == 1


# ---------------------------------------------------------------------------
# fleet_audit_is_enabled — feature flag
# ---------------------------------------------------------------------------

class TestFeatureFlag:
    async def test_defaults_to_true(self, monkeypatch):
        monkeypatch.delenv("FLEET_AUDIT_ENABLED", raising=False)
        assert await _run_flag() is True

    async def test_respects_explicit_false(self, monkeypatch):
        monkeypatch.setenv("FLEET_AUDIT_ENABLED", "false")
        assert await _run_flag() is False

    async def test_case_insensitive_true(self, monkeypatch):
        monkeypatch.setenv("FLEET_AUDIT_ENABLED", "TrUe")
        assert await _run_flag() is True

    async def test_whitespace_handled(self, monkeypatch):
        monkeypatch.setenv("FLEET_AUDIT_ENABLED", "  false  ")
        assert await _run_flag() is False
