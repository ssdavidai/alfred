/**
 * Google-family identity allowlists for the tenant-email guard.
 *
 * Kept in a separate module from oauthTenantEmailGuard.ts so that unit tests
 * that import the guard don't drag in `wasp/server` transitively (the guard
 * itself is pure; the OAuth integration that uses it is not).
 *
 * All slugs are normalized via `.toLowerCase().replace(/[-_\s]/g, "")`
 * before lookup, so we only need to store the normalized form here.
 */

/** OAuth2 provider slugs whose identity is a Google account. */
export const GOOGLE_FAMILY_PROVIDERS: ReadonlySet<string> = new Set([
  "google",
  "gmail",
  "googlemail",
  "googlecalendar",
  "googledrive",
  "googlemeet",
  "googledocs",
  "googlesheets",
  "googleworkspace",
]);

/**
 * Composio toolkit slugs whose identity is a Google account.
 *
 * Source: Composio's toolkit catalog. Any toolkit that authenticates via
 * a Google OAuth consent screen belongs here. Non-Google toolkits (Notion,
 * Slack, GitHub, Linear, …) are intentionally absent — their identity is a
 * workspace/team/user id, not an email address, so tenant-owner-email isn't
 * a valid comparator.
 */
export const GOOGLE_FAMILY_TOOLKITS: ReadonlySet<string> = new Set([
  "gmail",
  "googlemail",
  "googlecalendar",
  "googledrive",
  "googlemeet",
  "googledocs",
  "googlesheets",
  "googleworkspace",
  "googletasks",
  "googlephotos",
  "googleforms",
  "googlecontacts",
  "googleslides",
  "youtube", // YouTube uses a Google account identity
]);
