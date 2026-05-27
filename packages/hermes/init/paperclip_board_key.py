"""Paperclip board API key wiring for Hermes' Paperclip MCP server.

Why this exists
---------------
Hermes ships `@paperclipai/mcp-server@2026.525.0` baked into the image
(see hermes-config.yaml.njk § paperclip). The MCP server reads
``PAPERCLIP_API_KEY`` from its process environment and sends
``Authorization: Bearer <key>`` on every Paperclip HTTP call.

Paperclip's auth middleware (``/app/server/dist/middleware/auth.js``)
recognises three Bearer-token shapes:

  * ``pcp_board_<48hex>`` → ``boardApiKeys`` row → ``actor.type="board"``
    – this is what the MCP tools need (they call company-scoped routes
    that 403 with ``"Board access required"`` otherwise).
  * ``pcp_<…>`` → ``agentApiKeys`` row → ``actor.type="agent"``
    – this is what ``PAPERCLIP_AGENT_TOKEN`` is. Sufficient for
    ``/agents/me`` and Paperclip → Hermes heartbeats, NOT for the 39
    other MCP tools (they all return 403 ``"Board access required"``).
  * Local agent JWT → same as agent-key but signed by the
    ``PAPERCLIP_HEARTBEAT_SECRET``.

PR #84 wired the agent key into ``/opt/alfred/.env`` as
``PAPERCLIP_AGENT_TOKEN`` and that solved the Paperclip → Hermes
heartbeat path; the reverse direction (Hermes-MCP → Paperclip) was
left to a manual "paste your key into ``.env``" UI step that no one
ever did. The 2026-05-27 smoke test in PR #87 caught this: every MCP
tool call from Hermes 401-ed.

This module is the seam that mints a board key headlessly and writes
``PAPERCLIP_API_KEY`` into each Hermes profile's ``.env`` so the MCP
server picks it up on the next ``docker compose restart hermes``.

Two paths in
------------

1. **bootstrap-paperclip.sh / fresh tenant**: the script already has
   a Better-Auth session cookie (it just signed up the seed user at
   step 6). ``mint_board_key_via_api`` uses the cli-auth challenge
   flow (``POST /api/cli-auth/challenges`` + ``…/:id/approve``) to
   trade the cookie for a long-lived ``pcp_board_…`` token.

2. **migrate-paperclip-board-key.sh / already-seeded tenant**: home
   was seeded before PR #84 and the 4 newer tenants lost their seed
   credentials file. We can't sign in again, so we mint by direct
   ``INSERT INTO board_api_keys`` against the embedded postgres
   (``mint_board_key_via_db``). This bypasses Better-Auth entirely;
   it's safe because (a) we already have the user_id from the same
   DB, (b) we hash the token with the same sha256 the runtime uses
   to verify it, (c) the auth middleware reads from the same table.

Either path lands at ``write_paperclip_api_key_to_profiles`` which
upserts ``PAPERCLIP_API_KEY=<token>`` into every profile's ``.env``,
matching the merge-preserve invariants in ``render_hermes.py``.

Note: ``PAPERCLIP_`` is already in ``_RUNTIME_KEY_PREFIXES`` so future
init re-renders will keep this key. Don't drop the prefix from the
allowlist without re-checking this wiring.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.cookiejar import CookieJar
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Constants — keep in sync with services/board-auth.js in Paperclip.
# ---------------------------------------------------------------------------

# 24 random bytes hex-encoded = 48-char suffix; ``pcp_board_`` prefix = 10
# chars; total 58 chars. Matches ``createBoardApiToken`` in
# ``services/board-auth.js`` — DO NOT change without also updating
# Paperclip's runtime (the auth middleware verifies by sha256 hash, so a
# token of any shape works — but staying byte-compatible means CLI
# operators can grep ``board_api_keys`` for our keys by prefix).
BOARD_API_KEY_PREFIX = "pcp_board_"
BOARD_API_KEY_TOKEN_BYTES = 24
# Match BOARD_API_KEY_TTL_MS in services/board-auth.js (30 days).
BOARD_API_KEY_TTL_DAYS = 30


def generate_board_api_token() -> str:
    """Generate a fresh ``pcp_board_<48hex>`` token.

    Cryptographically random; uses ``secrets`` so the bytes are pulled
    from the OS CSPRNG, not Python's ``random``. ~192 bits of entropy.
    """
    return BOARD_API_KEY_PREFIX + secrets.token_hex(BOARD_API_KEY_TOKEN_BYTES)


def hash_bearer_token(token: str) -> str:
    """SHA-256 hex hash of a bearer token.

    Mirrors ``hashBearerToken`` in ``services/board-auth.js`` so the
    auth middleware can verify a token we minted by direct DB insert.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Path 1 — mint via the live HTTP API (preferred; uses an existing session).
