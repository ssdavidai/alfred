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

// Composio REST API bases
const COMPOSIO_API_V3 = "https://backend.composio.dev/api/v3";
const COMPOSIO_API_V2 = "https://backend.composio.dev/api/v2";

// Paths
const STREAMS_DIR = "/mnt/encrypted/alfred/streams";
const STREAM_CONFIGS_DIR = path.join(STREAMS_DIR, "configs");
const OPENCLAW_CONFIG_PATH = "/mnt/encrypted/openclaw/openclaw.json";
const OPENCLAW_WORKERS_CONFIG_PATH = "/mnt/encrypted/openclaw-workers/openclaw.json";
const OPENCLAW_SKILLS_DIR = "/mnt/encrypted/openclaw/workspace/skills";
const OPENCLAW_WORKERS_SKILLS_DIR = "/mnt/encrypted/openclaw-workers/workspace/skills";

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
const COMPOSIO_USER_ID_FALLBACK_FILE = "/mnt/encrypted/alfred/.composio-user-id";

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

/**
 * Check whether a Composio connected_account payload belongs to the given user_id.
 * Handles both `member_id` (legacy) and `user_id` field names.
 */
function accountMatchesUserId(acct: Record<string, unknown>, userId: string): boolean {
  const a = acct as any;
  const m = a.member_id ?? a.user_id ?? a.userId ?? "";
  return typeof m === "string" && m === userId;
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
// Helpers for openclaw.json tool management
// ---------------------------------------------------------------------------

function readOpenclawConfig(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeOpenclawConfig(data: Record<string, any>): void {
  data.meta = data.meta || {};
  data.meta.lastTouchedAt = new Date().toISOString().replace(/\.\d{3}Z/, ".000Z");
  fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// openclaw-workers config helpers
// ---------------------------------------------------------------------------

function readWorkersConfig(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(OPENCLAW_WORKERS_CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeWorkersConfig(data: Record<string, any>): void {
  data.meta = data.meta || {};
  data.meta.lastTouchedAt = new Date().toISOString().replace(/\.\d{3}Z/, ".000Z");
  fs.writeFileSync(OPENCLAW_WORKERS_CONFIG_PATH, JSON.stringify(data, null, 2));
}

/** Add a tool to gateway.tools.allow in both openclaw configs if not present. */
function ensureToolInGateway(toolName: string): void {
  for (const [readFn, writeFn] of [
    [readOpenclawConfig, writeOpenclawConfig],
    [readWorkersConfig, writeWorkersConfig],
  ] as const) {
    try {
      const cfg = readFn();
      if (!cfg.gateway) cfg.gateway = {};
      if (!cfg.gateway.tools) cfg.gateway.tools = {};
      if (!Array.isArray(cfg.gateway.tools.allow)) cfg.gateway.tools.allow = [];
      if (!cfg.gateway.tools.allow.includes(toolName)) {
        cfg.gateway.tools.allow.push(toolName);
        cfg.gateway.tools.allow.sort();
        writeFn(cfg);
      }
    } catch { /* best effort */ }
  }
}

/** Remove a tool from gateway.tools.allow in both openclaw configs. */
function removeToolFromGateway(toolName: string): void {
  for (const [readFn, writeFn] of [
    [readOpenclawConfig, writeOpenclawConfig],
    [readWorkersConfig, writeWorkersConfig],
  ] as const) {
    try {
      const cfg = readFn();
      const allow: string[] = cfg?.gateway?.tools?.allow || [];
      const idx = allow.indexOf(toolName);
      if (idx >= 0) {
        allow.splice(idx, 1);
        cfg.gateway.tools.allow = allow;
        writeFn(cfg);
      }
    } catch { /* best effort */ }
  }
}

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
  gmail:          { action: "GMAIL_FETCH_EMAILS",         name: "Gmail Emails",     interval: 300, args: { userId: "me" } },
  // slack omitted: SLACK_FETCH_CONVERSATION_HISTORY requires a channel ID (per-tenant config)
  github:         { action: "GITHUB_LIST_NOTIFICATIONS",  name: "GitHub Notifications", interval: 300, args: {} },
  notion:         { action: "NOTION_LIST_PAGES",          name: "Notion Pages",     interval: 600, args: {} },
};

const SYNC_MODE: Record<string, "snapshot" | "append" | "sync"> = {
  googlecalendar: "sync",
  gmail: "append",
  slack: "append",
  github: "append",
  notion: "append",
};

const DEFAULT_ARGS: Record<string, Record<string, unknown>> = {
  GOOGLECALENDAR_EVENTS_LIST: { calendarId: "primary" },
  GOOGLECALENDAR_FIND_EVENT: { calendarId: "primary" },
  GOOGLECALENDAR_CREATE_EVENT: { calendarId: "primary" },
  GMAIL_FETCH_EMAILS: { userId: "me" },
  GMAIL_SEND_EMAIL: { userId: "me" },
  GMAIL_LIST_LABELS: { userId: "me" },
};

const TOOLKIT_EMOJI: Record<string, string> = {
  gmail: "📧", googlecalendar: "📅", slack: "💬", notion: "📝",
  github: "🐙", linear: "📋", stripe: "💳", discord: "🎮",
  trello: "📌", asana: "✅", hubspot: "🔶", salesforce: "☁️",
  googledrive: "📁", dropbox: "📦", twitter: "🐦", linkedin: "💼",
};

// ---------------------------------------------------------------------------
// Skill generation
// ---------------------------------------------------------------------------

async function generateComposioSkill(
  toolkit: string,
  connId: string,
  apiKey: string,
): Promise<{ actions_count: number; skill_path: string }> {
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

  // Build common usage examples — uses the MCP `ctrl` tool to call
  // POST /api/v1/integrations/execute (no standalone `ctrl_composio_execute`
  // tool exists; the only callable surface is the MCP `ctrl` tool).
  const recommended = RECOMMENDED_STREAMS[toolkit];
  let usageSection = "";
  if (toolActions.length > 0 || recommended) {
    const examples: string[] = [];
    const buildCall = (action: string, args: Record<string, unknown> | string): string => {
      const argsLiteral = typeof args === "string" ? args : JSON.stringify(args);
      return (
        `\`ctrl(endpoint="/api/v1/integrations/execute", method="POST", ` +
        `body={"action": "${action}", "arguments": ${argsLiteral}})\``
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

  const skillContent = `---
name: alfred-composio-${toolkit}
description: ${displayName} integration — ${actions.length} available actions via the MCP ctrl tool (POST /api/v1/integrations/execute).
version: "1.0"
metadata:
  openclaw:
    emoji: "${emoji}"
  generated: true
  composio_toolkit: "${toolkit}"
  composio_connection_id: "${connId}"
---

# ${emoji} ${displayName}

Connected via Composio. Call actions through the MCP \`ctrl\` tool: \`ctrl(endpoint="/api/v1/integrations/execute", method="POST", body={"action": "<ACTION_NAME>", "arguments": {...}})\`.

${streamActions.length > 0 ? `**Stream**: ${recommended ? `${recommended.name} (auto-configured, polling every ${Math.round(recommended.interval / 60)} min)` : "available but not auto-configured"}` : ""}
**Tool actions**: ${toolActions.length} | **Stream actions**: ${streamActions.length}

## Actions

${actionTable}
${usageSection}`;

  // Write to both workspaces
  const skillDirName = `alfred-composio-${toolkit}`;
  for (const baseDir of [OPENCLAW_SKILLS_DIR, OPENCLAW_WORKERS_SKILLS_DIR]) {
    const skillDir = path.join(baseDir, skillDirName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillContent);
    // Set ownership to node user (uid 1000) for openclaw containers
    try {
      fs.chownSync(skillDir, 1000, 1000);
      fs.chownSync(path.join(skillDir, "SKILL.md"), 1000, 1000);
    } catch { /* may fail if not root, that's ok */ }
  }

  return { actions_count: actions.length, skill_path: skillDirName };
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
      // Scope server-side via user_id query param. Composio v3 accepts this
      // to filter connected_accounts to a single end-user (tenant).
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

      // Defense-in-depth: if the server-side filter was silently ignored by
      // Composio (older API versions), drop anything that does not match our
      // tenant user_id. Better to return empty than to leak another tenant's
      // connections.
      const filtered = items
        .filter((a: any) => accountMatchesUserId(a, userId))
        .map((a: any) => ({
          id: a.id,
          toolkit: a.toolkit?.slug ?? a.appName ?? "",
          toolkit_name: a.toolkit?.displayName ?? a.toolkit?.name ?? a.appName ?? "",
          toolkit_icon: a.toolkit?.logo ?? "",
          status: a.status,
          auth_scheme: a.authScheme ?? "",
          user_id: a.member_id ?? a.user_id ?? "",
          created_at: a.createdAt ?? a.created_at ?? "",
        }));

      sendJson(res, 200, { integrations: filtered, count: filtered.length });
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
      const all = await fetchCatalog(apiKey);

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

      // Collect unique categories
      const categories = [...new Set(all.map((t) => t.category))].sort();

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
  // POST /api/v1/integrations/connect — initiate OAuth Connect Link
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/connect", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.toolkit_slug !== "string") {
      throw new ValidationError("toolkit_slug (string) is required");
    }
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
      let toolkit = "";
      let ownerUserId = "";
      try {
        const connResp = await fetch(
          `${COMPOSIO_API_V3}/connected_accounts/${encodeURIComponent(connId)}`,
          { headers: { "x-api-key": apiKey } },
        );
        if (connResp.ok) {
          const conn = (await connResp.json()) as any;
          toolkit = (conn.toolkit?.slug ?? conn.appName ?? "").toLowerCase();
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

      // 3. Clean up: remove any stream configs backed by this integration
      const cleanedStreams: string[] = [];
      try {
        fs.mkdirSync(STREAM_CONFIGS_DIR, { recursive: true });
        const configFiles = fs.readdirSync(STREAM_CONFIGS_DIR).filter((f) => f.endsWith(".json"));
        for (const file of configFiles) {
          const configPath = path.join(STREAM_CONFIGS_DIR, file);
          try {
            const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            if (config.composio_connection_id === connId) {
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

      // 5. Clean up: delete Temporal schedules for cleaned streams
      const deletedSchedules: string[] = [];
      for (const streamId of cleanedStreams) {
        const scheduleId = `al-stream-pull-composio-${streamId.slice(0, 20)}`;
        try {
          await dockerExec("temporal", [
            "temporal", "schedule", "delete", "--schedule-id", scheduleId,
          ]);
          deletedSchedules.push(scheduleId);
        } catch { /* schedule may not exist */ }
      }

      // 6. Clean up: remove Composio tool slugs from gateway.tools.allow
      const removedTools: string[] = [];
      if (toolkit) {
        try {
          const cfg = readOpenclawConfig();
          const allow: string[] = cfg?.gateway?.tools?.allow || [];
          const prefix = toolkit.toUpperCase() + "_";
          const kept = allow.filter((t) => {
            if (t.startsWith(prefix)) {
              removedTools.push(t);
              return false;
            }
            return true;
          });
          if (removedTools.length > 0) {
            cfg.gateway.tools.allow = kept;
            writeOpenclawConfig(cfg);
          }
        } catch { /* openclaw config cleanup is best-effort */ }
      }

      // 7. Clean up: remove skill files from both workspaces
      let skillRemoved = false;
      if (toolkit) {
        const skillDirName = `alfred-composio-${toolkit}`;
        for (const baseDir of [OPENCLAW_SKILLS_DIR, OPENCLAW_WORKERS_SKILLS_DIR]) {
          try {
            fs.rmSync(path.join(baseDir, skillDirName), { recursive: true, force: true });
            skillRemoved = true;
          } catch { /* ok */ }
        }
      }

      // 8. If no Composio connections remain for THIS tenant, remove
      //    composio_execute from gateway. Scoped by user_id so one tenant
      //    disconnecting does not yank the tool from another tenant.
      let composioExecuteRemoved = false;
      try {
        const remainingUrl = new URL(`${COMPOSIO_API_V3}/connected_accounts`);
        remainingUrl.searchParams.set("user_id", userId);
        const remainingResp = await fetch(remainingUrl.toString(), {
          headers: { "x-api-key": apiKey },
        });
        if (remainingResp.ok) {
          const remainingData = (await remainingResp.json()) as any;
          const remaining = (Array.isArray(remainingData.items) ? remainingData.items : [])
            .filter((a: any) => a.status === "ACTIVE" && accountMatchesUserId(a, userId));
          if (remaining.length === 0) {
            removeToolFromGateway("ctrl_composio_execute");
            composioExecuteRemoved = true;
          }
        }
      } catch { /* best effort */ }

      sendJson(res, 200, {
        status: "disconnected",
        connection_id: connId,
        toolkit,
        cleaned_streams: cleanedStreams,
        deleted_schedules: deletedSchedules,
        removed_tools: removedTools,
        skill_removed: skillRemoved,
        composio_execute_removed: composioExecuteRemoved,
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to disconnect: ${err.message}` });
    }
  });

  // =========================================================================
  // GET /api/v1/integrations/:id/capabilities — classify actions for a connection
  // =========================================================================
  addRoute("GET", "/api/v1/integrations/:id/capabilities", async ({ res, params }) => {
    const apiKey = getComposioApiKey();
    const connId = params.id;

    try {
      // First, get the connected account to find its toolkit
      const connResp = await fetch(
        `${COMPOSIO_API_V3}/connected_accounts/${encodeURIComponent(connId)}`,
        { headers: { "x-api-key": apiKey } },
      );

      if (!connResp.ok) {
        if (connResp.status === 404) throw new NotFoundError(`Connected account ${connId} not found`);
        sendJson(res, connResp.status, { error: `Composio API error: ${connResp.status}` });
        return;
      }

      const conn = (await connResp.json()) as any;
      const toolkit = conn.toolkit?.slug ?? conn.appName ?? "";

      if (!toolkit) {
        sendJson(res, 200, { toolkit: "", stream_actions: [], tool_actions: [] });
        return;
      }

      // Fetch available actions for this toolkit (v2 API uses apps= param)
      const actionsResp = await fetch(
        `${COMPOSIO_API_V2}/actions?apps=${encodeURIComponent(toolkit)}&limit=100`,
        { headers: { "x-api-key": apiKey } },
      );

      if (!actionsResp.ok) {
        sendJson(res, actionsResp.status, { error: `Composio actions error: ${actionsResp.status}` });
        return;
      }

      const actionsData = (await actionsResp.json()) as any;
      const tools = Array.isArray(actionsData.items) ? actionsData.items
        : Array.isArray(actionsData.tools) ? actionsData.tools : [];

      const streamActions: Array<{ slug: string; description: string }> = [];
      const toolActions: Array<{ slug: string; description: string }> = [];

      // Check which tools are currently enabled in openclaw.json
      let enabledTools: Set<string>;
      try {
        const cfg = readOpenclawConfig();
        enabledTools = new Set(cfg?.gateway?.tools?.allow || []);
      } catch {
        enabledTools = new Set();
      }

      // Check which actions are currently backing streams
      const activeStreamActions = new Set<string>();
      try {
        fs.mkdirSync(STREAM_CONFIGS_DIR, { recursive: true });
        const configFiles = fs.readdirSync(STREAM_CONFIGS_DIR).filter((f) => f.endsWith(".json"));
        for (const file of configFiles) {
          try {
            const config = JSON.parse(fs.readFileSync(path.join(STREAM_CONFIGS_DIR, file), "utf-8"));
            if (config.composio_action) activeStreamActions.add(config.composio_action);
          } catch { /* skip */ }
        }
      } catch { /* ok */ }

      for (const tool of tools) {
        const slug = tool.name ?? tool.slug ?? "";
        const description = tool.description ?? "";
        const type = classifyAction(slug);

        const entry = {
          slug,
          description,
          enabled: type === "stream" ? activeStreamActions.has(slug) : enabledTools.has(slug),
        };

        if (type === "stream") {
          streamActions.push(entry);
        } else {
          toolActions.push(entry);
        }
      }

      sendJson(res, 200, {
        connection_id: connId,
        toolkit,
        toolkit_name: conn.toolkit?.displayName ?? conn.toolkit?.name ?? toolkit,
        stream_actions: streamActions,
        tool_actions: toolActions,
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
        message: `Stream created. Create a Temporal schedule for StreamPullerWorkflow with stream_id=${streamId} to start polling.`,
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to create stream: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/enable-tool — add a Composio tool to gateway.tools.allow
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/enable-tool", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.action_slug !== "string") {
      throw new ValidationError("action_slug (string) is required");
    }
    const slug = b.action_slug as string;

    try {
      const cfg = readOpenclawConfig();
      if (!cfg.gateway) cfg.gateway = {};
      if (!cfg.gateway.tools) cfg.gateway.tools = {};
      if (!Array.isArray(cfg.gateway.tools.allow)) cfg.gateway.tools.allow = [];

      const allow: string[] = cfg.gateway.tools.allow;
      if (!allow.includes(slug)) {
        allow.push(slug);
        allow.sort();
        writeOpenclawConfig(cfg);
      }

      sendJson(res, 200, {
        status: "enabled",
        action_slug: slug,
        tools_count: allow.length,
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to enable tool: ${err.message}` });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/disable-tool — remove a Composio tool from gateway.tools.allow
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/disable-tool", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || typeof b.action_slug !== "string") {
      throw new ValidationError("action_slug (string) is required");
    }
    const slug = b.action_slug as string;

    try {
      const cfg = readOpenclawConfig();
      const allow: string[] = cfg?.gateway?.tools?.allow || [];
      const idx = allow.indexOf(slug);
      if (idx >= 0) {
        allow.splice(idx, 1);
        cfg.gateway.tools.allow = allow;
        writeOpenclawConfig(cfg);
      }

      sendJson(res, 200, {
        status: "disabled",
        action_slug: slug,
        tools_count: allow.length,
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to disable tool: ${err.message}` });
    }
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
    try {
      const resp = await fetch(`${COMPOSIO_API_V3}/connected_accounts`, {
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
          .filter((a: any) => a.status === "ACTIVE")
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
    const toolkit = actionSlug.split("_")[0].toLowerCase();
    let connectedAccountId = "";
    try {
      const connUrl = new URL(`${COMPOSIO_API_V3}/connected_accounts`);
      connUrl.searchParams.set("user_id", userId);
      const connResp = await fetch(connUrl.toString(), {
        headers: { "x-api-key": apiKey },
      });
      if (connResp.ok) {
        const data = (await connResp.json()) as any;
        const items = Array.isArray(data.items) ? data.items : [];
        const match = items.find((a: any) =>
          (a.toolkit?.slug ?? a.appName ?? "").toLowerCase() === toolkit &&
          a.status === "ACTIVE" &&
          accountMatchesUserId(a, userId),
        );
        if (match) connectedAccountId = match.id;
      }
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
      sendJson(res, 200, { action: actionSlug, toolkit, result });
    } catch (err: any) {
      sendJson(res, 500, {
        error: `Composio execute failed: ${err.message?.slice(0, 300)}`,
        action: actionSlug,
      });
    }
  });

  // =========================================================================
  // POST /api/v1/integrations/:id/auto-config — auto-configure after connect
  // =========================================================================
  addRoute("POST", "/api/v1/integrations/:id/auto-config", async ({ res, params }) => {
    const apiKey = getComposioApiKey();
    const connId = params.id;
    const summary: Record<string, unknown> = { connection_id: connId };

    try {
      // 1. Validate connection
      const connResp = await fetch(
        `${COMPOSIO_API_V3}/connected_accounts/${encodeURIComponent(connId)}`,
        { headers: { "x-api-key": apiKey } },
      );
      if (!connResp.ok) {
        sendJson(res, connResp.status, { error: `Connection ${connId} not found` });
        return;
      }
      const conn = (await connResp.json()) as any;
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

      // 2. Ensure composio_execute is in gateway.tools.allow (both configs)
      ensureToolInGateway("ctrl_composio_execute");
      summary.composio_execute_enabled = true;

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

        // Create Temporal schedule
        const scheduleId = `al-stream-pull-composio-${streamId.slice(0, 20)}`;
        const intervalMin = Math.max(Math.round(rec.interval / 60), 1);
        try {
          await dockerExec("temporal", [
            "temporal", "schedule", "create",
            "--schedule-id", scheduleId,
            "--type", "StreamPullerWorkflow",
            "--task-queue", "alfred-learn",
            "--cron", `*/${intervalMin} * * * *`,
            "--input", JSON.stringify({ stream_id: streamId }),
            "--overlap-policy", "Skip",
          ]);
          summary.stream_created = streamId;
          summary.schedule_created = scheduleId;
        } catch (err: any) {
          // Schedule might already exist
          if (err.message?.includes("already exists") || err.message?.includes("AlreadyExists") || err.message?.includes("already registered")) {
            summary.stream_created = streamId;
            summary.schedule_created = `${scheduleId} (already exists)`;
          } else {
            summary.stream_error = err.message?.slice(0, 200);
          }
        }
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
}
