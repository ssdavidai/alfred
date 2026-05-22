/**
 * Composio integration management routes.
 *
 * Exposes Composio connected accounts, toolkit catalog, OAuth connect flow,
 * capabilities classification, and stream/tool enablement to the SaaS
 * dashboard. Credentials are stored server-side at Composio — only the
 * connected_account_id and metadata are visible to the tenant.
 */
import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { dockerExec } from "../helpers.js";
import { createOrReuseOmiStream } from "./streams.js";

// Synthetic catalog slugs are NOT real Composio toolkits — they render bespoke
// modals (DEVICE_PAIR / INBOUND_WEBHOOK) and have their own routes. Posting one
// to Composio's connect flow fuzzy-resolves it to a junk toolkit (alfred-omi →
// `cal`), minting stray INITIATED connections. Reject them up front.
const SYNTHETIC_TOOLKIT_SLUGS = new Set(["alfred-omi", "alfred-webhook"]);

function assertNotSyntheticSlug(slug: string): void {
  if (SYNTHETIC_TOOLKIT_SLUGS.has(slug.toLowerCase())) {
    throw new ValidationError(
      `"${slug}" is not a Composio toolkit — it is a synthetic Alfred source. ` +
        `Use its dedicated flow (OMI → POST /api/v1/integrations/omi/pair; ` +
        `webhook → POST /api/v1/webhooks/inbound) instead of the Composio connect route.`,
    );
  }
}

// Vault root — for synthetic integration sources (Omi, custom webhooks).
const VAULT_ROOT = process.env.VAULT_PATH ?? "/vault";
const STREAM_EVENT_DIR = path.join(VAULT_ROOT, "stream_event");
const WEBHOOK_ENDPOINT_DIR = path.join(VAULT_ROOT, "webhook_endpoint");

// Composio REST API bases
const COMPOSIO_API_V3 = "https://backend.composio.dev/api/v3";
const COMPOSIO_API_V2 = "https://backend.composio.dev/api/v2";

// Paths — alfred-black named volumes (PLAN.md Part E).
const ALFRED_DATA_DIR = process.env.ALFRED_DATA_DIR ?? "/alfred-data";
const STREAMS_DIR = `${ALFRED_DATA_DIR}/streams`;
const STREAM_CONFIGS_DIR = path.join(STREAMS_DIR, "configs");

// Hermes per-profile workspace skill dirs. Hermes resolves profile state
// under HERMES_HOME (default /opt/data — see packages/hermes/Dockerfile);
// each profile's workspace skills live at
// ${HERMES_HOME}/profiles/<profile>/workspace/skills. The Composio skill-gen
// flow writes the alfred-composio-<toolkit> skill folders here. Note: skill
// files are genuine workspace files, NOT Hermes runtime config — connecting a
// Composio app no longer touches any config.yaml (see the long comment below).
const HERMES_HOME = process.env.HERMES_HOME ?? "/opt/data";
const HERMES_PROFILES_DIR = process.env.HERMES_CONFIG_DIR ?? `${HERMES_HOME}/profiles`;
const OPENCLAW_SKILLS_DIR = `${HERMES_PROFILES_DIR}/main/workspace/skills`;
const OPENCLAW_WORKERS_SKILLS_DIR = `${HERMES_PROFILES_DIR}/workers/workspace/skills`;

// Reconnect ledger — tracks (old_connection_id → new_connection_id) pairs from
// the /reconnect endpoint so the old connection can be deleted 1h after the
// new one is verified ACTIVE. Persisted on disk so the grace window survives
// ctrl-api restarts. See registerIntegrationRoutes for the lazy-reaper logic.
const RECONNECT_LEDGER_PATH = `${ALFRED_DATA_DIR}/.composio-reconnect-ledger.json`;
const RECONNECT_GRACE_MS = 60 * 60 * 1000; // 1 hour

function getComposioApiKey(): string {
  const key = process.env.COMPOSIO_API_KEY || "";
  if (!key) throw new ValidationError("COMPOSIO_API_KEY not configured on this tenant");
  return key;
}

/**
 * Resolve the Composio user_id for this tenant.
 *
 * Every tenant MUST have a unique COMPOSIO_USER_ID so that connected_accounts
 * (OAuth credentials, API keys) are scoped to the tenant. Without this, the
 * single shared platform-level Composio API key lets every tenant see — and
 * potentially EXECUTE against — every other tenant's connections. See #408.
 *
 * `"default"` is treated as "not set" — we refuse to proceed with it, because
 * that's the old buggy behaviour that caused cross-tenant data leakage.
 *
 * Injected at provisioning time by `packages/ctrl/src/infra/provisioner.ts`
 * and backfilled for existing tenants by `packages/openclaw/init/entrypoint.sh`.
 */
// Fallback file written by the init container for tenants provisioned
// before the provisioner learned to inject COMPOSIO_USER_ID. See
// packages/openclaw/init/entrypoint.sh step 10.
const COMPOSIO_USER_ID_FALLBACK_FILE = `${ALFRED_DATA_DIR}/.composio-user-id`;

function getComposioUserId(): string {
  let uid = (process.env.COMPOSIO_USER_ID || "").trim();
  if (!uid || uid === "default") {
    // Try the init-container-written fallback file for existing tenants
    // whose .env has not been backfilled yet.
    try {
      if (fs.existsSync(COMPOSIO_USER_ID_FALLBACK_FILE)) {
        const fileUid = fs.readFileSync(COMPOSIO_USER_ID_FALLBACK_FILE, "utf-8").trim();
        if (fileUid && fileUid !== "default") uid = fileUid;
      }
    } catch { /* ignore */ }
  }
  if (!uid || uid === "default") {
    throw new ValidationError(
      "COMPOSIO_USER_ID is not configured for this tenant. " +
      "This is required to isolate Composio connected accounts per tenant. " +
      "Set COMPOSIO_USER_ID=alfred-<slug>-<instance-id> in /opt/alfred/compose/.env and restart ctrl-api.",
    );
  }
  return uid;
}

// Google-backed Composio toolkits whose OAuth grant lives in the principal's
// Google account. Revoking the connection at Composio drops Composio's stored
// credential but NOT the upstream Google grant — that needs an explicit call to
// Google's revoke endpoint (F23).
const GOOGLE_TOOLKIT_PREFIXES = ["gmail", "googlecalendar", "googledrive", "googlemeet", "googledocs", "googlesheets", "googletasks", "youtube", "googlephotos", "gmaps", "googlemaps"];

function isGoogleToolkit(slug: string): boolean {
  const lower = slug.toLowerCase();
  return GOOGLE_TOOLKIT_PREFIXES.some((p) => lower === p || lower.startsWith(p));
}

/**
 * Revoke a Google OAuth token at Google so the grant disappears from the
 * principal's Google account. Best-effort + idempotent: an already-revoked
 * token (Google replies 400 invalid_token) counts as success. Returns true if
 * Google accepted the revoke (or it was already gone), false on a real error.
 */
async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const resp = await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    // 200 = revoked; 400 invalid_token = already revoked/expired (still success).
    if (resp.ok || resp.status === 400) return true;
    console.error(`[integrations] Google token revoke failed: ${resp.status}`);
    return false;
  } catch (err: any) {
    console.error(`[integrations] Google token revoke threw: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Pull the most-revocable OAuth token off a connected_account record. Google's
 * revoke accepts either the access or refresh token; prefer the refresh token
 * (revoking it kills the whole grant). Composio mirrors credentials at
 * state.val / data / params.
 */
function extractOAuthToken(conn: Record<string, unknown>): string | null {
  const c = conn as any;
  for (const src of [c?.state?.val, c?.data, c?.params]) {
    if (!src) continue;
    const t = src.refresh_token ?? src.access_token ?? src.token;
    if (typeof t === "string" && t) return t;
  }
  return null;
}

/**
 * Check whether a Composio connected_account payload belongs to the given user_id.
 * Handles both `member_id` (legacy) and `user_id` field names.
 */
function accountMatchesUserId(acct: Record<string, unknown>, userId: string): boolean {
  const a = acct as any;
  const m = a.member_id ?? a.user_id ?? a.userId ?? "";
  return typeof m === "string" && m === userId;
}

/**
 * Walk every page of Composio's /connected_accounts list, applying the local
 * user_id filter per page. Returns every account that actually belongs to the
 * tenant.
 *
 * Why this needs to loop: Composio's server-side `user_id` query-string filter
 * is silently broken — it ignores the filter and returns accounts across every
 * tenant in the workspace, paginated at 10 per page. A tenant whose accounts
 * happen to land on page 2+ of the global list sees an empty
 * `/api/v1/integrations` response even though their connections are healthy.
 *
 * Pagination: Composio v3 returns `next_cursor` per page. We loop until
 * `next_cursor` is falsy or we hit `PAGINATION_MAX_PAGES` (safety cap against
 * runaway loops in case the server misbehaves).
 */
const PAGINATION_MAX_PAGES = 100;
async function fetchAllOwnedConnectedAccounts(
  apiKey: string,
  userId: string,
): Promise<any[]> {
  const owned: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PAGINATION_MAX_PAGES; page++) {
    const url = new URL(`${COMPOSIO_API_V3}/connected_accounts`);
    url.searchParams.set("user_id", userId);
    if (cursor) url.searchParams.set("cursor", cursor);
    const resp = await fetch(url.toString(), {
      headers: { "x-api-key": apiKey },
    });
    if (!resp.ok) {
      throw new Error(`Composio API error: ${resp.status}`);
    }
    const data = (await resp.json()) as Record<string, unknown>;
    const items = Array.isArray(data.items) ? data.items : [];
    for (const a of items as any[]) {
      if (accountMatchesUserId(a, userId)) owned.push(a);
    }
    const nextCursor = (data.next_cursor ?? data.nextCursor ?? null) as string | null;
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return owned;
}

/**
 * Fetch a Composio connected_account by id and verify it belongs to THIS tenant.
 *
 * Composio's server-side `user_id` filter on `connected_accounts` list queries
 * has been observed to silently return accounts that don't match the filter
 * (see PR #469). That doesn't affect lookups by id, but every endpoint that
 * takes a connection-id path param and then operates on the connection MUST
 * verify ownership itself — otherwise one tenant could read/mutate another
 * tenant's connection by guessing or scraping the id.
 *
 * Returns the connection JSON on success. On 404 / 403 / network error it
 * sends the response and returns null; callers must return early when null.
 */
async function assertConnectionOwnedByTenant(
  res: any,
  connId: string,
  userId: string,
  apiKey: string,
): Promise<Record<string, unknown> | null> {
  try {
    const connResp = await fetch(
      `${COMPOSIO_API_V3}/connected_accounts/${encodeURIComponent(connId)}`,
      { headers: { "x-api-key": apiKey } },
    );
    if (connResp.status === 404) {
      sendJson(res, 404, { error: `Connected account ${connId} not found` });
      return null;
    }
    if (!connResp.ok) {
      sendJson(res, connResp.status, { error: `Composio API error: ${connResp.status}` });
      return null;
    }
    const conn = (await connResp.json()) as Record<string, unknown>;
    if (!accountMatchesUserId(conn, userId)) {
      // Treat ownership mismatch as 404 rather than 403 so enumeration can't
      // confirm a victim's connection id exists.
      sendJson(res, 404, { error: `Connected account ${connId} not found` });
      return null;
    }
    return conn;
  } catch (err: any) {
    sendJson(res, 500, { error: `Failed to verify connection ownership: ${err?.message ?? err}` });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Catalog cache (1h TTL)
// ---------------------------------------------------------------------------
interface CatalogEntry {
  slug: string;
  name: string;
  description: string;
  icon_url: string;
  category: string;
  auth_schemes: string[];
}

let catalogCache: { data: CatalogEntry[]; fetchedAt: number } | null = null;
const CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour

// Top-50 category map for known toolkits
const CATEGORY_MAP: Record<string, string> = {
  gmail: "communication", googlemail: "communication", outlook: "communication",
  slack: "communication", discord: "communication", teams: "communication",
  telegram: "communication", whatsapp: "communication", twilio: "communication",
  sendgrid: "communication", mailchimp: "communication", mailgun: "communication",
  notion: "productivity", todoist: "productivity", trello: "productivity",
  asana: "productivity", clickup: "productivity", monday: "productivity",
  evernote: "productivity", onenote: "productivity",
  github: "dev-tools", gitlab: "dev-tools", bitbucket: "dev-tools",
  jira: "dev-tools", linear: "dev-tools", sentry: "dev-tools",
  vercel: "dev-tools", netlify: "dev-tools", heroku: "dev-tools",
  stripe: "finance", paypal: "finance", square: "finance",
  quickbooks: "finance", xero: "finance", freshbooks: "finance",
  plaid: "finance", wise: "finance",
  googlecalendar: "calendar", calendly: "calendar",
  googledrive: "storage", dropbox: "storage", box: "storage", onedrive: "storage",
  hubspot: "crm", salesforce: "crm", pipedrive: "crm", zoho: "crm",
  airtable: "database", supabase: "database", firebase: "database",
  shopify: "ecommerce", woocommerce: "ecommerce",
  twitter: "social", linkedin: "social", facebook: "social", instagram: "social",
  youtube: "social", tiktok: "social", reddit: "social",
  zendesk: "support", intercom: "support", freshdesk: "support",
};

function classifyCategory(slug: string, meta?: Record<string, unknown>): string {
  const lower = slug.toLowerCase().replace(/[-_\s]/g, "");
  if (CATEGORY_MAP[lower]) return CATEGORY_MAP[lower];
  // Try from Composio metadata category field
  if (meta && typeof meta.category === "string" && meta.category) return meta.category.toLowerCase();
  return "other";
}

// Read verbs → stream actions (data IN), write verbs → tool actions (actions OUT)
const READ_VERBS = new Set(["FETCH", "GET", "LIST", "SEARCH", "FIND", "READ", "QUERY", "EXPORT", "DOWNLOAD", "CHECK", "RETRIEVE", "LOOKUP", "SHOW", "VIEW"]);
const WRITE_VERBS = new Set(["SEND", "CREATE", "UPDATE", "DELETE", "POST", "PUT", "PATCH", "WRITE", "ADD", "REMOVE", "SET", "INVITE", "ASSIGN", "CLOSE", "ARCHIVE", "MOVE", "COPY", "REPLY", "FORWARD", "UPLOAD", "TRIGGER", "EXECUTE", "RUN", "START", "STOP", "CANCEL", "APPROVE", "REJECT"]);

function classifyAction(slug: string): "stream" | "tool" {
  // Action slugs are typically TOOLKIT_VERB_REST e.g. GMAIL_FETCH_EMAILS
  const parts = slug.split("_");
  // Skip the first part (toolkit name), check remaining parts for verbs
  for (let i = 1; i < parts.length; i++) {
    const word = parts[i].toUpperCase();
    if (READ_VERBS.has(word)) return "stream";
    if (WRITE_VERBS.has(word)) return "tool";
  }
  // Default: if it starts with GET/LIST/FETCH it's a stream, otherwise tool
  if (parts.length > 1) {
    const verb = parts[1].toUpperCase();
    if (verb.startsWith("GET") || verb.startsWith("LIST") || verb.startsWith("FETCH")) return "stream";
  }
  return "tool";
}

async function fetchCatalog(apiKey: string): Promise<CatalogEntry[]> {
  // Check cache
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache.data;
  }

  const all: CatalogEntry[] = [];
  let cursor: string | null = null;
  const MAX_PAGES = 10;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${COMPOSIO_API_V3}/toolkits`);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    const resp = await fetch(url.toString(), {
      headers: { "x-api-key": apiKey },
    });

    if (!resp.ok) break;

    const data = (await resp.json()) as Record<string, unknown>;
    const items = Array.isArray(data.items) ? data.items : Array.isArray(data.toolkits) ? data.toolkits : [];

    for (const item of items as any[]) {
      all.push({
        slug: item.slug ?? item.name ?? "",
        name: item.displayName ?? item.name ?? item.slug ?? "",
        description: item.description ?? "",
        icon_url: item.logo ?? item.iconUrl ?? item.icon_url ?? "",
        category: classifyCategory(item.slug ?? "", item),
        auth_schemes: Array.isArray(item.auth_schemes)
          ? item.auth_schemes.map((s: any) => typeof s === "string" ? s : s?.mode ?? "")
          : item.authSchemes ? [item.authSchemes] : [],
      });
    }

    // Pagination — check for next cursor
    const nextCursor = (data as any).next_cursor ?? (data as any).nextCursor;
    if (!nextCursor || items.length === 0) break;
    cursor = nextCursor;
  }

  catalogCache = { data: all, fetchedAt: Date.now() };
  return all;
}

