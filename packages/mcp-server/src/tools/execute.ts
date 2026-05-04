// Execute MCP tool catalogue — Composio surface for claude.ai.
//
// Composio's design: ONE execute tool, every action submitted as the `action`
// parameter. The tool catalogue here mirrors that — a single `composio_execute`
// tool plus the metadata + connection-management surface needed to discover
// what to call and to manage the auth state.
//
// All routes proxy ctrl-api's existing /api/v1/integrations/* endpoints. No
// new server-side surface required; the routes have been live for months
// powering the dashboard's Apps page (packages/saas/.../IntegrationsPage.tsx).
//
// Catalogue contents (6 tools):
//   - list_composio_tools(toolkit?)    — actions available on a toolkit
//                                        (or list connected toolkits if no arg)
//   - composio_execute(action, args)   — run one action, return its output
//   - list_connections()               — currently connected accounts
//   - create_connection(toolkit_slug)  — start OAuth, returns auth URL Sir clicks
//   - reconnect_connection(id)         — re-auth an expired/broken connection
//   - delete_connection(id)            — disconnect (revoke + cleanup)

import { z } from "zod";
import type { ToolDef } from "./types.js";

const Uuid = z
  .string()
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "must be a Composio connection id (alphanumeric, dashes, underscores)",
  );

const ToolkitSlug = z
  .string()
  .regex(/^[a-z0-9_-]+$/i, "must be a Composio toolkit slug (e.g. 'gmail', 'github')")
  .min(2);

const ActionSlug = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]+$/, "must be a Composio action slug in UPPER_SNAKE_CASE (e.g. GMAIL_SEND_EMAIL)")
  .min(3);

export const ALL_EXECUTE_TOOLS: ToolDef[] = [
  // ── discovery ────────────────────────────────────────────────────────────
  {
    name: "list_composio_tools",
    description:
      "List available Composio actions. Pass `toolkit` to scope to one app's actions (e.g. {toolkit: 'gmail'} returns ['GMAIL_SEND_EMAIL','GMAIL_FETCH_EMAILS', …]). Omit to list every connected toolkit on this tenant — pick one, then call again to enumerate its actions. Use this BEFORE composio_execute when you don't already know the action slug; the per-toolkit alfred-composio-* skill files document the common ones with example payloads. Backing: GET /api/v1/integrations/:toolkit/actions or GET /api/v1/integrations.",
    inputSchema: z.object({
      toolkit: ToolkitSlug.optional().describe(
        "Toolkit slug to enumerate (lowercase, e.g. 'gmail', 'slack', 'github'). Omit to list connected toolkits.",
      ),
    }),
    buildRequest: ({ toolkit }) => {
      if (toolkit) {
        return {
          method: "GET",
          path: `/api/v1/integrations/${encodeURIComponent(toolkit)}/actions`,
        };
      }
      return { method: "GET", path: "/api/v1/integrations" };
    },
  },

  // ── execute ──────────────────────────────────────────────────────────────
  {
    name: "composio_execute",
    description:
      "Execute one Composio action. Composio is configured as a SINGLE tool with the action submitted as a parameter — every Gmail send, GitHub PR open, Slack message post, Notion page create goes through this same tool with a different `action` slug. The `arguments` shape is per-action; see the alfred-composio-<toolkit> skill files for canonical payloads, or call `list_composio_tools({toolkit})` to discover slugs. Returns `{action, toolkit, result}`. NOT idempotent on writes — re-running creates duplicates. Backing: POST /api/v1/integrations/execute.",
    inputSchema: z.object({
      action: ActionSlug.describe(
        "Composio action slug, UPPER_SNAKE_CASE. Examples: GMAIL_SEND_EMAIL, GITHUB_CREATE_AN_ISSUE, NOTION_CREATE_PAGE, SLACK_SENDS_MESSAGE_TO_A_CHANNEL.",
      ),
      arguments: z.record(z.string(), z.any()).describe(
        "Per-action payload. Each Composio action has its own JSON schema — consult the alfred-composio-<toolkit> skill or call `list_composio_tools({toolkit})` to discover required fields.",
      ),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/integrations/execute",
      body: args,
    }),
  },

  // ── connections: list ────────────────────────────────────────────────────
  {
    name: "list_connections",
    description:
      "List active Composio connected accounts on this tenant. Returns id + toolkit + display name + status (ACTIVE / DISABLED / EXPIRED) + auth scheme + created_at for each. Use BEFORE composio_execute when Sir asks 'what's connected?', or to fetch a connection id for `reconnect_connection` / `delete_connection`. Identical shape to GET /api/v1/integrations.",
    inputSchema: z.object({}),
    buildRequest: () => ({ method: "GET", path: "/api/v1/integrations" }),
  },

  // ── connections: create (OAuth flow) ─────────────────────────────────────
  {
    name: "create_connection",
    description:
      "Start an OAuth flow for a new Composio toolkit. Returns `{redirect_url, connection_id}` — Sir opens the URL in his browser, completes the third-party auth, and the connection lands as ACTIVE. Use when Sir asks 'connect Gmail' / 'add Notion' / 'I want to integrate Stripe'. The auth flow runs in the browser; this tool only initiates it. After Sir tells you he completed it, call `list_connections` to confirm the new ACTIVE connection. Backing: POST /api/v1/integrations/connect.",
    inputSchema: z.object({
      toolkit_slug: ToolkitSlug.describe(
        "Toolkit slug to connect (lowercase, e.g. 'gmail', 'github', 'notion'). Browse via `list_composio_tools()` (no toolkit arg) to see what's already connected; new toolkits come from Composio's catalog.",
      ),
      redirect_url: z
        .string()
        .url()
        .optional()
        .describe(
          "Where Composio sends Sir's browser after auth completes. Defaults to the dashboard's Apps page; only override if you have a reason.",
        ),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/integrations/connect",
      body: args,
    }),
  },

  // ── connections: reconnect ───────────────────────────────────────────────
  {
    name: "reconnect_connection",
    description:
      "Re-auth an existing Composio connection — used when status is EXPIRED or composio_execute starts failing with auth errors on a previously-working toolkit. Returns a fresh `redirect_url` Sir clicks. The connection_id stays the same; this is an in-place credential refresh, not a new account. Backing: POST /api/v1/integrations/:id/reconnect.",
    inputSchema: z.object({
      id: Uuid.describe("Composio connection id from `list_connections`"),
    }),
    buildRequest: ({ id }) => ({
      method: "POST",
      path: `/api/v1/integrations/${encodeURIComponent(id)}/reconnect`,
    }),
  },

  // ── connections: delete ──────────────────────────────────────────────────
  {
    name: "delete_connection",
    description:
      "Disconnect a Composio integration — revokes the OAuth grant at the third party (where supported), removes the connected_account record, and cleans up the auto-generated alfred-composio-<toolkit> skill if no other connection on this tenant uses it. After deletion, composio_execute against any of that toolkit's actions returns 'No active <toolkit> connection found'. Confirm with Sir before calling — this revokes Alfred's access to that app on Sir's account, including any background streams. Backing: DELETE /api/v1/integrations/:id.",
    inputSchema: z.object({
      id: Uuid.describe("Composio connection id from `list_connections`"),
    }),
    buildRequest: ({ id }) => ({
      method: "DELETE",
      path: `/api/v1/integrations/${encodeURIComponent(id)}`,
    }),
  },
];
