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
//   POST   /api/v1/channels/tailscale/cert        — PR 4 LE-via-Tailscale cert issue.
//   POST   /api/v1/channels/tailscale/serve       — PR 4 Tailscale Serve (tailnet-only).
//   POST   /api/v1/channels/tailscale/funnel      — PR 4 Tailscale Funnel (public).
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
import path from "node:path";

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

// ── PR 4: cert + serve + funnel ──────────────────────────────────────────
//
// `tailscale cert` writes a `<domain>.crt` + `<domain>.key` pair into the
// sidecar's working directory; we shuffle them across to Caddy's bind
// mount so the active web server can pick them up. Caddy already imports
// `tailscale-snippets/*.caddy` (see Caddyfile + docker-compose.yaml), so
// the cert route also drops a per-domain snippet there and triggers
// `caddy reload`.
//
// The compose-side paths and the in-Caddy paths are deliberately split:
//   - host side: `${COMPOSE_DIR}/caddy/tailscale-{certs,snippets}/`
//   - caddy view: `/tailscale-certs/` and `/tailscale-snippets/`
// ctrl-api lives next to the docker socket; it writes via the host
// path because that's what's bind-mounted by docker compose.
//
// The directories are seeded by bootstrap.sh (.gitkeep'd in the repo)
// so the first `caddy reload` after PR 4 lands doesn't fail on a
// missing glob target.

/** Host path to the Caddy-shared bind mount where `.crt`+`.key` land. */
const CERT_HOST_DIR = `${COMPOSE_DIR}/caddy/tailscale-certs`;

/** Host path to the Caddy snippet directory imported by Caddyfile. */
const SNIPPET_HOST_DIR = `${COMPOSE_DIR}/caddy/tailscale-snippets`;

/** Path Caddy sees in the certs bind mount (used inside snippet files). */
const CERT_CADDY_DIR = "/tailscale-certs";

/** Compose service name for Caddy — used for the reload `docker exec` call. */
const CADDY_SERVICE = "caddy";

/** Compose service name for Tailscale — alias of TAILSCALE_SERVICE for symmetry. */
// (kept inline below — same value as TAILSCALE_SERVICE)

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

// ── PR 4 body parsers ────────────────────────────────────────────────────

/**
 * Restrictive hostname check. We're going to feed this straight to
 * `tailscale cert` AND use it as a filename. Allow only a-z, 0-9, dot, hyphen.
 * The MagicDNS namespace is `<host>.<tailnet>.ts.net` so the longest live
 * domain we'd see is ~63 chars × 3 labels = ~250.
 */
function parseDomainBody(raw: unknown): string {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new ValidationError("body must be a JSON object with `domain`");
  }
  const b = raw as Record<string, unknown>;
  const domain = b.domain;
  if (typeof domain !== "string" || domain.trim().length === 0) {
    throw new ValidationError("`domain` must be a non-empty string");
  }
  const d = domain.trim();
  if (d.length > 253) {
    throw new ValidationError("`domain` is too long");
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(d)) {
    throw new ValidationError(
      "`domain` must be a valid hostname (lowercase letters, digits, hyphen, dot)",
    );
  }
  // Additional guard — path traversal in filenames.
  if (d.includes("/") || d.includes("..") || d.startsWith(".")) {
    throw new ValidationError("`domain` must not contain path separators");
  }
  return d;
}

interface ServeBody {
  port: number;
  path?: string;
}
function parseServeBody(raw: unknown): ServeBody {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.port !== "number" || !Number.isInteger(b.port)) {
    throw new ValidationError("`port` must be an integer");
  }
  if (b.port < 1 || b.port > 65535) {
    throw new ValidationError("`port` must be in 1..65535");
  }
  let p: string | undefined;
  if (b.path !== undefined && b.path !== null) {
    if (typeof b.path !== "string") {
      throw new ValidationError("`path` must be a string when present");
    }
    p = b.path.startsWith("/") ? b.path : `/${b.path}`;
  }
  return { port: b.port, path: p };
}

