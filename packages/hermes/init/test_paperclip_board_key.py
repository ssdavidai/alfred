"""Tests for paperclip_board_key.py — board API key wiring for Hermes' MCP server.

These tests pin three invariants:

  1. The token shape we generate matches Paperclip's
     ``createBoardApiToken`` so the auth middleware's sha256-and-lookup
     verifies our tokens identically to ones minted by the upstream
     CLI.
  2. ``write_paperclip_api_key_to_profiles`` is idempotent + preserves
     other env keys — the merge-preserve invariant in render_hermes.py
     stays intact, but our writes don't depend on it.
  3. The cli-auth challenge HTTP flow uses the right shape: POST to
     ``/api/cli-auth/challenges`` then ``…/:id/approve`` with the
     challenge secret in the body. We mock urlopen because the real
     Paperclip embedded postgres isn't available in CI.

The 2026-05-27 incident: Hermes' Paperclip MCP server 401-ed on every
tool call because ``PAPERCLIP_API_KEY`` was never set in any profile
``.env``. PR #84 wired the *agent* token into /opt/alfred/.env but the
MCP tools need a *board* key. Don't lose this distinction in a refactor.
"""
from __future__ import annotations

import hashlib
import io
import json
import sys
from http.cookiejar import CookieJar
from pathlib import Path
from unittest.mock import patch

# Make the module importable without installing.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from paperclip_board_key import (  # type: ignore
    BOARD_API_KEY_PREFIX,
    BOARD_API_KEY_TOKEN_BYTES,
    DEFAULT_HERMES_PROFILES,
    PAPERCLIP_API_KEY_NAME,
    _upsert_env_key,
    board_api_key_expires_at,
    generate_board_api_token,
    hash_bearer_token,
    mint_board_key_via_api,
    write_paperclip_api_key_to_profiles,
)


# ---------------------------------------------------------------------------
# Token-shape pins — must stay byte-compatible with services/board-auth.js
# ---------------------------------------------------------------------------


def test_generate_board_api_token_shape() -> None:
    token = generate_board_api_token()
    # Prefix matches Paperclip's createBoardApiToken
    assert token.startswith(BOARD_API_KEY_PREFIX) == True
    # 24 random bytes hex-encoded = 48 chars + 10-char prefix = 58 total
    assert len(token) == len(BOARD_API_KEY_PREFIX) + BOARD_API_KEY_TOKEN_BYTES * 2
    # All-lowercase hex after the prefix
    suffix = token[len(BOARD_API_KEY_PREFIX):]
    int(suffix, 16)  # raises ValueError if not hex


def test_generate_board_api_token_is_random() -> None:
    """Pull 100 tokens; they all differ. Catches a future regression
    where someone seeds secrets.token_hex with a fixed value."""
    tokens = {generate_board_api_token() for _ in range(100)}
    assert len(tokens) == 100


def test_hash_bearer_token_is_sha256_hex() -> None:
    """Pin the hash algorithm — auth middleware verifies via
    ``hashBearerToken`` in services/board-auth.js which is sha256 hex."""
    token = "pcp_board_deadbeef" + ("0" * 40)
    expected = hashlib.sha256(token.encode("utf-8")).hexdigest()
    assert hash_bearer_token(token) == expected
    # 64 hex chars
    assert len(hash_bearer_token(token)) == 64


def test_board_api_key_expires_at_is_30_days_out() -> None:
    """Paperclip's BOARD_API_KEY_TTL_MS is 30*24*60*60*1000.
    Drift here means our keys would either expire early (breaking
    tools after N<30 days) or never (drifting from upstream's
    expectations)."""
    from datetime import datetime, timezone
    now = datetime(2026, 5, 27, 0, 0, 0, tzinfo=timezone.utc)
    expires = board_api_key_expires_at(now)
    delta = expires - now
    assert delta.days == 30
    assert delta.seconds == 0


# ---------------------------------------------------------------------------
# Env writer — idempotency + preservation
# ---------------------------------------------------------------------------


def test_upsert_env_key_creates_missing_file(tmp_path: Path) -> None:
    env_path = tmp_path / ".env"
    _upsert_env_key(env_path, PAPERCLIP_API_KEY_NAME, "pcp_board_test")
    assert env_path.exists()
    content = env_path.read_text()
    assert f"{PAPERCLIP_API_KEY_NAME}=pcp_board_test" in content