// ---------------------------------------------------------------------------
// Composio tool access under Hermes — why there is no config to mutate.
//
// Under OpenClaw, ctrl-api hand-edited a `gateway.tools.allow` array in the
// gateway config and restarted the gateway whenever a Composio app was
// connected. alfred-black runs Hermes instead, and Hermes models Composio
// completely differently:
//
//   • Composio is ONE tool — `composio_execute` — exposed by the `execute`
//     MCP server, which is registered UNCONDITIONALLY in every profile's
//     `mcp_servers` block (see packages/hermes/hermes-config.yaml.njk). Hermes
//     namespaces it `mcp_execute_composio_execute`. Individual Composio action
//     slugs (GMAIL_FETCH_EMAILS, …) are *arguments* to that one tool, never
//     entries in any allow-list.
//   • Hermes' native config (`platform_toolsets` + `mcp_servers`) has no
//     `tools.enabled` key at all. The old ctrl-api machinery wrote a phantom
//     key Hermes never reads, on a path (`/hermes-data/main/config.yaml`)
//     that does not even exist in the runtime (Hermes profiles live under
//     `${HERMES_HOME}/profiles/<p>/`).
//
// Net effect: connecting or disconnecting a Composio app needs NO Hermes
// config change and NO gateway restart — `composio_execute` is always live.
// The hand-edit-then-restart machinery (debounced flush, dual-profile config
// writers, `tools.enabled` mutators) was therefore both wrong and dead; it
// has been removed. `gateway_restart_triggered` is kept in route responses as
// a permanent `false` so the dashboard's web layer compiles unchanged.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Recommended streams + default args per toolkit
// ---------------------------------------------------------------------------

const RECOMMENDED_STREAMS: Record<string, {
  action: string;
  name: string;
  interval: number;
  args: Record<string, unknown>;
}> = {
  googlecalendar: { action: "GOOGLECALENDAR_EVENTS_LIST", name: "Calendar Events", interval: 300, args: { calendarId: "primary" } },
  // Gmail polling stream: format=metadata strips bodies (~1 KB/msg) so the
  // openclaw runtime's ~15 KB tool-result cap doesn't truncate after one
  // message. See platform issue: openclaw runtime tool-result truncation.
  gmail:          { action: "GMAIL_FETCH_EMAILS",         name: "Gmail Emails",     interval: 300, args: { userId: "me", format: "metadata", maxResults: 50 } },
  // slack omitted: SLACK_FETCH_CONVERSATION_HISTORY requires a channel ID (per-tenant config)
  // GITHUB_LIST_NOTIFICATIONS was renamed by Composio in early 2026 to
  // GITHUB_LIST_NOTIFICATIONS_FOR_THE_AUTHENTICATED_USER. Same behavior;
  // pulls the auth'd user's unread notifications feed.
  github:         { action: "GITHUB_LIST_NOTIFICATIONS_FOR_THE_AUTHENTICATED_USER",  name: "GitHub Notifications", interval: 300, args: {} },
  // NOTION_LIST_PAGES was removed from Composio's catalog in early 2026
  // (replaced by NOTION_FETCH_DATA which wraps Notion's search API). The new
  // action has no last_edited_time filter, so we run snapshot-mode: every
  // pull returns the 50 most-recently-edited items; StreamEvent dedupes via
  // the (streamId, sourceRef) unique index.
  notion:         { action: "NOTION_FETCH_DATA",          name: "Notion Pages",     interval: 600, args: { get_all: false, get_pages: true, get_databases: true, page_size: 50 } },
};

const SYNC_MODE: Record<string, "snapshot" | "append" | "sync"> = {
  googlecalendar: "sync",
  gmail: "append",
  slack: "append",
  github: "append",
  notion: "snapshot",
};

const DEFAULT_ARGS: Record<string, Record<string, unknown>> = {
  GOOGLECALENDAR_EVENTS_LIST: { calendarId: "primary" },
  GOOGLECALENDAR_FIND_EVENT: { calendarId: "primary" },
  GOOGLECALENDAR_CREATE_EVENT: { calendarId: "primary" },
  // Gmail listing actions: default to format=metadata so the openclaw
  // ~15 KB tool-result cap doesn't drop messages. A full message is
  // ~14 KB; metadata is ~1 KB. Use format="full" only when fetching ONE
  // specific message by id. See `alfred-composio-gmail` SKILL.md.
  GMAIL_FETCH_EMAILS: { userId: "me", format: "metadata", maxResults: 50 },
  GMAIL_LIST_THREADS: { userId: "me", format: "metadata", maxResults: 50 },
  GMAIL_SEND_EMAIL: { userId: "me" },
  GMAIL_LIST_LABELS: { userId: "me" },
};

// ---------------------------------------------------------------------------
// Gmail metadata-mode response stripping
//
// Composio's GMAIL_FETCH_EMAILS adapter silently ignores the `format` argument
// and always returns full RFC 5322 (headers + body + base64-encoded attachment
// parts). One message averages ~104 KB on the wire. Even after raising the
// openclaw tool-result cap to 160 KB, that's only ~2 messages per call —
// nowhere near enough for "list every email in the last 24 hours" (40+ msgs).
//
// When the agent passed `format: "metadata"` (the documented opt-in for the
// lightweight shape), we know it just wants navigation data — message ids,
// subject, sender, timestamp, label ids, snippet, attachment names. So we
// strip the body / payload tree / attachment binaries server-side. Net per
// message: ~104 KB → ~1 KB (~50–100x reduction observed against Sir's inbox).
//
// Strict pass-through rules:
//   • Only when action === "GMAIL_FETCH_EMAILS" AND arguments.format ===
//     "metadata" AND result.successful === true AND result.data.messages is
//     an array. Anything else flows through untouched.
//   • format: "full" (or unset, Composio's own default) is a deliberate
//     "give me one specific body" call — never strip.
//   • Top-level data fields like nextPageToken / resultSizeEstimate are
//     preserved so pagination keeps working.
//   • If the response shape doesn't match what we expect (Composio changed
//     it under us), we log at warn level and pass through untouched rather
//     than silently swallow data.
// ---------------------------------------------------------------------------

const PREVIEW_MAX_CHARS = 240;

const GMAIL_METADATA_KEEP_FIELDS = [
  "messageId",
  "threadId",
  "subject",
  "sender",
  "to",
  "messageTimestamp",
  "labelIds",
] as const;

function truncatePreview(value: unknown): unknown {
  // Composio's `preview` field is observed in two shapes:
  //   • a string snippet (older shape)
  //   • an object like { body: string, subject?: string } (current shape)
  // Truncate the body in either case; pass through anything else unchanged
  // so we don't corrupt unfamiliar variants.
  if (typeof value === "string") {
    return value.length > PREVIEW_MAX_CHARS
      ? value.slice(0, PREVIEW_MAX_CHARS) + "…"
      : value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const body = obj.body;
    if (typeof body === "string" && body.length > PREVIEW_MAX_CHARS) {
      return { ...obj, body: body.slice(0, PREVIEW_MAX_CHARS) + "…" };
    }
    return value;
  }
  return value;
}

function stripAttachmentEntry(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== "object") return null;
  const a = entry as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof a.filename === "string") out.filename = a.filename;
  if (typeof a.mimeType === "string") out.mimeType = a.mimeType;
  if (typeof a.size === "number") out.size = a.size;
  if (typeof a.attachmentId === "string") out.attachmentId = a.attachmentId;
  return out;
}

function stripGmailMetadataMessage(msg: unknown): Record<string, unknown> | unknown {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return msg;
  const m = msg as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const k of GMAIL_METADATA_KEEP_FIELDS) {
    if (k in m) out[k] = m[k];
  }
  if ("preview" in m) {
    out.preview = truncatePreview(m.preview);
  }
  if (Array.isArray(m.attachmentList) && m.attachmentList.length > 0) {
    const stripped = m.attachmentList
      .map(stripAttachmentEntry)
      .filter((x): x is Record<string, unknown> => x !== null);
    // Only emit the field if the source had at least one entry — don't
    // synthesise an empty array where there wasn't one.
    if (stripped.length > 0) out.attachmentList = stripped;
  }
  return out;
}

/**
 * Pure transform: given a raw `/api/v1/integrations/execute` response wrapping
 * a GMAIL_FETCH_EMAILS+format=metadata call, return a copy with each message
 * reduced to the navigation fields Alfred actually needs. See block comment
 * above for the policy. Exported for unit tests.
 *
 * The caller is responsible for checking that this transform is appropriate
 * (action + format match) before invoking — this helper assumes it is and
 * focuses on shape-checking the payload itself.
 */
export function stripGmailMetadataResponse(rawResponse: unknown): unknown {
  if (!rawResponse || typeof rawResponse !== "object") return rawResponse;
  const top = rawResponse as Record<string, unknown>;
  const result = top.result;
  if (!result || typeof result !== "object") return rawResponse;
  const r = result as Record<string, unknown>;
  if (r.successful !== true) return rawResponse;
  const data = r.data;
  if (!data || typeof data !== "object") {
    console.warn(
      "[integrations/execute] GMAIL_FETCH_EMAILS metadata-strip: result.data missing/invalid, passing through",
    );
    return rawResponse;
  }
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.messages)) {
    console.warn(
      "[integrations/execute] GMAIL_FETCH_EMAILS metadata-strip: result.data.messages not an array, passing through",
    );
    return rawResponse;
  }

  const strippedMessages = d.messages.map(stripGmailMetadataMessage);

  return {
    ...top,
    result: {
      ...r,
      data: {
        ...d,
        messages: strippedMessages,
      },
    },
  };
}

const TOOLKIT_EMOJI: Record<string, string> = {
  gmail: "📧", googlecalendar: "📅", slack: "💬", notion: "📝",
  github: "🐙", linear: "📋", stripe: "💳", discord: "🎮",
  trello: "📌", asana: "✅", hubspot: "🔶", salesforce: "☁️",
  googledrive: "📁", dropbox: "📦", twitter: "🐦", linkedin: "💼",
};

// ---------------------------------------------------------------------------
// Skill generation
// ---------------------------------------------------------------------------

// Toolkit-specific extra guidance injected into the generated SKILL.md.
// Today only Gmail needs special handling because of payload size + Gmail's
// pageToken model; future toolkits with similar quirks (Notion's giant page
// blocks, Calendar event lists, etc.) can be added here when investigated.
//
// Exported for tests.
export function buildToolkitGuidance(toolkit: string): string {
  if (toolkit !== "gmail") return "";
  return `
## Reading email — payload-size budget

**The openclaw tool-result cap is ~15 KB. A full Gmail message is ~14 KB. So:**

- **Always pass \`format: "metadata"\` for listing/scanning.** This strips the body — ~1 KB/message → ~12 messages fit per call.
- **Only pass \`format: "full"\` when fetching ONE specific message** (e.g. Sir says "show me the one from Müller").
- **Always paginate.** If the response has \`nextPageToken\`, call again with \`pageToken: <that token>\` until the token is empty or you have what Sir asked for.
- **Use Gmail's native query for time windows.** \`query: "newer_than:1d"\` for the last 24h, \`"newer_than:7d"\` for the week, \`"after:2026/04/24"\` for a specific date.

### Worked example: pull last 24 hours of email metadata

\`\`\`js
let allMessages = [];
let pageToken = null;
let pages = 0;

do {
  const resp = await self({
    endpoint: "/api/v1/integrations/execute",
    method: "POST",
    body: {
      action: "GMAIL_FETCH_EMAILS",
      arguments: {
        userId: "me",
        query: "newer_than:1d",
        format: "metadata",
        maxResults: 50,
        ...(pageToken && { pageToken }),
      },
    },
  });
  allMessages.push(...(resp.result?.data?.messages || []));
  pageToken = resp.result?.data?.nextPageToken;
  pages++;
  if (pages >= 5) break; // sanity cap, ~250 messages
} while (pageToken);

// Now allMessages has [{id, threadId, subject, from, date, snippet}, ...]
// To read the FULL body of one specific message:
// await self({endpoint: "/api/v1/integrations/execute", method: "POST",
//   body: {action: "GMAIL_FETCH_EMAILS", arguments: {userId: "me", query: \`rfc822msgid:<id>\`, format: "full", maxResults: 1}}})
\`\`\`
`;
}

/**
 * Short clarification injected into every generated alfred-composio-* SKILL.md.
 * The `user_id` field returned by Composio responses is the TENANT's Composio
 * identity (e.g. `alfred-tenant-a-101`), NOT Sir's identity in the underlying
 * app (Slack U-ID, Gmail address, GitHub login, etc.). For Sir's actual
 * per-app identity, the agent should consult `KNOWN_CONTACTS.md`.
 *
 * Exported for tests.
 */
export function buildUserIdClarification(): string {
  return `
## Note on \`user_id\`

The \`user_id\` value you'll see in Composio responses (e.g. \`alfred-<tenant>-<n>\`) is the **tenant's Composio identity**, NOT Sir's identity inside the underlying app. It is shared across every connection on this tenant, regardless of which provider account is on the other end.

For Sir's actual per-app identity (Slack U-ID, Gmail address, GitHub login, etc.) consult \`~/.openclaw/workspace/KNOWN_CONTACTS.md\`. Never feed the Composio \`user_id\` back into the underlying app's user-targeting fields — they expect the app's native identifier.
`;
}

