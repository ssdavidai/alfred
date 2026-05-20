/**
 * Tenant-email guard for OAuth flows.
 *
 * Background: on 2026-04-16, a tenant got contaminated with a different
 * tenant's Gmail + Calendar data because the operator's browser was signed
 * into the wrong Google account when completing OAuth. This guard makes
 * that failure mode impossible going forward: after any Google OAuth
 * completes, we verify the returned email matches the tenant owner's
 * canonical email. Mismatch → reject, do not persist tokens.
 *
 * Pure-function core is exported separately so it can be unit-tested
 * without HTTP plumbing. See verifyGoogleEmailMatch below.
 */
import { GOOGLE_FAMILY_PROVIDERS, GOOGLE_FAMILY_TOOLKITS } from "./oauthTenantEmailGuardConstants";

/**
 * Error thrown when the OAuth-returned email doesn't match the tenant owner.
 * Carries both emails so the caller can surface a helpful message.
 */
export class GoogleAccountMismatchError extends Error {
  public readonly code = "google_account_mismatch";
  public readonly connectedEmail: string;
  public readonly expectedEmail: string;

  constructor(connectedEmail: string, expectedEmail: string) {
    super(
      `Google account mismatch: connected=${connectedEmail} expected=${expectedEmail}`,
    );
    this.name = "GoogleAccountMismatchError";
    this.connectedEmail = connectedEmail;
    this.expectedEmail = expectedEmail;
  }
}

/**
 * Case-insensitive email match. Throws GoogleAccountMismatchError on mismatch.
 * Returns the normalized (lowercased) owner email on success.
 *
 * Both arguments are required. If the owner email is not set on a given
 * tenant, callers should skip the guard entirely rather than pass null —
 * see the `skipIfEmpty` helpers below.
 */
export function verifyGoogleEmailMatch(
  connectedEmail: string,
  ownerEmail: string,
): string {
  if (!connectedEmail || typeof connectedEmail !== "string") {
    throw new GoogleAccountMismatchError(String(connectedEmail ?? ""), ownerEmail);
  }
  if (!ownerEmail || typeof ownerEmail !== "string") {
    throw new Error(
      "ownerEmail is required; call sites should skip the guard when owner email is unknown.",
    );
  }
  const connected = connectedEmail.trim().toLowerCase();
  const owner = ownerEmail.trim().toLowerCase();
  if (!connected || !owner) {
    throw new GoogleAccountMismatchError(connectedEmail, ownerEmail);
  }
  if (connected !== owner) {
    throw new GoogleAccountMismatchError(connectedEmail, ownerEmail);
  }
  return owner;
}

/**
 * Is the guard enabled? Default: on. Set OAUTH_TENANT_EMAIL_GUARD_ENABLED=false
 * to disable in an emergency.
 */
export function isGuardEnabled(): boolean {
  const v = (process.env.OAUTH_TENANT_EMAIL_GUARD_ENABLED ?? "true")
    .trim()
    .toLowerCase();
  return v !== "false" && v !== "0" && v !== "off" && v !== "no";
}

/**
 * Query Google's userinfo endpoint with an access token and return the
 * verified email. Throws if the call fails or email is missing.
 */
export async function fetchGoogleUserEmail(accessToken: string): Promise<{
  email: string;
  email_verified?: boolean;
}> {
  const resp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Google userinfo fetch failed (${resp.status}): ${text.slice(0, 200)}`,
    );
  }
  const data = (await resp.json()) as {
    email?: string;
    email_verified?: boolean;
    verified_email?: boolean;
  };
  if (!data.email) {
    throw new Error("Google userinfo response missing email field");
  }
  return {
    email: data.email,
    email_verified: data.email_verified ?? data.verified_email,
  };
}

/**
 * Is this OAuth provider slug a member of the Google family (and therefore
 * subject to the guard)? "google", "gmail", "googlecalendar", "googledrive",
 * "meet", "googlemeet" etc.
 */
export function isGoogleFamilyProvider(provider: string): boolean {
  const p = (provider ?? "").toLowerCase().replace(/[-_\s]/g, "");
  return GOOGLE_FAMILY_PROVIDERS.has(p);
}

/**
 * Same, for Composio toolkit slugs ("gmail", "googlecalendar", "googledrive",
 * "googlemeet", "googledocs", "googlesheets", "youtube", ...). A Composio
 * toolkit is Google-family iff its provider identity is a Google account.
 */
export function isGoogleFamilyToolkit(toolkit: string): boolean {
  const t = (toolkit ?? "").toLowerCase().replace(/[-_\s]/g, "");
  return GOOGLE_FAMILY_TOOLKITS.has(t);
}
