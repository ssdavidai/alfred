// haCardCore — pure shape derivation for the /channels Home Assistant
// card. Import-free (no React/Wasp) so the derived states unit-test
// under node:test the same way tailscaleCardCore / omiCardCore do.
//
// #110 PR3 (2026-05-29): the deep-integration card. PR1 (#133 backfill)
// landed the ctrl-api routes:
//
//   POST /api/v1/channels/ha/connect       — body {ha_url, llat, label?}
//   GET  /api/v1/channels/ha/status        — fail-soft snapshot
//   DELETE /api/v1/channels/ha/disconnect  — clears state.db + vault item
//   GET  /api/v1/channels/ha/registry      — {entities, areas, devices,
//                                              automations, scenes, helpers}
//
// PR4 will land the recent-runs ledger; PR5 will populate ha_registry.
// This card is built to render an empty registry sensibly so the
// connected-state surface ships before PR4/PR5 backfill.
//
// The five UI states the derivation maps to are the ctrl-api `state`
// column values (0005_ha_channel.sql):
//
//   • unconfigured — no row in ha_connection. Show the connect form.
//   • connecting   — connect is mid-flight (operator pressed the button,
//                    ctrl-api is probing). UI polls /status every 3s.
//   • connected    — happy path. Show ha_url, ha_version, registry
//                    counts, optional expanders.
//   • error        — last connect/probe failed. Show last_error verbatim.
//   • disconnected — the principal hit Disconnect. Same shape as
//                    unconfigured for the form, but with a calmer
//                    headline ("HA disconnected — reconnect any time").
//
// SECURITY: the LLAT is the Home Assistant long-lived access token, a
// ~180-char JWT shaped string. It NEVER appears in any UI element, log
// line, error toast, commit, or PR body. The HA /status route strips it
// at the server layer; this file's `redactLlat` is the ONLY formatter
// allowed for any in-memory LLAT that touches the React tree (and even
// then it is only the first 8 characters).

export type HaState =
  | "unconfigured"
  | "connecting"
  | "connected"
  | "error"
  | "disconnected";

/** Status pill values consumed by ChannelCard. */
export type HaPill = "active" | "available" | "starting" | "error";

/** The view-mode the card surface renders against. */
export type HaViewMode =
  | "unconfigured"
  | "connecting"
  | "connected"
  | "error";

/**
 * Shape returned by GET /api/v1/channels/ha/status.
 *
 * From ctrl-api (channels_ha.ts):
 *   unconfigured → { connected: false, state: 'unconfigured', ... nulls }
 *   connected    → { connected: true,  state: 'connected', ha_url,
 *                    ha_version, label, last_test_ok, last_test_at, error }
 *
 * The LLAT is NEVER in this payload. Fields are intentionally permissive
 * (every value can be absent) so the UI does not crash on a partial
 * response — the derivation fills in safe defaults.
 */
export interface HaStatus {
  connected: boolean;
  state: HaState;
  ha_url: string | null;
  ha_version: string | null;
  label?: string | null;
  last_test_ok?: boolean;
  last_test_at?: string | null;
  error?: string | null;
}

/** A single registry entity. PR5 backfills these via HaBootstrapWorkflow. */
export interface HaEntity {
  ha_id?: string;
  entity_id?: string;
  domain?: string | null;
  friendly_name?: string | null;
  area_id?: string | null;
  device_id?: string | null;
  payload_json?: unknown;
}

/** A single registry area. */
export interface HaArea {
  ha_id?: string;
  area_id?: string;
  name?: string | null;
}

/** A single registry device. */
export interface HaDevice {
  ha_id?: string;
  device_id?: string;
  name?: string | null;
  area_id?: string | null;
}

/** A single registry automation. */
export interface HaAutomation {
  ha_id?: string;
  entity_id?: string;
  friendly_name?: string | null;
  state?: string | null;
}

/**
 * Shape returned by GET /api/v1/channels/ha/registry.
 *
 * Six buckets per ctrl-api:
 *   entities    — every HA entity (light, switch, sensor, climate, …)
 *   areas       — registered rooms / zones
 *   devices     — registered devices
 *   automations — automation entities (entity_id like 'automation.foo')
 *   scenes      — scene entities (entity_id like 'scene.foo')
 *   helpers     — input_* / timer / counter / etc.
 *
 * PR5 (HaBootstrapWorkflow Phase A) populates these. PR3 ships the
 * empty read so the connected-state surface lights up the moment the
 * principal connects.
 */
