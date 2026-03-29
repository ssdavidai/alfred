/**
 * Generic OAuth2 provider — handles authorization, token exchange, refresh,
 * and encrypted storage for any OAuth2-compliant provider.
 *
 * Provider-specific behavior is configured via OAUTH2_PROVIDERS map.
 * No per-provider code — just config.
 */

import crypto from "crypto";
import express from "express";
import type { Application, Request, Response } from "express";
import { encryptApiKey, decryptApiKey } from "./tenantProxy";
import { prisma } from "wasp/server";

// ---------------------------------------------------------------------------
// Provider config registry
// ---------------------------------------------------------------------------

interface OAuth2ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: () => string;
  clientSecret: () => string;
  defaultScopes: string[];
  /** Some providers need extra params on the authorize URL */
  extraAuthorizeParams?: Record<string, string>;
}

const OAUTH2_PROVIDERS: Record<string, OAuth2ProviderConfig> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: () => process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET || "",
    defaultScopes: ["openid", "email", "profile"],
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  },
  microsoft: {
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    clientId: () => process.env.MICROSOFT_CLIENT_ID || "",
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET || "",
    defaultScopes: ["openid", "email", "profile", "offline_access"],
  },
  notion: {
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    clientId: () => process.env.NOTION_CLIENT_ID || "",
    clientSecret: () => process.env.NOTION_CLIENT_SECRET || "",
    defaultScopes: [],  // Notion doesn't use scopes — permissions set in integration config
    extraAuthorizeParams: { owner: "user" },
  },
};

// In-memory state store (short-lived, cleared on callback)
const pendingStates = new Map<string, { userId: string; provider: string; scopes: string[]; redirectAfter: string }>();

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

function getCallbackUrl(provider: string): string {
  const base = process.env.WASP_SERVER_URL || "https://alfred.black";
  return `${base}/auth/oauth2/${provider}/callback`;
}

function buildAuthorizeUrl(provider: string, config: OAuth2ProviderConfig, scopes: string[], state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId(),
    redirect_uri: getCallbackUrl(provider),
    response_type: "code",
    scope: scopes.join(" "),
    state,
    ...(config.extraAuthorizeParams || {}),
  });
  return `${config.authorizeUrl}?${params.toString()}`;
}

