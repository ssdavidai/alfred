// paperclipCardCore — pure shape derivation for the /channels Paperclip
// card. Import-free (no React/Wasp) so it unit-tests under node:test the
// same way telegramCardCore / omiCardCore / slackCardCore do.
//
// The Paperclip card is a hybrid: it's both an INTEGRATION card (the
// Paperclip platform Alfred runs inside as a managed employee) and a
// CHANNEL card (heartbeats flow inbound, Hermes responds). The status
// shape comes from Lane I's ctrl-api endpoint:
//
//   GET /api/v1/channels/paperclip/status → PaperclipStatus
//   POST /api/v1/channels/paperclip/test   → { ok, status, latency_ms, … }
//
// PAPERCLIP_API_KEY (used for outbound calls, Lane V/P1) is pasted into
// /opt/alfred/.env by hand; PAPERCLIP_HEARTBEAT_SECRET is auto-generated
// by bootstrap.sh. The card is read-only except for the Test button — it
// surfaces the webhook URL the operator pastes into Paperclip's UI when
// creating the Alfred employee, plus the round-trip ping result.
//
// Three derived states:
//
//   • missing_secret — has_signing_secret=false. bootstrap.sh hasn't
//                      generated the heartbeat secret (or ctrl-api can't
//                      see it). Test button disabled; warning copy.
//   • awaiting       — has_signing_secret=true, last_heartbeat_at=null.
//                      The default state on a fresh install. Surfaces
//                      the heartbeat_url for paste-into-Paperclip + the
//                      paperclip.<DOMAIN> deep-link button.
//   • connected      — last_heartbeat_at non-null. Pill = "Connected",
//                      recent_runs visible (top 5 + expandable to 10),
//                      heartbeat URL collapsed-by-default.

export type PaperclipStatusState =
  | "missing_secret"
  | "needs_api_key"
  | "awaiting"
  | "connected";

// P3 — Paperclip's setup-state, probed by ctrl-api against paperclip:3100
// (with the right Host header). See route comments in channels_paperclip.ts
// for the four values. The card uses this to render the new sign-up + paste-
// API-key sub-card when the principal hasn't completed Paperclip's own
// onboarding ritual yet.
export type PaperclipSetupState =
  | "needs_api_key"
  | "configured"
  | "auth_failed"
  | "unreachable";

export type PaperclipRunStatus =
  | "ok"
  | "auth_failed"
  | "translation_failed"
  | "hermes_unreachable"
  | "replay";

export interface PaperclipRun {
  ts: string;
  run_id: string;
  paperclip_agent_id: string;
  task_id: string;
  status: PaperclipRunStatus;
  duration_ms: number;
}

export interface PaperclipStatus {
  configured: boolean;
  heartbeat_url: string;
  has_signing_secret: boolean;
  last_heartbeat_at: string | null;
  recent_runs: PaperclipRun[];
  /** P3 fields — present on /status responses ≥ P3. Older ctrl-api may
   *  omit them; the card falls back to deriving from has_signing_secret +
   *  last_heartbeat_at the old way (back-compat). */
  setup_state?: PaperclipSetupState;
  paperclip_origin?: string;
}

export interface PaperclipCardState {
  /** The visual state — drives which block of UI renders. */
  status: PaperclipStatusState;
  /** Pretty pill label ("Connected" / "Awaiting first task" / "Setup required"). */
  pillLabel: string;
  /** Pill tone — matches ChannelCard's ChannelStatus enum. */
  pillTone: "active" | "available" | "soon" | "error";
  /** Heading copy under the card name. */
  heading: string;
  /** Italic marginalia under the heading. */
  description: string;
  /** Verbatim heartbeat URL passed through from the API. */
  heartbeatUrl: string;
  /**
   * Deep-link origin for the "Open Paperclip →" button — derived by
   * parsing heartbeat_url and replacing the host with paperclip.<host>.
   * Empty string when heartbeat_url is unparseable.
   */
  paperclipOrigin: string;
  /** True iff the Test button should be enabled (i.e. signing secret is set). */
  canTest: boolean;
  /** Top 5 runs from recent_runs (newest first), normalised for display. */
  visibleRuns: PaperclipRun[];
  /** True when recent_runs has more than 5 entries — drives "show all". */
  hasMoreRuns: boolean;
  /** Up to 10 runs (for the expanded view). */
  allRuns: PaperclipRun[];
  /**
   * Human-relative wording for last_heartbeat_at ("3 minutes ago"), or
   * null when we don't have a heartbeat yet.
   */
  lastHeartbeatRelative: string | null;
}

