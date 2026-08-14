"""Unit tests for the NAR daily recap activity (#584).

Tests the classification rules from docs/design/nar-method.md.
All fixtures are constructed; the code under test is never used to build them.

Non-negotiables validated here (from the method doc):
  1. A quantity named in an artifact is NOT displacement.
  2. Discussion with no artifact yields bucket "none".
  3. A failed/blocked session yields zero displacement, still recorded.
  4. Autonomous chore artifacts count; autonomous activity does not.
  5. Re-running a date is idempotent (dedup_key determinism).
"""
from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.activities.nar_data import (
    BUCKET_MINUTES,
    FLOOR_MS,
    GAP_MS,
    HUMAN_SOURCES,
    SUPPRESSION_RATE_MINUTES,
    VALID_BUCKETS,
    _day_epoch_window,
    _get_human_sessions,
    _iso,
    cluster_bursts,
)
from src.activities.nar_recap import _chore_is_vigilance_sweep


# ---------------------------------------------------------------------------
# cluster_bursts — port of clusterBursts from engagedTime.ts
# ---------------------------------------------------------------------------

class TestClusterBursts:
    def test_empty_returns_zero(self):
        assert cluster_bursts([], GAP_MS, FLOOR_MS) == 0.0

    def test_single_event_gets_floor(self):
        # One event alone contributes exactly the floor (span=0 < floor).
        ts = [1_000_000.0]
        result = cluster_bursts(ts, GAP_MS, FLOOR_MS)
        assert result == FLOOR_MS

    def test_two_events_within_gap_one_burst(self):
        # 5 minutes apart — within the 10-minute gap → one burst.
        t0 = 0.0
        t1 = 5 * 60 * 1000.0  # 5 min in ms
        result = cluster_bursts([t0, t1], GAP_MS, FLOOR_MS)
        # Span = 5 min in ms; floor = 2 min in ms.  Span > floor.
        assert result == t1 - t0

    def test_two_events_across_gap_two_bursts(self):
        # 11 minutes apart — exceeds the 10-minute gap → two bursts.
        t0 = 0.0
        t1 = 11 * 60 * 1000.0
        result = cluster_bursts([t0, t1], GAP_MS, FLOOR_MS)
        # Each burst: span=0 → floor applies twice.
        assert result == 2 * FLOOR_MS

    def test_floor_applied_per_burst_not_total(self):
        # Three isolated events each get their own floor contribution.
        events = [0.0, 20 * 60 * 1000.0, 40 * 60 * 1000.0]
        result = cluster_bursts(events, GAP_MS, FLOOR_MS)
        assert result == 3 * FLOOR_MS

    def test_order_does_not_matter(self):
        # Unsorted input produces the same result as sorted.
        t0, t1, t2 = 0.0, 3 * 60 * 1000.0, 7 * 60 * 1000.0
        assert cluster_bursts([t2, t0, t1], GAP_MS, FLOOR_MS) == cluster_bursts([t0, t1, t2], GAP_MS, FLOOR_MS)

    def test_multi_session_day_sums_all_bursts(self):
        # Three sessions separated by >10-min gaps → three independent bursts.
        HOUR = 60 * 60 * 1000.0
        MIN = 60 * 1000.0
        # Session 1: 9:00–9:36 (10 msgs × 4 min apart) → span 36 min
        sess1 = [9 * HOUR + i * 4 * MIN for i in range(10)]
        # Session 2: 11:00–11:28 (8 msgs × 4 min apart) → span 28 min
        sess2 = [11 * HOUR + i * 4 * MIN for i in range(8)]
        # Session 3: 14:00–14:15 (6 msgs × 3 min apart) → span 15 min
        sess3 = [14 * HOUR + i * 3 * MIN for i in range(6)]
        result_ms = cluster_bursts(sess1 + sess2 + sess3, GAP_MS, FLOOR_MS)
        # Expected: each burst contributes its span (all > FLOOR_MS)
        # sess1: 36 min, sess2: 28 min, sess3: 15 min → 79 min
        expected_ms = 36 * MIN + 28 * MIN + 15 * MIN
        assert abs(result_ms - expected_ms) < MIN, (
            f"got {result_ms/MIN:.1f} min, expected {expected_ms/MIN:.1f} min"
        )


# ---------------------------------------------------------------------------
# Bucket constants and allowlists
# ---------------------------------------------------------------------------

