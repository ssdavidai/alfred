/**
 * Composio integration management routes.
 *
 * Exposes Composio connected accounts and tool listings to the SaaS
 * dashboard and the agent. The actual credentials are stored server-side
 * at Composio — only the connected_account_id and metadata are visible
 * to the tenant.
 */
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";

// Composio REST API base — the SDK calls go through the learn container,
// but for listing integrations we call the Composio REST API directly
// from ctrl since it's a read-only operation that doesn't need Temporal.
const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3";

function getComposioApiKey(): string {
  const key = process.env.COMPOSIO_API_KEY || "";
  if (!key) throw new ValidationError("COMPOSIO_API_KEY not configured on this tenant");
  return key;
}

function getComposioUserId(): string {
  return process.env.COMPOSIO_USER_ID || "default";
}

export function registerIntegrationRoutes(): void {
  // List connected integrations for this tenant
  addRoute("GET", "/api/v1/integrations", async ({ res }) => {
    const apiKey = getComposioApiKey();
    try {
      const resp = await fetch(`${COMPOSIO_API_BASE}/connected_accounts`, {
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

  // List available actions for a toolkit (e.g. "gmail", "notion")
  addRoute("GET", "/api/v1/integrations/:toolkit/actions", async ({ res, params }) => {
    const apiKey = getComposioApiKey();
    const toolkit = params.toolkit;
    try {
      const resp = await fetch(
        `${COMPOSIO_API_BASE}/tools/list?toolkit=${encodeURIComponent(toolkit)}&limit=50`,
        { headers: { "x-api-key": apiKey } },
      );
      if (!resp.ok) {
        sendJson(res, resp.status, { error: `Composio API error: ${resp.status}` });
        return;
      }
      const data = (await resp.json()) as Record<string, unknown>;
      const tools = Array.isArray(data.tools) ? data.tools : Array.isArray(data.items) ? data.items : [];
      sendJson(res, 200, {
        toolkit,
        actions: tools.map((t: any) => ({
          slug: t.slug ?? t.name ?? "",
          description: t.description ?? "",
        })),
        count: tools.length,
      });
    } catch (err: any) {
      sendJson(res, 500, { error: `Failed to fetch actions: ${err.message}` });
    }
  });

  // Check integration readiness for a list of required tools
  addRoute("POST", "/api/v1/integrations/check-readiness", async ({ res, body }) => {
    const b = body as Record<string, unknown> | undefined;
    if (!b || !Array.isArray(b.tools_required)) {
      throw new ValidationError("tools_required (string[]) is required");
    }
    const apiKey = getComposioApiKey();
    try {
      const resp = await fetch(`${COMPOSIO_API_BASE}/connected_accounts`, {
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
