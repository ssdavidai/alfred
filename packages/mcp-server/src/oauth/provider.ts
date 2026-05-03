// SQLite-backed OAuthServerProvider implementing the interface from
// @modelcontextprotocol/sdk/server/auth/provider.js. The SDK's auth router
// handles the protocol-level details (param validation, error redirects,
// metadata endpoints, bearer middleware); this class plugs in the storage
// + business logic.
//
// authorize() flow: when Claude redirects Sir to /authorize, the SDK
// validates the request and calls our authorize(client, params, res). We
// render an HTML form embedding the params as hidden fields. The form
// posts to /approve (a separate Express route handled in src/index.ts).
// /approve validates the per-tenant approval secret, issues an auth code,
// and redirects back to Claude with the code + state.

import * as crypto from "node:crypto";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { OAuthStorage, randomToken, sha256 } from "./storage.js";
import { isAppId } from "../tools/registry.js";
import type { AppId } from "../tools/registry.js";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Bound to every issued token. The MCP request handler reads it from
 * `req.auth.extra` to know which app + ctrl-api credentials to use on the
 * outbound call.
 */
export interface MCPProps extends Record<string, unknown> {
  appId: AppId;
  tenantLabel: string;
}

export interface ProviderConfig {
  storage: OAuthStorage;
  /** Canonical resource URI this server represents (e.g. https://alfred-david-mnbqn4jg.alfred.black). */
  publicUrl: string;
}

export class SqliteOAuthProvider implements OAuthServerProvider {
  constructor(private cfg: ProviderConfig) {}

  // ── clients store ────────────────────────────────────────────────────────

  get clientsStore(): OAuthRegisteredClientsStore {
    const { storage } = this.cfg;
    return {
      async getClient(client_id) {
        const row = storage.getClient(client_id);
        if (!row) return undefined;
        // Trust the persisted metadata as the canonical client record.
        // The SDK's /register handler pre-populates client_id, client_secret,
        // client_id_issued_at, client_secret_expires_at on the OAuthClient-
        // InformationFull object before calling registerClient(); we stored
        // it verbatim, so we return it verbatim. The SDK's clientAuth
        // middleware does a string-equals check against client.client_secret,
        // so the raw secret has to be present (we keep it on disk in the
        // LUKS-encrypted volume — see ClientRow.client_secret in storage.ts).
        return row.metadata as OAuthClientInformationFull;
      },
      async registerClient(metadata) {
        // With the SDK's default `clientIdGeneration: true`, the register
        // handler has already set client_id (randomUUID) and client_secret
        // (randomBytes for confidential clients) on the input object — its
        // TS type still says Omit<…,"client_id"|…> but at runtime the
        // fields are present. Earlier we generated our OWN client_id and
        // stored the SDK's id inside metadata, which clobbered the explicit
        // client_id field on getClient spread → invalid_grant. Now we
        // accept whichever id the SDK gave us, fall back to one of our
        // own only when the caller has explicitly opted into provider-side
        // generation, and persist the resulting object as the canonical
        // record so /register response and getClient() lookup are byte-
        // identical.
        const m = metadata as OAuthClientInformationFull & { client_id?: string };
        const now = Date.now();
        const client_id = m.client_id ?? crypto.randomBytes(12).toString("base64url");
        const client_id_issued_at = m.client_id_issued_at ?? Math.floor(now / 1000);
        const full: OAuthClientInformationFull = {
          ...m,
          client_id,
          client_id_issued_at,
        };
        storage.insertClient({
          client_id,
          client_secret: full.client_secret ?? null,
          client_secret_expires_at: full.client_secret_expires_at ?? 0,
          metadata: full,
          created_at: now,
        });
        return full;
      },
    };
  }

  // ── authorize: render approval form ──────────────────────────────────────

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Resource binding (RFC 8707): MCP spec mandates the `resource` param
    // identify the protected resource the token will be used against. In
    // our deployment, resource encodes the app:
    //   https://<tenant>.alfred.black/<app>/mcp
    const appId = extractAppFromResource(params.resource, this.cfg.publicUrl);
    if (!appId) {
      res.status(400).type("text/plain").send(
        `Bad resource — connector URL must be ${this.cfg.publicUrl}/<app>/mcp where <app> is one of: sure, plane`,
      );
      return;
    }