# ---------------------------------------------------------------------------


def mint_board_key_via_api(
    *,
    internal_url: str,
    public_url: str,
    cookies: CookieJar,
    client_name: str = "alfred-hermes-mcp",
    timeout: int = 30,
) -> str:
    """Mint a board API key via Paperclip's cli-auth challenge flow.

    Two-step ritual (matches the upstream CLI's behaviour at
    ``/app/cli/src/client/board-auth.ts``):

      1. POST /api/cli-auth/challenges (no auth) → returns
         ``{id, token, boardApiToken}`` — ``boardApiToken`` is a
         freshly-minted ``pcp_board_…`` whose db row is PENDING until
         step 2 lands.
      2. POST /api/cli-auth/challenges/<id>/approve with the body
         ``{token}`` and the session cookie of a signed-in board user
         → flips the pending row to ACTIVE and ``approved=true``.

    The session cookie is what authorises step 2. The bootstrap script
    signs up ``alfred@<DOMAIN>`` at step 6 and that user becomes the
    sole company owner — they qualify as ``actor.type === "board"``
    via the Better-Auth session path through the auth middleware.

    Returns the activated ``pcp_board_…`` token on success. Raises on
    any HTTP failure so the caller's ``die()`` can surface the exact
    step that broke.

    Mirrors the request-helper pattern in bootstrap-paperclip.sh —
    Host + Origin headers point at the public origin so Better-Auth's
    trustedOrigins allowlist accepts us even though we talk to the
    compose-network DNS name (paperclip:3100).
    """
    internal_url = internal_url.rstrip("/")
    public_url = public_url.rstrip("/")
    public_host = urllib.parse.urlparse(public_url).netloc

    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cookies)
    )

    def _request(method: str, path: str, body: Any | None = None) -> tuple[int, bytes]:
        url = internal_url + path
        data = None
        headers = {
            "Host": public_host,
            "Origin": public_url,
            "Accept": "application/json",
            "User-Agent": "alfred-paperclip-init/1.0",
        }
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            resp = opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        return resp.status, resp.read()

    # Step 1 — create the challenge. ``command`` is a free-text audit
    # field; we tag with our service name so an operator paging through
    # Paperclip's activity log can spot the key's provenance.
    code, body = _request("POST", "/api/cli-auth/challenges", {
        "command": "alfred-paperclip-init bootstrap",
        "clientName": client_name,
    })
    if code >= 400:
        raise RuntimeError(
            f"POST /api/cli-auth/challenges failed with HTTP {code}: "
            f"{body[:200].decode('utf-8', 'replace')}"
        )
    try:
        created = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"POST /api/cli-auth/challenges returned non-JSON body: "
            f"{body[:200].decode('utf-8', 'replace')}"
        ) from exc

    challenge_id = created.get("id")
    challenge_secret = created.get("token")
    board_api_token = created.get("boardApiToken")
    if not (challenge_id and challenge_secret and board_api_token):
        raise RuntimeError(
            "POST /api/cli-auth/challenges missing one of "
            "{id, token, boardApiToken}"
        )

    # Step 2 — approve as the signed-in board user. The cookie jar
    # already has the session cookie from the bootstrap script's
    # sign-up. The handler resolves req.actor via the session, mints
    # the boardApiKey row using the pending key hash, and returns
    # ``{approved:true, status:"approved", keyId}``.
    code, body = _request(
        "POST",
        f"/api/cli-auth/challenges/{urllib.parse.quote(str(challenge_id), safe='')}/approve",
        {"token": challenge_secret},
    )
    if code >= 400:
        raise RuntimeError(
            f"POST /api/cli-auth/challenges/{challenge_id}/approve "
            f"failed with HTTP {code}: {body[:200].decode('utf-8', 'replace')}"
        )
    try:
        approved = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            "POST /api/cli-auth/challenges/<id>/approve returned non-JSON"
        ) from exc

    if not approved.get("approved"):
        raise RuntimeError(
            f"cli-auth challenge approval did not resolve to approved: "
            f"status={approved.get('status')!r}"
        )

    return board_api_token


