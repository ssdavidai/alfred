// recallCardCore — pure shape derivation for the /channels Recall.ai card.
// Mirrors paperclipCardCore / omiCardCore: import-free (no React / no Wasp)
// so the derived states unit-test under node:test the same way.
//
// Recall.ai replaces the retired Vexa stack as the per-meeting bot
// transport (#113). The principal never visits recall.ai — every dial
// the bot reads (region, bot name, announces-on-join, auto-join policy,
// calendar source, monthly-hours cap, leave-after-N-minutes, respond
// mode, wake word, cost-alert thresholds) is edited from this card.
//
// PR2 (#129) shipped these ctrl-api routes under /api/v1/channels/recall/:
//
//   POST  /validate-key                — paste-and-round-trip an API key
//   GET   /config                      — current dials (singleton row)
//   PATCH /config                      — update dials
//   GET   /usage                       — month-to-date hours rollup
//   GET   /bots/active                 — non-terminal bots
//   DELETE /bots/:bot_id               — mid-meeting terminate
//   POST  /webhook-test                — synthetic Svix-signed delivery
//   POST  /webhooks/recall             — inbound Svix-signed target
//
// Persistence of RECALL_API_KEY itself (Vaultwarden-backed POST /api-key)
// is *not* in PR2 — it lands in PR3a. PR3 ships the operator-facing
// surface against the validate-only contract: paste → round-trip →
// success copy + a soft "persistence pending" hint. Once PR3a lands the
// /api-key setter, the card upgrades to a save-on-success flow with no
// derivation change.
//
// The three derived "outer states" the card hangs UI off:
//
//   • disabled            — no API key on file (validate-key never
//                           passed AND none of the env-dependent routes
//                           succeed). Hero copy = "Activate Recall.ai
//                           meeting bot" + API-key paste form.
//   • configured          — config + usage routes return OK. Card shows
//                           the full dial form, recent-bots table,
//                           Test affordance, webhook setup expander.
//   • error               — the underlying probes returned a hard error
//                           ctrl-api itself couldn't recover from.

// ── enum option lists (single source of truth) ────────────────────────────
//
// These match the validator in channels_recall.ts. The web layer reads
// them straight off this module so the <select> options never drift
// from the route validator.

/** Regions Recall.ai hosts. Matches RECALL_REGION_HOSTS in the route. */
export const RECALL_REGION_OPTIONS = [
  "us-east-1",
  "us-west-2",
  "eu-central-1",
  "ap-northeast-1",
] as const;
export type RecallRegion = (typeof RECALL_REGION_OPTIONS)[number];

/** Auto-join policy. Matches VALID_AUTO_JOIN_POLICIES in the route. */
export const RECALL_AUTO_JOIN_POLICY_OPTIONS = [
  "off",
  "principal_attendee",
  "all",
] as const;
export type RecallAutoJoinPolicy =
  (typeof RECALL_AUTO_JOIN_POLICY_OPTIONS)[number];

/** Calendar source. Matches VALID_CALENDAR_SOURCES in the route. */
export const RECALL_CALENDAR_SOURCE_OPTIONS = [
  "composio",
  "recall_v2",
] as const;
export type RecallCalendarSource =
  (typeof RECALL_CALENDAR_SOURCE_OPTIONS)[number];

/** Respond mode. Matches VALID_RESPOND_MODES in the route. */
export const RECALL_RESPOND_MODE_OPTIONS = [
  "off",
  "on_mention",
  "always",
] as const;
export type RecallRespondMode =
  (typeof RECALL_RESPOND_MODE_OPTIONS)[number];

/** Bot lifecycle status (terminal + non-terminal, from recall_bot.status). */
export type RecallBotStatus =
  | "requested"
  | "joining"
  | "in_meeting"
  | "leaving"
  | "done"
  | "fail";

const TERMINAL_BOT_STATUSES: ReadonlySet<RecallBotStatus> = new Set([
  "done",
  "fail",
]);

// ── wire types — the shape the proxied ctrl-api responses produce ─────────

/**
 * GET /api/v1/channels/recall/config response (1:1 with rowToApiConfig).
 * All fields always present; updated_at is unix-ms.
 *
 * `api_key_set` + `api_key_first6` (PR3a) surface whether RECALL_API_KEY
 * is on file in the live ctrl-api .env. NEVER carries the full key —
 * `api_key_first6` is exactly six chars (or null when no key is set).
 * Both fields are optional on the wire so a pre-PR3a ctrl-api still
 * deserialises cleanly.
 */