def test_upsert_env_key_replaces_existing_value(tmp_path: Path) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text(
        "OPENROUTER_API_KEY=keep-me\n"
        f"{PAPERCLIP_API_KEY_NAME}=stale-value\n"
        "TELEGRAM_BOT_TOKEN=keep-this-too\n"
    )
    _upsert_env_key(env_path, PAPERCLIP_API_KEY_NAME, "pcp_board_fresh")
    text = env_path.read_text()
    # Stale value gone, fresh value present
    assert "stale-value" not in text
    assert "pcp_board_fresh" in text
    # Other keys preserved verbatim, in the same relative position
    assert "OPENROUTER_API_KEY=keep-me" in text
    assert "TELEGRAM_BOT_TOKEN=keep-this-too" in text


def test_upsert_env_key_appends_when_absent(tmp_path: Path) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text(
        "API_SERVER_PORT=18789\n"
        "OPENROUTER_API_KEY=foo\n"
    )
    _upsert_env_key(env_path, PAPERCLIP_API_KEY_NAME, "pcp_board_new")
    lines = env_path.read_text().splitlines()
    # Existing keys untouched
    assert "API_SERVER_PORT=18789" in lines
    assert "OPENROUTER_API_KEY=foo" in lines
    # New key appended
    assert f"{PAPERCLIP_API_KEY_NAME}=pcp_board_new" in lines


def test_upsert_env_key_preserves_comments_and_blanks(tmp_path: Path) -> None:
    """Pin that we don't gobble # comments / blank lines — operators
    sometimes annotate the .env, and even render_hermes uses the
    preservation footer as a marker line."""
    env_path = tmp_path / ".env"
    env_path.write_text(
        "# Runtime keys (preserved across init re-renders)\n"
        "\n"
        "OPENROUTER_API_KEY=foo\n"
        "# this is a hand-written note from the operator\n"
        f"{PAPERCLIP_API_KEY_NAME}=old\n"
    )
    _upsert_env_key(env_path, PAPERCLIP_API_KEY_NAME, "new")
    text = env_path.read_text()
    assert "# Runtime keys (preserved across init re-renders)" in text
    assert "# this is a hand-written note from the operator" in text
    assert f"{PAPERCLIP_API_KEY_NAME}=new" in text
    assert "=old" not in text


def test_upsert_env_key_atomic_no_partial_writes(tmp_path: Path) -> None:
    """Pin: temp file is renamed in one step. We verify that after a
    successful write, no .tmp sibling remains (regression check for a
    future refactor that forgets the rename)."""
    env_path = tmp_path / ".env"
    env_path.write_text("FOO=bar\n")
    _upsert_env_key(env_path, PAPERCLIP_API_KEY_NAME, "x")
    siblings = sorted(p.name for p in env_path.parent.iterdir())
    assert siblings == [".env"]


def test_write_paperclip_api_key_writes_all_present_profiles(tmp_path: Path) -> None:
    state = tmp_path / "hermes-state"
    for profile in DEFAULT_HERMES_PROFILES:
        d = state / "profiles" / profile
        d.mkdir(parents=True)
        (d / ".env").write_text("API_SERVER_PORT=18789\n")
    written = write_paperclip_api_key_to_profiles(
        hermes_state_dir=state,
        token="pcp_board_" + ("a" * 48),
    )
    assert len(written) == len(DEFAULT_HERMES_PROFILES)
    for path in written:
        content = path.read_text()
        assert f"{PAPERCLIP_API_KEY_NAME}=pcp_board_" in content
        # API_SERVER_PORT preserved
        assert "API_SERVER_PORT=18789" in content


def test_write_paperclip_api_key_skips_missing_profile_dirs(tmp_path: Path) -> None:
    """Only writes into profile dirs that exist — supports a future
    main-only build without dragging dead writes into nonexistent
    workers/heavy dirs."""
    state = tmp_path / "hermes-state"
    (state / "profiles" / "main").mkdir(parents=True)
    (state / "profiles" / "main" / ".env").write_text("")
    # No workers/, no heavy/ — should silently skip
    written = write_paperclip_api_key_to_profiles(
        hermes_state_dir=state,
        token="pcp_board_" + ("b" * 48),
    )
    assert len(written) == 1
    assert written[0] == state / "profiles" / "main" / ".env"