# ---------------------------------------------------------------------------
# Path 2 — direct DB insert (hot-fix for tenants seeded pre-PR #84 or
# where the seed credentials file was lost). The Node-side mint script
# lives at packages/hermes/init/migrate-paperclip-board-key.sh — this
# helper exists so the bootstrap script can fall back to it if the
# cli-auth path fails partway through.
# ---------------------------------------------------------------------------


def board_api_key_expires_at(now: datetime | None = None) -> datetime:
    """Return the timestamp 30 days from now (matches Paperclip's
    ``boardApiKeyExpiresAt`` in services/board-auth.js).

    UTC, microsecond-truncated to match what Paperclip writes (the
    actual seconds-precision in postgres is fine — this just keeps the
    string we render compatible with Paperclip's parsing).
    """
    base = now or datetime.now(timezone.utc)
    return base + timedelta(days=BOARD_API_KEY_TTL_DAYS)


# ---------------------------------------------------------------------------
# Hermes per-profile .env writer.
# ---------------------------------------------------------------------------

# Profiles that get the PAPERCLIP_API_KEY. ``main`` is the only profile
# whose config.yaml currently registers the paperclip MCP server, but
# we write to all three for symmetry — if a future config.yaml seeds
# the MCP server on workers/heavy too (e.g. for a "list issues" tool
# call from a workers-routed task), the env will already be in place.
DEFAULT_HERMES_PROFILES: tuple[str, ...] = ("main", "workers", "heavy")

# Env var name. The MCP server reads this (config.js
# ``readConfigFromEnv`` throws "Missing PAPERCLIP_API_KEY" without it).
PAPERCLIP_API_KEY_NAME = "PAPERCLIP_API_KEY"


def write_paperclip_api_key_to_profiles(
    *,
    hermes_state_dir: str | Path,
    token: str,
    company_id: str | None = None,
    agent_id: str | None = None,
    profiles: tuple[str, ...] = DEFAULT_HERMES_PROFILES,
) -> list[Path]:
    """Upsert ``PAPERCLIP_API_KEY=<token>`` (+ optional company/agent
    ids) in each profile's ``.env``.

    Mirrors the line-by-line "set or append" pattern in
    bootstrap-paperclip.sh's step 11b. Idempotent: re-running with a
    new token replaces the existing line; re-running with the same
    token is a no-op (functionally — the line gets re-written with
    identical contents).

    ``company_id`` / ``agent_id`` are optional and only written when
    non-empty. They become defaults for the MCP server's
    ``resolveCompanyId`` / ``resolveAgentId`` so the LLM doesn't need
    to thread the UUIDs through every tool call. Without them, every
    company-scoped tool surfaces "companyId is required because
    PAPERCLIP_COMPANY_ID is not set".

    File permissions: 0600 (matches what render_hermes writes). Each
    profile's ``.env`` is owned by uid 10000 (the hermes UID); we
    preserve that on rewrite if we can.

    Returns the list of paths we touched, for logging/tests.
    """
    if not token:
        raise ValueError("token is empty; refusing to write empty PAPERCLIP_API_KEY")
    if not token.startswith(BOARD_API_KEY_PREFIX):
        # Don't strictly enforce — an operator's hand-issued board key
        # might come from a future Paperclip release with a different
        # prefix. Just warn-via-print so the bootstrap log makes the
        # decision visible.
        print(
            f"[paperclip-board-key] WARN: token prefix is not "
            f"{BOARD_API_KEY_PREFIX!r}; writing anyway"
        )

    extras: dict[str, str] = {}
    if company_id:
        extras["PAPERCLIP_COMPANY_ID"] = company_id
    if agent_id:
        extras["PAPERCLIP_AGENT_ID"] = agent_id

    hermes_state = Path(hermes_state_dir)
    written: list[Path] = []
    for profile in profiles:
        profile_dir = hermes_state / "profiles" / profile
        if not profile_dir.is_dir():
            # Hermes only creates profile dirs that are enabled in
            # render_hermes.py's PROFILES list; skip missing ones
            # silently so this works on a future ``main``-only build.
            continue
        env_path = profile_dir / ".env"
        _upsert_env_key(env_path, PAPERCLIP_API_KEY_NAME, token)
        for k, v in extras.items():
            _upsert_env_key(env_path, k, v)
        written.append(env_path)
    return written