export interface RecallConfig {
  region: RecallRegion;
  bot_name: string;
  announces_on_join: boolean;
  auto_join_policy: RecallAutoJoinPolicy;
  calendar_source: RecallCalendarSource;
  monthly_hours_cap: number;
  leave_after_minutes: number;
  respond_mode: RecallRespondMode;
  wake_word: string;
  cost_alert_thresholds: number[];
  updated_at: number;
  api_key_set?: boolean;
  api_key_first6?: string | null;
  /** True iff RECALL_WEBHOOK_SECRET is on file in the live ctrl-api .env.
   *  Mirrors api_key_set; optional on the wire (older ctrl-api omits). */
  webhook_secret_set?: boolean;
  /** First 6 chars of the Svix signing secret, or null when unset. The
   *  full value is NEVER round-tripped. */
  webhook_secret_first6?: string | null;
  /** The URL the operator pastes into Recall.ai's webhook dashboard
   *  (ctrl-api builds it from $DOMAIN). Optional on the wire. */
  webhook_url?: string | null;
}

/** GET /api/v1/channels/recall/usage response. */
export interface RecallUsage {
  this_month_hours: number;
  monthly_hours_cap: number;
  bot_count_active: number;
}

/**
 * One row from GET /api/v1/channels/recall/bots/active. The route returns
 * `{ bots: RecallBot[] }`; in the web layer we unwrap before passing in.
 * Timestamps are unix-ms (the ctrl-api passes them through as INTEGER).
 */
export interface RecallBot {
  id: string;
  calendar_event_id: string | null;
  meeting_url: string | null;
  status: RecallBotStatus;
  created_at: number;
  joined_at: number | null;
  left_at: number | null;
  transcript_url: string | null;
}

/**
 * Composite status the card actually renders off. Built in
 * operations.ts by stitching the three live queries together; the
 * fields below are the ones derivation cares about. `enabled` is the
 * "do we have a working API key" signal — derived in operations.ts
 * from "the env-dependent probes returned non-503". The web layer
 * NEVER sees the API key itself; only this boolean.
 */
export interface RecallStatus {
  enabled: boolean;
  config: RecallConfig | null;
  usage: RecallUsage | null;
  active_bots: RecallBot[];
  /** Verbatim error string from the most recent failed probe, if any. */
  error: string | null;
  /**
   * Webhook delivery URL the operator pastes into Recall.ai's dashboard.
   * Built off the tenant's public origin in ctrl-api (PR3a will surface
   * it on /config). Until then the web layer derives it from
   * window.location.origin. Optional on the wire.
   */
  webhook_url?: string;
  /**
   * First 6 chars of RECALL_WEBHOOK_SECRET (whsec_…). Surfaced for the
   * operator to recognise "did I paste the right secret?" without ever
   * round-tripping the full secret. Optional on the wire (older
   * ctrl-api may omit).
   */
  webhook_secret_first6?: string | null;
  /**
   * True iff RECALL_WEBHOOK_SECRET is on file in the live ctrl-api .env.
   * Drives the "API key set · webhook not wired" pill and the inline
   * webhook-secret paste field on the configured panel. Optional on
   * the wire (older ctrl-api may omit; the card treats `undefined` as
   * "unknown" and assumes wired so older deployments don't regress).
   */
  webhook_secret_set?: boolean;
}

// ── derived card state ────────────────────────────────────────────────────

/**
 * Four top-level card states the React layer renders off:
 *
 *   • disabled    — no API key on file. Pill = "Not connected".
 *                   Render the API-key paste form.
 *   • partial     — API key present, but RECALL_WEBHOOK_SECRET missing.
 *                   Pill = "Webhook not wired". Render the full dial
 *                   form AND a prominent webhook-secret paste field at
 *                   the top — Recall.ai's bot deliveries will 401 at
 *                   ctrl-api's inbound until the secret lands.
 *   • configured  — both API key + webhook secret on file. Pill =
 *                   "Connected". Full surface.
 *   • error       — enabled but a probe returned a hard error.
 */
export type RecallCardStatusKind =
  | "disabled"
  | "partial"
  | "configured"
  | "error";

