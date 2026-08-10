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


def _make_db(path: Path, with_fts_triggers: bool = True) -> None:
    """Create a schema from the real Hermes session-store DDL.

    compression_locks uses expiry semantics (expires_at REAL NOT NULL),
    not released_at.  messages_fts is a plain FTS5 table — not a content
    table — with one column named `content`.  The live store has six
    triggers; with_fts_triggers=True (the default) installs them so that
    DELETE on `messages` cascades to both FTS indexes automatically.
    with_fts_triggers=False lets tests exercise the explicit-FTS-delete path.
    """
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
        -- Plain FTS5: one column named 'content'.  NOT a content= table.
        -- The column name and the content= option look similar but are different things.
        CREATE VIRTUAL TABLE messages_fts USING fts5(content);
        CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(content, tokenize='trigram');
        -- Real compression_locks schema: expiry-time semantics, no released_at column.
        CREATE TABLE compression_locks (
            session_id  TEXT PRIMARY KEY,
            holder      TEXT NOT NULL,
            acquired_at REAL NOT NULL,
            expires_at  REAL NOT NULL
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
        # Six triggers matching the live store: three for messages_fts,
        # three for messages_fts_trigram.
        con.executescript(
            """
            CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
            END;
            CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
                DELETE FROM messages_fts WHERE rowid = old.id;
            END;
            CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
                DELETE FROM messages_fts WHERE rowid = old.id;
                INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
            END;
            CREATE TRIGGER messages_fts_trigram_insert AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts_trigram(rowid, content) VALUES (new.id, new.content);
            END;
            CREATE TRIGGER messages_fts_trigram_delete AFTER DELETE ON messages BEGIN
                DELETE FROM messages_fts_trigram WHERE rowid = old.id;
            END;
            CREATE TRIGGER messages_fts_trigram_update AFTER UPDATE ON messages BEGIN
                DELETE FROM messages_fts_trigram WHERE rowid = old.id;
                INSERT INTO messages_fts_trigram(rowid, content) VALUES (new.id, new.content);
            END;
            """
        )
    con.commit()
    con.close()


def _insert_session(con, sid, started_offset_days, ended=True, locked=False, lock_expired=False):
    """Insert a session and optionally a compression lock.

    locked=True inserts a lock with expires_at in the future (still held).
    lock_expired=True inserts a lock whose expires_at is in the past (released).
    The real compression_locks schema has no released_at column.
    """
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
    if locked or lock_expired:
        expires_at = NOW + 3600 if locked else NOW - 3600  # future = held, past = expired
        con.execute(
            "INSERT INTO compression_locks (session_id, holder, acquired_at, expires_at) "
            "VALUES (?,?,?,?)",
            (sid, "test-worker", started_at, expires_at),
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
        """Sessions with a live (non-expired) compression lock must be protected.

        The real compression_locks schema: session_id, holder, acquired_at,
        expires_at (REAL unix timestamp).  A lock is held while expires_at > now.
        There is no released_at column.
        """
        con = sqlite3.connect(str(self.db))
        con.row_factory = sqlite3.Row
        _insert_session(con, "locked-1", started_offset_days=50, locked=True)
        cut = _cutoff(30)
        ids = _eligible(con, cut)
        self.assertNotIn("locked-1", ids, "compression-locked session leaked through")
        con.close()

    def test_expired_lock_is_eligible(self):
        """A session whose lock has expired (expires_at < now) is eligible for deletion.

        'Released' is expressed as an already-passed expires_at, not a released_at column.
        """
        con = sqlite3.connect(str(self.db))
        con.row_factory = sqlite3.Row
        _insert_session(con, "unlocked-1", started_offset_days=50, lock_expired=True)
        cut = _cutoff(30)
        ids = _eligible(con, cut)
        self.assertIn("unlocked-1", ids, "session with expired lock must be eligible")
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
    """Tests for FTS5 maintenance during session deletion.

    The real messages_fts schema is a PLAIN FTS5 table — USING fts5(content) —
    where 'content' is a column name, NOT the content= external-content option.
    Six triggers maintain both messages_fts and messages_fts_trigram automatically.

    This is the important distinction: a column named 'content' in a plain FTS5
    table is completely different from the content='tablename' external-content
    option.  We burned a PR review cycle confusing these two things.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_plain_fts_not_content_table(self):
        """The real messages_fts DDL has no content= option; it must NOT be treated as a content table.

        USING fts5(content) — 'content' here is a column name.
        USING fts5(..., content='messages') — this is the content= option that designates an external table.
        They look similar; they are entirely different.
        """
        db = Path(self.tmp.name) / "plain.db"
        _make_db(db, with_fts_triggers=True)
        con = _open(db, readonly=False)
        # The real DDL has NO content= option; DDL parsing must not match
        row = con.execute("SELECT sql FROM sqlite_master WHERE name='messages_fts'").fetchone()
        ddl = row[0].lower() if row else ""
        # 'content' appears as a column name, but NOT as content=<tablename>
        self.assertNotIn("content='", ddl, "messages_fts must not use the external-content option")
        self.assertNotIn('content="', ddl, "messages_fts must not use the external-content option")
        con.close()

    def test_detects_trigger_presence(self):
        """Real store has six FTS triggers; _has_fts_triggers must return True."""
        db = Path(self.tmp.name) / "with_trigger.db"
        _make_db(db, with_fts_triggers=True)
        con = _open(db, readonly=True)
        self.assertTrue(_has_fts_triggers(con))
        con.close()

    def test_detects_trigger_absence(self):
        """Without triggers, _has_fts_triggers must return False."""
        db = Path(self.tmp.name) / "no_trigger.db"
        _make_db(db, with_fts_triggers=False)
        con = _open(db, readonly=True)
        self.assertFalse(_has_fts_triggers(con))
        con.close()

    def test_triggers_maintain_fts_without_explicit_delete(self):
        """With triggers, deleting from messages automatically removes FTS rows.

        apply() must NOT call any explicit FTS delete or 'rebuild' — the
        triggers handle it.  This test proves the FTS count drops to zero
        after apply() on a trigger-maintained schema, with no extra cleanup.
        """
        db = Path(self.tmp.name) / "trigger_maintained.db"
        _make_db(db, with_fts_triggers=True)
        con = sqlite3.connect(str(db))
        con.row_factory = sqlite3.Row
        _insert_session(con, "fts-old", started_offset_days=50)
        # Insert row is handled by the insert trigger; verify FTS has a row
        fts_before = con.execute("SELECT COUNT(*) FROM messages_fts").fetchone()[0]
        con.close()
        self.assertEqual(fts_before, 1, "FTS must have a row before deletion (trigger inserted it)")

        apply(db, "workers", 30, verbose=False)

        con2 = sqlite3.connect(str(db))
        msg_count = con2.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        fts_after = con2.execute("SELECT COUNT(*) FROM messages_fts").fetchone()[0]
        trigram_after = con2.execute("SELECT COUNT(*) FROM messages_fts_trigram").fetchone()[0]
        con2.close()
        self.assertEqual(msg_count, 0, "messages must be deleted")
        self.assertEqual(fts_after, 0, "messages_fts must be empty after deletion (trigger cascade)")
        self.assertEqual(trigram_after, 0, "messages_fts_trigram must be empty after deletion (trigger cascade)")

    def test_no_trigger_explicit_fts_delete(self):
        """Without triggers, apply() deletes from messages_fts explicitly by rowid.

        This tests the fallback path.  On the live store it does not run
        (triggers exist), but the code must not silently leave FTS orphans.
        """
        db = Path(self.tmp.name) / "no_trigger.db"
        _make_db(db, with_fts_triggers=False)
        con = sqlite3.connect(str(db))
        con.row_factory = sqlite3.Row
        _insert_session(con, "fts-old", started_offset_days=50)
        # Manually insert the FTS row (no trigger to do it)
        msg_id = con.execute("SELECT id FROM messages WHERE session_id='fts-old'").fetchone()["id"]
        con.execute("INSERT INTO messages_fts(rowid, content) VALUES (?,?)", (msg_id, "fts-old content"))
        con.commit()
        con.close()

        apply(db, "workers", 30, verbose=False)

        con2 = sqlite3.connect(str(db))
        msg_count = con2.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        fts_count = con2.execute("SELECT COUNT(*) FROM messages_fts").fetchone()[0]
        con2.close()
        self.assertEqual(msg_count, 0, "messages must be deleted")
        self.assertEqual(fts_count, 0, "messages_fts must be cleaned by explicit rowid DELETE")


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