interface FunnelBody {
  port: number;
}
function parseFunnelBody(raw: unknown): FunnelBody {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.port !== "number" || !Number.isInteger(b.port)) {
    throw new ValidationError("`port` must be an integer");
  }
  if (b.port < 1 || b.port > 65535) {
    throw new ValidationError("`port` must be in 1..65535");
  }
  return { port: b.port };
}

/**
 * Throws 503 SIDECAR_DOWN when the sidecar isn't reachable. Used by the
 * three PR 4 routes (cert / serve / funnel) which can't do anything useful
 * without the tailscale CLI alive on the other end of the socket.
 *
 * Implementation: a probe of `tailscale status --json` — if that's fine the
 * sidecar's listener is up. The probe is mocked by tests via
 * `_setTailscaleProbeForTests`, so this stays exercise-able without docker.
 */
async function ensureSidecarRunning(): Promise<void> {
  const probe = await probeTailscaleStatus();
  if (!probe.ok) {
    throw new ApiError(
      503,
      "SIDECAR_DOWN",
      `Tailscale sidecar is not reachable: ${probe.reason}`,
    );
  }
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
  // POST /api/v1/channels/tailscale/cert  — issue #109 PR 4
  //
  // Body: { domain: string }
  //
  // Issues a Let's Encrypt cert *via Tailscale* (the tailnet's MagicDNS
  // names get LE certs for free through Tailscale's HTTPS feature).
  // Flow:
  //   1. Sidecar must be running — 503 SIDECAR_DOWN otherwise.
  //   2. `docker exec tailscale tailscale cert <domain>` writes a
  //      <domain>.crt + <domain>.key pair into the sidecar's CWD.
  //   3. We `cat` them out and write them to ${COMPOSE_DIR}/caddy/
  //      tailscale-certs/<domain>.{crt,key} — the same path Caddy sees
  //      as /tailscale-certs/<domain>.{crt,key} via the bind mount.
  //   4. Drop a per-domain snippet at ${COMPOSE_DIR}/caddy/
  //      tailscale-snippets/<domain>.caddy that defines the site block
  //      with `tls /tailscale-certs/<d>.crt /tailscale-certs/<d>.key`.
  //   5. `docker exec caddy caddy reload --config /etc/caddy/Caddyfile`
  //      to pick up the new snippet.
  //
  // Returns: { ok, domain, cert_path, key_path, expires_at }.
  // expires_at is read off the cert's `Not After` field via openssl
  // when available; falls back to null when the tool is absent.
  //
  // First-issue can take 5-30s (LE HTTP-01 round-trip via Tailscale's
  // edge); we don't add a custom timeout here because dockerExec's
  // default 30s is the floor we need anyway and the test mocks dockerExec
  // wholesale.
  // ──────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/tailscale/cert", async ({ res, body }) => {
    const domain = parseDomainBody(body);
    await ensureSidecarRunning();

    let certPem = "";
    let keyPem = "";
    try {
      // `tailscale cert --cert-file=... --key-file=...` writes to disk inside
      // the sidecar; we'd then need a second exec to read it. Easier: pipe
      // both to stdout via `-` markers, which the CLI doesn't support, so we
      // use the on-disk form + `cat` round-trip.
      await dockerExec(TAILSCALE_SERVICE, [
        "tailscale",
        "cert",
        "--cert-file",
        `/tmp/${domain}.crt`,
        "--key-file",
        `/tmp/${domain}.key`,
        domain,
      ]);
      certPem = (await dockerExec(TAILSCALE_SERVICE, ["cat", `/tmp/${domain}.crt`])).trim();
      keyPem = (await dockerExec(TAILSCALE_SERVICE, ["cat", `/tmp/${domain}.key`])).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditWrite("tailscale_cert_failed", `Failed to issue cert for ${domain}: ${msg}`, {
        domain,
      });
      // Tailscale itself rejects domains it doesn't own (`HTTPS not enabled`
      // on the tailnet, or domain doesn't match MagicDNS). Map to 502 so the
      // UI surfaces "issue failed" without a generic 500.
      throw new ApiError(
        502,
        "TAILSCALE_CERT_FAILED",
        `tailscale cert ${domain} failed: ${msg}`,
      );
    }

    if (!certPem || !keyPem) {
      throw new ApiError(
        502,
        "TAILSCALE_CERT_EMPTY",
        `tailscale cert returned an empty body for ${domain}`,
      );
    }

    // Write to the Caddy-shared bind mount on the host.
    try {
      fs.mkdirSync(CERT_HOST_DIR, { recursive: true });
      fs.mkdirSync(SNIPPET_HOST_DIR, { recursive: true });
    } catch {
      /* ignore — the bootstrap likely already created these */
    }
    const certHostPath = path.join(CERT_HOST_DIR, `${domain}.crt`);
    const keyHostPath = path.join(CERT_HOST_DIR, `${domain}.key`);
    fs.writeFileSync(certHostPath, `${certPem}\n`, { mode: 0o644 });
    fs.writeFileSync(keyHostPath, `${keyPem}\n`, { mode: 0o600 });

    // Caddy snippet: a full site block that uses the bind-mounted cert.
    // ctrl-api is the only writer; Caddy is the only reader. We use the
    // tenant's web-client as the default upstream — same target as the
    // apex site in Caddyfile. The principal can swap it on POST /serve
    // (which targets an arbitrary localhost port) but the default
    // tls-only block is the common case: the dashboard, behind the LE
    // cert, reachable on the tailnet hostname.
    const snippetHostPath = path.join(SNIPPET_HOST_DIR, `${domain}.caddy`);
    const snippet =
      `# Issued by ctrl-api on behalf of POST /api/v1/channels/tailscale/cert.\n` +
      `# Domain: ${domain}\n` +
      `# Cert  : ${CERT_CADDY_DIR}/${domain}.crt\n` +
      `# Key   : ${CERT_CADDY_DIR}/${domain}.key\n` +
      `${domain} {\n` +
      `\tencode zstd gzip\n` +
      `\ttls ${CERT_CADDY_DIR}/${domain}.crt ${CERT_CADDY_DIR}/${domain}.key\n` +
      `\treverse_proxy web-client:80\n` +
      `}\n`;
    fs.writeFileSync(snippetHostPath, snippet, { mode: 0o644 });

    // Hot-reload Caddy so the new snippet picks up without restart.
    let reloadOk = true;
    try {
      await dockerExec(CADDY_SERVICE, [
        "caddy",
        "reload",
        "--config",
        "/etc/caddy/Caddyfile",
      ]);
    } catch (err) {
      reloadOk = false;
      console.warn(
        "[channels_tailscale] caddy reload failed (cert written, will pick up on next restart):",
        err instanceof Error ? err.message : String(err),
      );
    }

    // Best-effort `Not After` extraction. We don't depend on openssl being
    // present — the cert's PEM is shaped so the Node TLS lib can decode it,
    // but pulling in `crypto.X509Certificate` keeps the import surface
    // small.
    let expiresAt: string | null = null;
    try {
      // X509Certificate accepts PEM. Available since Node 15.6 — well below
      // the v22 floor.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { X509Certificate } = await import("node:crypto");
      const cert = new X509Certificate(certPem);
      expiresAt = cert.validTo; // e.g. "Aug 13 12:00:00 2026 GMT"
    } catch {
      /* leave null */
    }

    auditWrite(
      "tailscale_cert_issued",
      `Issued Tailscale LE cert for ${domain}`,
      { domain, reload_ok: reloadOk },
    );

    sendJson(res, 200, {
      ok: true,
      domain,
      cert_path: `${CERT_CADDY_DIR}/${domain}.crt`,
      key_path: `${CERT_CADDY_DIR}/${domain}.key`,
      expires_at: expiresAt,
      caddy_reload_ok: reloadOk,
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/tailscale/serve  — issue #109 PR 4
  //
  // Body: { port: number, path?: string }
  //
  // Calls `tailscale serve --bg https / http://127.0.0.1:<port>` so the
  // tenant exposes a localhost service over Tailscale's tailnet-only
  // HTTPS (no LE round-trip, Tailscale terminates internally).
  //
  // Idempotent: tailscale's own `serve` config is keyed on (mountpoint,
  // upstream) — re-running with the same args is a no-op as far as the
  // tailnet is concerned, and we treat it as success. A `port=N, path=/X`
  // pair replaces whatever was previously serving on /X.
  //
  // Returns: { ok, url } where url is `https://<hostname>.ts.net<path>`.
  // ──────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/tailscale/serve", async ({ res, body }) => {
    const parsed = parseServeBody(body);
    await ensureSidecarRunning();

    const mountPath = parsed.path ?? "/";
    const upstream = `http://127.0.0.1:${parsed.port}`;
    try {
      await dockerExec(TAILSCALE_SERVICE, [
        "tailscale",
        "serve",
        "--bg",
        "--https",
        "443",
        "--set-path",
        mountPath,
        upstream,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      auditWrite(
        "tailscale_serve_failed",
        `tailscale serve port=${parsed.port} path=${mountPath} failed: ${msg}`,
        { port: parsed.port, path: mountPath },
      );
      throw new ApiError(
        502,
        "TAILSCALE_SERVE_FAILED",
        `tailscale serve failed: ${msg}`,
      );
    }

    // Hostname comes from the lifecycle row (populated by /status probe).
    // When the row is fresh and a probe hasn't run yet, fall back to a
    // generic placeholder rather than 500-ing — the UI can re-fetch.
    const row = getTailscaleRow();
    const hostname = row.tailnet_hostname ?? "this-node.ts.net";
    const url = `https://${hostname}${mountPath}`;

    auditWrite(
      "tailscale_serve_set",
      `Tailscale Serve mapped ${mountPath} → :${parsed.port}`,
      { port: parsed.port, path: mountPath, url },
    );

    sendJson(res, 200, {
      ok: true,
      url,
      port: parsed.port,
      path: mountPath,
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // POST /api/v1/channels/tailscale/funnel  — issue #109 PR 4
  //
  // Body: { port: number }
  //
  // Calls `tailscale funnel --bg <port>` to expose a localhost port to the
  // public internet via Tailscale Funnel (LE-passthrough, no Caddy needed).
  //
  // Funnel is gated at the tailnet-policy level — when the org's
  // `tailnet-funnel` ACL doesn't include this node's tag, the CLI fails
  // with "funnel is not enabled". We map that to 403 FUNNEL_NOT_ENABLED
  // so the UI can prompt the principal to open
  // https://login.tailscale.com/admin/dns and toggle the feature.
  //
  // Returns: { ok, public_url }.
  // ──────────────────────────────────────────────────────────────────────
  addRoute("POST", "/api/v1/channels/tailscale/funnel", async ({ res, body }) => {
    const parsed = parseFunnelBody(body);
    await ensureSidecarRunning();

    try {
      await dockerExec(TAILSCALE_SERVICE, [
        "tailscale",
        "funnel",
        "--bg",
        String(parsed.port),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The CLI surfaces "funnel is not available" / "HTTPS not enabled" /
      // "not allowed on this tailnet" when the org policy denies funnel.
      // Catch every variant so the UI can prompt to enable it.
      if (
        /funnel.*(not enabled|not available|not allowed|disabled)/i.test(msg) ||
        /HTTPS not enabled/i.test(msg)
      ) {
        auditWrite("tailscale_funnel_denied", `Funnel denied by tailnet policy`, {
          port: parsed.port,
          message: msg,
        });
        throw new ApiError(
          403,
          "FUNNEL_NOT_ENABLED",
          "Tailscale Funnel is not enabled for this tailnet. Open the admin console and toggle Funnel on for this node.",
        );
      }
      auditWrite(
        "tailscale_funnel_failed",
        `tailscale funnel port=${parsed.port} failed: ${msg}`,
        { port: parsed.port },
      );
      throw new ApiError(
        502,
        "TAILSCALE_FUNNEL_FAILED",
        `tailscale funnel failed: ${msg}`,
      );
    }

    const row = getTailscaleRow();
    const hostname = row.tailnet_hostname ?? "this-node.ts.net";
    const publicUrl = `https://${hostname}`;

    auditWrite(
      "tailscale_funnel_set",
      `Tailscale Funnel exposing :${parsed.port} publicly at ${publicUrl}`,
      { port: parsed.port, public_url: publicUrl },
    );

    sendJson(res, 200, {
      ok: true,
      public_url: publicUrl,
      port: parsed.port,
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
