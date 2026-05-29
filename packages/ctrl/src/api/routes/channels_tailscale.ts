// /api/v1/channels/tailscale/* — Tailscale channel routes (issue #109 PR 2).
//
// Spec: docs/specs/issue-109-tailscale-via-ui.md.
//
// What this file ships
// --------------------
// The six routes that drive the off-by-default Tailscale sidecar (declared by
// `profiles: ["tailscale"]` in PR 1's docker-compose.yaml):
//
//   GET    /api/v1/channels/tailscale/status      — live lifecycle (fail-soft).
//   POST   /api/v1/channels/tailscale/connect     — bring the sidecar up.
//   POST   /api/v1/channels/tailscale/disconnect  — logout + stop.
//   GET    /api/v1/channels/tailscale/cert        — PR 4 stub (501).
//   POST   /api/v1/channels/tailscale/serve       — PR 4 stub (501).
//   GET    /api/v1/channels/tailscale/peers       — peer list (fail-soft).
//
// Architecture
// ------------
// The `tailscale_connection` table (singleton, PR 1 migration 0003) is the
// authoritative lifecycle state.db row. This module is its sole writer.
// Live state on the sidecar is probed via `docker exec
// alfred-black-tailscale-1 tailscale status --json`; probe failures NEVER
// 500 — they fall through to the cached row + a `last_error`/`reason`
// field. The dashboard polls /status; the route caches at the table level
// (last_status_probe_at) so spammy pollers don't fork-storm.
//
// Every write is audited (action_type `tailscale_*`) via the existing
// `appendAudit` helper so the audit ledger reflects who turned the tailnet
// on, when, and from where.
//
// Why direct `docker compose` from ctrl-api?
// ------------------------------------------
// ctrl-api has the docker socket bind-mounted (see compose `volumes`); the
// `helpers.ts` patterns (`dockerComposeCmd`, `dockerExec`) already gate
// concurrent docker forks under a 8-slot semaphore. We reuse those.
//
// PR boundary
// -----------
// PR 3 (the `/connections` web card) drives all six routes from the dash;
// PR 4 (Caddy + Tailscale Serve) fills in /cert + /serve. Neither lands here.