export interface HaRegistry {
  entities: HaEntity[];
  areas: HaArea[];
  devices: HaDevice[];
  automations: HaAutomation[];
  scenes: HaEntity[];
  helpers: HaEntity[];
}

/**
 * Counts surfaced by the connected-state header. The seven entity-domain
 * counts are the ones the operator cares about at-a-glance; the long
 * tail (binary_sensor, fan, lock, …) is omitted from the summary but
 * still appears in the "Registry" expander.
 *
 * `scenes` here counts the dedicated `registry.scenes[]` bucket — NOT
 * `entities[].domain === 'scene'` — because scenes are a top-level kind
 * in the ha_registry schema (kind = 'scene').
 */
export interface HaRegistryCounts {
  lights: number;
  switches: number;
  scenes: number;
  sensors: number;
  climate: number;
  cover: number;
  media_player: number;
}

export interface HaRegistrySummary {
  counts: HaRegistryCounts;
  areaCount: number;
  deviceCount: number;
  automationCount: number;
}

/** One row from the future /runs ledger (#110 PR4). */
export interface HaRunRow {
  id?: number | string;
  kind?: string;
  domain?: string | null;
  service?: string | null;
  entity_id?: string | null;
  created_at?: string;
}

/**
 * Derived view-state the React layer renders against.
 *
 * Fields are designed so the surface is a thin switch on `mode` — every
 * mode-specific copy/pill/flag value is precomputed here, including the
 * polling cadence (3s while connecting, off otherwise).
 */
export interface HaCardState {
  state: HaState;
  mode: HaViewMode;
  heading: string;
  description: string;
  pill: HaPill;
  /** ha_url being probed / connected to (null when unconfigured). */
  haUrl: string | null;
  /** ha_version surfaced in the connected state (null when missing). */
  haVersion: string | null;
  /** True iff the card should poll /status every 3s. */
  shouldPoll: boolean;
  /** True iff the connect form should render. */
  showConnectForm: boolean;
  /** True iff the "Disconnect" button should render. */
  showDisconnect: boolean;
  /** True iff the "Retry" button should render (error state). */
  showRetry: boolean;
  /** Verbatim error message — only meaningful when mode === "error". */
  errorMessage: string | null;
}

const NULL_STATUS: HaStatus = {
  connected: false,
  state: "unconfigured",
  ha_url: null,
  ha_version: null,
  label: null,
  last_test_ok: false,
  last_test_at: null,
  error: null,
};

const EMPTY_REGISTRY: HaRegistry = {
  entities: [],
  areas: [],
  devices: [],
  automations: [],
  scenes: [],
  helpers: [],
};

export function deriveHaCardState(args: {
  status: HaStatus | null | undefined;
}): HaCardState {
  const status = args.status ?? NULL_STATUS;
  const errorText = pickNonEmpty(status.error) ?? null;
  const haUrl = pickNonEmpty(status.ha_url);
  const haVersion = pickNonEmpty(status.ha_version);

  switch (status.state) {
    case "connecting":
      return {
        state: "connecting",
        mode: "connecting",
        heading: "Connecting to Home Assistant",
        description: haUrl
          ? `Probing ${haUrl} — this usually takes a couple of seconds.`
          : "Probing your Home Assistant install — this usually takes " +
            "a couple of seconds.",
        pill: "starting",
        haUrl,
        haVersion: null,
        shouldPoll: true,
        showConnectForm: false,
        showDisconnect: true,
        showRetry: false,
        errorMessage: null,
      };

    case "connected": {
      const versionFragment = haVersion ? ` (HA ${haVersion})` : "";
      const heading = haUrl
        ? `Connected to ${haUrl}${versionFragment}`
        : "Connected to Home Assistant";
      return {
        state: "connected",
        mode: "connected",
        heading,
        description:
          "Alfred can read your registry and (once PR5 lands the " +
          "bootstrap workflow) propose a baseline of automations.",
        pill: "active",
        haUrl,
        haVersion,
        shouldPoll: false,
        showConnectForm: false,
        showDisconnect: true,
        showRetry: false,
        errorMessage: null,
      };
    }

    case "error":
      return {
        state: "error",
        mode: "error",
        heading: "Home Assistant needs attention",
        description:
          errorText ||
          "Last connect / probe failed. Try again, or disconnect and " +
            "start over with a fresh LLAT.",
        pill: "error",
        haUrl,
        haVersion: null,
        shouldPoll: false,
        showConnectForm: false,
        showDisconnect: true,
        showRetry: true,
        errorMessage: errorText,
      };

    case "disconnected":
      return {
        state: "disconnected",
        mode: "unconfigured",
        heading: "HA disconnected — reconnect any time",
        description:
          "You disconnected earlier. Paste the HA URL + a fresh LLAT to " +
          "reconnect; everything previously discovered is forgotten.",
        pill: "available",
        haUrl: null,
        haVersion: null,
        shouldPoll: false,
        showConnectForm: true,
        showDisconnect: false,
        showRetry: false,
        errorMessage: null,
      };

    case "unconfigured":
    default:
      return {
        state: "unconfigured",
        mode: "unconfigured",
        heading: "Connect to your HA install",
        description:
          "Install the alfred-ha custom component first, then paste your " +
          "HA URL and a Long-Lived Access Token. Alfred reads your " +
          "registry on connect and never touches anything you haven't " +
          "approved.",
        pill: "available",
        haUrl: null,
        haVersion: null,
        shouldPoll: false,
        showConnectForm: true,
        showDisconnect: false,
        showRetry: false,
        errorMessage: null,
      };
  }
}

