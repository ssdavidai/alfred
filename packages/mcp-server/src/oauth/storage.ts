// SQLite storage for OAuth 2.1 state. Single file at $DATA_DIR/oauth.sqlite.
//
// The schema mirrors the recommended pattern from
// modelcontextprotocol/example-remote-server (Redis → SQLite swap):
//   - secrets and tokens are stored as SHA-256 HASHES, never raw values
//   - resource (audience) binding per RFC 8707 — verifyAccessToken rejects
//     tokens whose stored resource doesn't match the canonical server URI
//   - PKCE S256 enforced (code_challenge stored on auth_codes; verified at
//     /token time)
//   - refresh-token rotation per OAuth 2.1: each /token call issues a new
//     refresh_token and `rotated_to` links the chain (audit trail).

import { DatabaseSync } from "node:sqlite";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";

export interface ClientRow {
  client_id: string;
  // Stored RAW (not hashed) because the MCP SDK's clientAuth middleware
  // does a string-equals comparison against the value returned from
  // getClient(). Storing a hash would break confidential-client auth.
  // Acceptable here because the SQLite file lives on the LUKS-encrypted
  // /mnt/encrypted volume, alongside .env which already holds raw secrets.
  client_secret: string | null;
  client_secret_expires_at: number;
  metadata: Record<string, unknown>;
  created_at: number;
}

export interface AuthCodeRow {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256" | "plain";
  resource: string | null;
  scopes: string[];
  props: Record<string, unknown>;
  expires_at: number;
}

export interface AccessTokenRow {
  token_hash: string;
  client_id: string;
  scopes: string[];
  resource: string;
  props: Record<string, unknown>;
  expires_at: number;
}

export interface RefreshTokenRow {
  token_hash: string;
  client_id: string;
  scopes: string[];
  resource: string;
  props: Record<string, unknown>;
  expires_at: number;
  rotated_to: string | null;
}

/**
 * A long-lived, per-app static bearer token — the headless alternative to
 * the OAuth flow for non-interactive clients (ElevenLabs / LiveKit voice
 * agents, scripts). Unlike the tenant-wide `MCP_APPROVAL_SECRET`, each row
 * is scoped to exactly ONE app and can be listed / rotated / deleted
 * independently, so a leaked or retired vendor credential is contained.
 * Only the SHA-256 hash is persisted; the raw token is shown once at mint.
 */
export interface ScopedTokenRow {
  /** Public id used for management (rotate/delete). Never secret. */
  id: string;
  /** The single app this token authorizes (`AppId`). */
  app_id: string;
  token_hash: string;
  /** First chars of the raw token, for display in the UI. Not secret. */
  prefix: string;
  /** Human label, e.g. "ElevenLabs prod". */
  label: string;
  created_at: number;
  last_used_at: number | null;
  /** Soft-disable timestamp; a revoked token fails validation. */
  revoked_at: number | null;
}

