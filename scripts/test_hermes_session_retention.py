#!/usr/bin/env python3
"""
Fixture tests for hermes-session-retention.py  refs #430

Run with:  python3 scripts/test_hermes_session_retention.py
No external dependencies — stdlib only.
"""

import importlib.util
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

# Load the hyphen-named module via importlib (Python disallows hyphens in identifiers)
_script = Path(__file__).parent / "hermes-session-retention.py"
_spec = importlib.util.spec_from_file_location("hermes_session_retention", _script)
_mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(_mod)  # type: ignore[union-attr]

PROFILE_RETENTION = _mod.PROFILE_RETENTION
_cutoff = _mod._cutoff
_eligible = _mod._eligible
_fts_is_content_table = _mod._fts_is_content_table
_has_fts_triggers = _mod._has_fts_triggers
_integrity = _mod._integrity
_msg_count = _mod._msg_count
_open = _mod._open
apply = _mod.apply
checkpoint = _mod.checkpoint
dry_run = _mod.dry_run

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
NOW = time.time()
DAY = 86400


def _make_db(path: Path, with_fts_triggers: bool = False) -> None:
    """Create a minimal schema matching the Hermes session store."""
    con = sqlite3.connect(str(path))
    con.executescript(
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT,
            started_at REAL,
            ended_at REAL
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY,
            session_id TEXT REFERENCES sessions(id),
            timestamp REAL,
            content TEXT
        );
        CREATE VIRTUAL TABLE messages_fts USING fts5(
            content,
            content='messages',
            content_rowid='id',
            tokenize='trigram'
        );
        CREATE TABLE compression_locks (
            id INTEGER PRIMARY KEY,
            session_id TEXT,
            released_at REAL
        );
        CREATE TABLE async_delegations (id INTEGER PRIMARY KEY);
        CREATE TABLE delivery_obligations (id INTEGER PRIMARY KEY);
        CREATE TABLE gateway_routing (id INTEGER PRIMARY KEY);
        CREATE TABLE session_model_usage (id INTEGER PRIMARY KEY);
        CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
        CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
        """
    )
    if with_fts_triggers:
        con.executescript(
            """
            CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
                DELETE FROM messages_fts WHERE rowid = old.id;
            END;
            """
        )
    con.commit()
    con.close()


def _insert_session(con, sid, started_offset_days, ended=True, locked=False):
    """Insert a session and optionally a compression lock."""
    started_at = NOW - started_offset_days * DAY
    ended_at = NOW - (started_offset_days - 1) * DAY if ended else None
    con.execute(
        "INSERT INTO sessions (id, source, started_at, ended_at) VALUES (?,?,?,?)",
        (sid, "test", started_at, ended_at),
    )
    con.execute(
        "INSERT INTO messages (session_id, timestamp, content) VALUES (?,?,?)",
        (sid, started_at + 60, f"message for {sid}"),
    )
    if locked:
        con.execute(
            "INSERT INTO compression_locks (session_id, released_at) VALUES (?,?)",
            (sid, None),
        )
    con.commit()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
class TestEligibilityWindows(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "state.db"
        _make_db(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def test_old_session_eligible(self):
        con = sqlite3.connect(str(self.db))
        con.row_factory = sqlite3.Row
        _insert_session(con, "old-1", started_offset_days=40)
        cut = _cutoff(30)
        ids = _eligible(con, cut)
        self.assertIn("old-1", ids)
        con.close()

    def test_recent_session_not_eligible(self):
        con = sqlite3.connect(str(self.db))
        con.row_factory = sqlite3.Row
        _insert_session(con, "new-1", started_offset_days=5)
        cut = _cutoff(30)
        ids = _eligible(con, cut)
        self.assertNotIn("new-1", ids)
        con.close()

    def test_open_session_excluded(self):
        """Sessions with ended_at IS NULL must never be pruned."""
        con = sqlite3.connect(str(self.db))
        con.row_factory = sqlite3.Row
        _insert_session(con, "live-1", started_offset_days=60, ended=False)
        cut = _cutoff(30)
        ids = _eligible(con, cut)
        self.assertNotIn("live-1", ids, "live session leaked through liveness predicate")
        con.close()

    def test_compression_locked_excluded(self):
        """Sessions held by an active compression_lock must be protected."""
        con = sqlite3.connect(str(self.db))
        con.row_factory = sqlite3.Row
        _insert_session(con, "locked-1", started_offset_days=50, locked=True)
        cut = _cutoff(30)
        ids = _eligible(con, cut)
        self.assertNotIn("locked-1", ids, "compression-locked session leaked through")
        con.close()

    def test_released_lock_is_eligible(self):
        """A session whose lock has been released is eligible."""
        con = sqlite3.connect(str(self.db))
        con.row_factory = sqlite3.Row
        _insert_session(con, "unlocked-1", started_offset_days=50, locked=True)
        # Release the lock
        con.execute("UPDATE compression_locks SET released_at=? WHERE session_id=?", (NOW - 100, "unlocked-1"))
        con.commit()
        cut = _cutoff(30)
        ids = _eligible(con, cut)
        self.assertIn("unlocked-1", ids)
        con.close()


class TestDryRunNoMutation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db_path = Path(self.tmp.name) / "state.db"
        _make_db(db_path)
        con = sqlite3.connect(str(db_path))
        con.row_factory = sqlite3.Row
        _insert_session(con, "prune-me", started_offset_days=60)
        _insert_session(con, "keep-me", started_offset_days=5)
        con.close()
        # Rebuild in the profile structure dry_run expects
        profile_dir = Path(self.tmp.name) / "profiles" / "workers"
        profile_dir.mkdir(parents=True)
        db_path.rename(profile_dir / "state.db")
        self.profile_dir = profile_dir
        self.db = profile_dir / "state.db"

    def tearDown(self):
        self.tmp.cleanup()

    def test_dry_run_reports_eligible(self):
        result = dry_run(self.db, "workers", 30)
        self.assertNotIn("error", result)
        self.assertEqual(result["eligible_sessions"], 1)
        self.assertGreater(result["eligible_messages"], 0)

    def test_dry_run_does_not_mutate(self):
        dry_run(self.db, "workers", 30)
        con = sqlite3.connect(str(self.db))
        count = con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        con.close()
        self.assertEqual(count, 2, "dry_run must not delete any sessions")


class TestBatchedApply(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "state.db"
        _make_db(self.db)
        con = sqlite3.connect(str(self.db))
        con.row_factory = sqlite3.Row
        for i in range(15):
            _insert_session(con, f"old-{i}", started_offset_days=40 + i)
        _insert_session(con, "keep-1", started_offset_days=5)
        con.close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_apply_deletes_eligible_only(self):
        result = apply(self.db, "workers", 30, verbose=False)
        self.assertNotIn("error", result)
        self.assertEqual(result["deleted_sessions"], 15)
        con = sqlite3.connect(str(self.db))
        remaining = con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        con.close()
        self.assertEqual(remaining, 1)  # "keep-1" survives

    def test_apply_is_idempotent(self):
        """Re-running after full deletion returns 0 further deletes."""
        apply(self.db, "workers", 30, verbose=False)
        r2 = apply(self.db, "workers", 30, verbose=False)
        self.assertEqual(r2["deleted_sessions"], 0)

    def test_apply_preserves_young_sessions(self):
        apply(self.db, "workers", 30, verbose=False)
        con = sqlite3.connect(str(self.db))
        row = con.execute("SELECT id FROM sessions WHERE id='keep-1'").fetchone()
        con.close()
        self.assertIsNotNone(row, "session within window must not be deleted")


class TestFtsCleanup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_detects_trigger_absence(self):
        db = Path(self.tmp.name) / "no_trigger.db"
        _make_db(db, with_fts_triggers=False)
        con = _open(db, readonly=True)
        self.assertFalse(_has_fts_triggers(con))
        con.close()

    def test_detects_trigger_presence(self):
        db = Path(self.tmp.name) / "with_trigger.db"
        _make_db(db, with_fts_triggers=True)
        con = _open(db, readonly=True)
        self.assertTrue(_has_fts_triggers(con))
        con.close()

    def test_detects_content_table(self):
        """The schema uses content='messages' — must be detected as a content FTS table."""
        db = Path(self.tmp.name) / "content.db"
        _make_db(db, with_fts_triggers=False)
        con = _open(db, readonly=False)
        self.assertTrue(_fts_is_content_table(con), "messages_fts is a content table and must be detected as such")
        con.close()

    def test_content_table_fts_rebuilt_after_deletion(self):
        """For content table FTS without triggers, apply() rebuilds the index (not raw DELETE).

        After deletion, messages_fts count() should return 0 because the index
        is rebuilt from the now-empty messages table.  Querying COUNT(*) on a
        content FTS table returns the count of indexed terms, not rows, but
        a full rebuild of an empty source gives 0 results.
        """
        db = Path(self.tmp.name) / "rebuild.db"
        _make_db(db, with_fts_triggers=False)
        con = sqlite3.connect(str(db))
        con.row_factory = sqlite3.Row
        _insert_session(con, "fts-session", started_offset_days=50)
        # Populate FTS via rebuild before test so the index has content
        con.execute("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')")
        con.commit()
        con.close()
        apply(db, "workers", 30, verbose=False)
        # After deletion + rebuild, messages table is empty
        con2 = sqlite3.connect(str(db))
        msg_count = con2.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        # FTS5 content table count() reflects the underlying messages table after rebuild
        fts_count = con2.execute("SELECT COUNT(*) FROM messages_fts").fetchone()[0]
        con2.close()
        self.assertEqual(msg_count, 0, "messages must be deleted")
        self.assertEqual(fts_count, 0, "FTS index must reflect empty messages table after rebuild")


class TestIntegrityGuard(unittest.TestCase):
    def test_integrity_ok_on_fresh_db(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "fresh.db"
            _make_db(db)
            con = _open(db, readonly=True)
            self.assertTrue(_integrity(con))
            con.close()

    def test_missing_db_reported(self):
        result = dry_run(Path("/nonexistent/path/state.db"), "test", 30)
        self.assertIn("error", result)


class TestDefaultWindows(unittest.TestCase):
    def test_workers_window_is_aggressive(self):
        self.assertLessEqual(PROFILE_RETENTION["workers"], 30, "workers must use a short window")

    def test_main_window_is_conservative(self):
        self.assertGreaterEqual(PROFILE_RETENTION["main"], 60, "main must use a long window")

    def test_heavy_window_is_conservative(self):
        self.assertGreaterEqual(PROFILE_RETENTION["heavy"], 60, "heavy must use a long window")


if __name__ == "__main__":
    unittest.main(verbosity=2)