import { addRoute } from "../server.js";
import { sendJson, ValidationError, ApiError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import { appendAudit } from "./state.js";
import {
  COMPOSE_DIR,
  dockerComposeCmd,
  dockerExec,
} from "../helpers.js";
import fs from "node:fs";

// ── Constants ─────────────────────────────────────────────────────────────

/**
 * Compose service name for the Tailscale sidecar (matches PR 1's
 * `services.tailscale` block). The literal container name docker compose
 * synthesises is `<project>-tailscale-1` — by default
 * `alfred-black-tailscale-1`, configurable via COMPOSE_PROJECT_NAME.
 */
const TAILSCALE_SERVICE = "tailscale";

/**
 * Live container name for `docker exec` calls. Mirrors the pattern in
 * channels_paperclip.ts (`docker exec alfred-black-hermes-1 …`). Overridable
 * for tests + non-default compose project names.
 */
const TAILSCALE_CONTAINER =
  process.env.TAILSCALE_CONTAINER ?? "alfred-black-tailscale-1";

/**
 * Vaultwarden item name for the auth-key Path A flow. Sir's UI surfaces this
 * label in the credentials list.
 */
const VAULT_ITEM_NAME = "Tailscale Auth Key";

/** Vault-cli (bw serve) base URL — same default as routes/vaultwarden.ts. */
const VAULT_CLI_URL = process.env.VAULT_CLI_URL ?? "http://vault-cli:8087";

/** `.env` file the compose run reads — same path the bootstrap script writes. */
const ENV_PATH = `${COMPOSE_DIR}/.env`;

/** Spec §5.1: cache the status probe for ~2s to absorb the dashboard poller. */
const STATUS_CACHE_MS = 2_000;

// ── Lifecycle row helpers ────────────────────────────────────────────────

export type TailscaleState =
  | "disabled"
  | "starting"
  | "authenticating"
  | "connected"
  | "error";

export interface TailscaleConnectionRow {
  id: number;
  state: TailscaleState;
  tailnet_ip: string | null;
  tailnet_hostname: string | null;
  authkey_used_at: number | null;
  auth_url: string | null;
  last_status_probe_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** Read the singleton lifecycle row, seeding it if absent. */
export function getTailscaleRow(): TailscaleConnectionRow {
  const db = getStateDb();
  const row = db
    .prepare("SELECT * FROM tailscale_connection WHERE id = 1")
    .get() as TailscaleConnectionRow | undefined;
  if (row) return row;
  const now = Date.now();
  db.prepare(
    `INSERT INTO tailscale_connection
       (id, state, created_at, updated_at)
     VALUES (1, 'disabled', ?, ?)`,
  ).run(now, now);
  return db
    .prepare("SELECT * FROM tailscale_connection WHERE id = 1")
    .get() as TailscaleConnectionRow;
}

/** Patch a subset of the lifecycle row. Always bumps updated_at. */
export function updateTailscaleRow(
  patch: Partial<Omit<TailscaleConnectionRow, "id" | "created_at" | "updated_at">>,
): TailscaleConnectionRow {
  getTailscaleRow(); // ensure seeded
  const db = getStateDb();
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    values.push(v ?? null);
  }
  fields.push("updated_at = ?");
  values.push(Date.now());
  db.prepare(
    `UPDATE tailscale_connection SET ${fields.join(", ")} WHERE id = 1`,
  ).run(...(values as Parameters<ReturnType<typeof db.prepare>["run"]>));
  return db
    .prepare("SELECT * FROM tailscale_connection WHERE id = 1")
    .get() as TailscaleConnectionRow;
}

// ── Live probe (fail-soft) ───────────────────────────────────────────────

interface TailscaleStatusJson {
  Self?: {
    HostName?: string;
    DNSName?: string;
    TailscaleIPs?: string[];
    Online?: boolean;
  };
  Peer?: Record<
    string,
    {
      ID?: string;
      HostName?: string;
      DNSName?: string;
      OS?: string;
      TailscaleIPs?: string[];
      Online?: boolean;
      LastSeen?: string;
    }
  >;
  BackendState?: string;
  AuthURL?: string;
  MagicDNSSuffix?: string;
  CurrentTailnet?: { Name?: string; MagicDNSSuffix?: string };
}

interface ProbeResult {
  ok: true;
  status: TailscaleStatusJson;
}
interface ProbeFailure {
  ok: false;
  reason: string;
}

/**
 * Best-effort `tailscale status --json` against the sidecar. On any failure
 * (container absent, exec error, malformed JSON) returns `{ok: false}` with a
 * human-readable reason. Never throws — the GET /status route is required to
 * stay fail-soft per spec §5.1.
 *
 * Override surface for tests: `_setProbeForTests(fn)`.
 */
let _probeOverride:
  | (() => Promise<ProbeResult | ProbeFailure>)
  | null = null;
export function _setTailscaleProbeForTests(
  fn: (() => Promise<ProbeResult | ProbeFailure>) | null,
): void {
  _probeOverride = fn;
}

async function probeTailscaleStatus(): Promise<ProbeResult | ProbeFailure> {
  if (_probeOverride) return _probeOverride();
  try {
    const raw = await dockerExec(TAILSCALE_SERVICE, [
      "tailscale",
      "status",
      "--json",
    ]);
    const trimmed = raw.trim();
    if (!trimmed) {
      return { ok: false, reason: "tailscale status returned empty output" };
    }
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return { ok: false, reason: "tailscale status returned non-JSON" };
    }
    if (typeof json !== "object" || json === null) {
      return { ok: false, reason: "tailscale status returned non-object" };
    }
    return { ok: true, status: json as TailscaleStatusJson };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `probe failed: ${msg}` };
  }
}

/**
 * Reconcile the live probe with the singleton row. Reads the BackendState
 * field (`Running` → connected, `NeedsLogin` → authenticating, etc.) and
 * upserts hostname/IP/auth_url as it goes. Cached at the table level: if a
 * probe ran within STATUS_CACHE_MS we return the row as-is.
 */
async function reconcileFromProbe(): Promise<TailscaleConnectionRow> {
  const row = getTailscaleRow();
  // If the sidecar is disabled, never probe — there's nothing to talk to.
  if (row.state === "disabled") return row;
  const now = Date.now();
  if (row.last_status_probe_at && now - row.last_status_probe_at < STATUS_CACHE_MS) {
    return row;
  }
  const probe = await probeTailscaleStatus();
  if (!probe.ok) {
    return updateTailscaleRow({
      state: "error",
      last_status_probe_at: now,
      last_error: probe.reason,
    });
  }
  const s = probe.status;
  const backend = s.BackendState ?? "";
  // Defaults that map every BackendState we care about onto our lifecycle
  // enum. Anything we don't recognise stays in the current state but clears
  // last_error.
  const patch: Partial<TailscaleConnectionRow> = {
    last_status_probe_at: now,
    last_error: null,
  };
  if (s.Self?.TailscaleIPs && s.Self.TailscaleIPs.length > 0) {
    patch.tailnet_ip = s.Self.TailscaleIPs[0];
  }
  if (s.Self?.DNSName) {
    // Strip the trailing dot — tailscale emits `host.tailnet.ts.net.`.
    patch.tailnet_hostname = s.Self.DNSName.replace(/\.$/, "");
  } else if (s.Self?.HostName) {
    patch.tailnet_hostname = s.Self.HostName;
  }
  switch (backend) {
    case "Running":
      patch.state = "connected";
      patch.auth_url = null;
      break;
    case "NeedsLogin":
    case "NeedsMachineAuth":
      patch.state = "authenticating";
      if (s.AuthURL) patch.auth_url = s.AuthURL;
      break;
    case "Starting":
    case "NoState":
      patch.state = "starting";
      break;
    case "Stopped":
      patch.state = "disabled";
      break;
    default:
      // Unknown BackendState — keep current.
      break;
  }
  return updateTailscaleRow(patch);
}