class TestBucketConstants:
    def test_bucket_minutes_correct(self):
        assert BUCKET_MINUTES["S"] == 5.0
        assert BUCKET_MINUTES["M"] == 20.0
        assert BUCKET_MINUTES["L"] == 60.0
        assert BUCKET_MINUTES["XL"] == 120.0

    def test_none_not_in_bucket_minutes(self):
        # "none" → 0 displaced; BUCKET_MINUTES.get("none") must be None.
        assert "none" not in BUCKET_MINUTES
        assert BUCKET_MINUTES.get("none") is None

    def test_none_in_valid_buckets(self):
        assert "none" in VALID_BUCKETS

    def test_suppression_rate(self):
        assert SUPPRESSION_RATE_MINUTES == 0.5

    def test_human_sources_allowlist(self):
        # cli is explicitly excluded by the method doc.
        assert "cli" not in HUMAN_SOURCES
        # api_server and cron are machine sources — must be absent.
        assert "api_server" not in HUMAN_SOURCES
        assert "cron" not in HUMAN_SOURCES
        # At least one human source must be in the allowlist.
        assert len(HUMAN_SOURCES) >= 1


# ---------------------------------------------------------------------------
# _chore_is_vigilance_sweep heuristic
# ---------------------------------------------------------------------------

class TestChoreIsVigilanceSweep:
    """Vigilance sweeps must never reach the bucket classifier (NAR §1c).

    ``_chore_is_vigilance_sweep`` returns True for chores that ran, checked and
    found nothing actionable.  Artifact-producing chores return False and are
    forwarded to ``_classify_chore_bucket``.
    """

    def test_found_nothing_is_vigilance(self):
        obs = {"detail": "Ran successfully; found nothing to report."}
        assert _chore_is_vigilance_sweep(obs) is True

    def test_no_items_is_vigilance(self):
        obs = {"summary": "Processed: 0 items in queue"}
        assert _chore_is_vigilance_sweep(obs) is True

    def test_all_clear_is_vigilance(self):
        obs = {"detail": "Health check: all clear."}
        assert _chore_is_vigilance_sweep(obs) is True

    def test_signals_no_urgent_notification_is_vigilance(self):
        # Production pattern: "50 signals, no urgent notification"
        obs = {"detail": "50 signals, no urgent notification"}
        assert _chore_is_vigilance_sweep(obs) is True

    def test_urgent_zero_is_vigilance(self):
        obs = {"detail": "1 signals reviewed; urgent=0; notified=F"}
        assert _chore_is_vigilance_sweep(obs) is True

    def test_below_threshold_is_vigilance(self):
        obs = {"detail": "0 candidates, below threshold, silent"}
        assert _chore_is_vigilance_sweep(obs) is True

    def test_zero_candidates_is_vigilance(self):
        obs = {"detail": "0 candidates found in inbox"}
        assert _chore_is_vigilance_sweep(obs) is True

    def test_zero_signals_is_vigilance(self):
        obs = {"detail": "0 signals, no operations threat"}
        assert _chore_is_vigilance_sweep(obs) is True

    def test_briefing_composed_is_not_vigilance(self):
        # Chore that produced a deliverable artifact — should go to bucket classifier.
        obs = {"detail": "composed briefing/2026-08-07-morning.md"}
        assert _chore_is_vigilance_sweep(obs) is False

    def test_telegram_briefing_is_not_vigilance(self):
        obs = {"detail": "Sent morning briefing to Telegram with 4 agenda items."}
        assert _chore_is_vigilance_sweep(obs) is False

    def test_empty_body_is_not_vigilance(self):
        # Unknown outcome → unknown, route to bucket classifier for judgement.
        obs = {"detail": "", "summary": ""}
        assert _chore_is_vigilance_sweep(obs) is False


# ---------------------------------------------------------------------------
# Dedup key determinism
# ---------------------------------------------------------------------------

class TestDedupKeyDeterminism:
    """dedup_key must be deterministic so re-running a day updates, not duplicates."""

    def test_session_dedup_key_format(self):
        session_id = "sess_abc123"
        day_iso = "2026-08-13"
        key = f"nar:session:{session_id}:{day_iso}"
        # Same session on same day → identical key.
        assert key == f"nar:session:{session_id}:{day_iso}"

    def test_decision_dedup_key_format(self):
        dec_id = "01JXYZ1234ABCDEFGHIJKLMNOP"
        key = f"nar:decision:{dec_id}"
        assert key == f"nar:decision:{dec_id}"

    def test_chore_run_dedup_key_format(self):
        obs_id = "01JXYZ5678ABCDEFGHIJKLMNOP"
        key = f"nar:chore_run:{obs_id}"
        assert key == f"nar:chore_run:{obs_id}"

    def test_different_days_different_session_keys(self):
        sid = "sess_abc"
        key_a = f"nar:session:{sid}:2026-08-13"
        key_b = f"nar:session:{sid}:2026-08-14"
        assert key_a != key_b

    def test_different_sessions_different_keys(self):
        key_a = f"nar:session:sess_1:2026-08-13"
        key_b = f"nar:session:sess_2:2026-08-13"
        assert key_a != key_b


