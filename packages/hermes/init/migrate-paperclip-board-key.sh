#!/usr/bin/env bash
# =============================================================================
# migrate-paperclip-board-key.sh — hot-fix the Paperclip MCP auth wiring
# on a tenant that was seeded BEFORE step 12 of bootstrap-paperclip.sh
# landed (home seeded pre-PR #84; rj/joe/zsolt/miguel seeded between
# PR #84 and this fix).
#
# What this fixes
# ---------------
# Hermes' Paperclip MCP server reads `PAPERCLIP_API_KEY` from its
# process env and sends `Authorization: Bearer <key>` on every tool
# call. Paperclip's auth middleware accepts THREE token shapes:
#
#   * `pcp_board_<48hex>` (board API key) — `actor.type="board"`,
#     scope = a user's company memberships. The MCP tools call
#     company-scoped routes (e.g. `/api/companies/<id>/issues`) that
#     403 with "Board access required" on agent scope.
#   * `pcp_<…>` (agent API key) — `actor.type="agent"`, scope = one
#     agent's own context. PR #84 wired this into
#     `PAPERCLIP_AGENT_TOKEN`. Sufficient for Paperclip → Hermes
#     heartbeats (PR #87) and the `paperclipMe` MCP tool, NOT for the
#     other 39 tools.
#   * Local agent JWT — same scope as agent key, signed by the
#     heartbeat secret. Not what we want here.
#
# Until step 12 landed, NO board key existed on any tenant. Every MCP
# call from Hermes 401-ed. This script fixes that by:
#
#   1. Querying the embedded Paperclip postgres to find the
#      instance_admin user (the principal that signed up at
#      `paperclip.<DOMAIN>`).
#   2. Generating a `pcp_board_<48hex>` token + sha256-hashing it (same
#      shape as Paperclip's `createBoardApiToken`).
#   3. INSERT INTO board_api_keys (user_id, name, key_hash, expires_at)
#      — same row shape the live auth middleware reads.
#   4. Writing PAPERCLIP_API_KEY=<token> into each Hermes profile's
#      .env via paperclip_board_key.py.
#   5. Restarting hermes so the MCP server re-reads its env.
#
# Why direct-DB-insert and not the cli-auth challenge flow?
# ---------------------------------------------------------
# The cli-auth flow needs an active session cookie. The bootstrap
# script signs up `alfred@<DOMAIN>` with a fresh password but ONLY
# persists the password to the alfred_data volume on the first run.
# Tenants seeded before that step landed have no recoverable password,
# and Better-Auth has no admin "issue a session token" endpoint we can
# call from outside. Direct-DB-insert bypasses Better-Auth — safe
# because we already read the user_id from the same DB and use the
# same sha256 hash the auth middleware verifies against.
#
# Usage
# -----
#
#   ssh root@<tenant> 'bash -s' < migrate-paperclip-board-key.sh
#
# or, equivalently:
#
#   scp migrate-paperclip-board-key.sh root@<tenant>:/tmp/
#   ssh root@<tenant> 'bash /tmp/migrate-paperclip-board-key.sh'
#
# Idempotent. Re-runs revoke the old key (by name) and mint a fresh
# one. The window when no key is valid is exactly the one transaction
# (~1ms in practice).
#
# Constraints
# -----------
#  * Tenant must have a Paperclip container running with the embedded
#    postgres on 127.0.0.1:54329 (the default config).
#  * Tenant must have an instance_admin user (created by step 6-7 of
#    bootstrap-paperclip.sh OR by signing up at paperclip.<DOMAIN>
#    manually). The CEO claim sets this role.
#  * Hermes container must be running so the post-write restart picks
#    up the new env. The script restarts hermes-main, -workers, -heavy
#    if they exist (their MCP server config reuses PAPERCLIP_API_KEY).
# =============================================================================
set -euo pipefail

LOG_PREFIX="[paperclip-board-key-migrate]"
log() { echo "$LOG_PREFIX $*"; }

PAPERCLIP_CONTAINER="${PAPERCLIP_CONTAINER:-}"
HERMES_CONTAINER="${HERMES_CONTAINER:-}"
KEY_NAME="${KEY_NAME:-hermes-mcp}"

