#!/usr/bin/env python3
"""Fixture tests for hermes-session-retention.py  refs #430

Load-bearing cases: eligibility window, liveness exclusion,
batch/resume, dry-run-mutates-nothing, trigger-maintained FTS.

Run: python3 scripts/test_hermes_session_retention.py
"""
import importlib.util
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

_mod = importlib.util.module_from_spec(
    s := importlib.util.spec_from_file_location("_hsr", Path(__file__).parent / "hermes-session-retention.py")
)
s.loader.exec_module(_mod)  # type: ignore[union-attr]
PROFILE_RETENTION = _mod.PROFILE_RETENTION
_cutoff = _mod._cutoff; _eligible = _mod._eligible; _has_fts_triggers = _mod._has_fts_triggers
_open = _mod._open; apply = _mod.apply; dry_run = _mod.dry_run
checkpoint = _mod.checkpoint; vacuum_db = _mod.vacuum_db

NOW = time.time(); DAY = 86400


def _make_db(path: Path, triggers: bool = True) -> None:
    """Real Hermes DDL — verbatim schema.

    compression_locks uses expires_at (NOT released_at).
    messages_fts is plain fts5(content) — 'content' is a column name,
    not the content='tablename' external-content option.
    """
    con = sqlite3.connect(str(path))
    con.executescript("""
CREATE TABLE sessions(id TEXT PRIMARY KEY, source TEXT, started_at REAL, ended_at REAL);
CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT REFERENCES sessions(id), timestamp REAL, content TEXT);
CREATE VIRTUAL TABLE messages_fts USING fts5(content);
CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(content, tokenize='trigram');
CREATE TABLE compression_locks(session_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL NOT NULL, expires_at REAL NOT NULL);
CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
    """)
    if triggers:
        con.executescript("""
CREATE TRIGGER messages_fts_insert    AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid,content) VALUES(new.id,new.content); END;
CREATE TRIGGER messages_fts_delete    AFTER DELETE ON messages BEGIN DELETE FROM messages_fts WHERE rowid=old.id; END;
CREATE TRIGGER messages_fts_update    AFTER UPDATE ON messages BEGIN DELETE FROM messages_fts WHERE rowid=old.id; INSERT INTO messages_fts(rowid,content) VALUES(new.id,new.content); END;
CREATE TRIGGER messages_fts_trigram_insert AFTER INSERT ON messages BEGIN INSERT INTO messages_fts_trigram(rowid,content) VALUES(new.id,new.content); END;
CREATE TRIGGER messages_fts_trigram_delete AFTER DELETE ON messages BEGIN DELETE FROM messages_fts_trigram WHERE rowid=old.id; END;
CREATE TRIGGER messages_fts_trigram_update AFTER UPDATE ON messages BEGIN DELETE FROM messages_fts_trigram WHERE rowid=old.id; INSERT INTO messages_fts_trigram(rowid,content) VALUES(new.id,new.content); END;
        """)
    con.commit(); con.close()


def _ins(con, sid, days_old, ended=True, lock_offset=None):
    """Insert a session. lock_offset>0=live lock, <0=expired lock, None=no lock."""
    t = NOW - days_old * DAY
    con.execute("INSERT INTO sessions VALUES(?,?,?,?)", (sid, "t", t, t + DAY if ended else None))
    con.execute("INSERT INTO messages(session_id,timestamp,content) VALUES(?,?,?)", (sid, t + 60, f"m:{sid}"))
    if lock_offset is not None:
        con.execute("INSERT INTO compression_locks VALUES(?,?,?,?)", (sid, "w", t, NOW + lock_offset))
    con.commit()