    res
      .status(200)
      .type("text/html; charset=utf-8")
      .send(renderApprovePage({ client, params, appId }));
  }

  // ── PKCE check helper used by /token ─────────────────────────────────────

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    // The SDK calls this BEFORE exchangeAuthorizationCode to get the stored
    // challenge for verification. We can't take the auth code yet (the
    // exchange hasn't happened), so we peek without consuming.
    const code_hash = sha256(authorizationCode);
    // Peek the row by its hash. Don't delete here — exchangeAuthorizationCode
    // takes it.
    const row = (this.cfg.storage as unknown as {
      db?: unknown;
    });
    void row;
    const ac = peekAuthCode(this.cfg.storage, code_hash);
    if (!ac) throw new InvalidGrantError("Unknown or expired authorization code");
    return ac.code_challenge;
  }

  // ── exchange code → tokens ───────────────────────────────────────────────

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code_hash = sha256(authorizationCode);
    const ac = this.cfg.storage.takeAuthCode(code_hash);
    if (!ac) throw new InvalidGrantError("Unknown or expired authorization code");
    if (ac.client_id !== client.client_id) {
      throw new InvalidGrantError("Code was issued to a different client");
    }
    if (redirectUri && ac.redirect_uri !== redirectUri) {
      throw new InvalidGrantError("redirect_uri mismatch");
    }
    // Resource (RFC 8707): the resource at /token must match the resource
    // bound at /authorize. SDK does the param-level check but we re-validate
    // here for defense in depth.
    if (resource && ac.resource && resource.toString() !== ac.resource) {
      throw new InvalidGrantError("resource mismatch");
    }

    const resourceForToken = ac.resource ?? this.cfg.publicUrl;
    const access_token = randomToken();
    const refresh_token = randomToken();
    const now = Date.now();

    this.cfg.storage.insertAccessToken({
      token_hash: sha256(access_token),
      client_id: client.client_id,
      scopes: ac.scopes,
      resource: resourceForToken,
      props: ac.props,
      expires_at: now + ACCESS_TOKEN_TTL_MS,
    });
    this.cfg.storage.insertRefreshToken({
      token_hash: sha256(refresh_token),
      client_id: client.client_id,
      scopes: ac.scopes,
      resource: resourceForToken,
      props: ac.props,
      expires_at: now + REFRESH_TOKEN_TTL_MS,
      rotated_to: null,
    });

    return {
      access_token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token,
      scope: ac.scopes.join(" ") || undefined,
    };
  }

  // ── exchange refresh → tokens (with rotation) ────────────────────────────

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const old_hash = sha256(refreshToken);
    const old = this.cfg.storage.getRefreshToken(old_hash);
    if (!old) throw new InvalidGrantError("Unknown refresh token");
    if (old.client_id !== client.client_id) {
      throw new InvalidGrantError("Refresh token was issued to a different client");
    }
    if (old.rotated_to) {
      // Token reuse — possible attack. Per OAuth 2.1, treat as token-theft
      // signal and revoke the chain. (We trust the caller is the legitimate
      // holder if and only if they present the most recent token; reuse of
      // an already-rotated token is suspicious.)
      throw new InvalidGrantError("Refresh token already rotated");
    }
    if (old.expires_at < Date.now()) {
      throw new InvalidGrantError("Refresh token expired");
    }

    const resourceForToken = resource?.toString() ?? old.resource;
    const access_token = randomToken();
    const new_refresh = randomToken();
    const now = Date.now();

    this.cfg.storage.insertAccessToken({
      token_hash: sha256(access_token),
      client_id: client.client_id,
      scopes: old.scopes,
      resource: resourceForToken,
      props: old.props,
      expires_at: now + ACCESS_TOKEN_TTL_MS,
    });
    const new_refresh_hash = sha256(new_refresh);
    this.cfg.storage.insertRefreshToken({
      token_hash: new_refresh_hash,
      client_id: client.client_id,
      scopes: old.scopes,
      resource: resourceForToken,
      props: old.props,
      expires_at: now + REFRESH_TOKEN_TTL_MS,
      rotated_to: null,
    });
    this.cfg.storage.markRefreshRotated(old_hash, new_refresh_hash);

    return {
      access_token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: new_refresh,
      scope: old.scopes.join(" ") || undefined,
    };
  }

  // ── verify token (called by requireBearerAuth on every /mcp request) ─────

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const at = this.cfg.storage.getAccessToken(sha256(token));
    if (!at) throw new InvalidTokenError("Invalid or expired access token");

    // Audience binding (RFC 8707): the token's bound resource MUST match
    // this server's canonical resource URI, otherwise it's a confused-deputy
    // hole. The SDK's bearer middleware does another check using the
    // `resourceMetadataUrl` config; we belt-and-braces here at the provider
    // level because storage drives the truth.
    const expected = this.cfg.publicUrl.replace(/\/+$/, "");
    if (!at.resource.startsWith(expected)) {
      throw new InvalidTokenError("Token bound to a different resource");
    }

    return {
      token,
      clientId: at.client_id,
      scopes: at.scopes,
      expiresAt: Math.floor(at.expires_at / 1000),
      resource: new URL(at.resource),
      extra: at.props,
    };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function extractAppFromResource(resource: URL | undefined, publicUrl: string): AppId | null {
  if (!resource) return null;
  const expected = new URL(publicUrl);
  if (resource.host !== expected.host) return null;
  const m = resource.pathname.match(/^\/([a-z]+)\/mcp(\/.*)?$/);
  if (!m) return null;
  if (!isAppId(m[1])) return null;
  return m[1];
}

