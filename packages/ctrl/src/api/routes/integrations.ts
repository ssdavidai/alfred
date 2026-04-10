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

function getComposioApiKey(): string {
  const key = process.env.COMPOSIO_API_KEY || "";
  if (!key) throw new ValidationError("COMPOSIO_API_KEY not configured on this tenant");
  return key;
}

function getComposioUserId(): string {
  return process.env.COMPOSIO_USER_ID || "default";
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
// Route registration
// ---------------------------------------------------------------------------

export function registerIntegrationRoutes(): void {

  // =========================================================================
  // GET /api/v1/integrations — list connected integrations
  // =========================================================================
  addRoute("GET", "/api/v1/integrations", async ({ res }) => {
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

      const userId = getComposioUserId();
      const filtered = items
        .filter((a: any) => userId === "default" || a.member_id === userId || a.user_id === userId)
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

      // Step 2: Create a connected account using the auth_config
      const connectResp = await fetch(`${COMPOSIO_API_V3}/connected_accounts`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          auth_config: { id: authConfigId },
          connection: {
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
    const connId = params.id;

    try {
      // 1. Fetch the connection to learn its toolkit before deleting
      let toolkit = "";
      try {
        const connResp = await fetch(
          `${COMPOSIO_API_V3}/connected_accounts/${encodeURIComponent(connId)}`,
          { headers: { "x-api-key": apiKey } },
        );
        if (connResp.ok) {
          const conn = (await connResp.json()) as any;
          toolkit = (conn.toolkit?.slug ?? conn.appName ?? "").toLowerCase();
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

      sendJson(res, 200, {
        status: "disconnected",
        connection_id: connId,
        toolkit,
        cleaned_streams: cleanedStreams,
        deleted_schedules: deletedSchedules,
        removed_tools: removedTools,
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
}