export interface RecallCardState {
  /** Which top-level block renders. */
  status: RecallCardStatusKind;
  /** Pretty pill label ("Connected" / "Not connected" / "Needs attention"). */
  pillLabel: string;
  /** Pill tone — matches ChannelCard's ChannelStatus enum. */
  pillTone: "active" | "available" | "error";
  /** Heading copy under the card name. */
  heading: string;
  /** Marginalia under the heading. */
  description: string;
  /** Sub-line in the card's "address" slot. */
  address: string;
  /**
   * The dial form's initial values. On `disabled`/`error` the values
   * are still surfaced (so the principal sees Recall's defaults
   * pre-paste); on `configured` they reflect the live row.
   */
  formValues: RecallFormValues;
  /** Up to 10 active-bot rows, normalised + newest-first. */
  visibleBots: RecallBot[];
  /** True iff the dial form should be interactive (configured only). */
  canEditDials: boolean;
  /** True iff the "Send test webhook" CTA renders enabled. */
  canTest: boolean;
  /** Live month-to-date hours number, or null when not yet known. */
  monthHours: number | null;
  /** True when month-to-date use ≥ cost-alert threshold. Drives the badge. */
  costAlertTriggered: boolean;
}

/**
 * The shape the React form binds to. Keep it serialisable and
 * separately exported so a parent component can hold form state in a
 * single object without dragging in the whole derivation result.
 */
export interface RecallFormValues {
  region: RecallRegion;
  bot_name: string;
  announces_on_join: boolean;
  auto_join_policy: RecallAutoJoinPolicy;
  calendar_source: RecallCalendarSource;
  monthly_hours_cap: number;
  leave_after_minutes: number;
  respond_mode: RecallRespondMode;
  wake_word: string;
  cost_alert_thresholds: number[];
}

/** Defaults that match the migration's column defaults so the empty
 *  form never renders as blank strings. Single source of truth — the
 *  test asserts this matches the migration. */
export const RECALL_DEFAULT_FORM: RecallFormValues = {
  region: "us-east-1",
  bot_name: "Alfred's note-taker",
  announces_on_join: true,
  auto_join_policy: "principal_attendee",
  calendar_source: "composio",
  monthly_hours_cap: 60,
  leave_after_minutes: 90,
  respond_mode: "on_mention",
  wake_word: "Alfred",
  cost_alert_thresholds: [80, 100],
};

// ── input ranges (single source of truth for the form widgets) ────────────

/** Monthly-hours-cap input range. The route validator allows 0-10000;
 *  the card narrows to 1-500 because the principal is paying per hour
 *  and a 5000-hour cap would silently swallow a $50k bill. */
export const RECALL_MONTHLY_HOURS_CAP_RANGE = {
  min: 1,
  max: 500,
} as const;

/** Leave-after-minutes range. Mirrors the route validator (1-1440). */
export const RECALL_LEAVE_AFTER_MINUTES_RANGE = {
  min: 1,
  max: 1440,
} as const;

/** Wake-word length range. Mirrors the route validator. */
export const RECALL_WAKE_WORD_RANGE = {
  min: 1,
  max: 64,
} as const;

/** Cost-alert thresholds: each entry is a percentage; route allows
 *  0-1000 but the card narrows to 1-200 (the value is "% of monthly
 *  cap", so >200% is almost always a typo). */
export const RECALL_COST_THRESHOLD_RANGE = {
  min: 1,
  max: 200,
} as const;

// ── validators ────────────────────────────────────────────────────────────

/** Wake-word: non-empty, ≤64 chars, no leading/trailing whitespace,
 *  no control chars. Mirrors the route validator's intent + a little
 *  defensive trimming so the principal doesn't paste a stray newline. */