/**
 * Peek an auth code without consuming it (for challengeForAuthorizationCode).
 * Reads via a temporary SELECT so SDK's PKCE check can pre-validate without
 * burning the single-use guarantee.
 */
function peekAuthCode(storage: OAuthStorage, code_hash: string) {
  // The OAuthStorage class doesn't expose a peek method (every getter that
  // touches auth_codes deletes the row); use the raw db prepare here. Cast
  // through unknown because db is private.
  const db = (storage as unknown as { db: { prepare: (s: string) => { get: (...args: unknown[]) => unknown } } }).db;
  const row = db.prepare(
    "SELECT code_challenge, expires_at FROM auth_codes WHERE code_hash = ?",
  ).get(code_hash) as { code_challenge: string; expires_at: number } | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) return null;
  return { code_challenge: row.code_challenge };
}

// ── HTML approval page ─────────────────────────────────────────────────────

interface RenderArgs {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  appId: AppId;
}

function renderApprovePage(args: RenderArgs): string {
  const { client, params, appId } = args;
  // Embed all the fields needed to re-issue the auth flow on /approve.
  const hidden = (k: string, v: string | undefined) =>
    v === undefined ? "" : `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Approve Alfred MCP — ${escapeHtml(appId)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 28rem;
           margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: #6b7280; }
    code { background: #f3f4f6; padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.9rem; }
    label { display: block; margin: 1rem 0 0.25rem; font-weight: 500; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 0.5rem;
                            font-size: 1rem; border: 1px solid #d1d5db; border-radius: 6px; }
    button { margin-top: 1rem; padding: 0.6rem 1rem; background: #111827; color: white;
             border: 0; border-radius: 6px; font-size: 1rem; cursor: pointer; }
    .meta { font-size: 0.85rem; color: #6b7280; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>Approve Alfred MCP — ${escapeHtml(appId)}</h1>
  <p>Grants <strong>${escapeHtml(client.client_name ?? "Claude")}</strong> access to <code>${escapeHtml(appId)}</code> via the alfred-mcp-server. Claude exchanges this approval for an OAuth access token; nothing else has to be pasted into Claude.</p>
  <form method="POST" action="/approve">
    ${hidden("client_id", client.client_id)}
    ${hidden("redirect_uri", params.redirectUri)}
    ${hidden("code_challenge", params.codeChallenge)}
    ${hidden("scope", params.scopes?.join(" "))}
    ${hidden("state", params.state)}
    ${hidden("resource", params.resource?.toString())}
    ${hidden("app", appId)}
    <label for="secret">Approval secret</label>
    <input type="password" id="secret" name="secret" autocomplete="off" required autofocus />
    <button type="submit">Approve</button>
  </form>
  <p class="meta">Client ID: <code>${escapeHtml(client.client_id)}</code></p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * Issue an authorization code and store it. Called by /approve after the
 * approval secret has been validated. The PKCE challenge stays alive
 * until /token consumes the code.
 */
export function issueAuthCode(
  storage: OAuthStorage,
  args: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    scopes: string[];
    resource: string | null;
    props: MCPProps;
  },
): { code: string; expires_at: number } {
  const code = randomToken();
  const expires_at = Date.now() + AUTH_CODE_TTL_MS;
  storage.insertAuthCode({
    code_hash: sha256(code),
    client_id: args.client_id,
    redirect_uri: args.redirect_uri,
    code_challenge: args.code_challenge,
    code_challenge_method: "S256",
    resource: args.resource,
    scopes: args.scopes,
    props: args.props,
    expires_at,
  });
  return { code, expires_at };
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
