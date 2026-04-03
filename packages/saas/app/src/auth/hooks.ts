/**
 * Auth hooks — capture Google OAuth tokens on signup/login and store
 * them as OAuthCredentials so Gmail stream works without a separate
 * "Connect Gmail" step.
 */

import type {
  OnAfterSignupHook,
  OnAfterLoginHook,
} from "wasp/server/auth";
import { prisma } from "wasp/server";
import { encryptApiKey } from "../server/tenantProxy";

/**
 * Extract Google tokens from the OAuth data provided by Wasp.
 * Returns null if not a Google OAuth flow or tokens are missing.
 */
function extractGoogleTokens(oauth: any): {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  idToken: string | null;
} | null {
  if (!oauth?.providerName || oauth.providerName !== "google") return null;
  const tokens = oauth.tokens;
  if (!tokens) return null;

  // Wasp wraps Arctic OAuth tokens — access the underlying data
  const accessToken =
    tokens.accessToken?.() ?? tokens.access_token ?? tokens.accessToken;
  if (!accessToken) return null;

  const refreshToken =
    tokens.refreshToken?.() ?? tokens.refresh_token ?? tokens.refreshToken ?? null;
  const idToken =
    tokens.idToken?.() ?? tokens.id_token ?? tokens.idToken ?? null;

  let expiresIn: number | null = null;
  if (tokens.accessTokenExpiresAt) {
    const expiresAt =
      typeof tokens.accessTokenExpiresAt === "function"
        ? tokens.accessTokenExpiresAt()
        : tokens.accessTokenExpiresAt;
    if (expiresAt instanceof Date) {
      expiresIn = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    }
  }

  return { accessToken, refreshToken, expiresIn, idToken };
}

/**
 * Extract email from the Google ID token JWT payload.
 */
function extractEmailFromIdToken(idToken: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1], "base64url").toString()
    );
    return payload.email || null;
  } catch {
    return null;
  }
}

/**
 * Store Google tokens as an OAuthCredential (same format as the manual
 * "Connect Gmail" flow in oauth2.ts).
 */
async function storeGoogleCredential(
  userId: string,
  tokens: NonNullable<ReturnType<typeof extractGoogleTokens>>
) {
  const expiresAt = tokens.expiresIn
    ? new Date(Date.now() + tokens.expiresIn * 1000)
    : null;

  const accountLabel = tokens.idToken
    ? extractEmailFromIdToken(tokens.idToken)
    : null;

  await prisma.oAuthCredential.upsert({
    where: {
      userId_provider: { userId, provider: "google" },
    },
    create: {
      userId,
      provider: "google",
      accessToken: encryptApiKey(tokens.accessToken),
      refreshToken: tokens.refreshToken
        ? encryptApiKey(tokens.refreshToken)
        : null,
      tokenType: "Bearer",
      expiresAt,
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.readonly",
      ],
      accountLabel,
    },
    update: {
      accessToken: encryptApiKey(tokens.accessToken),
      ...(tokens.refreshToken
        ? { refreshToken: encryptApiKey(tokens.refreshToken) }
        : {}),
      expiresAt,
      accountLabel,
    },
  });

  console.info(
    `[auth] Stored Google OAuth credential for user ${userId}${accountLabel ? ` (${accountLabel})` : ""}`
  );
}

/**
 * After signup: capture Google tokens so Gmail works immediately.
 */
export const onAfterSignup: OnAfterSignupHook = async ({ oauth, user }) => {
  if (!oauth) return;

  const tokens = extractGoogleTokens(oauth);
  if (!tokens) return;

  try {
    await storeGoogleCredential(user.id, tokens);
  } catch (e: any) {
    console.error("[auth] Failed to store Google credential on signup:", e.message);
  }
};

/**
 * After login: refresh Google tokens (Google rotates access tokens on each login).
 */
export const onAfterLogin: OnAfterLoginHook = async ({ oauth, user }) => {
  if (!oauth) return;

  const tokens = extractGoogleTokens(oauth);
  if (!tokens) return;

  try {
    await storeGoogleCredential(user.id, tokens);
  } catch (e: any) {
    console.error("[auth] Failed to update Google credential on login:", e.message);
  }
};