const NULL_STATUS: PaperclipStatus = {
  configured: false,
  heartbeat_url: "",
  has_signing_secret: false,
  last_heartbeat_at: null,
  recent_runs: [],
};

const VALID_RUN_STATUSES: ReadonlySet<PaperclipRunStatus> = new Set([
  "ok",
  "auth_failed",
  "translation_failed",
  "hermes_unreachable",
  "replay",
]);

function normaliseRuns(raw: unknown): PaperclipRun[] {
  if (!Array.isArray(raw)) return [];
  const out: PaperclipRun[] = [];
  for (const it of raw) {
    if (typeof it !== "object" || it === null) continue;
    const r = it as Record<string, unknown>;
    const ts = typeof r.ts === "string" ? r.ts : "";
    const run_id = typeof r.run_id === "string" ? r.run_id : "";
    const paperclip_agent_id =
      typeof r.paperclip_agent_id === "string" ? r.paperclip_agent_id : "";
    const task_id = typeof r.task_id === "string" ? r.task_id : "";
    const statusRaw = typeof r.status === "string" ? r.status : "";
    const status: PaperclipRunStatus = VALID_RUN_STATUSES.has(
      statusRaw as PaperclipRunStatus,
    )
      ? (statusRaw as PaperclipRunStatus)
      : "ok";
    const duration_ms =
      typeof r.duration_ms === "number" && Number.isFinite(r.duration_ms)
        ? r.duration_ms
        : 0;
    out.push({ ts, run_id, paperclip_agent_id, task_id, status, duration_ms });
  }
  return out;
}

/**
 * Derive the paperclip.<host> origin from the heartbeat URL. The
 * heartbeat_url returned by ctrl-api looks like:
 *
 *   https://home.alfred.black/api/v1/channels/paperclip/heartbeat
 *
 * The Paperclip platform itself lives on a `paperclip.` subdomain Caddy
 * routes to the sidecar (Lane I P0 wires this up):
 *
 *   https://paperclip.home.alfred.black
 *
 * So we parse the URL, drop the path, and prepend `paperclip.` to the
 * host. We're tolerant: an empty / unparseable URL returns an empty
 * string, and the React layer hides the deep-link button accordingly.
 *
 * Edge case: if the host already starts with `paperclip.` (someone
 * paths the heartbeat URL through the Paperclip subdomain directly),
 * we don't prefix again.
 */
export function derivePaperclipOrigin(heartbeatUrl: string): string {
  if (typeof heartbeatUrl !== "string" || heartbeatUrl.length === 0) {
    return "";
  }
  try {
    const u = new URL(heartbeatUrl);
    const host = u.host.startsWith("paperclip.")
      ? u.host
      : `paperclip.${u.host}`;
    return `${u.protocol}//${host}`;
  } catch {
    return "";
  }
}