def test_write_paperclip_api_key_rejects_empty_token(tmp_path: Path) -> None:
    state = tmp_path / "hermes-state"
    (state / "profiles" / "main").mkdir(parents=True)
    try:
        write_paperclip_api_key_to_profiles(hermes_state_dir=state, token="")
    except ValueError as exc:
        assert "empty" in str(exc).lower()
    else:
        assert False, "empty token should raise ValueError"


def test_write_paperclip_api_key_also_writes_company_and_agent_ids(tmp_path: Path) -> None:
    """When company_id / agent_id are supplied, they land alongside
    PAPERCLIP_API_KEY in each profile's .env. The MCP server reads them
    as default fillers for the resolveCompanyId / resolveAgentId paths
    so the LLM doesn't need to thread UUIDs through every tool call."""
    state = tmp_path / "hermes-state"
    (state / "profiles" / "main").mkdir(parents=True)
    (state / "profiles" / "main" / ".env").write_text("API_SERVER_PORT=18789\n")

    written = write_paperclip_api_key_to_profiles(
        hermes_state_dir=state,
        token="pcp_board_" + ("c" * 48),
        company_id="company-uuid-1",
        agent_id="agent-uuid-1",
    )

    assert len(written) == 1
    text = written[0].read_text()
    assert "PAPERCLIP_API_KEY=pcp_board_" in text
    assert "PAPERCLIP_COMPANY_ID=company-uuid-1" in text
    assert "PAPERCLIP_AGENT_ID=agent-uuid-1" in text
    # Existing keys preserved
    assert "API_SERVER_PORT=18789" in text


def test_write_paperclip_api_key_skips_empty_company_or_agent_ids(tmp_path: Path) -> None:
    """Optional args: empty / None values must NOT write empty .env lines.
    Otherwise re-running on a tenant that hasn't seeded the company yet
    would persist an empty PAPERCLIP_COMPANY_ID=, which the MCP server's
    `nonEmpty()` reads as null — better to leave the var unset entirely.
    """
    state = tmp_path / "hermes-state"
    (state / "profiles" / "main").mkdir(parents=True)
    (state / "profiles" / "main" / ".env").write_text("")
    write_paperclip_api_key_to_profiles(
        hermes_state_dir=state,
        token="pcp_board_" + ("d" * 48),
        company_id="",  # falsy
        agent_id=None,
    )
    text = (state / "profiles" / "main" / ".env").read_text()
    assert "PAPERCLIP_API_KEY=" in text
    assert "PAPERCLIP_COMPANY_ID" not in text
    assert "PAPERCLIP_AGENT_ID" not in text


# ---------------------------------------------------------------------------
# HTTP API path — mock urlopen, verify the two-call ritual
# ---------------------------------------------------------------------------


class _MockResponse:
    """Stand-in for urllib's HTTPResponse object."""

    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self._body = body

    def read(self) -> bytes:
        return self._body


def test_mint_board_key_via_api_happy_path() -> None:
    """The two-call ritual succeeds and returns the boardApiToken from
    step 1's response."""
    cookies = CookieJar()

    calls: list[tuple[str, str, dict]] = []

    def fake_open(self, req, timeout=30):  # noqa: ARG001
        body = req.data.decode("utf-8") if req.data else ""
        calls.append((req.method, req.full_url, json.loads(body) if body else {}))
        if req.full_url.endswith("/api/cli-auth/challenges"):
            return _MockResponse(201, json.dumps({
                "id": "challenge-abc",
                "token": "secret-xyz",
                "boardApiToken": "pcp_board_" + ("c" * 48),
                "approvalPath": "/cli-auth/challenge-abc?token=secret-xyz",
                "approvalUrl": None,
                "pollPath": "/cli-auth/challenges/challenge-abc",
                "expiresAt": "2026-06-26T00:00:00.000Z",
                "suggestedPollIntervalMs": 1000,
            }).encode("utf-8"))
        if req.full_url.endswith("/api/cli-auth/challenges/challenge-abc/approve"):
            return _MockResponse(200, json.dumps({
                "approved": True,
                "status": "approved",
                "userId": "user-1",
                "keyId": "key-1",
                "expiresAt": "2026-06-26T00:00:00.000Z",
            }).encode("utf-8"))
        return _MockResponse(404, b'{"error":"not found"}')

    with patch("urllib.request.OpenerDirector.open", fake_open):
        token = mint_board_key_via_api(
            internal_url="http://paperclip:3100",
            public_url="https://paperclip.example.com",
            cookies=cookies,
        )

    assert token == "pcp_board_" + ("c" * 48)
    # Two POSTs in order: challenges then approve
    assert len(calls) == 2
    assert calls[0][0] == "POST"
    assert calls[0][1].endswith("/api/cli-auth/challenges")
    assert calls[1][0] == "POST"
    assert calls[1][1].endswith("/api/cli-auth/challenges/challenge-abc/approve")
    # The approve body carries the challenge secret (not the board token)
    assert calls[1][2] == {"token": "secret-xyz"}