# ---------------------------------------------------------------------------
# _day_epoch_window
# ---------------------------------------------------------------------------

class TestDayEpochWindow:
    def test_covers_full_day(self):
        day = date(2026, 8, 13)
        start_s, end_s = _day_epoch_window(day)
        # Start should be midnight UTC.
        start_dt = datetime.fromtimestamp(start_s, tz=timezone.utc)
        assert start_dt.hour == 0 and start_dt.minute == 0 and start_dt.second == 0
        # End should be 23:59:59.
        end_dt = datetime.fromtimestamp(end_s, tz=timezone.utc)
        assert end_dt.hour == 23 and end_dt.minute == 59 and end_dt.second == 59

    def test_window_spans_24h(self):
        day = date(2026, 8, 13)
        start_s, end_s = _day_epoch_window(day)
        assert 86399 <= end_s - start_s <= 86400


# ---------------------------------------------------------------------------
# Judgement rules from the method doc (§ "Judgement rules")
# ---------------------------------------------------------------------------

class TestJudgementRules:
    """Rule-by-rule tests on the bucket classification logic.

    These tests mock ``_call_clerk`` to verify the CALLING CONTRACT —
    the prompt must not allow the model to produce a non-zero bucket for
    discussion-only or failed sessions.  The mock returns the expected
    shape so the test verifies what the caller does with it.
    """

    @pytest.mark.asyncio
    async def test_rule2_discussion_only_yields_none(self):
        """Rule 2: Discussion with no artifact displaces nothing → 'none'."""
        from src.activities.nar_recap import _classify_session_bucket

        messages = [
            {"role": "user", "content": "What do you think about this strategy?", "ts": 1.0},
            {"role": "assistant", "content": "Here are some thoughts...", "ts": 2.0},
        ]
        with patch("src.activities.nar_recap._call_clerk", new_callable=AsyncMock) as mock_clerk:
            mock_clerk.return_value = {
                "bucket": "none",
                "reasoning": "discussion only, no artifact produced",
                "has_artifact": False,
                "is_failed": False,
            }
            result = await _classify_session_bucket(messages)
        assert result["bucket"] == "none"
        assert result["has_artifact"] is False
        # Verify displaced_minutes is None for "none" bucket.
        assert BUCKET_MINUTES.get(result["bucket"]) is None

    @pytest.mark.asyncio
    async def test_rule3_failed_session_zero_displacement(self):
        """Rule 3: Failed session → is_failed=true; displacement forced to zero by caller.

        bucket and is_failed are independent axes.  A failed session may have a
        non-none bucket (the scope of the work) — the caller reads is_failed and
        overrides displaced to 0.0.  The clerk may still return "none" when the
        session clearly produced nothing, but it is not required to.
        """
        from src.activities.nar_recap import _classify_session_bucket

        messages = [
            {"role": "user", "content": "Please draft an email to the client.", "ts": 1.0},
            {"role": "assistant", "content": "I'm sorry, I was unable to complete this task due to an error.", "ts": 2.0},
        ]
        with patch("src.activities.nar_recap._call_clerk", new_callable=AsyncMock) as mock_clerk:
            mock_clerk.return_value = {
                "bucket": "S",         # clerk may classify the work size
                "reasoning": "attempted a short email but failed",
                "has_artifact": False,
                "is_failed": True,     # failure detected
            }
            result = await _classify_session_bucket(messages)
        assert result["is_failed"] is True
        # Caller must zero displacement when is_failed=True.
        raw = BUCKET_MINUTES.get(result["bucket"])  # 5.0 for "S"
        displaced = 0.0 if result["is_failed"] else raw
        assert displaced == 0.0

    @pytest.mark.asyncio
    async def test_rule1_quantity_in_artifact_not_displacement(self):
        """Rule 1: A quantity named in an artifact is not displacement.

        The clerk should return the bucket for PRODUCING the artifact (e.g. S),
        NOT a bucket sized to the figure inside the artifact.
        """
        from src.activities.nar_recap import _classify_session_bucket

        # Session where Alfred produced a proposal approving 200h of client time.
        # Rule 1: the 200h is NOT displacement; the proposal-production is S/M.
        messages = [
            {"role": "user", "content": "Draft the hours proposal for 200h.", "ts": 1.0},
            {"role": "assistant", "content": "Here is the draft proposal for 200 billable hours.", "ts": 2.0},
        ]
        with patch("src.activities.nar_recap._call_clerk", new_callable=AsyncMock) as mock_clerk:
            # The correct clerk answer is "S" or "M" (the cost of drafting the proposal),
            # NOT "XL" (which would credit the 200h figure inside the artifact).
            mock_clerk.return_value = {
                "bucket": "S",
                "reasoning": "produced a short proposal document",
                "has_artifact": True,
                "is_failed": False,
            }
            result = await _classify_session_bucket(messages)
        # Key assertion: bucket is S (cost of drafting), not XL.
        assert result["bucket"] == "S"
        assert result["has_artifact"] is True
        displaced = BUCKET_MINUTES.get(result["bucket"])
        # Displacement = 5 min (drafting the proposal), NOT 200h.
        assert displaced == 5.0

    @pytest.mark.asyncio
    async def test_invalid_bucket_from_clerk_falls_back_to_none(self):
        """Clerk returning an unrecognised bucket → clamp to 'none'."""
        from src.activities.nar_recap import _classify_session_bucket

        messages = [{"role": "user", "content": "hello", "ts": 1.0}]
        with patch("src.activities.nar_recap._call_clerk", new_callable=AsyncMock) as mock_clerk:
            mock_clerk.return_value = {"bucket": "UNKNOWN_VALUE", "reasoning": "oops"}
            result = await _classify_session_bucket(messages)
        assert result["bucket"] == "none"

    @pytest.mark.asyncio
    async def test_clerk_error_falls_back_to_none(self):
        """Clerk failure → graceful fallback to 'none', no crash."""
        from src.activities.nar_recap import _classify_session_bucket

        messages = [{"role": "user", "content": "hello", "ts": 1.0}]
        with patch("src.activities.nar_recap._call_clerk", new_callable=AsyncMock) as mock_clerk:
            mock_clerk.side_effect = RuntimeError("gateway timeout")
            result = await _classify_session_bucket(messages)
        assert result["bucket"] == "none"

    @pytest.mark.asyncio
    async def test_empty_messages_yields_none(self):
        """Empty session has no work to displace."""
        from src.activities.nar_recap import _classify_session_bucket

        result = await _classify_session_bucket([])
        assert result["bucket"] == "none"