export function isProbablyValidWakeWord(s: unknown): boolean {
  if (typeof s !== "string") return false;
  const trimmed = s.trim();
  if (trimmed.length < RECALL_WAKE_WORD_RANGE.min) return false;
  if (trimmed.length > RECALL_WAKE_WORD_RANGE.max) return false;
  // Reject control chars (anything < 0x20 + DEL).
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/** Monthly-hours-cap input validator. */
export function isValidMonthlyHoursCap(n: unknown): boolean {
  if (typeof n !== "number" || !Number.isInteger(n)) return false;
  return (
    n >= RECALL_MONTHLY_HOURS_CAP_RANGE.min &&
    n <= RECALL_MONTHLY_HOURS_CAP_RANGE.max
  );
}

/** Leave-after-minutes input validator. */
export function isValidLeaveAfterMinutes(n: unknown): boolean {
  if (typeof n !== "number" || !Number.isInteger(n)) return false;
  return (
    n >= RECALL_LEAVE_AFTER_MINUTES_RANGE.min &&
    n <= RECALL_LEAVE_AFTER_MINUTES_RANGE.max
  );
}

/** Bot-name validator — non-empty, ≤200 chars (matches the route). */
export function isValidBotName(s: unknown): boolean {
  if (typeof s !== "string") return false;
  const trimmed = s.trim();
  return trimmed.length > 0 && trimmed.length <= 200;
}

// ── threshold parsing ─────────────────────────────────────────────────────

/**
 * Parse a comma-separated cost-alert threshold string ("80, 100, 150")
 * into a sorted-asc, deduped number array. Whitespace, trailing
 * commas, and stray "%" are tolerated. Returns null when any entry is
 * non-numeric or out of range — the caller surfaces a hint.
 *
 * Examples:
 *   "80, 100"          → [80, 100]
 *   "80 100 150"       → [80, 100, 150]   (whitespace separator)
 *   "100, 80, 80"      → [80, 100]        (sorted + deduped)
 *   "80%, 100%"        → [80, 100]        ('%' stripped)
 *   ""                 → null             (need at least one)
 *   "0, 100"           → null             (0 below min=1)
 *   "abc"              → null
 */
export function parseCostThresholdList(raw: string): number[] | null {
  if (typeof raw !== "string") return null;
  // Split on commas, whitespace, or both. Strip '%' so '80%' parses.
  const pieces = raw
    .split(/[,\s]+/)
    .map((p) => p.replace(/%/g, "").trim())
    .filter((p) => p.length > 0);
  if (pieces.length === 0) return null;
  const out: number[] = [];
  for (const p of pieces) {
    const n = Number(p);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    if (
      n < RECALL_COST_THRESHOLD_RANGE.min ||
      n > RECALL_COST_THRESHOLD_RANGE.max
    ) {
      return null;
    }
    if (!out.includes(n)) out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Inverse of parseCostThresholdList — render the array as a comma-joined
 *  string ("80, 100") for the <input> initial value. */
export function formatCostThresholdList(xs: number[]): string {
  if (!Array.isArray(xs)) return "";
  return xs
    .filter((x) => typeof x === "number" && Number.isFinite(x))
    .map((x) => String(x))
    .join(", ");
}

// ── recent-bots derivation ────────────────────────────────────────────────

/**
 * Split bots by terminal-ness; the React layer renders the active ones
 * inline at the top and the terminal ones in a "Recent" tail. Both
 * sets are newest-first.
 *
 * Defensively normalises an unknown[] array off the wire — drops nulls,
 * strings, unknown statuses (≠ the 6 in RecallBotStatus). The point is
 * to keep the card from blowing up when a future ctrl-api adds a new
 * status enum and the snapshot we hold is older than it.
 */
export function deriveBotsByStatus(raw: unknown): {
  active: RecallBot[];
  terminal: RecallBot[];
} {
  const all = normaliseBots(raw);
  const active: RecallBot[] = [];
  const terminal: RecallBot[] = [];
  for (const b of all) {
    if (TERMINAL_BOT_STATUSES.has(b.status)) terminal.push(b);
    else active.push(b);
  }
  // Newest-first by created_at.
  active.sort((a, b) => b.created_at - a.created_at);
  terminal.sort((a, b) => b.created_at - a.created_at);
  return { active, terminal };
}

const VALID_BOT_STATUSES: ReadonlySet<RecallBotStatus> = new Set([
  "requested",
  "joining",
  "in_meeting",
  "leaving",
  "done",
  "fail",
]);

function normaliseBots(raw: unknown): RecallBot[] {
  if (!Array.isArray(raw)) return [];
  const out: RecallBot[] = [];
  for (const it of raw) {
    if (typeof it !== "object" || it === null) continue;
    const r = it as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    if (!id) continue;
    const statusRaw = typeof r.status === "string" ? r.status : "";
    if (!VALID_BOT_STATUSES.has(statusRaw as RecallBotStatus)) continue;
    const status = statusRaw as RecallBotStatus;
    const calendar_event_id =
      typeof r.calendar_event_id === "string" ? r.calendar_event_id : null;
    const meeting_url =
      typeof r.meeting_url === "string" ? r.meeting_url : null;
    const created_at =
      typeof r.created_at === "number" && Number.isFinite(r.created_at)
        ? r.created_at
        : 0;
    const joined_at =
      typeof r.joined_at === "number" && Number.isFinite(r.joined_at)
        ? r.joined_at
        : null;
    const left_at =
      typeof r.left_at === "number" && Number.isFinite(r.left_at)
        ? r.left_at
        : null;
    const transcript_url =
      typeof r.transcript_url === "string" ? r.transcript_url : null;
    out.push({
      id,
      calendar_event_id,
      meeting_url,
      status,
      created_at,
      joined_at,
      left_at,
      transcript_url,
    });
  }
  return out;
}

/**
 * Duration in milliseconds the bot has been in the meeting, or null
 * when the bot hasn't joined yet. Caps at "now" for in-flight bots so
 * the React layer doesn't render a negative number.
 */
export function botDurationMs(
  bot: RecallBot,
  now: Date = new Date(),
): number | null {
  if (bot.joined_at === null) return null;
  const end = bot.left_at ?? now.getTime();
  return Math.max(0, end - bot.joined_at);
}

/** Pretty-format a duration in ms as "1h 12m" / "12m" / "47s". */
export function formatBotDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// ── webhook URL formatter ─────────────────────────────────────────────────

/**
 * Given the tenant's public origin (e.g. "https://home.alfred.black")
 * produce the URL the operator pastes into Recall.ai's webhook dashboard.
 *
 * Tolerates trailing slashes, missing scheme (assumes https), and an
 * empty string (returns ""). Never throws — the React layer hides the
 * Copy button when the result is empty.
 */
export function formatRecallWebhookUrl(origin: string | null | undefined): string {
  if (typeof origin !== "string" || origin.trim().length === 0) return "";
  let s = origin.trim();
  // No scheme → default to https.
  if (!/^https?:\/\//i.test(s)) {
    s = `https://${s}`;
  }
  // Strip trailing slash(es).
  s = s.replace(/\/+$/, "");
  // Validate it's parseable as a URL — fall through to the trimmed
  // string if not (caller may have a non-DNS hostname like "localhost").
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}/api/v1/webhooks/recall`;
  } catch {
    return `${s}/api/v1/webhooks/recall`;
  }
}

// ── status derivation ─────────────────────────────────────────────────────

/**
 * The card's top-level derivation. Pure: receives the composite
 * RecallStatus the operations layer built from the three queries (plus
 * the env-derived `enabled` boolean) and produces the React-ready
 * shape.
 *
 * Outer states:
 *   • disabled   — enabled=false (no API key on file). Hero copy +
 *                   paste form. Recent-bots table hidden.
 *   • error      — enabled=true but the live snapshot carries a hard
 *                   error string. Everything else still renders.
 *   • configured — enabled=true and no error. Full surface.
 */
export function deriveRecallCardState(
  status: RecallStatus | null | undefined,
  now: Date = new Date(),
): RecallCardState {
  const s = status ?? ({
    enabled: false,
    config: null,
    usage: null,
    active_bots: [],
    error: null,
  } as RecallStatus);

  const formValues = configToFormValues(s.config);
  const { active } = deriveBotsByStatus(s.active_bots);
  const visibleBots = active.slice(0, 10);
  const monthHours =
    s.usage && Number.isFinite(s.usage.this_month_hours)
      ? s.usage.this_month_hours
      : null;

  // Cost-alert: trigger when month-to-date hours ≥ (cap * lowest-threshold/100).
  // Lowest threshold = the most cautious one (e.g. 80% in [80, 100]).
  const costAlertTriggered =
    monthHours !== null &&
    formValues.cost_alert_thresholds.length > 0 &&
    formValues.monthly_hours_cap > 0 &&
    monthHours >=
      (formValues.monthly_hours_cap *
        Math.min(...formValues.cost_alert_thresholds)) /
        100;

  if (!s.enabled) {
    return {
      status: "disabled",
      pillLabel: "Not connected",
      pillTone: "available",
      heading: "Activate Recall.ai meeting bot",
      description:
        "Recall.ai sends a bot to your Zoom / Meet / Teams meetings and " +
        "feeds the transcript back here. Paste an API key from recall.ai " +
        "to start.",
      address: "Coming soon (Recall.ai)",
      formValues,
      visibleBots: [],
      canEditDials: false,
      canTest: false,
      monthHours: null,
      costAlertTriggered: false,
    };
  }

  if (s.error) {
    return {
      status: "error",
      pillLabel: "Needs attention",
      pillTone: "error",
      heading: "Recall.ai needs attention",
      description: s.error,
      address: "Error — see below",
      formValues,
      visibleBots,
      canEditDials: false,
      canTest: false,
      monthHours,
      costAlertTriggered,
    };
  }

  const addressBits: string[] = [];
  if (monthHours !== null) {
    addressBits.push(
      `${formatHours(monthHours)} / ${formValues.monthly_hours_cap}h this month`,
    );
  }
  if (s.usage && s.usage.bot_count_active > 0) {
    addressBits.push(
      `${s.usage.bot_count_active} bot${
        s.usage.bot_count_active === 1 ? "" : "s"
      } active`,
    );
  }
  const address =
    addressBits.length > 0
      ? addressBits.join(" · ")
      : `Bot in ${formValues.region}`;

  void now; // reserved for relative-time formatting on the address line.

  // Webhook-secret posture. The flag is optional on the wire — pre-#153
  // ctrl-api omits it; older deployments shouldn't regress to a yellow
  // pill they have no way to clear, so an absent flag is treated as
  // "wired" (the conservative default). Only an explicit `false`
  // triggers the partial state.
  const webhookSet =
    s.config && typeof s.config.webhook_secret_set === "boolean"
      ? s.config.webhook_secret_set
      : null;
  if (webhookSet === false) {
    return {
      status: "partial",
      pillLabel: "Webhook not wired",
      pillTone: "error",
      heading: "Recall.ai webhook not wired",
      description:
        "API key set, but RECALL_WEBHOOK_SECRET is missing. Inbound " +
        "deliveries from Recall.ai will be rejected until you paste " +
        "the Svix signing secret below.",
      address,
      formValues,
      visibleBots,
      canEditDials: true,
      canTest: false,
      monthHours,
      costAlertTriggered,
    };
  }

  return {
    status: "configured",
    pillLabel: "Connected",
    pillTone: "active",
    heading: "Recall.ai bot is on call",
    description:
      "Bot dials into meetings on your calendar (per the auto-join policy " +
      "below) and posts transcripts when each call ends.",
    address,
    formValues,
    visibleBots,
    canEditDials: true,
    canTest: true,
    monthHours,
    costAlertTriggered,
  };
}

/**
 * Map a server-side config row to the form's initial values. When the
 * row is null (fresh tenant), fall back to RECALL_DEFAULT_FORM so the
 * form never renders blank. Sanitises strings + clamps numbers into
 * the valid ranges so a corrupted row can't blow up the form.
 */
export function configToFormValues(
  config: RecallConfig | null | undefined,
): RecallFormValues {
  if (!config || typeof config !== "object") {
    return { ...RECALL_DEFAULT_FORM };
  }
  const region: RecallRegion = (RECALL_REGION_OPTIONS as readonly string[]).includes(
    config.region,
  )
    ? config.region
    : RECALL_DEFAULT_FORM.region;
  const auto: RecallAutoJoinPolicy = (
    RECALL_AUTO_JOIN_POLICY_OPTIONS as readonly string[]
  ).includes(config.auto_join_policy)
    ? config.auto_join_policy
    : RECALL_DEFAULT_FORM.auto_join_policy;
  const cal: RecallCalendarSource = (
    RECALL_CALENDAR_SOURCE_OPTIONS as readonly string[]
  ).includes(config.calendar_source)
    ? config.calendar_source
    : RECALL_DEFAULT_FORM.calendar_source;
  const respond: RecallRespondMode = (
    RECALL_RESPOND_MODE_OPTIONS as readonly string[]
  ).includes(config.respond_mode)
    ? config.respond_mode
    : RECALL_DEFAULT_FORM.respond_mode;

  const clamp = (n: unknown, min: number, max: number, def: number): number => {
    if (typeof n !== "number" || !Number.isFinite(n)) return def;
    const i = Math.round(n);
    if (i < min) return min;
    if (i > max) return max;
    return i;
  };

  const thresholds = Array.isArray(config.cost_alert_thresholds)
    ? config.cost_alert_thresholds
        .filter(
          (x): x is number =>
            typeof x === "number" && Number.isFinite(x) && x > 0,
        )
        .map((x) => Math.round(x))
    : [];

  return {
    region,
    bot_name:
      typeof config.bot_name === "string" && config.bot_name.length > 0
        ? config.bot_name.slice(0, 200)
        : RECALL_DEFAULT_FORM.bot_name,
    announces_on_join:
      typeof config.announces_on_join === "boolean"
        ? config.announces_on_join
        : RECALL_DEFAULT_FORM.announces_on_join,
    auto_join_policy: auto,
    calendar_source: cal,
    monthly_hours_cap: clamp(
      config.monthly_hours_cap,
      RECALL_MONTHLY_HOURS_CAP_RANGE.min,
      RECALL_MONTHLY_HOURS_CAP_RANGE.max,
      RECALL_DEFAULT_FORM.monthly_hours_cap,
    ),
    leave_after_minutes: clamp(
      config.leave_after_minutes,
      RECALL_LEAVE_AFTER_MINUTES_RANGE.min,
      RECALL_LEAVE_AFTER_MINUTES_RANGE.max,
      RECALL_DEFAULT_FORM.leave_after_minutes,
    ),
    respond_mode: respond,
    wake_word:
      typeof config.wake_word === "string" && config.wake_word.length > 0
        ? config.wake_word.slice(0, RECALL_WAKE_WORD_RANGE.max)
        : RECALL_DEFAULT_FORM.wake_word,
    cost_alert_thresholds:
      thresholds.length > 0
        ? thresholds.slice().sort((a, b) => a - b)
        : RECALL_DEFAULT_FORM.cost_alert_thresholds.slice(),
  };
}

/**
 * Serialise the form to the PATCH /config body. Diff-friendly: only
 * fields whose value differs from the previous (committed) values are
 * included, so a PATCH with no changes is a no-op on the wire.
 *
 * Returns an empty object when nothing changed — the React layer can
 * cheaply skip the network call.
 */
export function serializeFormPatch(
  next: RecallFormValues,
  prev: RecallFormValues,
): Partial<RecallFormValues> {
  const out: Partial<RecallFormValues> = {};
  if (next.region !== prev.region) out.region = next.region;
  if (next.bot_name.trim() !== prev.bot_name.trim()) {
    out.bot_name = next.bot_name.trim();
  }
  if (next.announces_on_join !== prev.announces_on_join) {
    out.announces_on_join = next.announces_on_join;
  }
  if (next.auto_join_policy !== prev.auto_join_policy) {
    out.auto_join_policy = next.auto_join_policy;
  }
  if (next.calendar_source !== prev.calendar_source) {
    out.calendar_source = next.calendar_source;
  }
  if (next.monthly_hours_cap !== prev.monthly_hours_cap) {
    out.monthly_hours_cap = next.monthly_hours_cap;
  }
  if (next.leave_after_minutes !== prev.leave_after_minutes) {
    out.leave_after_minutes = next.leave_after_minutes;
  }
  if (next.respond_mode !== prev.respond_mode) {
    out.respond_mode = next.respond_mode;
  }
  if (next.wake_word.trim() !== prev.wake_word.trim()) {
    out.wake_word = next.wake_word.trim();
  }
  // Threshold arrays compare element-wise (already sorted by the parser).
  const a = next.cost_alert_thresholds;
  const b = prev.cost_alert_thresholds;
  const sameThresholds =
    a.length === b.length && a.every((v, i) => v === b[i]);
  if (!sameThresholds) out.cost_alert_thresholds = a.slice();
  return out;
}

// ── tiny number formatting helpers ────────────────────────────────────────

/** "12.30h" / "0.05h" — round to two decimals, always emit "h" suffix. */
export function formatHours(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(Math.round(n * 100) / 100).toFixed(2)}h`;
}

/** "abc1234…" short-id renderer — same convention as truncateTaskId. */
export function truncateBotId(id: string): string {
  if (typeof id !== "string") return "";
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

/** Pretty-format a unix-ms timestamp as ISO-ish "2026-05-29 12:34 UTC". */
export function formatBotTimestamp(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}

/** Human label for a bot status. */
export function botStatusLabel(s: RecallBotStatus): string {
  switch (s) {
    case "requested":
      return "Requested";
    case "joining":
      return "Joining";
    case "in_meeting":
      return "In meeting";
    case "leaving":
      return "Leaving";
    case "done":
      return "Done";
    case "fail":
      return "Failed";
  }
}

// ── API-key persistence state machine (#113 PR3a) ────────────────────────
//
// The /channels Recall card walks a paste through two server round-trips:
//
//   1. validate — POST /api/v1/channels/recall/validate-key
//   2. persist  — POST /api/v1/channels/recall/api-key (only fires if
//                 step 1 returned {ok:true})
//
// We model the panel as a tiny pure state machine here so the React
// component stays declarative and the contract gets exercised by
// recallCardCore.test.ts without a DOM. The phases mirror the strings
// the React layer renders:
//
//   • idle           — user is typing
//   • validating     — validate request in flight
//   • saving         — persist request in flight (validate already
//                       returned ok)
//   • done           — persist returned ok (fresh write OR idempotent)
//   • err_validate   — validate returned {ok:false} or threw; the
//                       previous key (if any) is UNCHANGED on the
//                       tenant
//   • err_persist    — validate returned ok but persist threw; the
//                       previous key (if any) is UNCHANGED on the
//                       tenant (this is the "revert" contract)

export type ApiKeyFlowPhase =
  | "idle"
  | "validating"
  | "saving"
  | "done"
  | "err_validate"
  | "err_persist";

export interface ApiKeyFlowState {
  phase: ApiKeyFlowPhase;
  /** Verbatim error string from the latest failed step, if any. */
  error: string | null;
  /** First six chars of the latest persisted key, if any. Never the full
   *  key. */
  keyFirst6: string | null;
  /** True when the latest persist call hit the idempotence branch (same
   *  key was already on file). */
  idempotent: boolean;
}

export const API_KEY_FLOW_IDLE: ApiKeyFlowState = {
  phase: "idle",
  error: null,
  keyFirst6: null,
  idempotent: false,
};

/** validate-key envelope as ctrl-api returns it on the
 *  /validate-key route. */
export interface ValidateKeyOutcomeWire {
  ok?: boolean;
  reason?: string;
}

/** api-key envelope as ctrl-api returns it on the /api-key route. */
export interface PersistKeyOutcomeWire {
  ok?: boolean;
  idempotent?: boolean;
  region?: string;
  key_first6?: string;
  persisted_to?: string[];
  restarted?: string[];
  eta_seconds?: number;
  reason?: string;
}

/** Transition from `phase=idle` when the user clicks Submit — the
 *  validate request enters flight. */
export function apiKeyFlowStartValidate(): ApiKeyFlowState {
  return { phase: "validating", error: null, keyFirst6: null, idempotent: false };
}

/** Apply the validate-key result. On {ok:true} we move to `saving`
 *  immediately (the persist request fires); on anything else we land in
 *  `err_validate` with the reason verbatim. The previous key remains
 *  untouched on the tenant in both branches — the persist request
 *  hasn't fired yet. */
export function apiKeyFlowOnValidate(
  prev: ApiKeyFlowState,
  outcome: ValidateKeyOutcomeWire | null | undefined,
  thrownMessage?: string,
): ApiKeyFlowState {
  if (typeof thrownMessage === "string") {
    return {
      phase: "err_validate",
      error: thrownMessage,
      keyFirst6: prev.keyFirst6,
      idempotent: false,
    };
  }
  if (!outcome || outcome.ok !== true) {
    return {
      phase: "err_validate",
      error:
        typeof outcome?.reason === "string" && outcome.reason
          ? outcome.reason
          : "Recall rejected the key.",
      keyFirst6: prev.keyFirst6,
      idempotent: false,
    };
  }
  return {
    phase: "saving",
    error: null,
    keyFirst6: prev.keyFirst6,
    idempotent: false,
  };
}

/** Apply the persist (api-key) result. On {ok:true} we land in `done`
 *  with the new keyFirst6 and idempotent flag. On any failure we land
 *  in `err_persist`. CRITICAL: the failure branch keeps `prev.keyFirst6`
 *  unchanged — the tenant's previous key was not overwritten (ctrl-api
 *  short-circuits BEFORE the .env write when the vault upsert fails). */
export function apiKeyFlowOnPersist(
  prev: ApiKeyFlowState,
  outcome: PersistKeyOutcomeWire | null | undefined,
  thrownMessage?: string,
): ApiKeyFlowState {
  if (typeof thrownMessage === "string") {
    return {
      phase: "err_persist",
      error: thrownMessage,
      keyFirst6: prev.keyFirst6,
      idempotent: false,
    };
  }
  if (!outcome || outcome.ok !== true) {
    return {
      phase: "err_persist",
      error:
        typeof outcome?.reason === "string" && outcome.reason
          ? outcome.reason
          : "ctrl-api refused to persist the key.",
      keyFirst6: prev.keyFirst6,
      idempotent: false,
    };
  }
  return {
    phase: "done",
    error: null,
    keyFirst6:
      typeof outcome.key_first6 === "string"
        ? outcome.key_first6
        : prev.keyFirst6,
    idempotent: outcome.idempotent === true,
  };
}

/** Reset back to idle — used by the "Try a different key" / "Reset"
 *  affordance. */
export function apiKeyFlowReset(): ApiKeyFlowState {
  return API_KEY_FLOW_IDLE;
}