// ── HA URL validation ────────────────────────────────────────────────────

/**
 * Pre-flight client-side validation for the HA URL paste box. Mirrors the
 * server-side `assertValidHaUrl` in channels_ha.ts:
 *
 *   • Must parse as a URL (anything not URL-shaped → reject)
 *   • Scheme must be http: or https: (file://, javascript:, data:, ws:,
 *     etc. all reject)
 *   • Host must be non-empty
 *
 * On success returns the trimmed/normalised URL (trailing slash stripped
 * so the connect handler can append `/api/` cleanly). On failure returns
 * a human-friendly error pointing at the specific class of mistake.
 */
export interface ParseHaUrlResult {
  ok: boolean;
  url: string | null;
  error: string | null;
}

export function parseHaUrl(input: string): ParseHaUrlResult {
  if (typeof input !== "string") {
    return { ok: false, url: null, error: "HA URL must be a string." };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, url: null, error: "HA URL is required." };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      url: null,
      error:
        "That doesn't look like a URL. Try http://homeassistant.local:8123 " +
        "or https://your-ha.example.com.",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      url: null,
      error: `HA URL must use http:// or https:// (got ${parsed.protocol}).`,
    };
  }
  if (!parsed.host) {
    return { ok: false, url: null, error: "HA URL must include a host." };
  }
  // Normalise: strip trailing slash so the server-side `${ha_url}/api/`
  // append is clean.
  const normalised = trimmed.replace(/\/+$/, "");
  return { ok: true, url: normalised, error: null };
}

// ── LLAT redaction ───────────────────────────────────────────────────────

/**
 * Redact a Home Assistant Long-Lived Access Token for any in-memory
 * surface. Returns the first 8 characters followed by "…". Only the
 * first 8 chars may ever appear in any toast / error / debug breadcrumb
 * — and even then, only via this helper.
 *
 * Garbage input (non-string, empty, whitespace) returns the empty string
 * so callers can `${prefix && `token ${prefix}`}` cheaply.
 *
 * NEVER stringify or log a raw LLAT — see the lane brief security rule.
 */
export function redactLlat(s: string | null | undefined): string {
  if (typeof s !== "string") return "";
  const trimmed = s.trim();
  if (trimmed.length === 0) return "";
  // Even a very short input gets the same shape — the trailing ellipsis
  // is the contract that says "this is redacted, not the real value".
  if (trimmed.length <= 8) return `${trimmed}…`;
  return `${trimmed.slice(0, 8)}…`;
}

/**
 * The HA Long-Lived Access Token is a JWT-shaped string: three
 * base64url-encoded segments separated by dots, ~150-200 chars total.
 * This is a quick UX hint, NOT the server-side validator (HA itself is
 * the only thing that can really validate it via the /api/ probe).
 *
 * Whitespace-only input rejects; anything that doesn't look JWT-shaped
 * gives the operator a chance to spot a paste-fail before round-tripping.
 */
