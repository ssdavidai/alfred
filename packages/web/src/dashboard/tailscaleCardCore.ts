// tailscaleCardCore — pure shape derivation for the /channels Tailscale
// card. Import-free (no React/Wasp) so the five derived states unit-test
// under node:test the same way telegramCardCore / omiCardCore do.
//
// #109 PR3 (2026-05-29): the Tailscale sidecar lives under
// `profiles: ["tailscale"]` in docker-compose — off by default. Connecting
// from the UI is the operator's opt-in, which means the card has to walk
// the user through a small state machine:
//
//   • disabled        — sidecar is off (default). Two CTAs:
//                       "Connect via auth key" (Path A — paste) and
//                       "Use device auth URL" (Path C — let tailscaled
//                       mint an auth URL we open in a new tab).
//   • starting        — Path A used: ctrl-api just brought the sidecar up
//                       with a known auth key, waiting for `tailscaled`
//                       to register. Spinner copy; UI polls /status.
//   • authenticating  — Path C used: sidecar is up but the operator still
//                       has to click the device-auth URL. The URL itself
//                       is the hero; we keep polling until it transitions
//                       to connected.
//   • connected       — tailscaled has a tailnet IP. Card shows the
//                       hostname, the IP, last probe time, and a
//                       "View peers" expander.
//   • error           — anything that surfaced an error from ctrl-api or
//                       the docker-compose step. The verbatim
//                       `last_error` / `reason` field is shown.
//
// The five states map 1:1 to the `state` field returned by
// GET /api/v1/channels/tailscale/status. Lane I (PR2 #127) owns the
// endpoint; the derivation here is the only thing the UI needs to know
// about the state machine.
//
// SECURITY: the paste-authkey input is a `type="password"` field in the
// React layer. We never stringify or log a `tskey-…` value here. Helpers
// like `redactAuthKey` are provided so error toasts can only surface the
// first 6 characters of any key the user pasted.

export type TailscaleState =
  | "disabled"
  | "starting"
  | "authenticating"
  | "connected"
  | "error";

/** Status pill values consumed by ChannelCard. */
export type TailscalePill = "active" | "available" | "starting" | "error";

/** The four UI modes the card surface renders against. */
export type TailscaleViewMode =
  | "disabled"
  | "connecting"
  | "connected"
  | "error";

/**
 * The shape returned by GET /api/v1/channels/tailscale/status (Lane I,
 * PR2 #127). Fields are intentionally permissive (every value can be
 * absent) so the UI does not crash on a partial response — the derivation
 * fills in safe defaults.
 */
export interface TailscaleStatus {
  state: TailscaleState;
  tailnet_ip: string | null;
  tailnet_hostname: string | null;
  /** Device-auth URL the operator has to open in a new tab (Path C). */
  auth_url: string | null;
  /** Epoch-millis of the last successful auth-key write (Path A). */
  authkey_used_at: number | null;
  /** Epoch-millis of the last successful `tailscale status --json` probe. */
  last_status_probe_at: number | null;
  /** Last error string from ctrl-api (mirrors `reason`). */
  last_error: string | null;
  /** Alias of last_error so the UI doesn't have to special-case the column. */
  reason: string | null;
}

/** A single peer entry from GET /api/v1/channels/tailscale/peers. */
export interface TailscalePeer {
  id: string | null;
  hostname: string | null;
  dns_name: string | null;
  os: string | null;
  tailscale_ips: string[];
  online: boolean;
  last_seen: string | null;
}

/** Shape returned by GET /api/v1/channels/tailscale/peers. */
export interface TailscalePeersResponse {
  peers: TailscalePeer[];
  reason?: string | null;
}

/**
 * The Path-A vs Path-C choice for the disabled state. The UI surfaces a
 * primary CTA ("Connect via auth key") and a secondary one ("Use device
 * auth URL") — these labels live here so the unit tests can assert them.
 */
export interface TailscaleConnectChoice {
  /** Path A: operator pastes a tskey-auth-… key. */
  primaryLabel: string;
  /** Path C: ctrl-api mints a device-auth URL from tailscaled. */
  secondaryLabel: string;
}

export interface TailscaleCardState {
  /** Underlying ctrl-api state (full 5-value enum). */
  state: TailscaleState;
  /** Coarse view-mode the React surface renders against. */
  mode: TailscaleViewMode;
  /** One-line headline above the card body. */
  heading: string;
  /** Italic marginalia under the headline. */
  description: string;
  /** Pretty status pill. */
  pill: TailscalePill;
  /** The two CTAs shown in the disabled state. */
  connectChoice: TailscaleConnectChoice;
  /**
   * Device-auth URL when Path C is in flight. Forwarded straight from the
   * status response; null when not applicable.
   */
  authUrl: string | null;
  /** True iff Path C device-auth URL block should render. */
  showAuthUrl: boolean;
  /** True iff the card should poll /status every 5s. */
  shouldPoll: boolean;
  /** True iff the "Disconnect" button should render. */
  showDisconnect: boolean;
  /** True iff the "Retry" button should render (error state). */
  showRetry: boolean;
  /** Verbatim error message — only meaningful when mode === "error". */
  errorMessage: string | null;
}