class TestEligibility(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "state.db"
        _make_db(self.db)

    def tearDown(self): self.tmp.cleanup()

    def _eligible_ids(self, days=30):
        con = sqlite3.connect(str(self.db)); con.row_factory = sqlite3.Row
        ids = _eligible(con, _cutoff(days)); con.close(); return ids

    def test_old_session_eligible(self):
        con = sqlite3.connect(str(self.db)); con.row_factory = sqlite3.Row
        _ins(con, "old", 40); con.close()
        self.assertIn("old", self._eligible_ids())

    def test_recent_excluded(self):
        con = sqlite3.connect(str(self.db)); con.row_factory = sqlite3.Row
        _ins(con, "new", 5); con.close()
        self.assertNotIn("new", self._eligible_ids())

    def test_open_session_excluded(self):
        """ended_at IS NULL — must never be pruned."""
        con = sqlite3.connect(str(self.db)); con.row_factory = sqlite3.Row
        _ins(con, "live", 60, ended=False); con.close()
        self.assertNotIn("live", self._eligible_ids(), "open session leaked through liveness predicate")

    def test_live_lock_excluded(self):
        """expires_at > now — lock held.  NO released_at column in the real schema."""
        con = sqlite3.connect(str(self.db)); con.row_factory = sqlite3.Row
        _ins(con, "locked", 50, lock_offset=+3600); con.close()
        self.assertNotIn("locked", self._eligible_ids(), "live-lock session leaked through")

    def test_expired_lock_eligible(self):
        """expires_at < now — lock expired; session is eligible."""
        con = sqlite3.connect(str(self.db)); con.row_factory = sqlite3.Row
        _ins(con, "expired", 50, lock_offset=-3600); con.close()
        self.assertIn("expired", self._eligible_ids())


class TestDryRun(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        pd = Path(self.tmp.name) / "profiles" / "workers"; pd.mkdir(parents=True)
        self.db = pd / "state.db"; _make_db(self.db)
        con = sqlite3.connect(str(self.db)); con.row_factory = sqlite3.Row
        _ins(con, "prune", 60); _ins(con, "keep", 5); con.close()

    def tearDown(self): self.tmp.cleanup()

    def test_reports_eligible(self):
        r = dry_run(self.db, "workers", 30)
        self.assertNotIn("error", r); self.assertEqual(r["eligible_sessions"], 1)

    def test_does_not_mutate(self):
        dry_run(self.db, "workers", 30)
        n = sqlite3.connect(str(self.db)).execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        self.assertEqual(n, 2, "dry_run must not delete any sessions")

    def test_missing_db_reports_error(self):
        self.assertIn("error", dry_run(Path("/nonexistent/state.db"), "t", 30))


class TestApply(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "state.db"; _make_db(self.db)
        con = sqlite3.connect(str(self.db)); con.row_factory = sqlite3.Row
        for i in range(15): _ins(con, f"old-{i}", 40 + i)
        _ins(con, "keep", 5); con.close()

    def tearDown(self): self.tmp.cleanup()

    def test_deletes_eligible_only(self):
        r = apply(self.db, "workers", 30, verbose=False)
        self.assertEqual(r["deleted_sessions"], 15)
        self.assertEqual(sqlite3.connect(str(self.db)).execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 1)

    def test_idempotent(self):
        apply(self.db, "workers", 30, verbose=False)
        self.assertEqual(apply(self.db, "workers", 30, verbose=False)["deleted_sessions"], 0)

    def test_preserves_young_sessions(self):
        apply(self.db, "workers", 30, verbose=False)
        self.assertIsNotNone(sqlite3.connect(str(self.db)).execute("SELECT id FROM sessions WHERE id='keep'").fetchone())


class TestFts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self): self.tmp.cleanup()

    def test_trigger_detection(self):
        db = Path(self.tmp.name) / "t.db"; _make_db(db, triggers=True)
        con = _open(db, readonly=True); self.assertTrue(_has_fts_triggers(con)); con.close()
        db2 = Path(self.tmp.name) / "n.db"; _make_db(db2, triggers=False)
        con2 = _open(db2, readonly=True); self.assertFalse(_has_fts_triggers(con2)); con2.close()

    def test_triggers_maintain_fts_without_script_intervention(self):
        """apply() deletes from messages; triggers cascade to both FTS indexes. No extra step needed."""
        db = Path(self.tmp.name) / "fts.db"; _make_db(db, triggers=True)
        con = sqlite3.connect(str(db)); con.row_factory = sqlite3.Row
        _ins(con, "s1", 50)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM messages_fts").fetchone()[0], 1,
                         "insert trigger must have populated messages_fts")
        con.close()
        apply(db, "workers", 30, verbose=False)
        con2 = sqlite3.connect(str(db))
        self.assertEqual(con2.execute("SELECT COUNT(*) FROM messages").fetchone()[0], 0)
        self.assertEqual(con2.execute("SELECT COUNT(*) FROM messages_fts").fetchone()[0], 0,
                         "delete trigger must have cleared messages_fts")
        self.assertEqual(con2.execute("SELECT COUNT(*) FROM messages_fts_trigram").fetchone()[0], 0)
        con2.close()


class TestCheckpoint(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "state.db"; _make_db(self.db)

    def tearDown(self): self.tmp.cleanup()

    def test_checkpoint_returns_stats(self):
        """Checkpoint on a newly created WAL db returns log_pages and is not busy."""
        r = checkpoint(self.db, verbose=False)
        self.assertNotIn("error", r, r)
        self.assertIn("log_pages", r)
        self.assertIn("ckpt_pages", r)

    def test_checkpoint_missing_db(self):
        r = checkpoint(Path("/nonexistent/state.db"), verbose=False)
        self.assertIn("error", r)


class TestVacuum(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "state.db"; _make_db(self.db)
        con = sqlite3.connect(str(self.db)); con.row_factory = sqlite3.Row
        for i in range(5): _ins(con, f"s{i}", 10 + i)
        con.close()

    def tearDown(self): self.tmp.cleanup()

    def test_vacuum_ok(self):
        r = vacuum_db(self.db, verbose=False)
        self.assertNotIn("error", r, r)
        self.assertIn("bytes_before", r)
        self.assertIn("bytes_after", r)

    def test_vacuum_insufficient_disk_aborts(self):
        """_free_override=0 simulates a full disk; tool must refuse, not fill disk."""
        r = vacuum_db(self.db, verbose=False, _free_override=0)
        self.assertIn("error", r)
        self.assertIn("need", r["error"])
        self.assertIn("db_bytes", r)

    def test_vacuum_missing_db(self):
        r = vacuum_db(Path("/nonexistent/state.db"), verbose=False)
        self.assertIn("error", r)


class TestLargeIdList(unittest.TestCase):
    """Defect 1 regression: _msg_count() built one SQL placeholder per session id.
    On stores with >32 k eligible sessions this exceeded SQLite_MAX_VARIABLE_NUMBER
    (32766 on modern builds) and hung indefinitely.  dry_run must return correct
    counts using predicate-based queries that do NOT scale with id count."""

    N_OLD = 35_000  # deliberately > SQLITE_MAX_VARIABLE_NUMBER

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        pd = Path(self.tmp.name) / "profiles" / "workers"
        pd.mkdir(parents=True)
        self.db = pd / "state.db"
        _make_db(self.db)
        t_old = NOW - 40 * DAY
        con = sqlite3.connect(str(self.db))
        # executemany is faster than N individual _ins() calls (no per-row commit)
        con.executemany(
            "INSERT INTO sessions VALUES(?,?,?,?)",
            [(f"s{i}", "t", t_old, t_old + DAY) for i in range(self.N_OLD)],
        )
        con.executemany(
            "INSERT INTO messages(session_id,timestamp,content) VALUES(?,?,?)",
            [(f"s{i}", t_old + 60, f"m{i}") for i in range(self.N_OLD)],
        )
        # One session inside the window — must not be counted as eligible
        t_new = NOW - 5 * DAY
        con.execute("INSERT INTO sessions VALUES(?,?,?,?)", ("keep", "t", t_new, t_new + DAY))
        con.execute("INSERT INTO messages(session_id,timestamp,content) VALUES(?,?,?)",
                    ("keep", t_new + 60, "keep-msg"))
        con.commit(); con.close()

    def tearDown(self): self.tmp.cleanup()

    def test_dry_run_completes_and_counts_correctly(self):
        """Must return exact counts without building a >32k-placeholder SQL statement.
        If the old _msg_count() approach is used, this call hangs; the predicate
        JOIN returns in milliseconds."""
        r = dry_run(self.db, "workers", 30)
        self.assertNotIn("error", r, r)
        self.assertEqual(r["eligible_sessions"], self.N_OLD,
                         f"expected {self.N_OLD} eligible sessions; got {r['eligible_sessions']}")
        self.assertEqual(r["eligible_messages"], self.N_OLD,
                         f"expected {self.N_OLD} eligible messages; got {r['eligible_messages']}")


class TestDeletedCountAccuracy(unittest.TestCase):
    """Defect 2 regression: con.total_changes is cumulative for the entire connection
    lifetime, not per-statement.  Summing it once per batch produces quadratically
    inflated deleted_messages across batches.  Counters must equal rows actually removed."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "state.db"
        _make_db(self.db)
        con = sqlite3.connect(str(self.db)); con.row_factory = sqlite3.Row
        # 12 old sessions (forces 3 batches at BATCH_SIZE=5), each with 1 message
        for i in range(12):
            _ins(con, f"old-{i}", 40 + i)
        _ins(con, "keep", 5)
        con.close()

    def tearDown(self): self.tmp.cleanup()

    def test_deleted_counts_are_exact(self):
        """deleted_sessions and deleted_messages must equal actual rows removed."""
        orig_batch = _mod.BATCH_SIZE
        _mod.BATCH_SIZE = 5  # forces 3 batches (5+5+2); old total_changes bug triples the count
        try:
            r = apply(self.db, "workers", 30, verbose=False)
        finally:
            _mod.BATCH_SIZE = orig_batch
        self.assertNotIn("error", r, r)
        self.assertEqual(r["deleted_sessions"], 12,
                         "deleted_sessions must equal sessions actually removed")
        self.assertEqual(r["deleted_messages"], 12,
                         "deleted_messages wrong — likely total_changes accumulation bug "
                         "(each batch adds the cumulative total, not the per-statement rowcount)")


class TestCheckpointStandalone(unittest.TestCase):
    """Defect 3 regression: --checkpoint was inside the per-profile loop that always
    ran dry_run() first, so a checkpoint-only invocation paid the full (hanging) scan
    cost before checkpointing anything.  Without --apply, checkpoint/vacuum must skip
    the eligibility scan entirely."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.profiles = Path(self.tmp.name) / "profiles"
        for p in ("workers", "main", "heavy"):
            d = self.profiles / p; d.mkdir(parents=True)
            _make_db(d / "state.db")

    def tearDown(self): self.tmp.cleanup()

    def test_checkpoint_standalone_skips_eligibility(self):
        """main(--checkpoint) without --apply must not invoke _eligible() at all."""
        import sys, io, contextlib
        calls = []
        orig = _mod._eligible
        _mod._eligible = lambda *a, **kw: calls.append("_eligible") or orig(*a, **kw)
        orig_argv = sys.argv
        sys.argv = ["prog", "--hermes-home", str(self.tmp.name), "--checkpoint"]
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                _mod.main()
        except SystemExit:
            pass
        finally:
            sys.argv = orig_argv
            _mod._eligible = orig
        self.assertEqual(calls, [],
            "--checkpoint without --apply must not call _eligible(); "
            "the eligibility scan should be skipped entirely")


if __name__ == "__main__":
    unittest.main(verbosity=2)