async function exchangeCodeForTokens(
  provider: string,
  config: OAuth2ProviderConfig,
  code: string,
): Promise<{
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  [key: string]: unknown;
}> {
  // Notion uses Basic auth (base64 of client_id:client_secret) for token exchange
  // instead of passing credentials in the form body.
  const useBasicAuth = provider === "notion";

  const bodyParams: Record<string, string> = {
    code,
    grant_type: "authorization_code",
    redirect_uri: getCallbackUrl(provider),
  };

  if (!useBasicAuth) {
    bodyParams.client_id = config.clientId();
    bodyParams.client_secret = config.clientSecret();
  }

  const body = new URLSearchParams(bodyParams);

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (useBasicAuth) {
    const credentials = Buffer.from(`${config.clientId()}:${config.clientSecret()}`).toString("base64");
    headers["Authorization"] = `Basic ${credentials}`;
  }

  const resp = await fetch(config.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  return resp.json();
}

async function refreshAccessToken(
  provider: string,
  config: OAuth2ProviderConfig,
  refreshToken: string,
): Promise<{ access_token: string; expires_in?: number; token_type?: string }> {
  const body = new URLSearchParams({
    client_id: config.clientId(),
    client_secret: config.clientSecret(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const resp = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// Public API: get a valid access token (auto-refresh if expired)
// ---------------------------------------------------------------------------

export async function getValidAccessToken(credentialId: string): Promise<string> {
  const cred = await prisma.oAuthCredential.findUnique({ where: { id: credentialId } });
  if (!cred) throw new Error(`OAuth credential ${credentialId} not found`);

  const config = OAUTH2_PROVIDERS[cred.provider];
  if (!config) throw new Error(`Unknown OAuth provider: ${cred.provider}`);

  // Check if token is still valid (with 5min buffer)
  const now = new Date();
  const bufferMs = 5 * 60 * 1000;
  if (cred.expiresAt && cred.expiresAt.getTime() - bufferMs > now.getTime()) {
    return decryptApiKey(cred.accessToken);
  }

  // Token expired or about to expire — refresh
  if (!cred.refreshToken) {
    throw new Error(`OAuth credential ${credentialId} has no refresh token and access token is expired`);
  }

  const decryptedRefresh = decryptApiKey(cred.refreshToken);
  const result = await refreshAccessToken(cred.provider, config, decryptedRefresh);

  // Update stored tokens
  const expiresAt = result.expires_in
    ? new Date(Date.now() + result.expires_in * 1000)
    : null;

  await prisma.oAuthCredential.update({
    where: { id: credentialId },
    data: {
      accessToken: encryptApiKey(result.access_token),
      ...(expiresAt ? { expiresAt } : {}),
    },
  });

  return result.access_token;
}

// ---------------------------------------------------------------------------
// Query param helper — Express uses qs which returns string | string[] | ParsedQs | ParsedQs[]
// ---------------------------------------------------------------------------

function queryString(val: unknown): string {
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return String(val[0] ?? "");
  return String(val ?? "");
}

// ---------------------------------------------------------------------------
// Express route handlers
// ---------------------------------------------------------------------------

function handleStart(req: Request, res: Response) {
  const provider: string = Array.isArray(req.params.provider) ? req.params.provider[0] : req.params.provider;
  const config = OAUTH2_PROVIDERS[provider];
  if (!config) {
    return res.status(400).json({ error: `Unknown provider: ${provider}` });
  }

  const userId = queryString(req.query.userId);
  if (!userId) {
    return res.status(401).json({ error: "userId required" });
  }

  const scopesParam = queryString(req.query.scopes);
  const scopes: string[] = scopesParam
    ? scopesParam.split(",")
    : config.defaultScopes;

  const redirectAfter = queryString(req.query.redirectAfter) || "/dashboard/streams";

  // Generate state token
  const state = crypto.randomBytes(24).toString("hex");
  pendingStates.set(state, { userId, provider, scopes, redirectAfter });

  // Clean up stale states (older than 10 min)
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000);

  const url = buildAuthorizeUrl(provider, config, scopes, state);
  res.redirect(url);
}

async function handleCallback(req: Request, res: Response) {
  const code = queryString(req.query.code);
  const state = queryString(req.query.state);
  const error = queryString(req.query.error);

  if (error) {
    console.error(`[oauth2] Provider returned error: ${error}`);
    return res.redirect(`/dashboard/streams?error=${encodeURIComponent(String(error))}`);
  }

  if (!state || !code) {
    return res.status(400).json({ error: "Missing code or state" });
  }

  const pending = pendingStates.get(state);
  if (!pending) {
    return res.status(400).json({ error: "Invalid or expired state" });
  }
  pendingStates.delete(state);

  const config = OAUTH2_PROVIDERS[pending.provider];
  if (!config) {
    return res.status(400).json({ error: `Unknown provider: ${pending.provider}` });
  }

  try {
    const tokens = await exchangeCodeForTokens(pending.provider, config, code);

    // Extract account label from ID token or userinfo
    let accountLabel: string | null = null;
    if (tokens.id_token) {
      try {
        const payload = JSON.parse(
          Buffer.from((tokens.id_token as string).split(".")[1], "base64url").toString()
        );
        accountLabel = payload.email || payload.preferred_username || null;
      } catch {}
    }

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + (tokens.expires_in as number) * 1000)
      : null;

    // Upsert credential
    await prisma.oAuthCredential.upsert({
      where: {
        userId_provider: {
          userId: pending.userId,
          provider: pending.provider,
        },
      },
      create: {
        userId: pending.userId,
        provider: pending.provider,
        accessToken: encryptApiKey(tokens.access_token),
        refreshToken: tokens.refresh_token ? encryptApiKey(tokens.refresh_token) : null,
        tokenType: tokens.token_type || "Bearer",
        expiresAt,
        scopes: pending.scopes,
        accountLabel,
        raw: tokens as any,
      },
      update: {
        accessToken: encryptApiKey(tokens.access_token),
        refreshToken: tokens.refresh_token ? encryptApiKey(tokens.refresh_token) : null,
        tokenType: tokens.token_type || "Bearer",
        expiresAt,
        scopes: pending.scopes,
        accountLabel,
        raw: tokens as any,
      },
    });

    console.log(`[oauth2] Stored credentials for ${pending.provider} (user ${pending.userId}, account ${accountLabel})`);
    res.redirect(`${pending.redirectAfter}?oauth=success&provider=${pending.provider}`);
  } catch (err) {
    console.error(`[oauth2] Token exchange failed:`, err);
    res.redirect(`${pending.redirectAfter}?error=token_exchange_failed`);
  }
}

async function handleListCredentials(req: Request, res: Response) {
  const userId = queryString(req.query.userId);
  if (!userId) return res.status(401).json({ error: "userId required" });

  const creds = await prisma.oAuthCredential.findMany({
    where: { userId },
    select: {
      id: true,
      provider: true,
      accountLabel: true,
      scopes: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  res.json({ credentials: creds });
}

async function handleDeleteCredential(req: Request, res: Response) {
  const userId = queryString(req.query.userId);
  if (!userId) return res.status(401).json({ error: "userId required" });

  const id = queryString(req.params.id);
  await prisma.oAuthCredential.deleteMany({
    where: { id, userId },
  });

  res.json({ status: "deleted" });
}

// Internal endpoint: tenant requests a fresh access token
async function handleInternalTokenRequest(req: Request, res: Response) {
  // Authenticated via the same internal auth as other SaaS<->tenant calls
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // req.body may be undefined if Express JSON parser hasn't run on this route
  const body = req.body || {};
  const { credentialId, userId, provider } = body;

  try {
    let cred;
    if (credentialId) {
      cred = await prisma.oAuthCredential.findUnique({ where: { id: credentialId } });
    } else if (userId && provider) {
      cred = await prisma.oAuthCredential.findUnique({
        where: { userId_provider: { userId, provider } },
      });
    }

    if (!cred) {
      return res.status(404).json({ error: "OAuth credential not found" });
    }

    const token = await getValidAccessToken(cred.id);
    res.json({ access_token: token, token_type: "Bearer" });
  } catch (err: any) {
    console.error(`[oauth2] Internal token request failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerOAuth2Routes(app: Application): void {
  app.get("/auth/oauth2/:provider/start", handleStart);
  app.get("/auth/oauth2/:provider/callback", handleCallback);
  app.get("/auth/oauth2/credentials", handleListCredentials);
  app.delete("/auth/oauth2/credentials/:id", handleDeleteCredential);
  app.post("/api/internal/oauth2/token", express.json(), handleInternalTokenRequest);
  console.log("[oauth2] OAuth2 routes registered");
}