def test_mint_board_key_via_api_propagates_400_with_body() -> None:
    """Any non-2xx should surface the response body in the error so
    bootstrap-paperclip.sh's die() can log the failing step."""
    cookies = CookieJar()

    def fake_open(self, req, timeout=30):  # noqa: ARG001
        # Simulate the cli-auth challenges endpoint blowing up with 500
        return _MockResponse(500, b'{"error":"db unavailable"}')

    with patch("urllib.request.OpenerDirector.open", fake_open):
        try:
            mint_board_key_via_api(
                internal_url="http://paperclip:3100",
                public_url="https://paperclip.example.com",
                cookies=cookies,
            )
        except RuntimeError as exc:
            msg = str(exc)
            assert "HTTP 500" in msg
            assert "db unavailable" in msg
        else:
            assert False, "expected RuntimeError on HTTP 500"


def test_mint_board_key_via_api_rejects_unapproved_status() -> None:
    """If step 2 returns approved=false (e.g. expired challenge),
    we must NOT return the pending token — that key has never been
    activated and every API call with it would 401."""
    cookies = CookieJar()

    def fake_open(self, req, timeout=30):  # noqa: ARG001
        if req.full_url.endswith("/api/cli-auth/challenges"):
            return _MockResponse(201, json.dumps({
                "id": "challenge-1",
                "token": "secret-1",
                "boardApiToken": "pcp_board_" + ("d" * 48),
                "approvalPath": "/cli-auth/challenge-1?token=secret-1",
                "approvalUrl": None,
                "pollPath": "/cli-auth/challenges/challenge-1",
                "expiresAt": "2026-06-26T00:00:00.000Z",
                "suggestedPollIntervalMs": 1000,
            }).encode("utf-8"))
        return _MockResponse(200, json.dumps({
            "approved": False,
            "status": "expired",
            "userId": "user-1",
            "keyId": None,
            "expiresAt": "2026-06-26T00:00:00.000Z",
        }).encode("utf-8"))

    with patch("urllib.request.OpenerDirector.open", fake_open):
        try:
            mint_board_key_via_api(
                internal_url="http://paperclip:3100",
                public_url="https://paperclip.example.com",
                cookies=cookies,
            )
        except RuntimeError as exc:
            assert "approved" in str(exc).lower()
        else:
            assert False, "must reject unapproved challenge"


def test_mint_board_key_via_api_missing_fields_in_step1() -> None:
    """Step 1 returns 200 but the response is missing the boardApiToken
    — defensive: a Paperclip refactor that renamed the field would
    silently fall through to an empty-string return without this guard."""
    cookies = CookieJar()

    def fake_open(self, req, timeout=30):  # noqa: ARG001
        return _MockResponse(201, json.dumps({
            "id": "challenge-1",
            "token": "secret-1",
            # boardApiToken missing
        }).encode("utf-8"))

    with patch("urllib.request.OpenerDirector.open", fake_open):
        try:
            mint_board_key_via_api(
                internal_url="http://paperclip:3100",
                public_url="https://paperclip.example.com",
                cookies=cookies,
            )
        except RuntimeError as exc:
            assert "boardApiToken" in str(exc) or "missing" in str(exc).lower()
        else:
            assert False, "must reject missing boardApiToken"