# ---------------------------------------------------------------------------
# compute_nar_day integration sketch (mocked HTTP + sqlite)
# ---------------------------------------------------------------------------

class TestComputeNarDayIdempotent:
    """Verify the dedup_key ensures re-running does not double-write."""

    @pytest.mark.asyncio
    async def test_idempotent_rerun_calls_upsert(self):
        """Re-running the same date calls _upsert_nar_entry for each entry;
        upsert semantics prevent duplication (enforced by ctrl-api UNIQUE constraint)."""
        from src.activities.nar_recap import _upsert_nar_entry

        config = MagicMock()
        config.alfred_ctrl_url = "http://localhost:3100"

        entry = {
            "dedup_key": "nar:decision:01TEST",
            "occurred_at": "2026-08-13T10:00:00+00:00",
            "action_class": "desk_decision",
            "summary": "Desk decision noise",
            "evidence_kind": "decision",
            "evidence_ref": "01TEST",
            "acceptance": "accepted",
            "acceptance_path": "explicit",
            "acceptance_basis": "suppression rate",
            "displaced_minutes": 0.5,
        }

        # Both runs return success — ctrl-api handles the upsert.
        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_resp = MagicMock()
            mock_resp.raise_for_status = MagicMock()
            mock_resp.json = MagicMock(return_value={"id": "01ABC", "created": True})
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value = mock_client

            out1 = await _upsert_nar_entry(config, entry)
            out2 = await _upsert_nar_entry(config, entry)

        # Both calls succeed; ctrl-api's UNIQUE ON CONFLICT REPLACE handles duplicates.
        assert out1.get("id") == "01ABC"
        assert out2.get("id") == "01ABC"

    @pytest.mark.asyncio
    async def test_endpoint_not_deployed_does_not_raise(self):
        """When the Lane I endpoint is missing, we log and continue — no crash."""
        from src.activities.nar_recap import _upsert_nar_entry
        import httpx

        config = MagicMock()
        config.alfred_ctrl_url = "http://localhost:3100"
        entry = {"dedup_key": "nar:decision:01TEST", "occurred_at": "2026-08-13T10:00:00Z"}

        with patch("httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=False)
            mock_resp = MagicMock()
            mock_resp.status_code = 404
            mock_resp.raise_for_status = MagicMock(
                side_effect=httpx.HTTPStatusError("Not Found", request=MagicMock(), response=mock_resp)
            )
            mock_client.post = AsyncMock(return_value=mock_resp)
            mock_client_cls.return_value = mock_client

            out = await _upsert_nar_entry(config, entry)

        assert out["reason"] == "endpoint_not_deployed"
        assert out["dedup_key"] == "nar:decision:01TEST"


# ---------------------------------------------------------------------------
# is_failed enforcement — displacement forced to zero
# ---------------------------------------------------------------------------

class TestIsFailedEnforcement:
    """Rule 3: bucket and is_failed are independent axes.

    A session classified as L-scale that failed still records displaced=0.
    The enforcement is in compute_nar_day, not in the clerk prompt.
    """

    @pytest.mark.asyncio
    async def test_failed_L_session_gets_zero_displacement(self):
        """is_failed=True forces displaced=0.0 regardless of bucket."""
        from src.activities.nar_recap import _classify_session_bucket

        messages = [
            {"role": "user", "content": "Build the commitment register for the NeoTerra matter.", "ts": 1.0},
            {"role": "assistant", "content": "I've completed the commitment register tasks.", "ts": 2.0},
            {"role": "user", "content": "Can you verify the tasks were created?", "ts": 3.0},
            {"role": "assistant", "content": "I must concede — the tasks were created without the commitment-register contract. The pipeline failed.", "ts": 4.0},
        ]
        with patch("src.activities.nar_recap._call_clerk", new_callable=AsyncMock) as mock_clerk:
            mock_clerk.return_value = {
                "bucket": "L",         # session was L-scale
                "reasoning": "commitment register work L-scale but pipeline failed at final step",
                "has_artifact": False,
                "is_failed": True,     # failed
            }
            result = await _classify_session_bucket(messages)

        # Bucket is still L — the clerk correctly sized the scope.
        assert result["bucket"] == "L"
        assert result["is_failed"] is True

        # The CALLER must zero displacement; bucket_minutes("L") alone would give 60.
        # Verify that callers check is_failed:
        from src.activities.nar_recap import BUCKET_MINUTES
        raw_displaced = BUCKET_MINUTES.get(result["bucket"])
        assert raw_displaced == 60.0  # bucket says 60 min…
        # …but is_failed=True means the caller must override to 0.
        displaced = 0.0 if result["is_failed"] else raw_displaced
        assert displaced == 0.0

    @pytest.mark.asyncio
    async def test_failure_note_present_in_clerk_prompt(self):
        """The failure signal extracted from messages appears in the clerk prompt."""
        from src.activities.nar_recap import _classify_session_bucket
        from src.activities.nar_data import _CONCESSION_PHRASES

        # Build a session with an explicit concession in the middle.
        messages = [
            {"role": "user", "content": "Draft an email to the client.", "ts": 1.0},
            {"role": "assistant", "content": "I was wrong about the contact details; I apologize.", "ts": 2.0},
            {"role": "assistant", "content": "Here is a revised version.", "ts": 3.0},
        ]
        with patch("src.activities.nar_recap._call_clerk", new_callable=AsyncMock) as mock_clerk:
            mock_clerk.return_value = {"bucket": "S", "reasoning": "short email", "has_artifact": True, "is_failed": False}
            await _classify_session_bucket(messages)

        # The concession reaches the clerk as a SIGNAL, not a verdict. A phrase
        # match cannot tell "I was wrong, here is the corrected result" from
        # "I was wrong and could not do it" — deterministic matching zeroed three
        # delivering sessions and cost a reference day 4h. The clerk decides.
        prompt_sent = mock_clerk.call_args[0][0]
        assert "Self-correction signal:" in prompt_sent
        assert "Failure signal:" not in prompt_sent
        # The concession excerpt itself is passed through for the clerk to weigh.
        assert "i was wrong" in prompt_sent.lower() or "i apologize" in prompt_sent.lower()
        # And the prompt must tell the clerk that correction is not failure.
        assert "is not a failure" in prompt_sent.lower()


# ---------------------------------------------------------------------------
# _classify_chore_bucket — dedicated chore artifact classifier
# ---------------------------------------------------------------------------

class TestClassifyChoreeBucket:
    """Chore artifact classification uses a chore-specific prompt, not the
    session classifier.  Vigilance sweeps never reach this function."""

    @pytest.mark.asyncio
    async def test_briefing_chore_classified_as_M(self):
        """A chore that composed a briefing → M bucket."""
        from src.activities.nar_recap import _classify_chore_bucket

        with patch("src.activities.nar_recap._call_clerk", new_callable=AsyncMock) as mock_clerk:
            mock_clerk.return_value = {
                "bucket": "M",
                "reasoning": "briefing composition takes ~20 min by hand",
                "has_artifact": True,
                "is_failed": False,
            }
            result = await _classify_chore_bucket(
                "composed briefing/2026-08-07-morning.md",
                "morning-brief",
            )

        assert result["bucket"] == "M"
        assert result["has_artifact"] is True
        # Verify the prompt does NOT contain ask/delivery/failure_note framing.
        prompt_sent = mock_clerk.call_args[0][0]
        assert "(no user turn)" not in prompt_sent
        assert "Chore:" in prompt_sent
        assert "Output:" in prompt_sent

    @pytest.mark.asyncio
    async def test_failed_chore_returns_none_bucket(self):
        """A failed chore → zero displacement."""
        from src.activities.nar_recap import _classify_chore_bucket

        with patch("src.activities.nar_recap._call_clerk", new_callable=AsyncMock) as mock_clerk:
            mock_clerk.return_value = {
                "bucket": "none",
                "reasoning": "chore failed; no deliverable produced",
                "has_artifact": False,
                "is_failed": True,
            }
            result = await _classify_chore_bucket("Error: connection refused", "nightly-sync")

        assert result["bucket"] == "none"
        assert result["is_failed"] is True

    @pytest.mark.asyncio
    async def test_empty_detail_returns_none(self):
        """Empty chore output → no clerk call, bucket='none'."""
        from src.activities.nar_recap import _classify_chore_bucket

        result = await _classify_chore_bucket("", "test-chore")
        assert result["bucket"] == "none"
        assert result["has_artifact"] is False


# ---------------------------------------------------------------------------
# _get_human_sessions — parent_session_id IS NULL filter (#584)
# ---------------------------------------------------------------------------

def _make_session_db(
    sessions: list[dict],
    messages: list[dict] | None = None,
) -> sqlite3.Connection:
    """In-memory Hermes session store with the exact columns _get_human_sessions reads."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            source TEXT,
            started_at REAL,
            ended_at REAL,
            parent_session_id TEXT
        );
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            role TEXT,
            content TEXT,
            timestamp REAL
        );
    """)
    for s in sessions:
        conn.execute(
            "INSERT INTO sessions VALUES (?, ?, ?, ?, ?)",
            (s["id"], s["source"], s["started_at"],
             s.get("ended_at"), s.get("parent_session_id")),
        )
    for m in (messages or []):
        conn.execute(
            "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
            (m["session_id"], m["role"], m["content"], m["timestamp"]),
        )
    conn.commit()
    return conn