const LLAT_SHAPE_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function isProbablyValidLlat(s: string): boolean {
  if (typeof s !== "string") return false;
  const trimmed = s.trim();
  if (trimmed.length < 40) return false;
  return LLAT_SHAPE_RE.test(trimmed);
}

// ── Registry summary ─────────────────────────────────────────────────────

/**
 * The seven entity-domain counts the operator cares about at-a-glance:
 *
 *   light, switch, scene, sensor, climate, cover, media_player
 *
 * Plus three top-level counts: areas, devices, automations.
 *
 * `entities[].domain` is the discriminator inside the entities bucket
 * (HA's "domain" is the prefix of `entity_id`: `light.kitchen` →
 * `light`). Scenes appear both in entities[] (as `scene.*`) and the
 * dedicated `scenes[]` bucket — we prefer the dedicated bucket count so
 * the number lines up with the "Scenes" expander.
 *
 * Robust against `registry: null/undefined` and against any of the six
 * arrays being missing — every count defaults to 0.
 */
export function summariseRegistry(
  reg: HaRegistry | null | undefined,
): HaRegistrySummary {
  const r = reg ?? EMPTY_REGISTRY;
  const entities = Array.isArray(r.entities) ? r.entities : [];
  const areas = Array.isArray(r.areas) ? r.areas : [];
  const devices = Array.isArray(r.devices) ? r.devices : [];
  const automations = Array.isArray(r.automations) ? r.automations : [];
  const scenes = Array.isArray(r.scenes) ? r.scenes : [];

  const counts: HaRegistryCounts = {
    lights: 0,
    switches: 0,
    scenes: scenes.length,
    sensors: 0,
    climate: 0,
    cover: 0,
    media_player: 0,
  };

  for (const e of entities) {
    const domain = entityDomain(e);
    if (!domain) continue;
    switch (domain) {
      case "light":
        counts.lights += 1;
        break;
      case "switch":
        counts.switches += 1;
        break;
      case "sensor":
        counts.sensors += 1;
        break;
      case "climate":
        counts.climate += 1;
        break;
      case "cover":
        counts.cover += 1;
        break;
      case "media_player":
        counts.media_player += 1;
        break;
      // Other domains (binary_sensor, fan, lock, …) intentionally fall
      // through. They still appear in the "Registry" expander; just not
      // in the at-a-glance summary.
      default:
        break;
    }
  }

  return {
    counts,
    areaCount: areas.length,
    deviceCount: devices.length,
    automationCount: automations.length,
  };
}

/**
 * Extract a domain string from a registry entity. PR5's payload shape
 * puts `domain` at the top of the row (it's a column in ha_registry, the
 * partial index keys on it), but we fall back to entity_id parsing for
 * any payload that ships only the entity_id ("light.kitchen" → "light").
 *
 * Returns null when neither field is present, so the caller can skip
 * the row in the summary loop.
 */
function entityDomain(e: HaEntity | undefined | null): string | null {
  if (!e || typeof e !== "object") return null;
  const direct = pickNonEmpty(e.domain ?? null);
  if (direct) return direct;
  const id = pickNonEmpty(e.entity_id ?? e.ha_id ?? null);
  if (!id) return null;
  const dot = id.indexOf(".");
  if (dot <= 0) return null;
  return id.slice(0, dot);
}

// ── Recent runs sort ─────────────────────────────────────────────────────

/**
 * Sort a /runs payload by `created_at` desc and return the top 10. Used
 * by the "Recent runs" expander to show the freshest service-call /
 * automation-fire rows.
 *
 * Defensive: tolerates non-array input, malformed timestamps (those rows
 * sort to the bottom), and missing fields (id, kind, …) on individual
 * rows. The returned array is a copy — the caller's input is not
 * mutated.
 */
const RUNS_LIMIT = 10;

export function pickRecentRuns(
  rows: HaRunRow[] | null | undefined,
): HaRunRow[] {
  if (!Array.isArray(rows)) return [];
  const copy = rows.slice();
  copy.sort((a, b) => {
    const ta = parseTimestamp(a?.created_at);
    const tb = parseTimestamp(b?.created_at);
    // Rows with malformed timestamps sort to the bottom (oldest).
    if (tb === ta) return 0;
    return tb - ta;
  });
  return copy.slice(0, RUNS_LIMIT);
}

function parseTimestamp(s: string | null | undefined): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

// ── Internal helpers ─────────────────────────────────────────────────────

function pickNonEmpty(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}