async function generateComposioSkill(
  toolkit: string,
  connId: string,
  apiKey: string,
): Promise<{ actions_count: number; skill_path: string; written_paths: string[] }> {
  // Fetch actions from Composio v2 API
  const resp = await fetch(
    `${COMPOSIO_API_V2}/actions?apps=${encodeURIComponent(toolkit)}&limit=50`,
    { headers: { "x-api-key": apiKey } },
  );

  let actions: Array<{ slug: string; description: string; type: string }> = [];
  if (resp.ok) {
    const data = (await resp.json()) as any;
    const items = Array.isArray(data.items) ? data.items : [];
    actions = items.map((t: any) => ({
      slug: t.name ?? t.slug ?? "",
      description: (t.description ?? "").slice(0, 120),
      type: classifyAction(t.name ?? t.slug ?? ""),
    }));
  }

  const emoji = TOOLKIT_EMOJI[toolkit] || "🔌";
  const displayName = toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
  const toolActions = actions.filter((a) => a.type === "tool");
  const streamActions = actions.filter((a) => a.type === "stream");

  // Build common usage examples — uses the MCP `self` tool to call
  // POST /api/v1/integrations/execute. The MCP server (ctrl-server.mjs)
  // was renamed from `ctrl` to `self` in platform#438; this generator
  // was missed and kept producing skill files with the dead tool name,
  // so every connected tenant saw their agent say "no Gmail integration"
  // when it actually tried to dispatch.
  const recommended = RECOMMENDED_STREAMS[toolkit];
  let usageSection = "";
  if (toolActions.length > 0 || recommended) {
    const examples: string[] = [];
    const buildCall = (action: string, args: Record<string, unknown> | string): string => {
      const argsLiteral = typeof args === "string" ? args : JSON.stringify(args);
      return (
        `\`self({endpoint: "/api/v1/integrations/execute", method: "POST", ` +
        `body: {action: "${action}", arguments: ${argsLiteral}}})\``
      );
    };
    if (recommended) {
      examples.push(`- List data: ${buildCall(recommended.action, recommended.args)}`);
    }
    for (const ta of toolActions.slice(0, 3)) {
      const defaults = DEFAULT_ARGS[ta.slug];
      const argsExpr =
        defaults && Object.keys(defaults).length > 0 ? defaults : "{...}";
      examples.push(`- ${ta.description.split(".")[0]}: ${buildCall(ta.slug, argsExpr)}`);
    }
    usageSection = `\n## Common usage\n\n${examples.join("\n")}\n`;
  }

  // Build action table
  let actionTable = "| Action | Type | Description |\n|---|---|---|\n";
  for (const a of actions) {
    actionTable += `| \`${a.slug}\` | ${a.type} | ${a.description} |\n`;
  }

  // Toolkit-specific guidance. Gmail in particular needs explicit pagination +
  // payload-budget rules: the openclaw runtime caps tool-result text at
  // ~15 KB, while a single full Gmail message is ~14 KB — so without
  // format="metadata" + pageToken pagination, Alfred only ever sees one
  // message per call regardless of maxResults. See investigation that
  // motivated PR fix/gmail-skill-pagination-defaults.
  const toolkitGuidance = buildToolkitGuidance(toolkit);

  // Tenant Composio user_id ≠ Sir's identity in the underlying app. This
  // confused tenant-a's Alfred when a Slack action returned `user_id:
  // "alfred-tenant-a-101"` and he spent ~10s trying to reconcile that with
  // a Slack U-id. Apply the clarification across every generated SKILL.md
  // so the agent never makes that mistake again, regardless of toolkit.
  const userIdClarification = buildUserIdClarification();

  const skillContent = `---
name: alfred-composio-${toolkit}
description: ${displayName} integration — ${actions.length} available actions via the MCP self tool (POST /api/v1/integrations/execute).
version: "1.0"
metadata:
  openclaw:
    emoji: "${emoji}"
  generated: true
  composio_toolkit: "${toolkit}"
  composio_connection_id: "${connId}"
---

# ${emoji} ${displayName}

Connected via Composio. Call actions through the MCP \`self\` tool: \`self({endpoint: "/api/v1/integrations/execute", method: "POST", body: {action: "<ACTION_NAME>", arguments: {...}}})\`.

${streamActions.length > 0 ? `**Stream**: ${recommended ? `${recommended.name} (auto-configured, polling every ${Math.round(recommended.interval / 60)} min)` : "available but not auto-configured"}` : ""}
**Tool actions**: ${toolActions.length} | **Stream actions**: ${streamActions.length}
${userIdClarification}${toolkitGuidance}
## Actions

${actionTable}
${usageSection}`;

  // Write to both workspaces. Verify each write actually landed on disk by
  // re-reading and comparing content — without this, a silently-truncated or
  // a permission-denied write upstream of `writeFileSync` (e.g. immutable file
  // attribute, full disk on tmpfs, host-side stale-handle quirks) could let
  // the regen handler return `ok: true` while the file on disk is unchanged.
  // That was the symptom that motivated this guard: Sir's slack SKILL.md
  // stayed at the Apr 10 version through repeated regen calls that all
  // reported success.
  const skillDirName = `alfred-composio-${toolkit}`;
  const writtenPaths: string[] = [];
  for (const baseDir of [OPENCLAW_SKILLS_DIR, OPENCLAW_WORKERS_SKILLS_DIR]) {
    const skillDir = path.join(baseDir, skillDirName);
    const skillFile = path.join(skillDir, "SKILL.md");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillFile, skillContent);
    // Set ownership to node user (uid 1000) for openclaw containers
    try {
      fs.chownSync(skillDir, 1000, 1000);
      fs.chownSync(skillFile, 1000, 1000);
    } catch { /* may fail if not root, that's ok */ }
    // Read-after-write verification: if the on-disk content doesn't match what
    // we just wrote, surface a real error rather than swallowing it. The
    // previous handler's response would say `ok: true` even when the write
    // had no effect.
    let onDisk = "";
    try {
      onDisk = fs.readFileSync(skillFile, "utf-8");
    } catch (err: any) {
      throw new Error(`SKILL.md write verification failed for ${skillFile}: read-after-write errored (${err?.message ?? err})`);
    }
    if (onDisk !== skillContent) {
      throw new Error(
        `SKILL.md write verification failed for ${skillFile}: on-disk content (${onDisk.length}b) differs from written content (${skillContent.length}b)`,
      );
    }
    writtenPaths.push(skillFile);
  }

  return { actions_count: actions.length, skill_path: skillDirName, written_paths: writtenPaths };
}

// ---------------------------------------------------------------------------
// Reconnect ledger
//
// The reconnect endpoint creates a NEW Composio connected_account for the same
// (toolkit, user_id) pair while the OLD one is still alive. Both must coexist
// during the grace window so that:
//   - In-flight composio_execute calls keyed off the old id keep working until
//     stream configs / open sessions naturally migrate to the new id.
//   - If Sir abandons the OAuth handshake on the new connection, we don't end
//     up with NO connection at all (which would be the result of synchronously
//     deleting the old one and waiting on a never-completed handshake).
//
// After RECONNECT_GRACE_MS (1h) we check whether the new connection is ACTIVE
// and only then delete the old one. If the new connection never went ACTIVE,
// we keep the old one around — Sir is no worse off than before he asked.
//
// Two cleanup mechanisms:
//   1. In-process setTimeout, scheduled the moment the ledger entry is written.
//      Fast-path for the common case (ctrl-api stays up for >1h).
//   2. Lazy reaper that scans the ledger on every reconnect and on the
//      POST /api/v1/integrations/reconnect-cleanup endpoint. Survives restarts.
//      A future Temporal schedule (see follow-up issue) can call the cleanup
//      endpoint on a cron to remove the in-process-timer dependency entirely.
// ---------------------------------------------------------------------------

interface ReconnectLedgerEntry {
  old_connection_id: string;
  new_connection_id: string;
  toolkit: string;
  user_id: string;
  scheduled_at: number;   // ms since epoch — when the reconnect was requested
  cleanup_after: number;  // ms since epoch — earliest time to delete the old one
}

