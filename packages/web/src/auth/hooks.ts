/**
 * Auth hooks — capture Google OAuth tokens on signup/login and store
 * them as OAuthCredentials so Gmail stream works without a separate
 * "Connect Gmail" step.
 */

import type {
  OnBeforeSignupHook,
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

  // Access token fields — Wasp/Arctic may use plain properties or getter functions
  const accessToken =
    (typeof tokens.accessToken === "function" ? tokens.accessToken() : tokens.accessToken) ??
    tokens.access_token;
  if (!accessToken) return null;

  const refreshToken =
    (typeof tokens.refreshToken === "function" ? tokens.refreshToken() : tokens.refreshToken) ??
    tokens.refresh_token ?? null;
  const idToken =
    (typeof tokens.idToken === "function" ? tokens.idToken() : tokens.idToken) ??
    tokens.id_token ?? null;

  let expiresIn: number | null = null;
  const expiresAtRaw = tokens.accessTokenExpiresAt;
  if (expiresAtRaw) {
    const expiresAt =
      typeof expiresAtRaw === "function" ? expiresAtRaw() : expiresAtRaw;
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
 * After signup:
 *  1. Auto-verify the OWNER (first user). Single-VM deploys may run with no
 *     mail provider configured, so the verification email can't be
 *     delivered — without this the principal could never log in. Later
 *     users still verify by email as normal.
 *  2. Capture Google tokens so Gmail works immediately.
 */
/**
 * Single-VM registration lockdown (FAILURE-MODES web bug #1).
 *
 * Registration was open and `isOwner`/`isAdmin` were only cosmetic (no
 * server-side role check), so ANY visitor who reached the domain could sign up
 * and get full read/write to the owner's vault, RULES.md, decisions and Gmail
 * data. Per the owner's decision ("lock signups now, invites later"): once the
 * box is claimed (a user exists) registration is closed. `onBeforeSignup` runs
 * before the user row is created, so throwing here cleanly rejects the signup
 * across every auth provider. Set `ALLOW_SIGNUP_AFTER_OWNER=true` to re-open it
 * (e.g. to add a household member by hand) until a real invite flow lands.
 */
export const onBeforeSignup: OnBeforeSignupHook = async () => {
  if ((process.env.ALLOW_SIGNUP_AFTER_OWNER ?? "").toLowerCase() === "true") {
    return;
  }
  const existing = await prisma.user.count();
  if (existing > 0) {
    throw new Error(
      "Registration is closed: this Alfred is already claimed by its owner.",
    );
  }
};

export const onAfterSignup: OnAfterSignupHook = async (args) => {
  const { oauth, user } = args;
  const providerId = (args as any).providerId;

  // 1. owner email auto-verification
  if (providerId?.providerName === "email" && (user as any).isOwner) {
    try {
      const key = {
        providerName_providerUserId: {
          providerName: "email",
          providerUserId: providerId.providerUserId,
        },
      };
      const identity = await prisma.authIdentity.findUnique({ where: key });
      if (identity) {
        const data = JSON.parse(identity.providerData);
        if (!data.isEmailVerified) {
          data.isEmailVerified = true;
          await prisma.authIdentity.update({
            where: key,
            data: { providerData: JSON.stringify(data) },
          });
          console.info(
            `[auth] Auto-verified owner email ${providerId.providerUserId}`
          );
        }
      }
    } catch (e: any) {
      console.error("[auth] owner auto-verify failed:", e.message);
    }
  }

  // 2. capture Google tokens so Gmail works immediately
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