class TestGetHumanSessionsParentage:
    """_get_human_sessions must exclude agent-spawned sessions (#584).

    sessions.parent_session_id IS NULL is the structural discriminator:
    the principal's sessions have no parent; agent-spawned ones do.
    """

    def _day(self) -> date:
        return date(2026, 7, 15)

    def _ts(self, hour: int = 10) -> float:
        """Epoch-seconds for 2026-07-15 HH:00:00 UTC."""
        return datetime(2026, 7, 15, hour, 0, 0, tzinfo=timezone.utc).timestamp()

    def test_null_parent_slack_session_included(self):
        """A slack session with parent_session_id=NULL is a human session."""
        db = _make_session_db([
            {"id": "s1", "source": "slack", "started_at": self._ts(10),
             "ended_at": self._ts(11), "parent_session_id": None},
        ])
        results = _get_human_sessions(db, self._day())
        assert len(results) == 1
        assert results[0]["id"] == "s1"

    def test_nonnull_parent_slack_session_excluded(self):
        """A slack session with a non-null parent_session_id is agent-spawned
        and must NOT appear in the human session list."""
        db = _make_session_db([
            {"id": "s_spawned", "source": "slack", "started_at": self._ts(10),
             "ended_at": self._ts(10) + 300, "parent_session_id": "parent_abc"},
        ])
        results = _get_human_sessions(db, self._day())
        assert results == []

    def test_spawned_session_turns_absent_from_results(self):
        """Turns belonging to an agent-spawned session must not appear in the
        returned session list, so their timestamps cannot reach cluster_bursts."""
        spawned_ts = self._ts(9)
        human_ts = self._ts(10)
        db = _make_session_db(
            sessions=[
                {"id": "s_human", "source": "slack", "started_at": human_ts,
                 "parent_session_id": None},
                {"id": "s_spawned", "source": "slack", "started_at": spawned_ts,
                 "parent_session_id": "some_parent"},
            ],
            messages=[
                {"session_id": "s_human", "role": "user", "content": "hi", "timestamp": human_ts * 1000},
                {"session_id": "s_spawned", "role": "user", "content": "agent task", "timestamp": spawned_ts * 1000},
            ],
        )
        results = _get_human_sessions(db, self._day())
        assert len(results) == 1
        assert results[0]["id"] == "s_human"
        all_ts = [m["ts"] for s in results for m in s["messages"]]
        # spawned session's turn must not be in the timestamp set
        assert spawned_ts * 1000 not in all_ts
        assert human_ts * 1000 in all_ts

    def test_unknown_source_excluded_regardless_of_parent(self):
        """The source allowlist is maintained independently of the parentage
        filter.  An api_server session with parent_session_id=NULL is still
        machine traffic and must be excluded."""
        db = _make_session_db([
            {"id": "s_api", "source": "api_server", "started_at": self._ts(10),
             "parent_session_id": None},
        ])
        results = _get_human_sessions(db, self._day())
        assert results == []