function readReconnectLedger(): ReconnectLedgerEntry[] {
  try {
    const raw = fs.readFileSync(RECONNECT_LEDGER_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeReconnectLedger(entries: ReconnectLedgerEntry[]): void {
  try {
    fs.mkdirSync(path.dirname(RECONNECT_LEDGER_PATH), { recursive: true });
    fs.writeFileSync(RECONNECT_LEDGER_PATH, JSON.stringify(entries, null, 2));
  } catch (err: any) {
    console.error(`[reconnect] ledger write failed: ${err?.message ?? err}`);
  }
}

function appendReconnectLedger(entry: ReconnectLedgerEntry): void {
  const ledger = readReconnectLedger();
  // Drop any prior entry for the same old_connection_id — a re-reconnect
  // restarts the grace window against the newest new_connection_id.
  const filtered = ledger.filter((e) => e.old_connection_id !== entry.old_connection_id);
  filtered.push(entry);
  writeReconnectLedger(filtered);
}

/**
 * Try to delete one stale (old) Composio connected_account, but ONLY if its
 * paired new connection has reached ACTIVE. If the new one never made it
 * to ACTIVE, leave the old one alone — Sir's apps still work.
 *
 * Returns one of:
 *   "deleted" — old connection removed, ledger entry purged.
 *   "kept"    — new connection not yet ACTIVE; ledger entry kept for retry.
 *   "purged"  — entry removed without deleting (old connection already gone,
 *               or new connection itself is gone — nothing to clean up).
 */
async function reapReconnectEntry(
  entry: ReconnectLedgerEntry,
  apiKey: string,
): Promise<"deleted" | "kept" | "purged"> {
  // 1. Verify the new connection actually became ACTIVE. Without this guard
  //    we'd risk deleting Sir's only working connection if he abandoned OAuth.
  let newStatus = "";
  try {
    const newResp = await fetch(
      `${COMPOSIO_API_V3}/connected_accounts/${encodeURIComponent(entry.new_connection_id)}`,
      { headers: { "x-api-key": apiKey } },
    );
    if (newResp.status === 404) {
      // New connection vanished — no point keeping ledger entry around.
      return "purged";
    }
    if (newResp.ok) {
      const newConn = (await newResp.json()) as any;
      newStatus = String(newConn.status ?? "").toUpperCase();
    }
  } catch {
    // Network / Composio outage — leave entry, retry later.
    return "kept";
  }

  if (newStatus !== "ACTIVE") {
    return "kept";
  }

  // 2. Delete the old connection.
  try {
    const delResp = await fetch(
      `${COMPOSIO_API_V3}/connected_accounts/${encodeURIComponent(entry.old_connection_id)}`,
      { method: "DELETE", headers: { "x-api-key": apiKey } },
    );
    // 404 = already gone, treat as success.
    if (!delResp.ok && delResp.status !== 404) {
      return "kept";
    }
  } catch {
    return "kept";
  }
  return "deleted";
}

interface ReapSummary {
  deleted: string[];
  kept: string[];
  purged: string[];
}

async function reapReconnectLedger(apiKey: string, opts?: { force?: boolean }): Promise<ReapSummary> {
  const summary: ReapSummary = { deleted: [], kept: [], purged: [] };
  const ledger = readReconnectLedger();
  if (ledger.length === 0) return summary;

  const now = Date.now();
  const remaining: ReconnectLedgerEntry[] = [];

  for (const entry of ledger) {
    if (!opts?.force && now < entry.cleanup_after) {
      remaining.push(entry);
      continue;
    }
    const outcome = await reapReconnectEntry(entry, apiKey);
    if (outcome === "deleted") {
      summary.deleted.push(entry.old_connection_id);
    } else if (outcome === "purged") {
      summary.purged.push(entry.old_connection_id);
    } else {
      summary.kept.push(entry.old_connection_id);
      remaining.push(entry);
    }
  }
  writeReconnectLedger(remaining);
  return summary;
}

/**
 * Schedule an in-process timer to reap a single ledger entry once its grace
 * window elapses. Fast-path optimization — the lazy reaper will catch it
 * either way if ctrl-api restarts before the timer fires.
 *
 * The timer is unrefed so it does NOT block process shutdown.
 */
function scheduleInProcessReap(entry: ReconnectLedgerEntry): void {
  const delay = Math.max(0, entry.cleanup_after - Date.now());
  // Cap at a sane upper bound — if the entry is in the far future for some
  // reason, don't sit on a 30-day timer.
  const capped = Math.min(delay, 24 * 60 * 60 * 1000);
  const timer = setTimeout(async () => {
    try {
      const apiKey = process.env.COMPOSIO_API_KEY || "";
      if (!apiKey) return;
      await reapReconnectLedger(apiKey);
    } catch (err: any) {
      console.error(`[reconnect] in-process reaper failed: ${err?.message ?? err}`);
    }
  }, capped);
  if (typeof timer.unref === "function") timer.unref();
}

// ---------------------------------------------------------------------------
// Local frontmatter parser
//
// Standalone (does not pull in vault.ts) — keeps the import graph here narrow,
// integrations.ts is already large. Mirrors the YAML-1.2 behaviour of vault.ts
// closely enough for the small frontmatter blocks our synthetic vault records
// use (type / token / label / created_at / event_count / etc.). On malformed
// YAML we return {} and let the caller treat it as a stub.
// ---------------------------------------------------------------------------
function parseFrontmatterLocal(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = content.slice(4, end);
  const out: Record<string, unknown> = {};
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val: string = line.slice(idx + 1).trim();
    if (!key) continue;
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val === "null" || val === "~" || val === "") {
      out[key] = val === "" ? "" : null;
      continue;
    }
    if (val === "true") { out[key] = true; continue; }
    if (val === "false") { out[key] = false; continue; }
    if (/^-?\d+$/.test(val)) { out[key] = parseInt(val, 10); continue; }
    if (/^-?\d+\.\d+$/.test(val)) { out[key] = parseFloat(val); continue; }
    out[key] = val;
  }
  return out;
}

// Scan stream_event/ once and collect the set of unique `source_type` strings.
// Sampling cap keeps this cheap even for tenants with tens of thousands of
// stream events; we just need enough to detect "is this toolkit producing
// events at all". Limit per file matters because frontmatter is the first
// ~500 bytes — we don't need the whole record.
function collectStreamEventSourceTypes(): Set<string> {
  const out = new Set<string>();
  let entries: string[] = [];
  try {
    if (!fs.existsSync(STREAM_EVENT_DIR)) return out;
    entries = fs.readdirSync(STREAM_EVENT_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return out;
  }
  // Cap to last 500 files — recent activity is what the UI cares about, and
  // we don't want to read 50k files on every list call.
  const sampled = entries.length > 500 ? entries.slice(entries.length - 500) : entries;
  for (const entry of sampled) {
    try {
      const full = path.join(STREAM_EVENT_DIR, entry);
      // Read just the head — frontmatter is bounded.
      const fd = fs.openSync(full, "r");
      try {
        const buf = Buffer.alloc(1024);
        const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
        const head = buf.slice(0, bytes).toString("utf-8");
        const fm = parseFrontmatterLocal(head);
        const st = String(fm.source_type ?? "");
        if (st) out.add(st);
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* skip unreadable */ }
  }
  return out;
}

/**
 * Fetch the credential field name(s) a toolkit's API_KEY / BEARER_TOKEN
 * connection actually requires, from the toolkit detail's
 * `auth_config_details[].fields.connected_account_initiation.required[].name`.
 *
 * The canonical field is `generic_api_key` for almost every API-key toolkit
 * (SERP, Tavily, Exa, Perplexity), but it is NOT constant — Firecrawl needs
 * `generic_api_key` AND a second field (`full`/base_url). Hardcoding
 * `api_key`/`token` 400s with ConnectedAccount_MissingRequiredFields.
 *
 * Returns the matching auth_config_detail's required field names, or an empty
 * array when the detail can't be read (caller falls back to a sane default).
 */
async function fetchRequiredCredentialFields(
  toolkitSlug: string,
  authScheme: string,
  apiKey: string,
): Promise<string[]> {
  try {
    const resp = await fetch(
      `${COMPOSIO_API_V3}/toolkits/${encodeURIComponent(toolkitSlug)}`,
      { headers: { "x-api-key": apiKey } },
    );
    if (!resp.ok) {
      console.error(
        `[integrations] toolkit detail fetch for ${toolkitSlug} failed: ${resp.status}`,
      );
      return [];
    }
    const data = (await resp.json()) as any;
    const details: any[] = Array.isArray(data?.auth_config_details)
      ? data.auth_config_details
      : [];
    // Prefer the detail whose mode matches the requested scheme; fall back to
    // the first detail that exposes initiation fields.
    const matching = details.find(
      (d) => String(d?.mode ?? "").toUpperCase() === authScheme,
    );
    const detail = matching ?? details[0];
    const required: any[] =
      detail?.fields?.connected_account_initiation?.required ?? [];
    return required
      .map((f) => (typeof f?.name === "string" ? f.name : ""))
      .filter(Boolean);
  } catch (err: any) {
    console.error(
      `[integrations] toolkit detail fetch for ${toolkitSlug} threw: ${err?.message ?? err}`,
    );
    return [];
  }
}

/**
 * Read a connection's granted OAuth scope from the connected_account record.
 * Composio mirrors it at state.val.scope / data.scope / params.scope. Returns a
 * de-duped list of scope URLs (whitespace-separated in the grant).
 */
function readGrantedScopes(conn: Record<string, unknown>): string[] {
  const c = conn as any;
  const raw =
    c?.state?.val?.scope ?? c?.data?.scope ?? c?.params?.scope ?? "";
  if (typeof raw !== "string" || !raw.trim()) return [];
  return [...new Set(raw.split(/\s+/).filter(Boolean))];
}

/**
 * Classify a set of granted scopes as read-only vs read+write. A grant is
 * read+write if ANY scope is not a `.readonly` (or `*.read`) scope — i.e. the
 * connection can mutate. Empty/unknown grants classify as `unknown`.
 */
function classifyGrantedAccess(scopes: string[]): "read" | "read_write" | "unknown" {
  if (scopes.length === 0) return "unknown";
  const allReadOnly = scopes.every((s) => {
    const lower = s.toLowerCase();
    return lower.endsWith(".readonly") || lower.endsWith("/readonly") || lower.endsWith(".read");
  });
  return allReadOnly ? "read" : "read_write";
}

// ---------------------------------------------------------------------------
// Scope endpoint — per-toolkit action cache
// ---------------------------------------------------------------------------
interface ScopeCacheEntry {
  data: string[];
  fetchedAt: number;
}
const SCOPE_CACHE = new Map<string, ScopeCacheEntry>();
const SCOPE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function fetchToolkitTools(
  toolkit: string,
  apiKey: string,
): Promise<string[]> {
  const cached = SCOPE_CACHE.get(toolkit);
  if (cached && Date.now() - cached.fetchedAt < SCOPE_CACHE_TTL_MS) {
    return cached.data;
  }
  const tools: string[] = [];
  try {
    // Composio retired /api/v3/actions?apps= (it 404s); the live endpoint is
    // /api/v3/tools?toolkit_slug=. Do NOT swallow a non-200 — log it so a
    // future endpoint move is visible instead of producing a silent empty list.
    const resp = await fetch(
      `${COMPOSIO_API_V3}/tools?toolkit_slug=${encodeURIComponent(toolkit)}&limit=500`,
      { headers: { "x-api-key": apiKey } },
    );
    if (resp.ok) {
      const data = (await resp.json()) as any;
      const items = Array.isArray(data.items) ? data.items
        : Array.isArray(data.tools) ? data.tools : [];
      for (const item of items as any[]) {
        const slug = (item.name ?? item.slug ?? "") as string;
        if (!slug) continue;
        if (item.deprecated) continue;
        const displayName = (item.displayName ?? item.display_name ?? "").trim() || slug;
        tools.push(displayName);
      }
    } else {
      console.error(
        `[integrations] toolkit tools fetch for ${toolkit} failed: ${resp.status}`,
      );
    }
  } catch (err: any) {
    console.error(
      `[integrations] toolkit tools fetch for ${toolkit} threw: ${err?.message ?? err}`,
    );
  }
  tools.sort((a, b) => a.localeCompare(b));
  SCOPE_CACHE.set(toolkit, { data: tools, fetchedAt: Date.now() });
  return tools;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerIntegrationRoutes(): void {

  // =========================================================================
  // GET /api/v1/integrations — list connected integrations
  // =========================================================================
  addRoute("GET", "/api/v1/integrations", async ({ res }) => {
    const apiKey = getComposioApiKey();
    const userId = getComposioUserId();
    try {
      // Load streams.json once so we can flag each Composio toolkit row with
      // is_stream_source = true if there's a `composio-<toolkit>-*` stream
      // with event_count > 0. Cheap, single-file read.
      let streamsMeta: any[] = [];
      try {
        streamsMeta = JSON.parse(
          fs.readFileSync(path.join(STREAMS_DIR, "streams.json"), "utf-8"),
        );
      } catch { /* missing is fine — empty fleet */ }

      // For Omi / webhook sources we need to peek at stream_event vault
      // records (filenames usually encode source_type, but we also sample
      // frontmatter so naming convention isn't load-bearing). One readdir +
      // up to ~25 small reads.
      const sourceTypeSet = collectStreamEventSourceTypes();

      // 1. Composio rows — same shape as before plus is_stream_source flag.
      const owned = await fetchAllOwnedConnectedAccounts(apiKey, userId);
      const composioRows = owned.map((a: any) => {
        const slug = (a.toolkit?.slug ?? a.appName ?? "").toLowerCase();
        const hasStream = streamsMeta.some(
          (s: any) =>
            typeof s?.id === "string" &&
            slug &&
            s.id.toLowerCase().startsWith(`composio-${slug}-`) &&
            (s.event_count || 0) > 0,
        );
        return {
          id: a.id,
          toolkit: a.toolkit?.slug ?? a.appName ?? "",
          toolkit_name: a.toolkit?.displayName ?? a.toolkit?.name ?? a.appName ?? "",
          toolkit_icon: a.toolkit?.logo ?? "",
          status: a.status,
          auth_scheme: a.authScheme ?? "",
          user_id: a.member_id ?? a.user_id ?? "",
          created_at: a.createdAt ?? a.created_at ?? "",
          is_stream_source: hasStream,
        };
      });

      // 2. Omi wearable row — derived from stream-event source types.
      //    The OpenClaw-era `devices list --json` CLI that used to enumerate
      //    Omi devices does not exist in Hermes (issue #42 — Hermes pairing
      //    is messaging-channel DM pairing only). An Omi wearable is now
      //    surfaced when it has actually streamed events into the vault,
      //    which is the same signal the webhook rows below key off.
      const omiRows: any[] = [];
      const omiHasEvent = [...sourceTypeSet].some((s) => s.toLowerCase().includes("omi"));
      if (omiHasEvent) {
        omiRows.push({
          id: "omi:default",
          toolkit: "alfred-omi",
          toolkit_name: "Omi",
          toolkit_icon: "",
          status: "ACTIVE",
          auth_scheme: "DEVICE_PAIR",
          user_id: "",
          created_at: "",
          is_stream_source: true,
        });
      }

      // 3. Inbound webhook rows — list vault records under webhook_endpoint/.
      const webhookRows: any[] = [];
      try {
        const entries = fs.existsSync(WEBHOOK_ENDPOINT_DIR)
          ? fs.readdirSync(WEBHOOK_ENDPOINT_DIR).filter((f) => f.endsWith(".md"))
          : [];
        for (const entry of entries) {
          const full = path.join(WEBHOOK_ENDPOINT_DIR, entry);
          let raw = "";
          try { raw = fs.readFileSync(full, "utf-8"); } catch { continue; }
          const fm = parseFrontmatterLocal(raw);
          const token = String(fm.token ?? entry.replace(/\.md$/, "")) || "";
          if (!token) continue;
          const label = String(fm.label ?? "Custom Webhook");
          const eventCount = typeof fm.event_count === "number" ? fm.event_count : 0;
          const labelHasEvent = sourceTypeSet.has(`webhook:${label}`);
          webhookRows.push({
            id: `webhook:${token}`,
            toolkit: "alfred-webhook",
            toolkit_name: label || "Custom Webhook",
            toolkit_icon: "",
            status: "ACTIVE",
            auth_scheme: "INBOUND_WEBHOOK",
            user_id: "",
            created_at: String(fm.created_at ?? ""),
            is_stream_source: eventCount > 0 || labelHasEvent,
          });
        }
      } catch { /* dir missing or unreadable — no webhook integrations */ }

      const integrations = [...composioRows, ...omiRows, ...webhookRows];
      sendJson(res, 200, { integrations, count: integrations.length });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to fetch integrations: ${err.message}` });
    }
  });

  // =========================================================================
  // GET /api/v1/integrations/catalog — browsable toolkit catalog (cached 1h)
  // =========================================================================
  addRoute("GET", "/api/v1/integrations/catalog", async ({ res, query }) => {
    const apiKey = getComposioApiKey();
    try {
      const composioCatalog = await fetchCatalog(apiKey);

      // Synthetic catalog entries — surfaced at the head of the list so the
      // dashboard can render them like first-class toolkits. These don't go
      // through Composio's OAuth flow; the UI keys off the unique
      // auth_schemes ("DEVICE_PAIR" / "INBOUND_WEBHOOK") to render bespoke
      // modals instead of the Connect Link flow.
      const synthetic: CatalogEntry[] = [
        {
          slug: "alfred-omi",
          name: "Omi",
          description:
            "Wearable mic — Alfred listens, transcribes, and turns conversations into actions on your desk.",
          icon_url: "",
          category: "wearables",
          auth_schemes: ["DEVICE_PAIR"],
        },
        {
          slug: "alfred-webhook",
          name: "Custom Webhook",
          description:
            "A private URL you can POST anything to. Each call lands as a stream event for Alfred to curate.",
          icon_url: "",
          category: "developer",
          auth_schemes: ["INBOUND_WEBHOOK"],
        },
      ];
      const all = [...synthetic, ...composioCatalog];

      // Optional client-side search filter (server assists for convenience)
      const search = (query.get("search") || "").toLowerCase().trim();
      const category = (query.get("category") || "").toLowerCase().trim();

      let filtered = all;
      if (search) {
        filtered = filtered.filter(
          (t) =>
            t.slug.toLowerCase().includes(search) ||
            t.name.toLowerCase().includes(search) ||
            t.description.toLowerCase().includes(search),
        );
      }
      if (category && category !== "all") {
        filtered = filtered.filter((t) => t.category === category);
      }

      // Collect unique categories. Ensure the synthetic categories are
      // always present even if Composio's set didn't include them.
      const categorySet = new Set(all.map((t) => t.category));
      categorySet.add("wearables");
      categorySet.add("developer");
      const categories = [...categorySet].sort();

      sendJson(res, 200, {
        toolkits: filtered,
        categories,
        count: filtered.length,
        total: all.length,
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to fetch catalog: ${err.message}` });
    }
  });

  // =========================================================================
  // GET /api/v1/integrations/:id/scope — what data this connection can touch
  //
  // Returns a {read, write, note?} pair of human-readable action display names
  // so the dashboard can answer "what does this integration actually see and
  // do?" without firing /capabilities (which is much heavier and joins on
  // live stream state). Three classes of id:
  //   - "webhook:<token>" → inbound only, no scope to enumerate.
  //   - "omi:<device-id>" → audio + transcript stream, no write actions.
  //   - Composio connection id → real classification via the Composio actions
  //     catalogue, cached 10 minutes per toolkit.
  // =========================================================================
  addRoute("GET", "/api/v1/integrations/:id/scope", async ({ res, params }) => {
    const id = params.id;
    if (id.startsWith("webhook:")) {
      sendJson(res, 200, {
        read: [],
        write: [],
        note: "Inbound only — accepts anything you POST to the URL.",
      });
      return;
    }
    if (id.startsWith("omi:")) {
      sendJson(res, 200, {
        read: ["audio", "transcript"],
        write: [],
        note: "Omi streams audio + transcripts.",
      });
      return;
    }
    // Composio connection — resolve toolkit, then ask Composio for actions.
    const apiKey = getComposioApiKey();
    const userId = getComposioUserId();
    try {
      const conn = await assertConnectionOwnedByTenant(res, id, userId, apiKey);
      if (!conn) return;
      const toolkit = String(
        (conn as any).toolkit?.slug ?? (conn as any).appName ?? "",
      ).toLowerCase();

      // The authoritative answer is the connection's REAL granted OAuth scope,
      // not a verb heuristic over the toolkit catalogue (which is identical for
      // every connection of a toolkit and cannot tell read-only from
      // read+write). Read state.val.scope and classify it.
      const grantedScopes = readGrantedScopes(conn);
      const access = classifyGrantedAccess(grantedScopes);
      // The catalogue of actions this toolkit exposes ("tools I can act
      // through") — informational, distinct from the granted scope. Pulled
      // from the live /api/v3/tools endpoint (F22).
      const availableTools = toolkit ? await fetchToolkitTools(toolkit, apiKey) : [];
      sendJson(res, 200, {
        access,                       // "read" | "read_write" | "unknown"
        granted_scopes: grantedScopes,
        toolkit,
        available_tools: availableTools,
        // Backward-compatible chip arrays derived from the real grant: read is
        // always present once granted; write only when the grant is read+write.
        read: grantedScopes,
        write: access === "read_write" ? grantedScopes : [],
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to fetch scope: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/connect — initiate OAuth Connect Link
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/connect", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.toolkit_slug !== "string") {
      throw new ValidationError("toolkit_slug (string) is required");
    }
    assertNotSyntheticSlug(b.toolkit_slug as string);
    const apiKey = getComposioApiKey();
    const userId = getComposioUserId();
    const redirectUrl = typeof b.redirect_url === "string" ? b.redirect_url : "";

    try {
      // Step 1: Find or create an auth_config for this toolkit.
      // Check if one already exists.
      let authConfigId: string | null = null;

      const existingResp = await fetch(
        `${COMPOSIO_API_V3}/auth_configs?toolkit_slug=${encodeURIComponent(b.toolkit_slug as string)}`,
        { headers: { "x-api-key": apiKey } },
      );

      if (existingResp.ok) {
        const existingData = (await existingResp.json()) as any;
        const items = Array.isArray(existingData.items) ? existingData.items : [];
        // Use first non-disabled auth config
        const usable = items.find((ac: any) => !ac.is_disabled);
        if (usable) {
          authConfigId = usable.id;
        }
      }

      // If no auth_config exists, create one with Composio-managed OAuth
      if (!authConfigId) {
        const createResp = await fetch(`${COMPOSIO_API_V3}/auth_configs`, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            toolkit: { slug: b.toolkit_slug },
            use_composio_auth: true,
          }),
        });

        if (!createResp.ok) {
          const errText = await createResp.text().catch(() => "");
          sendJson(res, createResp.status, {
            error: `Failed to create auth config: ${createResp.status}`,
            detail: errText.slice(0, 500),
          });
          return;
        }

        const created = (await createResp.json()) as any;
        authConfigId = created?.auth_config?.id;
        if (!authConfigId) {
          sendJson(res, 500, { error: "Auth config created but no ID returned" });
          return;
        }
      }

      // Step 2: Create a connected account using the auth_config.
      // user_id scopes this connection to the current tenant so that
      // other tenants sharing the same platform Composio API key cannot
      // see or execute against it. See #408.
      const connectResp = await fetch(`${COMPOSIO_API_V3}/connected_accounts`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          auth_config: { id: authConfigId },
          connection: {
            user_id: userId,
            redirect_url: redirectUrl || undefined,
          },
        }),
      });

      if (!connectResp.ok) {
        const errText = await connectResp.text().catch(() => "");
        sendJson(res, connectResp.status, {
          error: `Composio connect error: ${connectResp.status}`,
          detail: errText.slice(0, 500),
        });
        return;
      }

      const connectData = (await connectResp.json()) as any;
      sendJson(res, 200, {
        connect_url: connectData.redirect_url ?? connectData.redirect_uri ?? connectData.redirectUrl ?? "",
        connection_id: connectData.id ?? "",
        status: connectData.status ?? "INITIATED",
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to initiate connection: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/connect-api-key — API-key / bearer-token flow
  //
  // Non-OAuth connect flow for toolkits whose auth_scheme is API_KEY or
  // BEARER_TOKEN (Clockify, Tavily, PostHog, …). The user supplies their
  // own credential and we go straight from "click Connect" to an ACTIVE
  // connected_account with no popup or redirect.
  //
  // Request body:
  //   {
  //     toolkit_slug: string,
  //     auth_scheme?: "API_KEY" | "BEARER_TOKEN"   // defaults to API_KEY
  //     credential: string                          // the user's key / token
  //   }
  //
  // Response mirrors /api/v1/integrations/connect so the SaaS side can reuse
  // the same upsertConnection path. `connect_url` is always empty — there
  // is nothing for the user to approve in a browser.
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/connect-api-key", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.toolkit_slug !== "string") {
      throw new ValidationError("toolkit_slug (string) is required");
    }
    assertNotSyntheticSlug(b.toolkit_slug as string);
    if (typeof b.credential !== "string" || !b.credential.trim()) {
      throw new ValidationError("credential (string) is required");
    }

    const authScheme = (typeof b.auth_scheme === "string" ? b.auth_scheme : "API_KEY").toUpperCase();
    if (authScheme !== "API_KEY" && authScheme !== "BEARER_TOKEN") {
      throw new ValidationError(`Unsupported auth_scheme "${authScheme}" — must be API_KEY or BEARER_TOKEN`);
    }

    const apiKey = getComposioApiKey();
    const userId = getComposioUserId();
    const toolkitSlug = b.toolkit_slug as string;
    const credential = (b.credential as string).trim();

    try {
      // Step 1: Find an existing auth_config for this toolkit that uses the
      // right scheme, OR create one. Auth configs are reusable — we share
      // one per (toolkit, scheme) across all tenants on our Composio key,
      // since the actual credential lives in the connected_account, not the
      // auth_config.
      let authConfigId: string | null = null;

      const existingResp = await fetch(
        `${COMPOSIO_API_V3}/auth_configs?toolkit_slug=${encodeURIComponent(toolkitSlug)}`,
        { headers: { "x-api-key": apiKey } },
      );

      if (existingResp.ok) {
        const existingData = (await existingResp.json()) as any;
        const items = Array.isArray(existingData.items) ? existingData.items : [];
        // Match on both scheme and "not disabled" — OAuth configs use a
        // different scheme, we don't want to reuse those.
        const usable = items.find((ac: any) => {
          if (ac.is_disabled) return false;
          const scheme = String(ac.auth_scheme ?? ac.authScheme ?? "").toUpperCase();
          // Require an EXACT scheme match. A managed-OAuth config's scheme is
          // often absent from the list payload; tolerating `scheme === ""` here
          // reused that OAuth config for an API_KEY connection, then failed on
          // the connected_account create with a scheme mismatch.
          return scheme === authScheme;
        });
        if (usable) authConfigId = usable.id;
      }

      if (!authConfigId) {
        const createResp = await fetch(`${COMPOSIO_API_V3}/auth_configs`, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "Content-Type": "application/json",
          },
          // Composio v3 reads the custom-auth directive from `auth_config`,
          // NOT `options`. Under `options` it is silently ignored and Composio
          // defaults to managed auth, 400ing for toolkits with no managed
          // credentials (SERP, Exa, …) — code 306 DefaultAuthConfigNotFound.
          body: JSON.stringify({
            toolkit: { slug: toolkitSlug },
            auth_config: {
              type: "use_custom_auth",
              authScheme,
              credentials: {},
            },
          }),
        });

        if (!createResp.ok) {
          const errText = await createResp.text().catch(() => "");
          sendJson(res, createResp.status, {
            error: `Failed to create auth config: ${createResp.status}`,
            detail: errText.slice(0, 500),
          });
          return;
        }

        const created = (await createResp.json()) as any;
        authConfigId = created?.auth_config?.id ?? created?.id ?? null;
        if (!authConfigId) {
          sendJson(res, 500, { error: "Auth config created but no ID returned" });
          return;
        }
      }

      // Step 2: Create a connected_account with the user's credential in
      // connection.state.val. The credential field name(s) are NOT a constant
      // — they come from the toolkit's connected_account_initiation.required
      // (SERP/Tavily/Exa want `generic_api_key`; Firecrawl wants
      // `generic_api_key` + `full`). Read them from the toolkit detail and map
      // the user's single pasted credential onto every required field. Fall
      // back to the legacy `generic_api_key`/`token` guess only when the detail
      // is unreadable.
      const requiredFields = await fetchRequiredCredentialFields(
        toolkitSlug,
        authScheme,
        apiKey,
      );
      const fallbackField = authScheme === "BEARER_TOKEN" ? "token" : "generic_api_key";
      const fields = requiredFields.length > 0 ? requiredFields : [fallbackField];
      const val: Record<string, string> = {};
      for (const field of fields) val[field] = credential;
      const connectResp = await fetch(`${COMPOSIO_API_V3}/connected_accounts`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          auth_config: { id: authConfigId },
          connection: {
            user_id: userId,
            state: {
              authScheme,
              val,
            },
          },
        }),
      });

      if (!connectResp.ok) {
        const errText = await connectResp.text().catch(() => "");
        sendJson(res, connectResp.status, {
          error: `Composio connect error: ${connectResp.status}`,
          detail: errText.slice(0, 500),
        });
        return;
      }

      const connectData = (await connectResp.json()) as any;
      sendJson(res, 200, {
        connect_url: "",
        connection_id: connectData.id ?? "",
        status: connectData.status ?? "ACTIVE",
        auth_scheme: authScheme,
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to initiate connection: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/omi/pair — pair an OMI wearable
  //
  // OMI is a push/stream source, NOT an OAuth/API-key Composio integration.
  // "Pairing" means handing the device a private tenant-scoped audio endpoint
  // to POST raw PCM to — exactly what the streams subsystem produces. This
  // route creates-or-reuses the single source:"omi" stream and returns its
  // composed device webhook_url; it NEVER touches Composio (which would
  // fuzzy-resolve the synthetic alfred-omi slug to a junk `cal` connection).
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/omi/pair", async ({ res }) => {
    const { stream, webhook_url, reused } = createOrReuseOmiStream();
    sendJson(res, 200, {
      stream_id: stream.id,
      webhook_url,
      reused,
      // null webhook_url means TENANT_BASE_URL is unset on this tenant — the
      // UI should show a "missing base URL" state rather than a broken URL.
      note: webhook_url
        ? "Paste this into the OMI app developer settings as the audio stream endpoint."
        : "Tenant is missing TENANT_BASE_URL — the device URL cannot be composed.",
    });
  });

  // =========================================================================
  // DELETE /api/v1/integrations/:id — disconnect an integration
  // =========================================================================
  addRoute("DELETE", "/api/v1/integrations/:id", async ({ res, params }) => {
    const apiKey = getComposioApiKey();
    const userId = getComposioUserId();
    const connId = params.id;

    try {
      // 1. Fetch the connection to learn its toolkit before deleting.
      //    ALSO validate that the connection belongs to the current tenant —
      //    otherwise one tenant could delete another tenant's connection.
      //    Capture the OAuth token so we can revoke it at Google after the
      //    Composio delete (F23).
      let toolkit = "";
      let ownerUserId = "";
      let oauthToken: string | null = null;
      try {
        const connResp = await fetch(
          `${COMPOSIO_API_V3}/connected_accounts/${encodeURIComponent(connId)}`,
          { headers: { "x-api-key": apiKey } },
        );
        if (connResp.ok) {
          const conn = (await connResp.json()) as any;
          toolkit = (conn.toolkit?.slug ?? conn.appName ?? "").toLowerCase();
          oauthToken = extractOAuthToken(conn);
          ownerUserId = (conn.member_id ?? conn.user_id ?? conn.userId ?? "") as string;
          // Defense-in-depth: require explicit ownership match. Treat a
          // missing/empty owner field as non-matching — otherwise a
          // connected_account payload without member_id/user_id would
          // allow cross-tenant deletes to slip through.
          if (!ownerUserId || ownerUserId !== userId) {
            sendJson(res, 403, {
              error: "Connection does not belong to this tenant",
              connection_id: connId,
            });
            return;
          }
        } else if (connResp.status === 404) {
          sendJson(res, 404, { error: `Connected account ${connId} not found` });
          return;
        }
      } catch { /* proceed with deletion anyway */ }

      // 2. Delete the connected account at Composio
      const resp = await fetch(`${COMPOSIO_API_V3}/connected_accounts/${encodeURIComponent(connId)}`, {
        method: "DELETE",
        headers: { "x-api-key": apiKey },
      });

      if (!resp.ok && resp.status !== 404) {
        sendJson(res, resp.status, { error: `Composio delete error: ${resp.status}` });
        return;
      }

      // 2b. Revoke the upstream Google OAuth grant (F23). Composio's delete
      //     only drops its stored credential; without this the grant stays
      //     live in the principal's Google "Third-party access". Best-effort.
      let googleTokenRevoked: boolean | null = null;
      if (toolkit && isGoogleToolkit(toolkit) && oauthToken) {
        googleTokenRevoked = await revokeGoogleToken(oauthToken);
      }

      // 2c. Is this the last ACTIVE account of the toolkit? Determines whether
      //     we sweep the shared skill dir (step 6/7) AND whether we sweep
      //     legacy/unbound stream configs of the toolkit (step 3, F24). On a
      //     lookup failure, err toward PRESERVING surface.
      let lastOfToolkit = false;
      if (toolkit) {
        try {
          const owned = await fetchAllOwnedConnectedAccounts(apiKey, userId);
          lastOfToolkit = owned.every(
            (a: any) =>
              a.id === connId ||
              a.status !== "ACTIVE" ||
              ((a.toolkit?.slug ?? a.appName ?? "") as string).toLowerCase() !== toolkit,
          );
        } catch { lastOfToolkit = false; }
      }

      // 3. Clean up stream configs backed by this integration. Always remove
      //    configs bound to the deleted connection id; when this was the LAST
      //    account of the toolkit, ALSO sweep legacy/unbound configs matched by
      //    composio_toolkit or source (e.g. a "migrated-to-composio" Gmail
      //    config with no composio_connection_id) so they don't linger as
      //    phantom streams. (F24)
      const cleanedStreams: string[] = [];
      try {
        fs.mkdirSync(STREAM_CONFIGS_DIR, { recursive: true });
        const configFiles = fs.readdirSync(STREAM_CONFIGS_DIR).filter((f) => f.endsWith(".json"));
        for (const file of configFiles) {
          const configPath = path.join(STREAM_CONFIGS_DIR, file);
          try {
            const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            const boundToConn = config.composio_connection_id === connId;
            const matchesToolkit =
              lastOfToolkit && toolkit &&
              (String(config.composio_toolkit ?? "").toLowerCase() === toolkit ||
                String(config.source ?? "").toLowerCase() === toolkit ||
                String(config.source ?? "").toLowerCase() === `composio:${toolkit}`);
            if (boundToConn || matchesToolkit) {
              cleanedStreams.push(config.id || file.replace(".json", ""));
              fs.unlinkSync(configPath);
            }
          } catch { /* skip unreadable configs */ }
        }
      } catch { /* stream cleanup is best-effort */ }

      // 4. Clean up streams.json metadata for cleaned streams
      if (cleanedStreams.length > 0) {
        try {
          const streamsMetaPath = path.join(STREAMS_DIR, "streams.json");
          let streams: any[] = JSON.parse(fs.readFileSync(streamsMetaPath, "utf-8"));
          const cleanedSet = new Set(cleanedStreams);
          streams = streams.filter((s: any) => !cleanedSet.has(s.id));
          fs.writeFileSync(streamsMetaPath, JSON.stringify(streams, null, 2));
        } catch { /* ok */ }
      }

      // 5. (#53) No per-stream Temporal schedule to delete. Streams are
      //    polled by the single al-stream-sweep schedule, which reads
      //    each stream's config; removing the config file in step 3
      //    drops the stream from the sweep on its next tick. The
      //    `deleted_schedules` field is kept in the response for shape
      //    stability with pre-#53 callers.
      const deletedSchedules: string[] = [];

      // 6 + 7. Per-toolkit cleanup, scoped to the deleted connection.
      //
      // Only strip the toolkit's `<TOOLKIT>_*` allow-list prefix and delete
      // the shared `alfred-composio-<toolkit>` skill dir IF no other ACTIVE
      // connection of the same toolkit remains for this tenant. With more
      // than one connection of the same toolkit (e.g. two Gmail accounts
      // for personal + work), the surviving connections still need both the
      // tool surface and the skill file.
      //
      // We deliberately do NOT touch the global `composio_execute` tool nor
      // do we sweep all toolkit prefixes here. Issue #658: the previous
      // global cleanup branch (former step 8) trusted Composio's broken
      // `?user_id=` query and would strip the entire Composio surface even
      // when 8+ active connections survived. Global cleanup is now an
      // explicit operation — see POST /api/v1/integrations/disconnect-all.
      const removedTools: string[] = [];
      let skillRemoved = false;

      // Reuses `lastOfToolkit` computed in step 2c (the same "no other ACTIVE
      // account of this toolkit survives" condition that gated the legacy
      // stream sweep). On a lookup failure it stays false → preserve surface.
      if (toolkit) {
        if (lastOfToolkit) {
          // Last connection for this toolkit — remove its shared skill dir.
          // There is no Hermes tool-enable list to clean up: Composio is the
          // single always-on `composio_execute` MCP tool, so disconnecting a
          // toolkit needs no config change and no gateway restart.
          const skillDirName = `alfred-composio-${toolkit}`;
          for (const baseDir of [OPENCLAW_SKILLS_DIR, OPENCLAW_WORKERS_SKILLS_DIR]) {
            try {
              fs.rmSync(path.join(baseDir, skillDirName), { recursive: true, force: true });
              skillRemoved = true;
            } catch { /* ok */ }
          }
        }
      }

      sendJson(res, 200, {
        status: "disconnected",
        connection_id: connId,
        toolkit,
        cleaned_streams: cleanedStreams,
        deleted_schedules: deletedSchedules,
        removed_tools: removedTools,
        skill_removed: skillRemoved,
        google_token_revoked: googleTokenRevoked,
        gateway_restart_triggered: false,
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to disconnect: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/disconnect-all — explicit global Composio reset
  //
  // Decoupled from the per-id DELETE handler in PR for #658. Previously the
  // DELETE handler tried to detect "this was the last Composio connection"
  // and globally tear down the Composio surface. That detection trusted
  // Composio's broken `?user_id=` filter and fired even with 8+ surviving
  // connections, vapourising the entire tool surface mid-conversation.
  //
  // Global cleanup is now an explicit user action ("disconnect all
  // integrations" button on the dashboard, or operator API call). Steps:
  //   1. Enumerate ALL of the tenant's Composio connections (paginated, no
  //      reliance on the broken server-side user_id filter).
  //   2. DELETE each at Composio.
  //   3. Best-effort cleanup of stream configs, streams.json, Temporal
  //      schedules backed by any of those connection ids.
  //   4. Strip every `<TOOLKIT>_*` allow-list entry across both openclaw
  //      configs (only the toolkits we actually disconnected — preserves
  //      any unrelated entries someone might have hand-added).
  //   5. Remove `composio_execute` from the gateway allowlist.
  //   6. Delete every `alfred-composio-*` skill dir from both workspaces.
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/disconnect-all", async ({ res }) => {
    const apiKey = getComposioApiKey();
    const userId = getComposioUserId();

    try {
      // 1. Enumerate.
      const owned = await fetchAllOwnedConnectedAccounts(apiKey, userId);
      const disconnectedIds: string[] = [];
      const failedIds: string[] = [];
      const toolkits = new Set<string>();
      for (const a of owned) {
        const id = String(a.id ?? "");
        const toolkit = String((a.toolkit?.slug ?? a.appName ?? "") as string).toLowerCase();
        if (!id) continue;
        if (toolkit) toolkits.add(toolkit);

        // 2. DELETE at Composio.
        try {
          const delResp = await fetch(
            `${COMPOSIO_API_V3}/connected_accounts/${encodeURIComponent(id)}`,
            { method: "DELETE", headers: { "x-api-key": apiKey } },
          );
          if (!delResp.ok && delResp.status !== 404) {
            failedIds.push(id);
            continue;
          }
        } catch {
          failedIds.push(id);
          continue;
        }
        disconnectedIds.push(id);
      }

      // 3. Stream config + streams.json + Temporal schedule cleanup.
      const cleanedStreams: string[] = [];
      const deletedSchedules: string[] = [];
      const disconnectedSet = new Set(disconnectedIds);
      try {
        fs.mkdirSync(STREAM_CONFIGS_DIR, { recursive: true });
        const configFiles = fs.readdirSync(STREAM_CONFIGS_DIR).filter((f) => f.endsWith(".json"));
        for (const file of configFiles) {
          const configPath = path.join(STREAM_CONFIGS_DIR, file);
          try {
            const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            if (config.composio_connection_id && disconnectedSet.has(config.composio_connection_id)) {
              cleanedStreams.push(config.id || file.replace(".json", ""));
              fs.unlinkSync(configPath);
            }
          } catch { /* skip unreadable */ }
        }
      } catch { /* best effort */ }

      if (cleanedStreams.length > 0) {
        try {
          const streamsMetaPath = path.join(STREAMS_DIR, "streams.json");
          let streams: any[] = JSON.parse(fs.readFileSync(streamsMetaPath, "utf-8"));
          const cleanedSet = new Set(cleanedStreams);
          streams = streams.filter((s: any) => !cleanedSet.has(s.id));
          fs.writeFileSync(streamsMetaPath, JSON.stringify(streams, null, 2));
        } catch { /* ok */ }
      }

      // (#53) No per-stream Temporal schedule to delete — the
      // al-stream-sweep schedule polls streams from their config files,
      // and the configs were removed above. `deleted_schedules` stays
      // in the response for shape stability with pre-#53 callers.

      // No Hermes tool-enable list to strip: Composio is the single
      // always-on `composio_execute` MCP tool, so disconnecting every
      // connection needs no config change and no gateway restart. The
      // Composio surface goes dark on its own once no connection is ACTIVE.
      const removedTools: string[] = [];

      // Delete every alfred-composio-* skill dir.
      const removedSkillDirs: string[] = [];
      for (const baseDir of [OPENCLAW_SKILLS_DIR, OPENCLAW_WORKERS_SKILLS_DIR]) {
        try {
          fs.mkdirSync(baseDir, { recursive: true });
          const entries = fs.readdirSync(baseDir);
          for (const entry of entries) {
            if (typeof entry === "string" && entry.startsWith("alfred-composio-")) {
              try {
                fs.rmSync(path.join(baseDir, entry), { recursive: true, force: true });
                removedSkillDirs.push(`${baseDir}/${entry}`);
              } catch { /* ok */ }
            }
          }
        } catch { /* ok */ }
      }

      sendJson(res, 200, {
        status: "all_disconnected",
        disconnected_count: disconnectedIds.length,
        disconnected_ids: disconnectedIds,
        failed_ids: failedIds,
        toolkits: [...toolkits],
        cleaned_streams: cleanedStreams,
        deleted_schedules: deletedSchedules,
        removed_tools: removedTools,
        removed_skill_dirs: removedSkillDirs,
        gateway_restart_triggered: false,
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to disconnect all: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/:id/reconnect — refresh an expired OAuth in one call
  //
  // Composio OAuth tokens expire (Gmail every few weeks, Calendar similar). The
  // pre-existing 4-step recovery dance (lookup toolkit → connect → wait → maybe
  // delete-old) is too fiddly for the agent to get right every time, so this
  // endpoint collapses it into one operation.
  //
  // What this does:
  //   1. Look up the existing connection by id; assert it belongs to this
  //      tenant (defense against cross-tenant id guessing). 404 if missing.
  //   2. Reuse the SAME auth_config_id and SAME user_id to create a NEW
  //      connected_account, returning the OAuth URL.
  //   3. Append a ledger entry so the OLD connection is reaped 1h after the
  //      NEW one becomes ACTIVE. The old one stays alive during the grace
  //      window so in-flight tool calls / open sessions don't break.
  //   4. Schedule an in-process timer for the reaper. Lazy reaper also runs
  //      on every reconnect call + on POST /reconnect-cleanup to survive
  //      ctrl-api restarts.
  //
  // The agent should:
  //   - Surface `new_connection_link` to Sir verbatim.
  //   - Wait for him to complete the OAuth handshake.
  //   - Confirm via GET /api/v1/integrations or :id/capabilities on the new id.
  //   - DO NOT delete the old connection manually — the reaper handles it.
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/:id/reconnect", async ({ res, params }) => {
    const apiKey = getComposioApiKey();
    const userId = getComposioUserId();
    const oldConnId = params.id;

    try {
      // 1. Lookup + ownership check.
      const oldConn = await assertConnectionOwnedByTenant(res, oldConnId, userId, apiKey);
      if (!oldConn) return; // assertConnectionOwnedByTenant already sent 404/500

      const oldConnAny = oldConn as any;
      const toolkit = String(oldConnAny.toolkit?.slug ?? oldConnAny.appName ?? "").toLowerCase();
      const authConfigId =
        oldConnAny.auth_config?.id ??
        oldConnAny.authConfig?.id ??
        oldConnAny.auth_config_id ??
        oldConnAny.authConfigId ??
        null;
      const oldExpiresAt =
        oldConnAny.expires_at ??
        oldConnAny.expiresAt ??
        oldConnAny.expiry ??
        null;

      if (!toolkit) {
        sendJson(res, 422, {
          error: "Connection has no toolkit_slug — cannot reconnect",
          connection_id: oldConnId,
        });
        return;
      }
      if (!authConfigId) {
        sendJson(res, 422, {
          error: "Connection has no auth_config_id — cannot reconnect (try /connect with toolkit_slug)",
          connection_id: oldConnId,
          toolkit,
        });
        return;
      }

      // 2. Create a NEW connected_account against the SAME auth_config + user_id.
      const connectResp = await fetch(`${COMPOSIO_API_V3}/connected_accounts`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          auth_config: { id: authConfigId },
          connection: { user_id: userId },
        }),
      });

      if (!connectResp.ok) {
        const errText = await connectResp.text().catch(() => "");
        sendJson(res, connectResp.status, {
          error: `Composio reconnect error: ${connectResp.status}`,
          detail: errText.slice(0, 500),
        });
        return;
      }

      const connectData = (await connectResp.json()) as any;
      const newConnectLink =
        connectData.redirect_url ??
        connectData.redirect_uri ??
        connectData.redirectUrl ??
        "";
      const newConnId = connectData.id ?? "";

      // 3. Persist the ledger entry so the reaper knows about this pair.
      const now = Date.now();
      const ledgerEntry: ReconnectLedgerEntry = {
        old_connection_id: oldConnId,
        new_connection_id: newConnId,
        toolkit,
        user_id: userId,
        scheduled_at: now,
        cleanup_after: now + RECONNECT_GRACE_MS,
      };
      appendReconnectLedger(ledgerEntry);

      // 4. Schedule in-process reap + opportunistically reap any past-due entries.
      scheduleInProcessReap(ledgerEntry);
      reapReconnectLedger(apiKey).catch(() => { /* best effort */ });

      sendJson(res, 200, {
        old_connection_id: oldConnId,
        new_connection_id: newConnId,
        new_connection_link: newConnectLink,
        app: toolkit,
        toolkit,
        expires_at: oldExpiresAt,
        cleanup_after_ms: ledgerEntry.cleanup_after,
        grace_window_seconds: Math.round(RECONNECT_GRACE_MS / 1000),
        instructions:
          "Send this link to Sir. After he completes the OAuth handshake, " +
          "the new connection will become ACTIVE. The old connection will be " +
          "cleaned up automatically 1 hour after the new one is verified ACTIVE.",
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to initiate reconnect: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/reconnect-cleanup — drain expired ledger entries
  //
  // Manual / scheduled reaper for the reconnect ledger. Safe to call any time.
  // Without `force=1`, only entries whose grace window (1h) has elapsed are
  // considered. With `force=1`, every entry is checked immediately — useful
  // for ops if Sir has explicitly confirmed the new connection is healthy and
  // wants the old one gone right now.
  //
  // This endpoint is intentionally a manual trigger today. A follow-up Temporal
  // schedule (e.g. al-reconnect-reaper, every 15 min) should call this so the
  // grace window survives ctrl-api restarts even when the in-process timer is
  // lost. See #645.
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/reconnect-cleanup", async ({ res, query }) => {
    const apiKey = getComposioApiKey();
    const force = query.get("force") === "1";
    try {
      const summary = await reapReconnectLedger(apiKey, { force });
      sendJson(res, 200, {
        deleted: summary.deleted,
        kept: summary.kept,
        purged: summary.purged,
        ledger_size_remaining: readReconnectLedger().length,
        forced: force,
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Reaper failed: ${err.message}` });
    }
  });

  // =========================================================================
  // GET /api/v1/integrations/:id/capabilities — enriched action inventory
  //
  // Returns what this specific connection can do, with:
  //   - display_name + description from Composio (human-friendly, not raw slugs)
  //   - deprecated flag (default excluded from response, include_deprecated=1 to see)
  //   - stream_actions[].enabled / .stream_id / .schedule_interval_seconds /
  //     .last_event_at / .last_pull_status — read from the live stream config
  //     AND matched by composio_connection_id (robust to Composio renaming a slug)
  //   - tool_actions[] — always available once composio_execute is in the
  //     gateway allowlist; no per-action toggle (the tool dispatches them all)
  //   - stale_streams[] — stream configs on disk whose composio_action is NOT
  //     in Composio's current catalog for this toolkit. These are broken (404
  //     on every pull) until migrated. Surfaces cleanly in the UI for a
  //     one-click migrate.
  // =========================================================================
  addRoute("GET", "/api/v1/integrations/:id/capabilities", async ({ res, params, query }) => {
    const apiKey = getComposioApiKey();
    const userId = getComposioUserId();
    const connId = params.id;
    const includeDeprecated = query.get("include_deprecated") === "1";

    try {
      // 1. Resolve connection → toolkit. Ownership check enforced here so one
      //    tenant cannot scrape another tenant's connection capabilities by id.
      const connJson = await assertConnectionOwnedByTenant(res, connId, userId, apiKey);
      if (!connJson) return;
      const conn = connJson as any;
      const toolkit = (conn.toolkit?.slug ?? conn.appName ?? "").toLowerCase();
      const toolkitName = conn.toolkit?.displayName ?? conn.toolkit?.name ?? toolkit;

      if (!toolkit) {
        sendJson(res, 200, {
          connection_id: connId,
          toolkit: "",
          toolkit_name: "",
          stream_actions: [],
          tool_actions: [],
          stale_streams: [],
          composio_execute_enabled: false,
        });
        return;
      }

      // 2. Fetch Composio's current action catalog for this toolkit.
      // Composio's v2 /actions caps at 500 items/page. GitHub ships ~400
      // actions — the old limit=100 missed the renamed
      // GITHUB_LIST_NOTIFICATIONS_FOR_THE_AUTHENTICATED_USER (was on page 2),
      // which made Sir's github stream appear permanently stale.
      const actionsResp = await fetch(
        `${COMPOSIO_API_V2}/actions?apps=${encodeURIComponent(toolkit)}&limit=500`,
        { headers: { "x-api-key": apiKey } },
      );
      if (!actionsResp.ok) {
        sendJson(res, actionsResp.status, { error: `Composio actions error: ${actionsResp.status}` });
        return;
      }
      const actionsData = (await actionsResp.json()) as any;
      const tools = Array.isArray(actionsData.items) ? actionsData.items
        : Array.isArray(actionsData.tools) ? actionsData.tools : [];

      const catalogSlugs = new Set<string>();
      for (const t of tools) {
        const s = (t.name ?? t.slug ?? "") as string;
        if (s) catalogSlugs.add(s);
      }

      // 3. Read live stream configs for THIS connection (matched by
      //    composio_connection_id — survives a Composio slug rename).
      //    streamConfigByAction: map current slug → on-disk config
      //    stale: configs whose composio_action is no longer in the catalog
      type StreamRecord = {
        stream_id: string;
        action: string;
        interval_seconds: number;
        last_pull_at: string | null;
        last_pull_status: string | null;
        event_count: number;
        last_event_at: string | null;
      };
      const streamByAction = new Map<string, StreamRecord>();
      const staleStreams: StreamRecord[] = [];

      try {
        fs.mkdirSync(STREAM_CONFIGS_DIR, { recursive: true });
        const configFiles = fs.readdirSync(STREAM_CONFIGS_DIR).filter((f) => f.endsWith(".json"));
        // Also look up event counts / last_event_at from streams.json
        let streamsMeta: any[] = [];
        try {
          streamsMeta = JSON.parse(fs.readFileSync(path.join(STREAMS_DIR, "streams.json"), "utf-8"));
        } catch { /* ok */ }
        const metaById = new Map(streamsMeta.map((s: any) => [s.id, s]));

        for (const file of configFiles) {
          try {
            const cfg = JSON.parse(fs.readFileSync(path.join(STREAM_CONFIGS_DIR, file), "utf-8"));
            if (cfg?.composio_connection_id !== connId) continue;
            const action = cfg.composio_action ?? "";
            const streamId = cfg.id ?? file.replace(/\.json$/, "");
            const meta = metaById.get(streamId) as any;
            const record: StreamRecord = {
              stream_id: streamId,
              action,
              interval_seconds: typeof cfg.schedule_interval_seconds === "number"
                ? cfg.schedule_interval_seconds
                : 300,
              last_pull_at: cfg.last_pull_at ?? null,
              last_pull_status: cfg.last_pull_status ?? null,
              event_count: typeof meta?.event_count === "number" ? meta.event_count : 0,
              last_event_at: meta?.last_event_at ?? null,
            };
            if (action && catalogSlugs.has(action)) {
              streamByAction.set(action, record);
            } else if (action) {
              staleStreams.push(record);
            }
          } catch { /* skip unreadable configs */ }
        }
      } catch { /* ok */ }

      // 4. Can Alfred invoke tools on this toolkit? Under Hermes,
      //    composio_execute is always present on the `execute` MCP server —
      //    there is no tool-enable list to consult. The real binary signal
      //    is simply whether this connection is ACTIVE in Composio.
      const composioExecuteEnabled = String(conn.status ?? "").toUpperCase() === "ACTIVE";

      // 5. Build enriched stream_actions + tool_actions with pretty names
      type Entry = {
        slug: string;
        display_name: string;
        description: string;
        deprecated: boolean;
        // Stream-only:
        enabled?: boolean;
        stream_id?: string | null;
        schedule_interval_seconds?: number | null;
        last_pull_at?: string | null;
        last_pull_status?: string | null;
        event_count?: number;
        last_event_at?: string | null;
      };
      const streamActions: Entry[] = [];
      const toolActions: Entry[] = [];

      for (const tool of tools) {
        const slug = (tool.name ?? tool.slug ?? "") as string;
        if (!slug) continue;
        const deprecated = Boolean(tool.deprecated);
        if (deprecated && !includeDeprecated) continue;
        const display_name = (tool.displayName ?? tool.display_name ?? "") as string;
        const description = (tool.description ?? "") as string;
        const type = classifyAction(slug);

        if (type === "stream") {
          const live = streamByAction.get(slug);
          streamActions.push({
            slug,
            display_name,
            description,
            deprecated,
            enabled: Boolean(live),
            stream_id: live?.stream_id ?? null,
            schedule_interval_seconds: live?.interval_seconds ?? null,
            last_pull_at: live?.last_pull_at ?? null,
            last_pull_status: live?.last_pull_status ?? null,
            event_count: live?.event_count ?? 0,
            last_event_at: live?.last_event_at ?? null,
          });
        } else {
          toolActions.push({ slug, display_name, description, deprecated });
        }
      }

      // Stable, read-before-write ordering (enabled streams first, then
      // alphabetical by display_name for readability)
      streamActions.sort((a, b) => {
        if ((a.enabled ? 1 : 0) !== (b.enabled ? 1 : 0)) return b.enabled ? 1 : -1;
        return (a.display_name || a.slug).localeCompare(b.display_name || b.slug);
      });
      toolActions.sort((a, b) =>
        (a.display_name || a.slug).localeCompare(b.display_name || b.slug),
      );

      sendJson(res, 200, {
        connection_id: connId,
        toolkit,
        toolkit_name: toolkitName,
        toolkit_icon: conn.toolkit?.logo ?? conn.toolkit?.iconUrl ?? null,
        composio_execute_enabled: composioExecuteEnabled,
        stream_actions: streamActions,
        tool_actions: toolActions,
        stale_streams: staleStreams.map((s) => ({
          stream_id: s.stream_id,
          action: s.action,
          interval_seconds: s.interval_seconds,
          last_pull_at: s.last_pull_at,
          last_pull_status: s.last_pull_status,
          event_count: s.event_count,
          last_event_at: s.last_event_at,
          suggested_replacement: (RECOMMENDED_STREAMS[toolkit]?.action) ?? null,
        })),
      });
    } catch (err: any) {
      if (err instanceof NotFoundError) throw err;
      sendJson(res, 500, { error: `Failed to fetch capabilities: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/:id/enable-stream — create a stream backed by Composio
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/:id/enable-stream", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.action_slug !== "string") {
      throw new ValidationError("action_slug (string) is required");
    }
    const connId = params.id;
    const actionSlug = b.action_slug as string;
    const pollInterval = typeof b.poll_interval_seconds === "number" ? b.poll_interval_seconds : 300;
    const streamName = typeof b.stream_name === "string" ? b.stream_name : actionSlug.replace(/_/g, " ");

    // Derive toolkit from action slug (GMAIL_FETCH_EMAILS → gmail)
    const toolkit = actionSlug.split("_")[0].toLowerCase();
    const streamId = `composio-${toolkit}-${actionSlug.toLowerCase().replace(/_/g, "-")}`;

    // Default composio_args: prefer RECOMMENDED_STREAMS for this toolkit if
    // the slug matches (the common case — user re-enabling the recommended
    // stream), else fall back to DEFAULT_ARGS[action], else empty. Any
    // composio_args on the prior config are lost when this endpoint
    // overwrites, but learn-side SYNC_CONFIGS provides a final safety net
    // for known actions.
    const rec = RECOMMENDED_STREAMS[toolkit];
    const recArgs = rec?.action === actionSlug ? rec.args : undefined;
    const composioArgs = recArgs ?? DEFAULT_ARGS[actionSlug] ?? {};

    // Create stream config
    const config = {
      id: streamId,
      name: streamName,
      type: "composio",
      source: `composio:${toolkit}`,
      enabled: true,
      composio_action: actionSlug,
      composio_connection_id: connId,
      composio_toolkit: toolkit,
      composio_args: composioArgs,
      parser: "composio",
      schedule_interval_seconds: pollInterval,
    };

    try {
      fs.mkdirSync(STREAM_CONFIGS_DIR, { recursive: true });
      const configPath = path.join(STREAM_CONFIGS_DIR, `${streamId}.json`);
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      // Also register in streams.json metadata
      const streamsMetaPath = path.join(STREAMS_DIR, "streams.json");
      let streams: any[] = [];
      try {
        streams = JSON.parse(fs.readFileSync(streamsMetaPath, "utf-8"));
      } catch { /* empty */ }

      // Remove existing entry with same ID
      streams = streams.filter((s: any) => s.id !== streamId);
      streams.push({
        id: streamId,
        name: streamName,
        type: "composio",
        source: `composio:${toolkit}`,
        enabled: true,
        status: "idle",
        last_event_at: null,
        event_count: 0,
      });
      fs.writeFileSync(streamsMetaPath, JSON.stringify(streams, null, 2));

      sendJson(res, 201, {
        stream_id: streamId,
        config,
        message: `Stream created and enabled. The al-stream-sweep schedule will pull it on its next tick (no per-stream schedule needed).`,
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to create stream: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/:id/migrate-stream — replace a stream's action
  //
  // When Composio renames/removes an action, the on-disk stream config still
  // references the old slug and every pull 404s. This endpoint rewrites the
  // stream config to the new slug (and new id), deletes the stale Temporal
  // schedule, and creates a fresh one on the same interval.
  //
  // Request body:
  //   {
  //     old_action_slug: string,          // e.g. "NOTION_LIST_PAGES"
  //     new_action_slug?: string,         // default: RECOMMENDED_STREAMS[toolkit]
  //     new_args?: Record<string, unknown>, // default: RECOMMENDED_STREAMS[toolkit].args
  //   }
  //
  // Returns the new stream config. The SaaS side then refetches capabilities
  // and the stale_streams banner disappears.
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/:id/migrate-stream", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.old_action_slug !== "string") {
      throw new ValidationError("old_action_slug (string) is required");
    }
    const connId = params.id;
    const oldSlug = b.old_action_slug as string;

    // Resolve toolkit from the live connected account. Enforces ownership so
    // one tenant cannot migrate a stream attached to another tenant's connection.
    const apiKey = getComposioApiKey();
    const userId = getComposioUserId();
    const conn = await assertConnectionOwnedByTenant(res, connId, userId, apiKey);
    if (!conn) return;
    const toolkit = (((conn as any).toolkit?.slug ?? (conn as any).appName ?? "") as string).toLowerCase();

    const recommended = toolkit ? RECOMMENDED_STREAMS[toolkit] : undefined;
    const newSlug = typeof b.new_action_slug === "string" && b.new_action_slug.trim()
      ? (b.new_action_slug as string)
      : recommended?.action;
    if (!newSlug) {
      throw new ValidationError(
        `No new_action_slug provided and no RECOMMENDED_STREAMS entry for toolkit "${toolkit}"`,
      );
    }

    try {
      fs.mkdirSync(STREAM_CONFIGS_DIR, { recursive: true });
      const configFiles = fs.readdirSync(STREAM_CONFIGS_DIR).filter((f) => f.endsWith(".json"));

      let oldConfigPath: string | null = null;
      let oldConfig: Record<string, unknown> | null = null;
      for (const file of configFiles) {
        const full = path.join(STREAM_CONFIGS_DIR, file);
        try {
          const cfg = JSON.parse(fs.readFileSync(full, "utf-8"));
          if (
            cfg?.composio_connection_id === connId &&
            cfg?.composio_action === oldSlug
          ) {
            oldConfigPath = full;
            oldConfig = cfg;
            break;
          }
        } catch { /* skip */ }
      }

      if (!oldConfig || !oldConfigPath) {
        throw new NotFoundError(
          `No stream config found for connection ${connId} with action ${oldSlug}`,
        );
      }

      const oldStreamId = (oldConfig.id as string) ?? oldConfigPath.split("/").pop()?.replace(/\.json$/, "") ?? "";
      const intervalSeconds = typeof oldConfig.schedule_interval_seconds === "number"
        ? (oldConfig.schedule_interval_seconds as number)
        : (recommended?.interval ?? 300);

      const newStreamId = `composio-${toolkit}-${newSlug.toLowerCase().replace(/_/g, "-")}`;
      const newArgs = (b.new_args && typeof b.new_args === "object")
        ? (b.new_args as Record<string, unknown>)
        : (recommended?.args ?? {});
      const newConfig: Record<string, unknown> = {
        id: newStreamId,
        name: (oldConfig.name as string) || recommended?.name || newSlug,
        type: "composio",
        source: `composio:${toolkit}`,
        enabled: true,
        composio_action: newSlug,
        composio_connection_id: connId,
        composio_toolkit: toolkit,
        composio_args: newArgs,
        parser: "composio",
        schedule_interval_seconds: intervalSeconds,
        pull_mode: SYNC_MODE[toolkit] ?? "append",
        cursor_value: "",
        last_pull_at: "",
        last_pull_status: "migrated",
      };

      // Write new config file
      const newPath = path.join(STREAM_CONFIGS_DIR, `${newStreamId}.json`);
      fs.writeFileSync(newPath, JSON.stringify(newConfig, null, 2));

      // If the new file is different from the old (new id), delete the old
      if (oldConfigPath !== newPath) {
        try { fs.unlinkSync(oldConfigPath); } catch { /* ok */ }
      }

      // Update streams.json metadata
      try {
        const streamsMetaPath = path.join(STREAMS_DIR, "streams.json");
        let streams: any[] = JSON.parse(fs.readFileSync(streamsMetaPath, "utf-8"));
        streams = streams.filter((s: any) => s.id !== oldStreamId && s.id !== newStreamId);
        streams.push({
          id: newStreamId,
          name: (oldConfig.name as string) || recommended?.name || newSlug,
          type: "composio",
          source: `composio:${toolkit}`,
          enabled: true,
          status: "idle",
          last_event_at: null,
          event_count: 0,
        });
        fs.writeFileSync(streamsMetaPath, JSON.stringify(streams, null, 2));
      } catch { /* ok */ }

      // (#53) No per-stream Temporal schedule to delete or recreate.
      // The migrate rewrote the on-disk config (new id, new action,
      // same schedule_interval_seconds); the al-stream-sweep schedule
      // reads stream configs by id every tick, so it picks up the
      // migrated config automatically and stops pulling the old id
      // once its config file is gone. Before #53 each stream had its
      // own al-stream-pull-* schedule that had to be deleted+recreated
      // here.

      sendJson(res, 200, {
        status: "migrated",
        old_action: oldSlug,
        new_action: newSlug,
        old_stream_id: oldStreamId,
        new_stream_id: newStreamId,
        schedule_interval_seconds: intervalSeconds,
        config: newConfig,
      });
    } catch (err: any) {
      if (err instanceof NotFoundError) throw err;
      if (err instanceof ValidationError) throw err;
      sendJson(res, 500, { error: `Failed to migrate stream: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/:id/disable-stream — tear down a Composio stream
  //
  // Inverse of enable-stream: finds the stream config that matches
  // (composio_action, composio_connection_id), deletes the config file and
  // removes the entry from streams.json.
  //
  // (#53) There is no per-stream Temporal schedule to delete. Streams are
  // polled by the single al-stream-sweep schedule, which reads stream
  // configs by id every tick — deleting the config file drops the stream
  // from the sweep on its next pass. `schedule_deleted: false` is kept in
  // the response for shape stability with pre-#53 callers.
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/:id/disable-stream", async ({ res, params, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.action_slug !== "string") {
      throw new ValidationError("action_slug (string) is required");
    }
    const connId = params.id;
    const actionSlug = b.action_slug as string;

    try {
      fs.mkdirSync(STREAM_CONFIGS_DIR, { recursive: true });
      const configFiles = fs.readdirSync(STREAM_CONFIGS_DIR).filter((f) => f.endsWith(".json"));

      let matchedStreamId: string | null = null;
      for (const file of configFiles) {
        const full = path.join(STREAM_CONFIGS_DIR, file);
        try {
          const cfg = JSON.parse(fs.readFileSync(full, "utf-8"));
          if (
            cfg?.composio_action === actionSlug &&
            cfg?.composio_connection_id === connId
          ) {
            matchedStreamId = cfg.id || file.replace(/\.json$/, "");
            fs.unlinkSync(full);
            break;
          }
        } catch { /* skip malformed */ }
      }

      // Remove from streams.json metadata
      const streamsMetaPath = path.join(STREAMS_DIR, "streams.json");
      try {
        const raw = fs.readFileSync(streamsMetaPath, "utf-8");
        let streams = JSON.parse(raw) as any[];
        if (Array.isArray(streams) && matchedStreamId) {
          const before = streams.length;
          streams = streams.filter((s: any) => s.id !== matchedStreamId);
          if (streams.length !== before) {
            fs.writeFileSync(streamsMetaPath, JSON.stringify(streams, null, 2));
          }
        }
      } catch { /* no metadata file — ok */ }

      // (#53) No per-stream Temporal schedule to delete — deleting the
      // config file above drops the stream from the al-stream-sweep
      // schedule. `schedule_deleted` is kept false for response-shape
      // stability with pre-#53 callers.
      const scheduleDeleted = false;

      sendJson(res, 200, {
        status: "disabled",
        action_slug: actionSlug,
        stream_id: matchedStreamId,
        schedule_deleted: scheduleDeleted,
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to disable stream: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/enable-tool — historically added a Composio
  // action to a Hermes tool-enable list. Under Hermes there is nothing to
  // enable: Composio is the single `composio_execute` tool on the always-on
  // `execute` MCP server (see the comment block above). Every Composio action
  // is callable the moment a connection is ACTIVE — no config, no restart.
  // The route is kept as a stable, idempotent no-op so the dashboard's
  // `enableIntegrationTool` Wasp action keeps working.
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/enable-tool", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.action_slug !== "string") {
      throw new ValidationError("action_slug (string) is required");
    }
    sendJson(res, 200, {
      status: "enabled",
      action_slug: b.action_slug as string,
      // composio_execute is always present on the `execute` MCP server.
      gateway_restart_triggered: false,
      note: "Composio actions are always available via the execute MCP server; no Hermes config change is needed.",
    });
  });

  // =========================================================================
  // POST /api/v1/integrations/disable-tool — the symmetric no-op. Disabling a
  // single Composio action is not a concept under Hermes (composio_execute is
  // one tool, the action is an argument). To remove Composio access entirely,
  // disconnect the connection (DELETE /integrations/:id) or disconnect-all.
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/disable-tool", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.action_slug !== "string") {
      throw new ValidationError("action_slug (string) is required");
    }
    sendJson(res, 200, {
      status: "disabled",
      action_slug: b.action_slug as string,
      gateway_restart_triggered: false,
      note: "Per-action disable is not modelled under Hermes; disconnect the connection to remove Composio access.",
    });
  });

  // =========================================================================
  // GET /api/v1/integrations/:toolkit/actions — list actions for a toolkit
  // =========================================================================
  addRoute("GET", "/api/v1/integrations/:toolkit/actions", async ({ res, params }) => {
    const apiKey = getComposioApiKey();
    const toolkit = params.toolkit;
    try {
      const resp = await fetch(
        `${COMPOSIO_API_V2}/actions?apps=${encodeURIComponent(toolkit)}&limit=50`,
        { headers: { "x-api-key": apiKey } },
      );
      if (!resp.ok) {
        sendJson(res, resp.status, { error: `Composio API error: ${resp.status}` });
        return;
      }
      const data = (await resp.json()) as Record<string, unknown>;
      const items = Array.isArray(data.items) ? data.items : [];
      sendJson(res, 200, {
        toolkit,
        actions: items.map((t: any) => ({
          slug: t.name ?? t.slug ?? "",
          description: t.description ?? "",
        })),
        count: items.length,
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to fetch actions: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/check-readiness — check tool readiness
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/check-readiness", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || !Array.isArray(b.tools_required)) {
      throw new ValidationError("tools_required (string[]) is required");
    }
    const apiKey = getComposioApiKey();
    const userId = getComposioUserId();
    try {
      // MUST scope by this tenant's user_id. Without it Composio returns the
      // fleet-wide connected_accounts list and we'd report "yes you have
      // googlecalendar" to any tenant whose peer connected it. Defense in depth:
      // also filter client-side on user_id match (Composio's server filter has
      // been observed to silently return unmatched accounts — see PR #469).
      const url = new URL(`${COMPOSIO_API_V3}/connected_accounts`);
      url.searchParams.set("user_id", userId);
      const resp = await fetch(url.toString(), {
        headers: { "x-api-key": apiKey },
      });
      if (!resp.ok) {
        sendJson(res, resp.status, { error: `Composio API error: ${resp.status}` });
        return;
      }
      const data = (await resp.json()) as Record<string, unknown>;
      const items = Array.isArray(data.items) ? data.items : [];

      const connectedToolkits = new Set(
        items
          .filter((a: any) => a.status === "ACTIVE" && accountMatchesUserId(a, userId))
          .map((a: any) => (a.toolkit?.slug ?? a.appName ?? "").toLowerCase()),
      );

      const toolsRequired = b.tools_required as string[];
      const available: string[] = [];
      const missing: string[] = [];
      for (const action of toolsRequired) {
        const toolkit = action.split("_")[0].toLowerCase();
        if (connectedToolkits.has(toolkit)) {
          available.push(action);
        } else {
          missing.push(action);
        }
      }

      sendJson(res, 200, {
        ready: missing.length === 0,
        available,
        missing,
        connected_toolkits: [...connectedToolkits].sort(),
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to check readiness: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/execute — execute a Composio action via SDK
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/execute", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.action !== "string" || !b.action) {
      throw new ValidationError("action (string) is required");
    }
    const apiKey = getComposioApiKey();
    const userId = getComposioUserId();
    const actionSlug = b.action as string;
    const userArgs = (b.arguments && typeof b.arguments === "object") ? b.arguments as Record<string, unknown> : {};

    // Merge default args for this action (user args take precedence)
    const defaults = DEFAULT_ARGS[actionSlug] || {};
    const mergedArgs = { ...defaults, ...userArgs };

    // Resolve connected account for this toolkit, scoped to this tenant.
    // MUST paginate: Composio's server-side user_id filter is broken and
    // returns accounts across every tenant, 10 per page. A single-page fetch
    // misses connections that land on page 2+ of the global pool — manifesting
    // as "No active <toolkit> connection found" even when the listing endpoint
    // (which paginates correctly via fetchAllOwnedConnectedAccounts) shows the
    // connection ACTIVE. See file-header pagination notes.
    const toolkit = actionSlug.split("_")[0].toLowerCase();
    let connectedAccountId = "";
    try {
      const owned = await fetchAllOwnedConnectedAccounts(apiKey, userId);
      const match = owned.find((a: any) =>
        (a.toolkit?.slug ?? a.appName ?? "").toLowerCase() === toolkit &&
        a.status === "ACTIVE",
      );
      if (match) connectedAccountId = match.id;
    } catch { /* proceed without — SDK will refuse without a match */ }

    if (!connectedAccountId) {
      sendJson(res, 400, {
        error: `No active ${toolkit} connection found. Connect ${toolkit} first via the Apps page.`,
      });
      return;
    }

    try {
      // Execute via docker exec into alfred-learn container (Python SDK).
      // Pass both COMPOSIO_API_KEY and COMPOSIO_USER_ID so the Python client
      // scopes the call correctly — the alfred-learn container already has
      // these from its env_file, but we set them explicitly for robustness.
      const script = `
import json, os, sys
os.environ.setdefault("COMPOSIO_API_KEY", ${JSON.stringify(apiKey)})
os.environ["COMPOSIO_USER_ID"] = ${JSON.stringify(userId)}
from src.integrations.composio_client import execute_action
result = execute_action(
    ${JSON.stringify(actionSlug)},
    json.loads(${JSON.stringify(JSON.stringify(mergedArgs))}),
    user_id=${JSON.stringify(userId)},
    connected_account_id=${JSON.stringify(connectedAccountId)},
)
print(json.dumps(result, default=str))
`.trim();

      const output = await dockerExec("alfred-learn", ["python3", "-c", script]);
      const result = JSON.parse(output.trim());
      let response: unknown = { action: actionSlug, toolkit, result };
      // Strip Gmail metadata-mode bulk fields (see stripGmailMetadataResponse
      // for the policy). Composio's adapter ignores `format: "metadata"` and
      // returns the full RFC822 + body; we trim it server-side so the agent
      // can fit ~150 messages per call instead of ~2.
      if (
        actionSlug === "GMAIL_FETCH_EMAILS" &&
        (mergedArgs as Record<string, unknown>).format === "metadata"
      ) {
        response = stripGmailMetadataResponse(response);
      }
      sendJson(res, 200, response);
    } catch (err: any) {
      sendJson(res, 500, {
        error: `Composio execute failed: ${err.message?.slice(0, 300)}`,
        action: actionSlug,
      });
    }
  });

  // =========================================================================
  // GET /api/v1/integrations/:id/google-identity — fetch the Google-account
  // email associated with a Google-family Composio connection. Used by the
  // SaaS-side tenant-email guard (see packages/saas/.../oauthTenantEmailGuard.ts)
  // to verify that the operator authorized the RIGHT Google account before
  // auto-config runs. On 2026-04-16 a tenant got contaminated with another
  // tenant's Gmail data because the operator's browser was signed into the
  // wrong Google account — this endpoint gives SaaS the identity it needs
  // to catch that mismatch and reject.
  //
  // Response: { email: string, verified: bool } on success,
  //           404 if the connection doesn't belong to this tenant,
  //           422 if identity couldn't be determined from Composio.
  // =========================================================================
  addRoute("GET", "/api/v1/integrations/:id/google-identity", async ({ res, params }) => {
    const apiKey = getComposioApiKey();
    const userId = getComposioUserId();
    const connId = params.id;

    const conn = await assertConnectionOwnedByTenant(res, connId, userId, apiKey);
    if (!conn) return;

    // Try the cheap path first — Composio connected_account payload often
    // carries the provider-returned email in state.val.profile, meta, or
    // account_identifier. Fall back to a live GMAIL_GET_PROFILE execution
    // for toolkits where the cheap path is empty.
    const candidates: string[] = [];
    const collectEmail = (obj: unknown, depth = 0): void => {
      if (!obj || typeof obj !== "object" || depth > 4) return;
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v === "string" && /@/.test(v) && /\./.test(v)) {
          const kl = k.toLowerCase();
          if (
            kl === "email" ||
            kl === "account_email" ||
            kl === "account_identifier" ||
            kl === "emailaddress" ||
            kl === "primary_email"
          ) {
            candidates.push(v);
          }
        } else if (v && typeof v === "object") {
          collectEmail(v, depth + 1);
        }
      }
    };
    collectEmail(conn);

    if (candidates.length > 0) {
      sendJson(res, 200, { email: candidates[0], verified: false, source: "composio_metadata" });
      return;
    }

    // Live probe — run GMAIL_GET_PROFILE if the toolkit is Gmail, otherwise
    // fail with 422 so SaaS knows it can't verify (and can make its own policy
    // call — skip guard vs. fail closed — per Google-family toolkit).
    const toolkit = (conn as any).toolkit?.slug ?? "";
    const toolkitL = String(toolkit).toLowerCase().replace(/[-_\s]/g, "");
    if (toolkitL !== "gmail" && toolkitL !== "googlemail") {
      sendJson(res, 422, {
        error: "identity_unavailable",
        reason:
          "Composio connected_account metadata has no email field and we " +
          "don't have a live-probe action for this toolkit.",
        toolkit,
      });
      return;
    }

    try {
      const script = `
import json, os
os.environ.setdefault("COMPOSIO_API_KEY", ${JSON.stringify(apiKey)})
os.environ["COMPOSIO_USER_ID"] = ${JSON.stringify(userId)}
from src.integrations.composio_client import execute_action
result = execute_action(
    "GMAIL_GET_PROFILE",
    {"userId": "me"},
    user_id=${JSON.stringify(userId)},
    connected_account_id=${JSON.stringify(connId)},
)
print(json.dumps(result, default=str))
`.trim();
      const output = await dockerExec("alfred-learn", ["python3", "-c", script]);
      const parsed = JSON.parse(output.trim());
      // GMAIL_GET_PROFILE returns { data: { emailAddress: "...", ... } }
      const data = (parsed && typeof parsed === "object" ? (parsed as any).data ?? parsed : {}) as any;
      const email = data?.emailAddress || data?.email || null;
      if (typeof email === "string" && email.includes("@")) {
        sendJson(res, 200, { email, verified: true, source: "gmail_get_profile" });
        return;
      }
      sendJson(res, 422, {
        error: "identity_unavailable",
        reason: "GMAIL_GET_PROFILE returned no email",
      });
    } catch (err: any) {
      sendJson(res, 422, {
        error: "identity_unavailable",
        reason: `GMAIL_GET_PROFILE failed: ${String(err?.message ?? err).slice(0, 200)}`,
      });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/:id/auto-config — auto-configure after connect
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/:id/auto-config", async ({ res, params }) => {
    const apiKey = getComposioApiKey();
    const userId = getComposioUserId();
    const connId = params.id;
    const summary: Record<string, unknown> = { connection_id: connId };

    try {
      // 1. Validate connection + enforce ownership — without this, one tenant
      //    could auto-configure streams/skills/tools on their own system
      //    pointing at another tenant's Composio connection.
      const connJson = await assertConnectionOwnedByTenant(res, connId, userId, apiKey);
      if (!connJson) return;
      const conn = connJson as any;
      const toolkit = (conn.toolkit?.slug ?? "").toLowerCase();
      if (!toolkit) {
        sendJson(res, 400, { error: "Connection has no toolkit" });
        return;
      }
      if (conn.status !== "ACTIVE") {
        sendJson(res, 400, { error: `Connection status is ${conn.status}, expected ACTIVE` });
        return;
      }
      summary.toolkit = toolkit;

      // 2. composio_execute needs no enabling under Hermes — it is a tool on
      // the always-on `execute` MCP server. The moment a connection is ACTIVE
      // Alfred can dispatch its actions. No config change, no gateway restart.
      summary.composio_execute_enabled = true;
      summary.gateway_restart_triggered = false;

      // 3. Create recommended stream if available
      const rec = RECOMMENDED_STREAMS[toolkit];
      if (rec) {
        const streamId = `composio-${toolkit}-${rec.action.toLowerCase().replace(/_/g, "-")}`;
        const config = {
          id: streamId,
          name: rec.name,
          type: "composio",
          source: `composio:${toolkit}`,
          enabled: true,
          composio_action: rec.action,
          composio_connection_id: connId,
          composio_toolkit: toolkit,
          composio_args: rec.args,
          parser: "composio",
          schedule_interval_seconds: rec.interval,
          pull_mode: SYNC_MODE[toolkit] || "snapshot",
        };

        // Write stream config
        fs.mkdirSync(STREAM_CONFIGS_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(STREAM_CONFIGS_DIR, `${streamId}.json`),
          JSON.stringify(config, null, 2),
        );

        // Register in streams.json
        const streamsMetaPath = path.join(STREAMS_DIR, "streams.json");
        let streams: any[] = [];
        try { streams = JSON.parse(fs.readFileSync(streamsMetaPath, "utf-8")); } catch { /* empty */ }
        streams = streams.filter((s: any) => s.id !== streamId);
        streams.push({
          id: streamId, name: rec.name, type: "composio",
          source: `composio:${toolkit}`, enabled: true, status: "idle",
          last_event_at: null, event_count: 0,
        });
        fs.writeFileSync(streamsMetaPath, JSON.stringify(streams, null, 2));

        // (#53) No per-stream Temporal schedule is created. Before #53
        // auto-config created one al-stream-pull-* schedule per stream
        // (with a describe/delete/recreate dance to heal a stale
        // encoded stream_id — tenant-a's notion schedule once fired 1,671
        // times against a dead `NOTION_LIST_PAGES` action before the
        // swap logic was added). The single al-stream-sweep schedule
        // (StreamSweepWorkflow, every 2 min) now reads every stream
        // config by id each tick, so writing the config above is the
        // whole job — there is no stale-schedule failure mode left, and
        // a re-run of auto-config simply rewrites the same config file.
        summary.stream_created = streamId;
      } else {
        summary.stream_created = null; // No recommended stream for this toolkit
      }

      // 4. Migrate legacy streams: disable any old OAuth-based stream for this toolkit
      const LEGACY_SOURCE_MAP: Record<string, string> = {
        gmail: "gmail",
        googlecalendar: "googlecalendar",
        notion: "notion",
        github: "github",
      };
      const legacySource = LEGACY_SOURCE_MAP[toolkit];
      if (legacySource) {
        try {
          const streamsMetaPath = path.join(STREAMS_DIR, "streams.json");
          const streams: any[] = JSON.parse(fs.readFileSync(streamsMetaPath, "utf-8"));
          const disabledLegacy: string[] = [];
          for (const s of streams) {
            // Match legacy streams by source (not composio-prefixed)
            if (s.source === legacySource && !s.id.startsWith("composio-") && s.enabled) {
              s.enabled = false;
              s.status = "migrated-to-composio";
              disabledLegacy.push(s.id);
              // Also disable in the config file
              const legacyConfigPath = path.join(STREAM_CONFIGS_DIR, `${s.id}.json`);
              try {
                const legacyCfg = JSON.parse(fs.readFileSync(legacyConfigPath, "utf-8"));
                legacyCfg.enabled = false;
                fs.writeFileSync(legacyConfigPath, JSON.stringify(legacyCfg, null, 2));
              } catch { /* config may not exist */ }
            }
          }
          if (disabledLegacy.length > 0) {
            fs.writeFileSync(streamsMetaPath, JSON.stringify(streams, null, 2));
            summary.legacy_streams_disabled = disabledLegacy;
          }
        } catch { /* migration is best-effort */ }
      }

      // 5. Generate skill file
      try {
        const skillResult = await generateComposioSkill(toolkit, connId, apiKey);
        summary.skill_generated = skillResult.skill_path;
        summary.actions_count = skillResult.actions_count;
      } catch (err: any) {
        summary.skill_error = err.message?.slice(0, 200);
      }

      sendJson(res, 200, summary);
    } catch (err: any) {
      sendJson(res, 500, { error: `Auto-config failed: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/regenerate-skills — rebuild every connected
  // app's SKILL.md from scratch. Needed after a template change (like the
  // ctrl→self tool rename) — without this, already-connected tenants would
  // have to click "Reconfigure" on every app one-at-a-time in the dashboard
  // to pick up the new template.
  //
  // Also performs a janitorial sweep of stale `alfred-composio-<toolkit>`
  // skill dirs whose toolkit no longer has any ACTIVE connection. The
  // disconnect handler removes the skill dir as best-effort, and historical
  // disconnects (or out-of-band cleanups via Composio's dashboard) can leave
  // these orphans behind. They're poison: openclaw still loads them, so the
  // agent confidently invokes a toolkit that has no working credentials.
  // Sir's slack SKILL.md was a real instance — the file persisted from
  // Apr 10 and described `composio_execute` (the dead pre-#430 dispatch
  // tool name) long after the slack connection itself was gone.
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/regenerate-skills", async ({ res }) => {
    const apiKey = getComposioApiKey();
    const userId = getComposioUserId();
    const results: Array<Record<string, unknown>> = [];
    const removed: Array<Record<string, unknown>> = [];

    try {
      const mine = await fetchAllOwnedConnectedAccounts(apiKey, userId);

      // Track which toolkits have at least one ACTIVE connection — the
      // janitorial sweep below uses this to decide what to remove.
      const activeToolkits = new Set<string>();

      for (const a of mine) {
        const connId = a.id;
        const toolkit = (a.toolkit?.slug ?? a.appName ?? "").toLowerCase();
        if (!toolkit || a.status !== "ACTIVE") {
          results.push({ connection_id: connId, toolkit, skipped: true, status: a.status });
          continue;
        }
        try {
          const out = await generateComposioSkill(toolkit, connId, apiKey);
          activeToolkits.add(toolkit);
          results.push({
            connection_id: connId,
            toolkit,
            ok: true,
            actions: out.actions_count,
            written_paths: out.written_paths,
          });
        } catch (err: any) {
          results.push({ connection_id: connId, toolkit, error: err.message?.slice(0, 200) });
        }
      }

      // Janitorial sweep: any `alfred-composio-<toolkit>` dir whose toolkit
      // is not in the ACTIVE set is stale and gets removed. We do NOT remove
      // dirs for toolkits that had a generation error this run — those are
      // ACTIVE-but-broken (e.g. transient Composio API hiccup), not orphans.
      const erroredToolkits = new Set(
        results
          .filter((r) => r.error && typeof r.toolkit === "string")
          .map((r) => r.toolkit as string),
      );
      for (const baseDir of [OPENCLAW_SKILLS_DIR, OPENCLAW_WORKERS_SKILLS_DIR]) {
        let entries: string[] = [];
        try {
          entries = fs.readdirSync(baseDir);
        } catch {
          continue; // base dir may not exist on a fresh tenant
        }
        for (const entry of entries) {
          if (!entry.startsWith("alfred-composio-")) continue;
          const toolkit = entry.slice("alfred-composio-".length).toLowerCase();
          if (!toolkit) continue;
          if (activeToolkits.has(toolkit)) continue;
          if (erroredToolkits.has(toolkit)) continue;
          const dirPath = path.join(baseDir, entry);
          try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            removed.push({ path: dirPath, toolkit });
          } catch (err: any) {
            removed.push({ path: dirPath, toolkit, error: err?.message?.slice(0, 200) });
          }
        }
      }

      sendJson(res, 200, { regenerated: results.length, results, stale_removed: removed });
    } catch (err: any) {
      sendJson(res, 500, {
        error: `Regenerate failed: ${err.message}`,
        partial_results: results,
        stale_removed: removed,
      });
    }
  });
}