# --- locate containers ------------------------------------------------------
resolve_container_by_service() {
    local service="$1"
    local name
    name=$(docker ps --filter "label=com.docker.compose.service=${service}" \
        --format '{{.Names}}' 2>/dev/null | head -n1 || true)
    if [[ -z "$name" ]]; then
        name=$(docker ps --format '{{.Names}}' 2>/dev/null | \
            grep -E "(^|[-_])${service}([-_]|$)" | head -n1 || true)
    fi
    echo "$name"
}

if [[ -z "$PAPERCLIP_CONTAINER" ]]; then
    PAPERCLIP_CONTAINER=$(resolve_container_by_service paperclip)
fi
if [[ -z "$PAPERCLIP_CONTAINER" ]]; then
    log "ERROR: no paperclip container running; cannot continue"
    exit 1
fi
log "paperclip container: $PAPERCLIP_CONTAINER"

if [[ -z "$HERMES_CONTAINER" ]]; then
    HERMES_CONTAINER=$(resolve_container_by_service hermes)
fi
if [[ -z "$HERMES_CONTAINER" ]]; then
    log "ERROR: no hermes container running; cannot continue"
    exit 1
fi
log "hermes container: $HERMES_CONTAINER"

# --- locate the embedded pg module path (the pnpm hash varies by build) ----
PG_MODULE=$(docker exec "$PAPERCLIP_CONTAINER" sh -c \
    'find /app/node_modules/.pnpm -maxdepth 2 -type d -name "pg@*" 2>/dev/null | head -n1' || true)
if [[ -z "$PG_MODULE" ]]; then
    log "ERROR: could not locate the pg module inside the paperclip container"
    exit 1
fi
PG_MODULE_PATH="${PG_MODULE}/node_modules/pg"
log "pg module: $PG_MODULE_PATH"

# --- step 1: mint board key by direct DB insert -----------------------------
#
# The Node script generates a fresh pcp_board_<48hex>, hashes with sha256,
# revokes any existing key with the same name (idempotency), inserts a new
# row, and prints the raw token on stdout. We pipe it to a temp file inside
# the hermes container so the token never crosses the tty (the SSH session
# would log it otherwise; the file gets chmod 600 then deleted at end).

log "step 1: minting fresh board API key"

# Drop the mint script into the paperclip container. Heredoc terminator
# is quoted so bash does NOT interpolate $VAR / <SUBSHELL> patterns
# inside the Node source — we only want PG_MODULE_PATH substituted in,
# which we do via a sed pass below. Quoting the terminator is the
# tightest way to avoid bash misreading angle-brackets inside a
# comment as redirection (`alfred@<DOMAIN>` blew up exactly this way
# in the first iteration of this script). `-i` on docker exec is
# REQUIRED so the heredoc reaches sh's stdin inside the container.
docker exec -i "$PAPERCLIP_CONTAINER" sh -c 'cat > /tmp/mint-board-key.js' <<'MINT_JS'
const crypto = require('node:crypto');
const { Client } = require("__PG_MODULE_PATH__");

const KEY_NAME = process.env.KEY_NAME || 'hermes-mcp';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