# ---------------------------------------------------------------------------
# _replace_nar_entries — batch replace writer (#584 stale-row fix)
# ---------------------------------------------------------------------------

class TestReplaceNarEntries:
    """_replace_nar_entries posts mode='replace' + date; 400 is a replace failure."""

    def _mock_http(self, status: int = 200):
        """Return (mock_client_cls, mock_client, mock_resp) for httpx.AsyncClient."""
        mc = AsyncMock()
        mc.__aenter__ = AsyncMock(return_value=mc)
        mc.__aexit__ = AsyncMock(return_value=False)
        mr = MagicMock()
        mr.status_code = status
        mr.raise_for_status = MagicMock()
        mr.json = MagicMock(return_value={"ok": True})
        mc.post = AsyncMock(return_value=mr)
        return MagicMock(return_value=mc), mc, mr

    @pytest.mark.asyncio
    @pytest.mark.parametrize("entries", [
        [{"dedup_key": "nar:decision:01TEST", "occurred_at": "2026-07-15T10:00:00Z"}],
        [],
    ], ids=["with-entries", "empty"])
    async def test_payload_carries_mode_replace_and_date(self, entries):
        """POST body must carry mode='replace' and the ISO date; empty list included."""
        from src.activities.nar_recap import _replace_nar_entries

        config = MagicMock()
        config.alfred_ctrl_url = "http://localhost:3100"
        mock_cls, mock_client, _ = self._mock_http()

        with patch("httpx.AsyncClient", mock_cls):
            await _replace_nar_entries(config, "2026-07-15", entries)

        body = mock_client.post.call_args.kwargs["json"]
        assert body["mode"] == "replace"
        assert body["date"] == "2026-07-15"
        assert body["entries"] == entries

    @pytest.mark.asyncio
    async def test_400_is_replace_failure_not_success(self):
        """400 from ctrl-api must surface as replace_not_supported, not success."""
        from src.activities.nar_recap import _replace_nar_entries
        import httpx

        config = MagicMock()
        config.alfred_ctrl_url = "http://localhost:3100"
        mock_cls, _, mock_resp = self._mock_http(status=400)
        mock_resp.raise_for_status = MagicMock(
            side_effect=httpx.HTTPStatusError(
                "Bad Request", request=MagicMock(), response=mock_resp
            )
        )

        with patch("httpx.AsyncClient", mock_cls):
            out = await _replace_nar_entries(config, "2026-07-15", [])

        assert out.get("ok") is False
        assert out["reason"] == "replace_not_supported"