const NULL_STATUS: TailscaleStatus = {
  state: "disabled",
  tailnet_ip: null,
  tailnet_hostname: null,
  auth_url: null,
  authkey_used_at: null,
  last_status_probe_at: null,
  last_error: null,
  reason: null,
};

const DEFAULT_CONNECT_CHOICE: TailscaleConnectChoice = {
  primaryLabel: "Connect via auth key",
  secondaryLabel: "Use device auth URL",
};

export function deriveTailscaleCardState(args: {
  status: TailscaleStatus | null | undefined;
}): TailscaleCardState {
  const status = args.status ?? NULL_STATUS;
  // `reason` aliases `last_error` per ctrl-api spec; prefer whichever is
  // non-empty so a backend that filled in only one column still surfaces.
  const errorText =
    pickNonEmpty(status.last_error) ?? pickNonEmpty(status.reason) ?? null;

  switch (status.state) {
    case "starting":
      return {
        state: "starting",
        mode: "connecting",
        heading: "Starting Tailscale",
        description:
          "The sidecar is registering with the tailnet. This usually " +
          "takes a few seconds.",
        pill: "starting",
        connectChoice: DEFAULT_CONNECT_CHOICE,
        authUrl: null,
        showAuthUrl: false,
        shouldPoll: true,
        showDisconnect: false,
        showRetry: false,
        errorMessage: null,
      };

    case "authenticating": {
      const hasUrl = typeof status.auth_url === "string" && status.auth_url.length > 0;
      return {
        state: "authenticating",
        mode: "connecting",
        heading: hasUrl ? "Open the device-auth URL" : "Awaiting device auth",
        description: hasUrl
          ? "Open the URL below in a new tab to authorise this device on " +
            "your tailnet. The card will refresh once authorisation lands."
          : "Waiting for tailscaled to mint a device-auth URL.",
        pill: "starting",
        connectChoice: DEFAULT_CONNECT_CHOICE,
        authUrl: hasUrl ? status.auth_url : null,
        showAuthUrl: hasUrl,
        shouldPoll: true,
        showDisconnect: true,
        showRetry: false,
        errorMessage: null,
      };
    }

    case "connected": {
      const hostname = pickNonEmpty(status.tailnet_hostname);
      const ip = pickNonEmpty(status.tailnet_ip);
      const heading = hostname
        ? `Connected as ${hostname}`
        : "Connected to your tailnet";
      const probe = formatProbeTime(status.last_status_probe_at);
      const probeFragment = probe ? ` Last probe: ${probe}.` : "";
      const ipFragment = ip ? ` Tailnet IP: ${ip}.` : "";
      return {
        state: "connected",
        mode: "connected",
        heading,
        description:
          "This tenant is reachable on your tailnet." + ipFragment + probeFragment,
        pill: "active",
        connectChoice: DEFAULT_CONNECT_CHOICE,
        authUrl: null,
        showAuthUrl: false,
        shouldPoll: false,
        showDisconnect: true,
        showRetry: false,
        errorMessage: null,
      };
    }

    case "error":
      return {
        state: "error",
        mode: "error",
        heading: "Tailscale needs attention",
        description:
          errorText ||
          "ctrl-api couldn't bring the Tailscale sidecar up. Try again, " +
            "or disconnect and start over.",
        pill: "error",
        connectChoice: DEFAULT_CONNECT_CHOICE,
        authUrl: null,
        showAuthUrl: false,
        shouldPoll: false,
        showDisconnect: true,
        showRetry: true,
        errorMessage: errorText,
      };

    case "disabled":
    default:
      return {
        state: "disabled",
        mode: "disabled",
        heading: "Join your tailnet",
        description:
          "The Tailscale sidecar is off until first connect. Paste an " +
          "auth key for the fastest path, or let tailscaled mint a " +
          "device-auth URL you open in a new tab.",
        pill: "available",
        connectChoice: DEFAULT_CONNECT_CHOICE,
        authUrl: null,
        showAuthUrl: false,
        shouldPoll: false,
        showDisconnect: false,
        showRetry: false,
        errorMessage: null,
      };
  }
}

// ── Connect-mode helpers ─────────────────────────────────────────────────