export class OAuthStorage {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, "oauth.sqlite");
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    this.migrate();
  }

  private migrate(): void {
    // clients: drop+recreate if the legacy hash column is present. The fleet
    // is single-tenant + SDK-generated DCR clients, so re-registration on
    // the next /register call is cheaper than a careful column migration.
    const cols = this.db
      .prepare("PRAGMA table_info('clients')")
      .all() as Array<{ name: string }>;
    const hasLegacyHash = cols.some((c) => c.name === "client_secret_hash");
    if (hasLegacyHash) {
      this.db.exec("DROP TABLE clients;");
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        client_secret TEXT,
        client_secret_expires_at INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        resource TEXT,
        scopes TEXT NOT NULL,
        props_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS access_tokens (
        token_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        resource TEXT NOT NULL,
        props_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        resource TEXT NOT NULL,
        props_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        rotated_to TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_access_expires ON access_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_refresh_expires ON refresh_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_authcodes_expires ON auth_codes(expires_at);
      CREATE TABLE IF NOT EXISTS scoped_tokens (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_scoped_app ON scoped_tokens(app_id);
      CREATE INDEX IF NOT EXISTS idx_scoped_hash ON scoped_tokens(token_hash);
    `);
  }

  // ── clients ──────────────────────────────────────────────────────────────

  insertClient(c: ClientRow): void {
    this.db.prepare(
      "INSERT INTO clients(client_id, client_secret, client_secret_expires_at, metadata_json, created_at) VALUES(?, ?, ?, ?, ?)",
    ).run(c.client_id, c.client_secret, c.client_secret_expires_at, JSON.stringify(c.metadata), c.created_at);
  }

  getClient(client_id: string): ClientRow | null {
    const row = this.db.prepare("SELECT * FROM clients WHERE client_id = ?").get(client_id) as
      | { client_id: string; client_secret: string | null; client_secret_expires_at: number; metadata_json: string; created_at: number }
      | undefined;
    if (!row) return null;
    return {
      client_id: row.client_id,
      client_secret: row.client_secret,
      client_secret_expires_at: row.client_secret_expires_at,
      metadata: JSON.parse(row.metadata_json),
      created_at: row.created_at,
    };
  }

  // ── auth codes ───────────────────────────────────────────────────────────

  insertAuthCode(c: AuthCodeRow): void {
    this.db.prepare(
      "INSERT INTO auth_codes(code_hash, client_id, redirect_uri, code_challenge, code_challenge_method, resource, scopes, props_json, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(c.code_hash, c.client_id, c.redirect_uri, c.code_challenge, c.code_challenge_method, c.resource, JSON.stringify(c.scopes), JSON.stringify(c.props), c.expires_at);
  }

  takeAuthCode(code_hash: string): AuthCodeRow | null {
    const row = this.db.prepare("SELECT * FROM auth_codes WHERE code_hash = ?").get(code_hash) as
      | { code_hash: string; client_id: string; redirect_uri: string; code_challenge: string; code_challenge_method: string; resource: string | null; scopes: string; props_json: string; expires_at: number }
      | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM auth_codes WHERE code_hash = ?").run(code_hash);
    if (row.expires_at < Date.now()) return null;
    return {
      code_hash: row.code_hash,
      client_id: row.client_id,
      redirect_uri: row.redirect_uri,
      code_challenge: row.code_challenge,
      code_challenge_method: row.code_challenge_method as "S256" | "plain",
      resource: row.resource,
      scopes: JSON.parse(row.scopes),
      props: JSON.parse(row.props_json),
      expires_at: row.expires_at,
    };
  }

  // ── access tokens ────────────────────────────────────────────────────────

  insertAccessToken(t: AccessTokenRow): void {
    this.db.prepare(
      "INSERT INTO access_tokens(token_hash, client_id, scopes, resource, props_json, expires_at) VALUES(?, ?, ?, ?, ?, ?)",
    ).run(t.token_hash, t.client_id, JSON.stringify(t.scopes), t.resource, JSON.stringify(t.props), t.expires_at);
  }

  getAccessToken(token_hash: string): AccessTokenRow | null {
    const row = this.db.prepare("SELECT * FROM access_tokens WHERE token_hash = ?").get(token_hash) as
      | { token_hash: string; client_id: string; scopes: string; resource: string; props_json: string; expires_at: number }
      | undefined;
    if (!row) return null;
    if (row.expires_at < Date.now()) return null;
    return {
      token_hash: row.token_hash,
      client_id: row.client_id,
      scopes: JSON.parse(row.scopes),
      resource: row.resource,
      props: JSON.parse(row.props_json),
      expires_at: row.expires_at,
    };
  }

  // ── refresh tokens ───────────────────────────────────────────────────────

  insertRefreshToken(t: RefreshTokenRow): void {
    this.db.prepare(
      "INSERT INTO refresh_tokens(token_hash, client_id, scopes, resource, props_json, expires_at, rotated_to) VALUES(?, ?, ?, ?, ?, ?, ?)",
    ).run(t.token_hash, t.client_id, JSON.stringify(t.scopes), t.resource, JSON.stringify(t.props), t.expires_at, t.rotated_to);
  }

  getRefreshToken(token_hash: string): RefreshTokenRow | null {
    const row = this.db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?").get(token_hash) as
      | { token_hash: string; client_id: string; scopes: string; resource: string; props_json: string; expires_at: number; rotated_to: string | null }
      | undefined;
    if (!row) return null;
    return {
      token_hash: row.token_hash,
      client_id: row.client_id,
      scopes: JSON.parse(row.scopes),
      resource: row.resource,
      props: JSON.parse(row.props_json),
      expires_at: row.expires_at,
      rotated_to: row.rotated_to,
    };
  }

  markRefreshRotated(old_hash: string, new_hash: string): void {
    this.db.prepare("UPDATE refresh_tokens SET rotated_to = ? WHERE token_hash = ?").run(new_hash, old_hash);
  }

  // ── scoped (per-app static) tokens ─────────────────────────────────────────

  private rowToScoped(row: {
    id: string; app_id: string; token_hash: string; prefix: string; label: string;
    created_at: number; last_used_at: number | null; revoked_at: number | null;
  }): ScopedTokenRow {
    return {
      id: row.id,
      app_id: row.app_id,
      token_hash: row.token_hash,
      prefix: row.prefix,
      label: row.label,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      revoked_at: row.revoked_at,
    };
  }

  insertScopedToken(t: ScopedTokenRow): void {
    this.db.prepare(
      "INSERT INTO scoped_tokens(id, app_id, token_hash, prefix, label, created_at, last_used_at, revoked_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(t.id, t.app_id, t.token_hash, t.prefix, t.label, t.created_at, t.last_used_at, t.revoked_at);
  }

  getScopedTokenByHash(token_hash: string): ScopedTokenRow | null {
    const row = this.db.prepare("SELECT * FROM scoped_tokens WHERE token_hash = ?").get(token_hash) as
      | Parameters<OAuthStorage["rowToScoped"]>[0] | undefined;
    return row ? this.rowToScoped(row) : null;
  }

  getScopedTokenById(id: string): ScopedTokenRow | null {
    const row = this.db.prepare("SELECT * FROM scoped_tokens WHERE id = ?").get(id) as
      | Parameters<OAuthStorage["rowToScoped"]>[0] | undefined;
    return row ? this.rowToScoped(row) : null;
  }

  /** List tokens (newest first), optionally filtered to one app. Never exposes the hash's preimage. */
  listScopedTokens(app_id?: string): ScopedTokenRow[] {
    const rows = (app_id
      ? this.db.prepare("SELECT * FROM scoped_tokens WHERE app_id = ? ORDER BY created_at DESC").all(app_id)
      : this.db.prepare("SELECT * FROM scoped_tokens ORDER BY created_at DESC").all()
    ) as Array<Parameters<OAuthStorage["rowToScoped"]>[0]>;
    return rows.map((r) => this.rowToScoped(r));
  }

  touchScopedToken(id: string, ts: number): void {
    this.db.prepare("UPDATE scoped_tokens SET last_used_at = ? WHERE id = ?").run(ts, id);
  }

  /** Replace the secret on an existing token in-place (keeps id + label). */
  rotateScopedToken(id: string, token_hash: string, prefix: string, ts: number): boolean {
    const r = this.db.prepare(
      "UPDATE scoped_tokens SET token_hash = ?, prefix = ?, created_at = ?, last_used_at = NULL, revoked_at = NULL WHERE id = ?",
    ).run(token_hash, prefix, ts, id);
    return Number(r.changes) > 0;
  }

  revokeScopedToken(id: string, ts: number): boolean {
    const r = this.db.prepare("UPDATE scoped_tokens SET revoked_at = ? WHERE id = ?").run(ts, id);
    return Number(r.changes) > 0;
  }

  deleteScopedToken(id: string): boolean {
    const r = this.db.prepare("DELETE FROM scoped_tokens WHERE id = ?").run(id);
    return Number(r.changes) > 0;
  }

  // ── janitor ──────────────────────────────────────────────────────────────

  pruneExpired(): void {
    const now = Date.now();
    this.db.prepare("DELETE FROM auth_codes WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM access_tokens WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM refresh_tokens WHERE expires_at < ?").run(now);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function randomShort(bytes = 12): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