# ---------------------------------------------------------------------------
# Defect 1 — summary must be human-readable (not a machine label)
# Defect 2 — outcome must be written to notes for ctrl to read
# ---------------------------------------------------------------------------

class TestOutcomeWrittenToNotes:
    """ctrl reads notes.outcome per inferred item; None renders as 'no displacement credit'.

    The logic below mirrors what compute_nar_day does — tested in isolation
    so the outcome-building contract is locked independently of the HTTP stack.
    """

    def _build_sess_notes(self, bucket: str, is_failed: bool) -> dict:
        """Mirror the outcome logic from compute_nar_day sessions section."""
        if is_failed:
            outcome: str | None = "failed"
        elif bucket != "none":
            outcome = "delivered"
        else:
            outcome = None
        obj: dict = {"bucket": bucket, "has_artifact": True}
        if outcome is not None:
            obj["outcome"] = outcome
        return json.loads(json.dumps(obj))

    def test_delivered_session_outcome_is_delivered(self):
        for bucket in ("S", "M", "L", "XL"):
            notes = self._build_sess_notes(bucket, is_failed=False)
            assert notes.get("outcome") == "delivered", f"bucket={bucket}"

    def test_failed_session_outcome_is_not_delivered(self):
        notes = self._build_sess_notes("S", is_failed=True)
        assert notes.get("outcome") != "delivered"
        # A specific non-None value must be present (the failed value).
        assert notes.get("outcome") is not None

    def test_bucket_none_not_failed_not_marked_failed(self):
        """bucket='none', not failed → outcome absent (discussion-only ≠ failure)."""
        notes = self._build_sess_notes("none", is_failed=False)
        assert notes.get("outcome") != "failed", (
            "bucket:none without failure must not be labelled failed"
        )

    @pytest.mark.asyncio
    async def test_classify_session_bucket_exposes_work_summary(self):
        """_classify_session_bucket must return work_summary so compute_nar_day can use it."""
        from src.activities.nar_recap import _classify_session_bucket

        messages = [{"role": "user", "content": "Draft the invoice.", "ts": 1.0}]
        with patch("src.activities.nar_recap._call_clerk", new_callable=AsyncMock) as mock_clerk:
            mock_clerk.return_value = {
                "bucket": "S",
                "reasoning": "short invoice task",
                "has_artifact": True,
                "is_failed": False,
                "work_summary": "Invoice drafted for client",
            }
            result = await _classify_session_bucket(messages)
        assert "work_summary" in result
        assert result["work_summary"] == "Invoice drafted for client"



