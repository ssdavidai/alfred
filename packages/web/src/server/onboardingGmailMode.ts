/**
 * onboardingGmailMode — the single, server-side source of truth for which
 * OAuth path onboarding's "connect Gmail" step uses.
 *
 * Phase 0 of the Composio-managed Gmail onboarding initiative
 * (GitHub #67, epic #66). See docs/SCOPE-composio-gmail-onboarding.md.
 *
 * This phase is FLAG ONLY — it computes a readable signal and changes no
 * behaviour. P1 (the web onboarding CTA) and P3 (the alfred-learn email
 * pipeline) consume the mode later; P0 just makes it correctly computable
 * and exposes it to the client.
 *
 *   composio — COMPOSIO_API_KEY is set → Composio's managed Google OAuth.
 *   google   — GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set → the legacy
 *              custom Wasp/Google OAuth path (src/server/oauth2.ts).
 *   none     — neither is configured → onboarding's Gmail step cannot run.
 *
 * If BOTH are set, `composio` wins — per the epic, Composio managed OAuth is
 * the preferred path (no Google app-verification burden on the deployer).
 *
 * `none` is reported honestly when nothing is configured — callers must not
 * fabricate a default; onboarding's Gmail step is genuinely unavailable.
 */

export type OnboardingGmailMode = "composio" | "google" | "none";

/**
 * True when an env var is meaningfully set: present, non-empty after trim,
 * and not one of the `.env.server.example` angle-bracket placeholders
 * (e.g. `<your-google-client-id>`). A placeholder left verbatim in a real
 * environment must count as "not set" — otherwise the mode would resolve
 * to a path that cannot actually authenticate.
 */
function isEnvVarSet(value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  // `.env.server.example` placeholder convention: `<your-...>`.
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return false;
  return true;
}

/**
 * Resolve the Gmail onboarding mode from server environment. Single source
 * of truth — called by both the `getOnboardingGmailMode` query and, later,
 * by `startOnboarding` so the mode can be stamped into `OnboardingInput`
 * (it must be computable inside a server operation, not only via a query).
 *
 * Safe to call from any server-side context; reads only `process.env`.
 */
export function resolveOnboardingGmailMode(): OnboardingGmailMode {
  const hasComposio = isEnvVarSet(process.env.COMPOSIO_API_KEY);
  if (hasComposio) return "composio";

  const hasGoogle =
    isEnvVarSet(process.env.GOOGLE_CLIENT_ID) &&
    isEnvVarSet(process.env.GOOGLE_CLIENT_SECRET);
  if (hasGoogle) return "google";

  return "none";
}