/**
 * The card has two CTAs in the disabled state. The "primary" path is
 * pasting an auth key (faster, headless). The "secondary" path lets
 * tailscaled mint a device-auth URL the operator opens in a new tab.
 *
 * `deriveConnectMode(input)` is a single-source-of-truth predicate that
 * tells the React layer which POST body to send to /connect:
 *
 *   • "authkey"     — non-empty `tskey-auth-…` was pasted; send {authkey}.
 *   • "device-auth" — paste box is empty; send {} and surface the
 *                     returned `auth_url`.
 *
 * Whitespace-only paste boxes count as empty (device-auth).
 */
export type TailscaleConnectMode = "authkey" | "device-auth";

export function deriveConnectMode(input: {
  authkey?: string | null | undefined;
}): TailscaleConnectMode {
  const raw = typeof input.authkey === "string" ? input.authkey.trim() : "";
  return raw.length > 0 ? "authkey" : "device-auth";
}

// Tailscale auth keys are documented as `tskey-auth-<id>-<secret>` (and
// historically the older `tskey-<secret>` shape). We accept either — the
// ctrl-api side is the real validator, this is just a quick UX hint so
// we don't fire a /connect with an obvious paste-fail.
const AUTHKEY_RE = /^tskey-(?:auth-)?[A-Za-z0-9_-]{8,}$/;

export function isProbablyValidAuthKey(s: string): boolean {
  if (typeof s !== "string") return false;
  return AUTHKEY_RE.test(s.trim());
}

/**
 * Redact an auth key for display in error toasts. Only the first 6 chars
 * may ever leak; everything after is replaced with an ellipsis. Garbage
 * input (non-string, empty) returns an empty string so callers can
 * `${prefix && `key ${prefix}…`}` cheaply.
 *
 * NEVER log or stringify the full key — see the lane brief security rule.
 */
export function redactAuthKey(s: string | null | undefined): string {
  if (typeof s !== "string" || s.length === 0) return "";
  const trimmed = s.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= 6) return `${trimmed}…`;
  return `${trimmed.slice(0, 6)}…`;
}

// ── Peers helpers ────────────────────────────────────────────────────────

/**
 * Peer count derivation. Robust against `peers: undefined`, missing
 * payload, or a `{reason: "..."}`-only response (Tailscale disabled,
 * probe failed). Always returns a non-negative integer.
 */
export function derivePeerCount(
  response: TailscalePeersResponse | null | undefined,
): number {
  if (!response) return 0;
  if (!Array.isArray(response.peers)) return 0;
  return response.peers.length;
}

/**
 * Normalise a peer for rendering. Defaults `hostname` to the dns_name (or
 * the first tailnet IP) so the UI always has *something* to show — peers
 * advertised without a HostName still render with a sensible label.
 */
export function normalisePeer(p: TailscalePeer): TailscalePeer & {
  displayName: string;
} {
  const fallbackIp = p.tailscale_ips?.[0] ?? "unknown";
  const displayName =
    pickNonEmpty(p.hostname) ??
    pickNonEmpty(p.dns_name) ??
    fallbackIp;
  return { ...p, displayName };
}

// ── Probe-time helper ────────────────────────────────────────────────────

/**
 * Format the `last_status_probe_at` epoch-millis into a calm relative
 * string ("just now" / "5 min ago" / "2 hours ago" / "3 days ago").
 * Mirrors the wording other channel cards use elsewhere — we'd rather
 * understate than be precise to the second.
 *
 * Garbage input (null, NaN, future timestamp) returns an empty string so
 * callers can `${probe && ` Last probe: ${probe}.`}` cheaply.
 *
 * `now` is overridable for deterministic unit tests.
 */
export function formatProbeTime(
  epochMs: number | null | undefined,
  now: Date = new Date(),
): string {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return "";
  if (epochMs <= 0) return "";
  const deltaMs = Math.max(0, now.getTime() - epochMs);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(seconds / 86_400);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

// ── Dashboard-payload helper ─────────────────────────────────────────────

/**
 * Pick the tailnet hostname out of a /channels/tailscale/status payload
 * for callers that only care whether to surface the field as a connected
 * value (the dashboard's `instance.tailscaleHostname` slot). Returns the
 * trimmed hostname iff the connection is live AND the hostname is a
 * non-empty string; otherwise null. Fail-soft: any shape mismatch → null.
 *
 * Lives in tailscaleCardCore (and not in operations.ts) so the derivation
 * can unit-test under node:test without pulling in the Wasp server-op
 * surface.
 *
 * #109 PR 5.
 */
export function pickTailnetHostnameForDashboard(
  status: unknown,
): string | null {
  if (!status || typeof status !== "object") return null;
  const s = status as Partial<TailscaleStatus>;
  if (s.state !== "connected") return null;
  return pickNonEmpty(s.tailnet_hostname);
}

// ── Internal helpers ─────────────────────────────────────────────────────

function pickNonEmpty(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}
