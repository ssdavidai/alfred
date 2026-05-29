-- 0003_tailscale_connection — issue #109 PR 1.
--
-- A singleton row holds the live state of THIS tenant's join to the
-- principal's tailnet. The Tailscale sidecar (docker-compose `tailscale`
-- service, gated by `profiles: [tailscale]`) is OFF by default; this table
-- records the lifecycle once the principal flips the `/connections` card
-- on. PR 2 lands the ctrl-api routes that read/write this row; PR 3 the
-- web card that surfaces it. PR 1 ships only the schema so the runner
-- order is locked in before any code reads/writes it.
--
-- Why singleton? Per the spec §3.5 a tenant joins exactly ONE tailnet at
-- a time. Multiple historical rows would invite "which row is current?"
-- ambiguity at the route layer. A `CHECK(id=1)` PK pins the table to a
-- single row; the route layer upserts. Historical audit lives in the
-- `audit` table (POST /api/v1/audit, signal-action events:
-- tailscale_connect_initiated / _completed / _disconnect / _cert_regen /
-- _serve_restored), which is the canonical "what happened when" ledger.
--
-- See packages/ctrl/CLAUDE.md and CLAUDE.md §Storage Architecture for the
-- promotion contract: this is machine bookkeeping (no principal reads it
-- directly), so it lives in state.db, not the vault.

CREATE TABLE IF NOT EXISTS tailscale_connection (
  id                   INTEGER PRIMARY KEY CHECK(id=1),
  -- One of: disabled | starting | authenticating | connected | error.
  -- 'disabled' is the shipped default (sidecar profile not running);
  -- transitions are driven by the ctrl-api routes in PR 2.
  state                TEXT NOT NULL DEFAULT 'disabled',
  -- The 100.x.x.x address Tailscale assigned to this node, or NULL.
  tailnet_ip           TEXT,
  -- The full *.tail-<id>.ts.net DNS name, or NULL.
  tailnet_hostname     TEXT,
  -- Unix ms timestamp the most recent auth-key was redeemed (path A
  -- only; path C — device-auth URL — leaves this NULL).
  authkey_used_at      INTEGER,
  -- When state='authenticating', the login.tailscale.com/a/<code> URL
  -- the principal must visit. Cleared once state flips to 'connected'.
  auth_url             TEXT,
  -- Unix ms timestamp of the last `tailscale status --json` probe;
  -- the route caches for 2s to absorb the dashboard poller.
  last_status_probe_at INTEGER,
  -- One-line error message when state='error'; NULL otherwise.
  last_error           TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