// ── `.env` upsert (for TAILSCALE_AUTHKEY + TAILSCALE_ENABLED flips) ──────

/**
 * Upsert a single KEY=value line in /srv/alfred-black/.env. Idempotent: if
 * the key exists, the line is rewritten; otherwise it's appended. Mirrors
 * the pattern in channels_paperclip.ts.
 */
function upsertEnvKey(path: string, key: string, value: string): void {
  let raw = "";
  try {
    raw = fs.readFileSync(path, "utf-8");
  } catch {
    /* file may not exist on a fresh tenant */
  }
  const lines = raw.split("\n");
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    if (t.slice(0, eq).trim() === key) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) {
    if (raw.length > 0 && !raw.endsWith("\n")) lines.push("");
    lines.push(`${key}=${value}`);
  }
  const out = lines.join("\n");
  fs.writeFileSync(path, out.endsWith("\n") ? out : out + "\n", { mode: 0o600 });
}

// ── Vaultwarden write (Path A authkey persistence) ───────────────────────

/**
 * Write the auth key to Vaultwarden so it lives in the principal's vault,
 * not just /srv/alfred-black/.env. Best-effort: if vault-cli is unreachable
 * we still proceed (the .env update is the authoritative store for compose
 * interpolation). Returns true on success, false otherwise.
 *
 * Test override: `_setVaultWriteForTests`.
 */
let _vaultWriteOverride: ((value: string) => Promise<boolean>) | null = null;
export function _setVaultWriteForTests(
  fn: ((value: string) => Promise<boolean>) | null,
): void {
  _vaultWriteOverride = fn;
}