export function derivePaperclipCardState(
  status: PaperclipStatus | null | undefined,
  now: Date = new Date(),
): PaperclipCardState {
  const s = status ?? NULL_STATUS;
  const allRuns = normaliseRuns(s.recent_runs).slice(0, 10);
  const visibleRuns = allRuns.slice(0, 5);
  const hasMoreRuns = allRuns.length > visibleRuns.length;
  const heartbeatUrl = typeof s.heartbeat_url === "string" ? s.heartbeat_url : "";
  const paperclipOrigin = derivePaperclipOrigin(heartbeatUrl);
  const lastHeartbeatRelative =
    typeof s.last_heartbeat_at === "string" && s.last_heartbeat_at
      ? relativeTimeFromIso(s.last_heartbeat_at, now)
      : null;

  if (!s.has_signing_secret) {
    return {
      status: "missing_secret",
      pillLabel: "Setup required",
      pillTone: "error",
      heading: "Heartbeat secret missing",
      description:
        "Run bootstrap.sh on the host to generate PAPERCLIP_HEARTBEAT_SECRET, " +
        "then `docker compose restart ctrl-api`.",
      heartbeatUrl,
      paperclipOrigin,
      canTest: false,
      visibleRuns,
      hasMoreRuns,
      allRuns,
      lastHeartbeatRelative,
    };
  }

  // P3 — Paperclip's own setup ritual hasn't been walked yet. We can't
  // auto-bootstrap Paperclip (it requires a CEO invite written through its
  // own DB), so the card carries the principal through Paperclip's UI:
  // "Open Paperclip → sign up → generate API key → paste it here". Once
  // pasted, ctrl-api writes the key into the runtime and the card flips
  // to "awaiting" (then "connected" once the first heartbeat arrives).
  //
  // setup_state is set by ctrl-api ≥ P3. When the upstream is older and
  // omits the field, fall through to the legacy awaiting/connected path
  // (PAPERCLIP_API_KEY was historically expected to be set manually
  // before the card was first viewed).
  if (s.setup_state === "needs_api_key" || s.setup_state === "auth_failed") {
    const needsAuth = s.setup_state === "auth_failed";
    return {
      status: "needs_api_key",
      pillLabel: needsAuth ? "Key rejected" : "Setup required",
      pillTone: needsAuth ? "error" : "available",
      heading: needsAuth
        ? "Paperclip rejected the API key"
        : "Finish Paperclip's setup",
      description: needsAuth
        ? "The saved key is no longer valid. Generate a new one in Paperclip → Settings → API keys, then paste it below."
        : "Paperclip is reachable but Alfred can't talk to it yet. Two clicks: sign up in Paperclip, then paste an API key here.",
      heartbeatUrl,
      paperclipOrigin: s.paperclip_origin || paperclipOrigin,
      canTest: false,
      visibleRuns,
      hasMoreRuns,
      allRuns,
      lastHeartbeatRelative,
    };
  }

  if (s.last_heartbeat_at === null || s.last_heartbeat_at === "") {
    return {
      status: "awaiting",
      pillLabel: "Awaiting first task",
      pillTone: "available",
      heading: "Ready for Paperclip",
      description:
        "Paste the heartbeat URL into Paperclip's HTTP adapter when you " +
        "create the Alfred employee. Once Paperclip pings you, this card " +
        "lights up.",
      heartbeatUrl,
      paperclipOrigin: s.paperclip_origin || paperclipOrigin,
      canTest: true,
      visibleRuns,
      hasMoreRuns,
      allRuns,
      lastHeartbeatRelative,
    };
  }

  return {
    status: "connected",
    pillLabel: "Connected",
    pillTone: "active",
    heading: "Paperclip is sending tasks",
    description: lastHeartbeatRelative
      ? `Last heartbeat: ${lastHeartbeatRelative}.`
      : "Heartbeats flowing.",
    heartbeatUrl,
    paperclipOrigin,
    canTest: true,
    visibleRuns,
    hasMoreRuns,
    allRuns,
    lastHeartbeatRelative,
  };
}

/**
 * Relative-time helper — kept local so the card never has to drag in a
 * date library. Mirrors telegramCardCore.relativeTimeFromIso's wording
 * floor (just now / N min / N hour[s] / N day[s]). Garbage in → "unknown".
 *
 * Exported because the React layer wants to format `recent_runs[].ts`
 * the same way.
 */
export function relativeTimeFromIso(
  iso: string,
  now: Date = new Date(),
): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const deltaSec = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (deltaSec < 45) return "just now";
  const min = Math.round(deltaSec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(deltaSec / 3600);
  if (hr < 24) return `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
  const day = Math.round(deltaSec / 86400);
  return `${day} ${day === 1 ? "day" : "days"} ago`;
}

/**
 * Truncate `task_id` for compact display in the recent-runs list. We
 * keep the first 6 + last 4 chars when it's longer than 12 — same
 * convention used elsewhere for short-id renderings (e.g. git sha).
 */
export function truncateTaskId(taskId: string): string {
  if (typeof taskId !== "string") return "";
  if (taskId.length <= 12) return taskId;
  return `${taskId.slice(0, 6)}…${taskId.slice(-4)}`;
}

/** Human label for a run status — matches the pill copy on the card. */
export function runStatusLabel(s: PaperclipRunStatus): string {
  switch (s) {
    case "ok":
      return "ok";
    case "auth_failed":
      return "auth failed";
    case "translation_failed":
      return "translation failed";
    case "hermes_unreachable":
      return "hermes unreachable";
    case "replay":
      return "replay";
  }
}