(async () => {
  const c = new Client({
    host: '127.0.0.1', port: 54329,
    user: 'paperclip', password: 'paperclip', database: 'paperclip',
  });
  await c.connect();

  // Find the instance_admin user. If multiple, pick the most-recently
  // created one — that's typically the seed user (`alfred@<DOMAIN>`),
  // BUT on home which was seeded manually before bootstrap-paperclip.sh
  // landed, it's `david@szabostuban.com`. Either is correct for our
  // purposes: a board key scoped to ANY instance_admin gives the MCP
  // server access to every company on this tenant.
  const userRes = await c.query(`
    SELECT u.id, u.email
    FROM "user" u
    INNER JOIN instance_user_roles ir ON ir.user_id = u.id
    WHERE ir.role = 'instance_admin'
    ORDER BY u.id
    LIMIT 1
  `);
  if (userRes.rows.length === 0) {
    // Fall back to any board-membership user (a tenant might have skipped
    // the instance_admin role on the seed user).
    const fallback = await c.query(`
      SELECT u.id, u.email
      FROM "user" u
      INNER JOIN company_memberships m ON m.principal_id = u.id
      WHERE m.principal_type = 'user' AND m.status = 'active'
      ORDER BY u.id LIMIT 1
    `);
    if (fallback.rows.length === 0) {
      console.error('FATAL: no board-eligible user on this tenant (no instance_admin and no active company member)');
      process.exit(2);
    }
    userRes.rows = fallback.rows;
  }
  const userId = userRes.rows[0].id;

  // Idempotency: revoke any existing key with our name. A re-run of this
  // script should leave the tenant with exactly one active key named
  // KEY_NAME.
  await c.query(
    'UPDATE board_api_keys SET revoked_at = NOW() WHERE user_id = $1 AND name = $2 AND revoked_at IS NULL',
    [userId, KEY_NAME]
  );

  const token = 'pcp_board_' + crypto.randomBytes(24).toString('hex');
  const keyHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + TTL_MS);

  const inserted = await c.query(
    `INSERT INTO board_api_keys (user_id, name, key_hash, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, KEY_NAME, keyHash, expiresAt]
  );

  // Emit a machine-parseable single-line key=value pair.
  process.stdout.write('BOARD_API_TOKEN=' + token + '\n');
  process.stderr.write('user_id=' + userId + ' key_id=' + inserted.rows[0].id + ' expires_at=' + expiresAt.toISOString() + '\n');

  await c.end();
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
MINT_JS

# Substitute the pg-module path into the placeholder. We use a fixed sentinel
# (__PG_MODULE_PATH__) rather than bash interpolation inside the heredoc so
# the heredoc terminator can stay quoted — see the comment above the heredoc
# for why quoting matters (angle-brackets in JS comments).
docker exec "$PAPERCLIP_CONTAINER" sh -c \
    "sed -i 's|__PG_MODULE_PATH__|${PG_MODULE_PATH}|g' /tmp/mint-board-key.js"

# Capture the token directly into a docker exec stdin -> file in hermes so
# it never touches our local tty/log. (The Node script writes the token to
# stdout; the host pipe goes straight into a `docker exec -i ... tee` on the
# hermes container.)
TOKEN_FILE_IN_HERMES="/tmp/paperclip-board-token-$$.env"

# Run mint, capture the stderr summary, and pipe stdout (the token line)
# straight into a 0600-permissioned file in the hermes container.
MINT_STDERR=$(mktemp)
docker exec -e KEY_NAME="$KEY_NAME" "$PAPERCLIP_CONTAINER" \
    node /tmp/mint-board-key.js 2>"$MINT_STDERR" | \
    docker exec -i "$HERMES_CONTAINER" sh -c "cat > $TOKEN_FILE_IN_HERMES && chmod 600 $TOKEN_FILE_IN_HERMES" || {
        log "ERROR: mint command failed; stderr:"
        sed 's/^/  /' "$MINT_STDERR" >&2
        rm -f "$MINT_STDERR"
        exit 1
    }

if [[ -s "$MINT_STDERR" ]]; then
    log "  mint context: $(cat "$MINT_STDERR")"
fi
rm -f "$MINT_STDERR"
docker exec "$PAPERCLIP_CONTAINER" rm -f /tmp/mint-board-key.js || true

# Verify the file in hermes is non-empty
TOKEN_LEN=$(docker exec "$HERMES_CONTAINER" sh -c "wc -c < $TOKEN_FILE_IN_HERMES" | tr -d ' ')
if [[ "${TOKEN_LEN:-0}" -lt 16 ]]; then
    log "ERROR: token file in hermes is empty or too short ($TOKEN_LEN bytes)"
    exit 1
fi
log "  token file: $TOKEN_FILE_IN_HERMES (${TOKEN_LEN} bytes)"

# --- step 2: write PAPERCLIP_API_KEY into each Hermes profile's .env --------
#
# We do the env write FROM INSIDE the hermes container so we can read the
# token file directly (no need to ship the value over docker exec stdin).
# The Hermes image already has python3 + paperclip_board_key.py is NOT
# in there yet — we ship the same `_upsert_env_key` logic inline (small
# enough to keep self-contained). If/when we standardize on bundling
# paperclip_board_key.py into the Hermes image, we can swap this for
# `python3 -m paperclip_board_key`.

log "step 2: writing PAPERCLIP_API_KEY (+ company/agent ids) into each Hermes profile's .env"

# Read PAPERCLIP_COMPANY_ID + PAPERCLIP_AGENT_ID from the host .env so we
# can seed the MCP server defaults. /opt/alfred/.env is the canonical
# source — bootstrap-paperclip.sh step 11b wrote them there. If absent
# (tenant seeded pre-PR #84 or via a different flow), we still write
# PAPERCLIP_API_KEY and let the operator add the ids manually.
HOST_ENV="${HOST_ENV:-/opt/alfred/.env}"
PAPERCLIP_COMPANY_ID_VALUE=""
PAPERCLIP_AGENT_ID_VALUE=""
if [[ -r "$HOST_ENV" ]]; then
    PAPERCLIP_COMPANY_ID_VALUE=$(grep -E "^PAPERCLIP_COMPANY_ID=" "$HOST_ENV" 2>/dev/null | head -n1 | cut -d= -f2- || true)
    PAPERCLIP_AGENT_ID_VALUE=$(grep -E "^PAPERCLIP_AGENT_ID=" "$HOST_ENV" 2>/dev/null | head -n1 | cut -d= -f2- || true)
fi

docker exec -i \
    -e PAPERCLIP_COMPANY_ID_VALUE="$PAPERCLIP_COMPANY_ID_VALUE" \
    -e PAPERCLIP_AGENT_ID_VALUE="$PAPERCLIP_AGENT_ID_VALUE" \
    "$HERMES_CONTAINER" python3 - "$TOKEN_FILE_IN_HERMES" <<'WRITE_PY'
"""Read the token from argv[1] (a 0600 file inside the hermes container)
and upsert PAPERCLIP_API_KEY=<token> into each profile's .env.

This is a self-contained copy of the env-writer logic in
paperclip_board_key.py — kept inline so this hot-fix script works against
the current Hermes image (which doesn't ship paperclip_board_key.py).
After PR #87+1 lands, this can be reduced to:

    python3 /opt/paperclip-mcp/paperclip_board_key.py
"""
import os
import sys
from pathlib import Path

token_file = Path(sys.argv[1])
token = token_file.read_text().strip()
if not token.startswith("BOARD_API_TOKEN="):
    print(f"ERROR: token file has unexpected shape (first line: {token[:32]!r})", file=sys.stderr)
    sys.exit(2)
token = token.split("=", 1)[1].strip()
if not token:
    print("ERROR: token after = is empty", file=sys.stderr)
    sys.exit(2)

HERMES_STATE = Path(os.environ.get("HERMES_HOME", "/hermes-state"))
PROFILES_DIR = HERMES_STATE / "profiles"
if not PROFILES_DIR.is_dir():
    print(f"ERROR: {PROFILES_DIR} does not exist", file=sys.stderr)
    sys.exit(2)


def upsert_env(path: Path, key: str, value: str) -> None:
    existing = path.read_text().splitlines() if path.exists() else []
    out = []
    seen = False
    for line in existing:
        s = line.strip()
        if not s or s.startswith("#"):
            out.append(line); continue
        eq = s.find("=")
        if eq < 0:
            out.append(line); continue
        k = s[:eq].strip()
        if k == key:
            out.append(f"{key}={value}"); seen = True
        else:
            out.append(line)
    if not seen:
        out.append(f"{key}={value}")
    tmp = path.with_suffix(path.suffix + ".paperclip-board.tmp")
    tmp.write_text("\n".join(out) + "\n")
    try:
        tmp.chmod(0o600)
    except PermissionError:
        pass
    os.replace(tmp, path)


company_id = (os.environ.get("PAPERCLIP_COMPANY_ID_VALUE") or "").strip()
agent_id = (os.environ.get("PAPERCLIP_AGENT_ID_VALUE") or "").strip()

written = []
for profile_dir in sorted(PROFILES_DIR.iterdir()):
    if not profile_dir.is_dir():
        continue
    env_path = profile_dir / ".env"
    upsert_env(env_path, "PAPERCLIP_API_KEY", token)
    # Seed the MCP server's default companyId / agentId so the LLM
    # doesn't need to thread UUIDs through every tool call. Skip empty
    # values — the MCP server's nonEmpty() treats them as unset.
    if company_id:
        upsert_env(env_path, "PAPERCLIP_COMPANY_ID", company_id)
    if agent_id:
        upsert_env(env_path, "PAPERCLIP_AGENT_ID", agent_id)
    written.append(env_path)
    print(f"  wrote PAPERCLIP_API_KEY -> {env_path}")

if not written:
    print("ERROR: no profile dirs found under /hermes-state/profiles", file=sys.stderr)
    sys.exit(2)

extras = []
if company_id:
    extras.append("COMPANY_ID")
if agent_id:
    extras.append("AGENT_ID")
extra_note = (" + " + " + ".join(extras)) if extras else " (COMPANY_ID/AGENT_ID skipped: not in /opt/alfred/.env)"
print(f"OK: PAPERCLIP_API_KEY{extra_note} persisted to {len(written)} profile(s)")
WRITE_PY

# Cleanup the token file inside hermes — the env was already updated.
docker exec "$HERMES_CONTAINER" rm -f "$TOKEN_FILE_IN_HERMES" || true

# --- step 2.5: patch each profile's config.yaml so the paperclip MCP
# server is registered AND its env: block passes PAPERCLIP_COMPANY_ID +
# PAPERCLIP_AGENT_ID through. config.yaml is "operator-owned" (init
# never re-renders it after first seed); tenants seeded BEFORE PR #67
# (where paperclip MCP was added to the template) don't have the block
# at all, and tenants seeded AFTER PR #67 but BEFORE this fix have the
# block but only PAPERCLIP_API_KEY in env: (no COMPANY_ID/AGENT_ID).
# The patch handles both: insert the full paperclip: block if absent,
# else add the missing env keys.
# --------------------------------------------------------------------------
log "step 2.5: patching config.yaml to register paperclip MCP + thread env vars"
docker exec -i "$HERMES_CONTAINER" python3 - <<'PATCH_PY'
"""Two-mode idempotent patch on each profile's config.yaml:

  Mode A — `paperclip:` block is absent under `mcp_servers:`. Insert
  the full block right before the `plugins:` (or end-of-mcp_servers)
  marker. Source: matches the post-PR #67 template.

  Mode B — `paperclip:` block is present but env: is missing
  PAPERCLIP_COMPANY_ID / PAPERCLIP_AGENT_ID (tenant on the pre-fix
  template). Append the two ${VAR} substitution lines.

Both modes write only ${VAR} substitutions — actual UUIDs live in
the per-profile .env (written in step 2). config.yaml stays
operator-portable.

Why we patch in-place rather than `hermes mcp add`:
  * `hermes mcp add` is interactive (`Enable all 40 tools? [y/N]`)
    and the prompt cancels silently on closed stdin. The memory note
    says `printf 'y\\ny\\n' | hermes mcp add ...` works but is finicky.
  * config.yaml is YAML with a stable shape; a small regex insert is
    deterministic and visible in the next operator review.
  * We only patch profiles whose config.yaml exists, so a future
    main-only build doesn't break.
"""
import os
import re
from pathlib import Path

PROFILES_DIR = Path("/hermes-state/profiles")

# Mode A — full block to insert when paperclip: is absent under
# mcp_servers:. Matches the post-PR #67 template exactly.
PAPERCLIP_FULL_BLOCK = """  paperclip:
    command: node
    args:
    - /opt/paperclip-mcp/node_modules/@paperclipai/mcp-server/dist/stdio.js
    env:
      PAPERCLIP_API_URL: http://paperclip:3100/api
      PAPERCLIP_API_KEY: ${PAPERCLIP_API_KEY}
      PAPERCLIP_COMPANY_ID: "${PAPERCLIP_COMPANY_ID}"
      PAPERCLIP_AGENT_ID: "${PAPERCLIP_AGENT_ID}"
    timeout: 120
    connect_timeout: 60
"""

# Mode B — env: keys to add if the block is present but missing them.
WANTED_ENV_KEYS = [
    ("PAPERCLIP_COMPANY_ID", "${PAPERCLIP_COMPANY_ID}"),
    ("PAPERCLIP_AGENT_ID", "${PAPERCLIP_AGENT_ID}"),
]

# Matches the paperclip: block boundary: from its header down to the
# next 2-space-indented mcp_servers key OR a top-level key (plugins:,
# etc.). Greedy on header, lazy on body so we stop at the next sibling.
PAPERCLIP_BLOCK_RE = re.compile(
    r"(^  paperclip:\n"
    r"(?:    [^\n]*\n)*"
    r"    env:\n"
    r"(?:      [^\n]*\n)*?)"
    r"(?=    [a-z]|^[a-z]|^$|^  [a-z])",
    re.MULTILINE,
)

# Matches the END of the mcp_servers: section so we know where to
# insert the full paperclip block in Mode A. Anchors on the next
# top-level key (typically `plugins:`) OR end-of-file when mcp_servers
# is the last top-level section (live-observed on joe's workers profile
# 2026-05-27 — its template has mcp_servers as the final block).
END_OF_MCP_SERVERS_RE = re.compile(
    r"(^mcp_servers:\n(?:  [^\n]*\n|    [^\n]*\n|      [^\n]*\n)*?)(?=^[a-z][a-z_]*:|\Z)",
    re.MULTILINE,
)

added_blocks = 0
patched_envs = 0
already_complete = 0

for profile_dir in sorted(PROFILES_DIR.iterdir()):
    if not profile_dir.is_dir():
        continue
    cfg_path = profile_dir / "config.yaml"
    if not cfg_path.exists():
        continue
    text = cfg_path.read_text()

    m = PAPERCLIP_BLOCK_RE.search(text)
    if not m:
        # Mode A: insert the full block at the end of mcp_servers:.
        m2 = END_OF_MCP_SERVERS_RE.search(text)
        if not m2:
            # No mcp_servers: section either — this profile is too
            # different from the template to patch safely. Leave it.
            print(f"  {cfg_path}: no mcp_servers: section — skipping (manual review)")
            continue
        # Insert PAPERCLIP_FULL_BLOCK right before the next top-level key.
        new_text = text[:m2.end(1)] + PAPERCLIP_FULL_BLOCK + text[m2.end(1):]
        tmp = cfg_path.with_suffix(cfg_path.suffix + ".paperclip-board.tmp")
        tmp.write_text(new_text)
        try:
            tmp.chmod(0o640)
        except PermissionError:
            pass
        os.replace(tmp, cfg_path)
        print(f"  {cfg_path}: inserted full paperclip: block")
        added_blocks += 1
        continue

    # Mode B: paperclip: is present, ensure env keys.
    block = m.group(1)
    new_block = block
    added = []
    for key, val in WANTED_ENV_KEYS:
        if f"      {key}:" in new_block:
            continue
        if new_block.endswith("\n"):
            new_block = new_block + f"      {key}: \"{val}\"\n"
        else:
            new_block = new_block + f"\n      {key}: \"{val}\"\n"
        added.append(key)
    if not added:
        already_complete += 1
        continue
    new_text = text[:m.start(1)] + new_block + text[m.end(1):]
    tmp = cfg_path.with_suffix(cfg_path.suffix + ".paperclip-board.tmp")
    tmp.write_text(new_text)
    try:
        tmp.chmod(0o640)
    except PermissionError:
        pass
    os.replace(tmp, cfg_path)
    print(f"  {cfg_path}: added {', '.join(added)}")
    patched_envs += 1

print(
    f"OK: inserted={added_blocks} env-patched={patched_envs} "
    f"already-complete={already_complete}"
)
PATCH_PY

# --- step 3: restart hermes so the MCP server re-reads its env --------------
#
# Hermes spawns the @paperclipai/mcp-server stdio subprocess on startup;
# the subprocess inherits its env from the parent process, which reads
# the per-profile .env at boot. A graceful restart is enough.

log "step 3: restarting hermes container to pick up the new env"
docker restart "$HERMES_CONTAINER" >/dev/null
log "  hermes restarted"

log "migration complete; verify with a Paperclip MCP tool call from Hermes"