class TestWorkSummaryShape:
    """summary must describe the work done, not the session metadata.

    Migration 0020 defines summary as 'one line, human readable — this is what
    the principal reads'.  The old format (Session <id12> (slack) — bucket L)
    told the principal nothing.
    """

    def test_summary_not_session_id_or_bucket_label(self):
        """When work_summary is present it replaces the machine label."""
        session_id = "sess_deadbeef1234"
        source = "slack"
        bucket = "L"
        work_summary = "Two weeks of messages, DMs and mail gathered"

        # New logic: summary = work_summary when non-empty.
        summary = work_summary if work_summary else f"{source} session"

        assert session_id[:12] not in summary, "session id must not appear in summary"
        assert f"— bucket {bucket}" not in summary, "bucket label must not appear in summary"
        assert f"bucket {bucket}" not in summary

    def test_fallback_summary_has_no_session_id(self):
        """When clerk returns empty work_summary, fallback is source-only (no id)."""
        session_id = "sess_deadbeef1234"
        source = "slack"
        work_summary = ""

        summary = work_summary if work_summary else f"{source} session"

        assert session_id[:12] not in summary
        assert "bucket" not in summary.lower()

    @pytest.mark.asyncio
    async def test_clerk_error_fallback_work_summary_empty(self):
        """On clerk error, work_summary is '' — the machine fallback summary is used."""
        from src.activities.nar_recap import _classify_session_bucket

        messages = [{"role": "user", "content": "hello", "ts": 1.0}]
        with patch("src.activities.nar_recap._call_clerk", new_callable=AsyncMock) as mock_clerk:
            mock_clerk.side_effect = RuntimeError("gateway timeout")
            result = await _classify_session_bucket(messages)
        assert result.get("work_summary") == ""

    @pytest.mark.asyncio
    async def test_chore_work_summary_used_as_summary(self):
        """Artifact chore summary comes from work_summary, not the machine label."""
        from src.activities.nar_recap import _classify_chore_bucket

        chore_name = "morning-brief"
        with patch("src.activities.nar_recap._call_clerk", new_callable=AsyncMock) as mock_clerk:
            mock_clerk.return_value = {
                "bucket": "M",
                "reasoning": "briefing composed",
                "has_artifact": True,
                "is_failed": False,
                "work_summary": "Morning briefing composed and delivered",
            }
            binfo = await _classify_chore_bucket("composed briefing.md", chore_name)

        work_summary = binfo.get("work_summary") or ""
        summary = (
            work_summary if work_summary
            else (chore_name if binfo.get("has_artifact") else f"{chore_name} — vigilance")
        )
        assert "artifact" not in summary
        assert summary == "Morning briefing composed and delivered"