async function writeAuthKeyToVault(authKey: string): Promise<boolean> {
  if (_vaultWriteOverride) return _vaultWriteOverride(authKey);
  try {
    // Search for an existing item by name; if present, update it.
    const search = await fetch(
      `${VAULT_CLI_URL}/list/object/items?search=${encodeURIComponent(
        VAULT_ITEM_NAME,
      )}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!search.ok) return false;
    const searchJson = (await search.json()) as {
      data?: { data?: Array<{ id?: string; name?: string }> };
    };
    const existing = (searchJson?.data?.data ?? []).find(
      (it) => it.name === VAULT_ITEM_NAME,
    );

    if (existing?.id) {
      // PUT shape mirrors routes/vaultwarden.ts — fetch the full item, patch
      // the login.password, write it back.
      const cur = await fetch(`${VAULT_CLI_URL}/object/item/${existing.id}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!cur.ok) return false;
      const curJson = (await cur.json()) as { data?: Record<string, unknown> };
      const item = (curJson?.data ?? {}) as Record<string, unknown>;
      const login = ((item.login as Record<string, unknown>) ?? {}) as Record<
        string,
        unknown
      >;
      login.password = authKey;
      item.login = login;
      const put = await fetch(`${VAULT_CLI_URL}/object/item/${existing.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
        signal: AbortSignal.timeout(10_000),
      });
      return put.ok;
    }

    // Create a fresh item.
    const create = await fetch(`${VAULT_CLI_URL}/object/item`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: 1, // login
        name: VAULT_ITEM_NAME,
        notes: "Tailscale auth key for the home-alfred-black sidecar.",
        favorite: false,
        reprompt: 0,
        login: {
          username: null,
          password: authKey,
          uris: [],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return create.ok;
  } catch {
    return false;
  }
}

// ── Audit helpers ────────────────────────────────────────────────────────

function auditWrite(actionType: string, summary: string, payload?: unknown): void {
  try {
    appendAudit({
      action_type: actionType,
      actor: "alfred-ctrl-api",
      source: "channels-tailscale",
      target_kind: "channel",
      target_path: "tailscale",
      summary,
      payload,
    });
  } catch (err) {
    // appendAudit is best-effort by default; this catch only fires if the
    // appendAudit internal swallow misses, which shouldn't happen. Logged
    // but not surfaced — the principal-facing action already succeeded.
    console.warn(
      "[channels_tailscale] audit append failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── Body shapes ──────────────────────────────────────────────────────────

interface ConnectBody {
  /** Auth key for Path A. When omitted, Path C (device-auth URL) is used. */
  authkey?: string;
}

function parseConnectBody(raw: unknown): ConnectBody {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object") {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  if (b.authkey !== undefined) {
    if (typeof b.authkey !== "string") {
      throw new ValidationError("authkey must be a string when present");
    }
    if (b.authkey.trim().length === 0) {
      throw new ValidationError("authkey must be non-empty when present");
    }
    // Tailscale auth keys are `tskey-auth-<id>-<secret>` (40+ chars).
    // We don't enforce the prefix here — the sidecar will reject a malformed
    // key at boot — but we strip whitespace as a courtesy.
    return { authkey: b.authkey.trim() };
  }
  return {};
}

// ── Routes ───────────────────────────────────────────────────────────────

export function registerChannelsTailscaleRoutes(): void {
  // ──────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/tailscale/status
  //
  // Spec §5.1: fail-soft lifecycle view. Returns the singleton row plus an
  // optional `live` probe result. Never 500s — every failure path falls
  // through to `{state: "error", reason: "..."}` in the row.
  // ──────────────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/channels/tailscale/status", async ({ res }) => {
    const row = await reconcileFromProbe();
    sendJson(res, 200, {
      state: row.state,
      tailnet_ip: row.tailnet_ip,
      tailnet_hostname: row.tailnet_hostname,
      auth_url: row.auth_url,
      authkey_used_at: row.authkey_used_at,
      last_status_probe_at: row.last_status_probe_at,
      last_error: row.last_error,
      // Spec §5.1: the row's `reason` aliases last_error so the UI doesn't
      // need to special-case the column name.
      reason: row.last_error,
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/tailscale/connect
  //
  // Body: { authkey?: string }
  //
  // Path A (authkey provided):
  //   1. Write to Vaultwarden ("Tailscale Auth Key") — best-effort.
  //   2. Upsert TAILSCALE_AUTHKEY + TAILSCALE_ENABLED=true in /srv/alfred-black/.env.
  //   3. `docker compose --profile tailscale up -d tailscale`.
  //   4. Row → state='starting', authkey_used_at=now.
  //
  // Path C (no authkey):
  //   1. Upsert TAILSCALE_ENABLED=true (no AUTHKEY).
  //   2. `docker compose --profile tailscale up -d tailscale`.
  //   3. Row → state='authenticating'. The /status route's probe will
  //      reconcile AuthURL on the next call.
  //
  // Idempotent: if state is already 'connected', returns 409 with a clear
  // message rather than silently re-running. The principal can /disconnect
  // first.
  // ──────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/tailscale/connect", async ({ res, body }) => {
    const parsed = parseConnectBody(body);
    const current = getTailscaleRow();
    if (current.state === "connected") {
      throw new ApiError(
        409,
        "ALREADY_CONNECTED",
        "Tailscale is already connected. Disconnect first if you want to re-key.",
      );
    }

    let vaultOk: boolean | null = null;
    const hasAuthKey = typeof parsed.authkey === "string";

    if (hasAuthKey) {
      // Path A — Vaultwarden first, .env second.
      vaultOk = await writeAuthKeyToVault(parsed.authkey!);
      upsertEnvKey(ENV_PATH, "TAILSCALE_AUTHKEY", parsed.authkey!);
    }
    upsertEnvKey(ENV_PATH, "TAILSCALE_ENABLED", "true");

    // Mark the row before the docker call so a /status poll mid-launch sees
    // a sensible state rather than `disabled`.
    updateTailscaleRow({
      state: hasAuthKey ? "starting" : "authenticating",
      authkey_used_at: hasAuthKey ? Date.now() : null,
      last_error: null,
      auth_url: null,
    });

    try {
      await dockerComposeCmd([
        "--profile",
        "tailscale",
        "up",
        "-d",
        TAILSCALE_SERVICE,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updateTailscaleRow({ state: "error", last_error: msg });
      auditWrite(
        "tailscale_connect_failed",
        `Failed to bring up tailscale sidecar: ${msg}`,
        { path: hasAuthKey ? "A" : "C" },
      );
      throw new ApiError(
        502,
        "DOCKER_COMPOSE_FAILED",
        `docker compose up tailscale failed: ${msg}`,
      );
    }

    auditWrite(
      "tailscale_connect_initiated",
      hasAuthKey
        ? "Tailscale sidecar starting with provided auth key"
        : "Tailscale sidecar starting; awaiting device-auth URL",
      { path: hasAuthKey ? "A" : "C", vault_write_ok: vaultOk },
    );

    const row = getTailscaleRow();
    sendJson(res, 200, {
      ok: true,
      state: row.state,
      path: hasAuthKey ? "A" : "C",
      vault_write_ok: vaultOk,
      auth_url: row.auth_url,
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/tailscale/disconnect
  //
  //   1. `docker exec alfred-black-tailscale-1 tailscale logout`
  //   2. `docker exec alfred-black-tailscale-1 tailscale down`
  //   3. `docker compose stop tailscale`
  //   4. Row → state='disabled', clears auth_url + tailnet fields.
  //
  // Each docker step is best-effort: a missing container or already-down
  // sidecar still completes the disconnect cleanly.
  // ──────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/tailscale/disconnect", async ({ res }) => {
    const errors: string[] = [];
    // Best-effort logout (clears tailnet keys).
    try {
      await dockerExec(TAILSCALE_SERVICE, ["tailscale", "logout"]);
    } catch (err) {
      errors.push(`logout: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Best-effort down (brings interface down).
    try {
      await dockerExec(TAILSCALE_SERVICE, ["tailscale", "down"]);
    } catch (err) {
      errors.push(`down: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Stop the compose service.
    try {
      await dockerComposeCmd(["stop", TAILSCALE_SERVICE]);
    } catch (err) {
      errors.push(
        `compose stop: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Best-effort: flip TAILSCALE_ENABLED back to false so a subsequent
    // `docker compose up -d` doesn't re-spawn the profile.
    try {
      upsertEnvKey(ENV_PATH, "TAILSCALE_ENABLED", "false");
    } catch {
      /* .env may not exist in tests */
    }

    const row = updateTailscaleRow({
      state: "disabled",
      tailnet_ip: null,
      tailnet_hostname: null,
      auth_url: null,
      last_error: errors.length > 0 ? errors.join("; ") : null,
    });

    auditWrite(
      "tailscale_disconnect",
      errors.length > 0
        ? `Tailscale sidecar disconnected with warnings: ${errors.join("; ")}`
        : "Tailscale sidecar disconnected cleanly",
      { errors },
    );

    sendJson(res, 200, {
      ok: true,
      state: row.state,
      warnings: errors,
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/tailscale/cert
  //
  // PR 4 (Caddy + Funnel ingress) lands the LE cert passthrough. PR 2
  // returns 501 so callers wiring against the catalogue see the explicit
  // shape rather than a 404.
  // ──────────────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/channels/tailscale/cert", async ({ res }) => {
    sendJson(res, 501, {
      error: {
        code: "NOT_IMPLEMENTED",
        message: "Tailscale cert passthrough lands in #109 PR 4.",
      },
      deferred: "PR4",
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/tailscale/serve
  //
  // Tailscale Serve config (the per-tenant `https://home-alfred-black.<tailnet>.ts.net`
  // ingress) lands in PR 4 with the Caddy story.
  // ──────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/tailscale/serve", async ({ res }) => {
    sendJson(res, 501, {
      error: {
        code: "NOT_IMPLEMENTED",
        message: "Tailscale Serve configuration lands in #109 PR 4.",
      },
      deferred: "PR4",
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // GET /api/v1/channels/tailscale/peers
  //
  // List the peers from `tailscale status --json`. Fail-soft: a probe
  // failure returns `{peers: [], reason: "..."}` so the UI can render
  // "no peers yet" without an error toast.
  // ──────────────────────────────────────────────────────────────────────
  addRoute("GET", "/api/v1/channels/tailscale/peers", async ({ res }) => {
    const row = getTailscaleRow();
    if (row.state === "disabled") {
      sendJson(res, 200, { peers: [], reason: "Tailscale is disabled" });
      return;
    }
    const probe = await probeTailscaleStatus();
    if (!probe.ok) {
      sendJson(res, 200, { peers: [], reason: probe.reason });
      return;
    }
    const peerMap = probe.status.Peer ?? {};
    const peers = Object.values(peerMap).map((p) => ({
      id: p.ID ?? null,
      hostname: p.HostName ?? null,
      dns_name: (p.DNSName ?? "").replace(/\.$/, "") || null,
      os: p.OS ?? null,
      tailscale_ips: p.TailscaleIPs ?? [],
      online: p.Online ?? false,
      last_seen: p.LastSeen ?? null,
    }));
    sendJson(res, 200, { peers });
  });
}