def _upsert_env_key(env_path: Path, key: str, value: str) -> None:
    """Set ``KEY=VALUE`` in an ``.env`` file, preserving everything else.

    Atomic via temp-file + rename so a partial write never leaves the
    file truncated (matches bootstrap-paperclip.sh's step 11b pattern).
    """
    existing_lines = env_path.read_text().splitlines() if env_path.exists() else []
    out_lines: list[str] = []
    seen = False
    for line in existing_lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            out_lines.append(line)
            continue
        eq = stripped.find("=")
        if eq < 0:
            out_lines.append(line)
            continue
        k = stripped[:eq].strip()
        if k == key:
            out_lines.append(f"{key}={value}")
            seen = True
        else:
            out_lines.append(line)
    if not seen:
        out_lines.append(f"{key}={value}")

    tmp_path = env_path.with_suffix(env_path.suffix + ".paperclip-board.tmp")
    tmp_path.write_text("\n".join(out_lines) + "\n")
    try:
        tmp_path.chmod(0o600)
    except PermissionError:
        # Filesystem doesn't support chmod (e.g. tmpfs on some CI
        # images) — proceed; permissions get inherited from rename.
        pass
    os.replace(tmp_path, env_path)


# ---------------------------------------------------------------------------
# CLI entrypoint — used by the bash hot-fix script.
# ---------------------------------------------------------------------------


def _main_write_token() -> int:
    """CLI shim: write PAPERCLIP_API_KEY into hermes profile .envs.

    Args via env:
      * HERMES_STATE_DIR — directory of the hermes_data volume (e.g.
        /hermes-state when mounted into a container, or the host
        ``/var/lib/docker/volumes/alfred-black_hermes_data/_data``).
      * PAPERCLIP_BOARD_API_TOKEN — the ``pcp_board_…`` token to write.

    Exit codes: 0 success, 2 misconfig, 1 IO error.
    """
    state_dir = os.environ.get("HERMES_STATE_DIR", "").strip()
    token = os.environ.get("PAPERCLIP_BOARD_API_TOKEN", "").strip()
    if not state_dir or not token:
        print(
            "ERROR: HERMES_STATE_DIR and PAPERCLIP_BOARD_API_TOKEN are required",
            flush=True,
        )
        return 2
    written = write_paperclip_api_key_to_profiles(
        hermes_state_dir=state_dir,
        token=token,
    )
    for path in written:
        print(f"[paperclip-board-key] wrote PAPERCLIP_API_KEY -> {path}")
    if not written:
        print(
            f"[paperclip-board-key] WARN: no profile dirs under "
            f"{state_dir}/profiles — nothing written"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(_main_write_token())
