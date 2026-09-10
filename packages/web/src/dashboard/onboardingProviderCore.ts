// Pure, network-free logic for the onboarding provider chooser (issue #758).
//
// The onboarding "connect your mailbox" step offers Gmail or Outlook /
// Microsoft 365. All of the branching a component needs — which providers are
// available in this deployment, what to label them, how the connected/marker
// state is encoded, and what error copy to show — lives here so it can be unit
// tested without React or a live tenant. DeskOnboardingGate.tsx consumes it.

export type EmailProvider = "gmail" | "outlook";

// The onboarding gmail-mode (transport) resolved server-side. Outlook is only
// reachable when Composio is configured — there is no direct-Microsoft-OAuth
// onboarding path, by design.
export type OnboardingMode = "composio" | "google" | "none" | null;

export interface ProviderOption {
  id: EmailProvider;
  label: string;
  /** Short line under the label. */
  hint: string;
  /** Whether the principal can pick this provider on this deployment. */
  available: boolean;
  /** When not available, why (shown as a muted note). */
  reason?: string;
}

export const CONNECTED_MARKER = "connected";

/** The Composio toolkit slug for a provider. */
export function toolkitForProvider(provider: EmailProvider): string {
  return provider === "outlook" ? "outlook" : "gmail";
}

/**
 * The two provider options, with availability decided by the transport mode.
 *
 * - Gmail is available in `google` and `composio` modes (its existing two
 *   implementations); unavailable only in `none`.
 * - Outlook requires `composio` — it has no direct-OAuth onboarding path. In
 *   any other mode it is shown but disabled, with a reason, rather than hidden,
 *   so the principal understands the option exists.
 */
export function providerOptions(mode: OnboardingMode): ProviderOption[] {
  const composio = mode === "composio";
  return [
    {
      id: "gmail",
      label: "Gmail",
      hint: "Google Workspace or personal Gmail",
      available: mode === "composio" || mode === "google",
      reason: mode === "none" ? "Email onboarding isn't configured on this instance." : undefined,
    },
    {
      id: "outlook",
      label: "Outlook / Microsoft 365",
      hint: "Work or personal Microsoft mailbox",
      available: composio,
      reason: composio
        ? undefined
        : "Outlook onboarding needs Composio configured on this instance.",
    },
  ];
}

/** Is a provider selectable given the mode? */
export function isProviderAvailable(provider: EmailProvider, mode: OnboardingMode): boolean {
  return providerOptions(mode).find((o) => o.id === provider)?.available ?? false;
}

/** Per-viewer storage key so a reload keeps the chosen provider. */
export const PROVIDER_STORAGE_KEY = "alfred.onboarding.provider";

export function readStoredProvider(): EmailProvider | null {
  try {
    const v = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
    return v === "gmail" || v === "outlook" ? v : null;
  } catch {
    return null;
  }
}

export function writeStoredProvider(provider: EmailProvider | null): void {
  try {
    if (provider) window.localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
    else window.localStorage.removeItem(PROVIDER_STORAGE_KEY);
  } catch {
    /* private mode / blocked storage — the URL marker is the fallback */
  }
}

/** The redirect URL carried back from a Composio consent round-trip. */
export function connectRedirect(origin: string, provider: EmailProvider): string {
  return `${origin}/desk?onboarding=${CONNECTED_MARKER}&provider=${provider}`;
}

/** Parse `?onboarding=connected&provider=outlook` off a URL search string. */
export function parseConnectedMarker(search: string): { marked: boolean; provider: EmailProvider | null } {
  try {
    const q = new URLSearchParams(search);
    const marked = q.get("onboarding") === CONNECTED_MARKER;
    const p = q.get("provider");
    return { marked, provider: p === "gmail" || p === "outlook" ? p : null };
  } catch {
    return { marked: false, provider: null };
  }
}

/** Human-readable connect-step error copy, provider-aware. */
export type ConnectErrorKind =
  | "popup_blocked"
  | "cancelled"
  | "admin_consent"
  | "mismatch"
  | "generic";

export function connectErrorCopy(kind: ConnectErrorKind, provider: EmailProvider): string {
  const name = provider === "outlook" ? "Microsoft" : "Google";
  switch (kind) {
    case "popup_blocked":
      return `Alfred couldn't open the ${name} sign-in window. Allow pop-ups and try again.`;
    case "cancelled":
      return "The connection didn't complete. Choose a mailbox to try again.";
    case "admin_consent":
      return provider === "outlook"
        ? "Your Microsoft 365 administrator must approve Alfred before it can read this mailbox. Ask them to grant consent, then try again."
        : "Your Google administrator must approve Alfred before it can read this mailbox.";
    case "mismatch":
      return "That account doesn't match this tenant's owner. Sign in with the owner's mailbox and try again.";
    default:
      return `Alfred couldn't start the ${name} connection. Please try again.`;
  }
}

/** Map a connection status string to whether it is usable. */
export function isActiveStatus(status: string | null | undefined): boolean {
  return String(status ?? "").toUpperCase() === "ACTIVE";
}
