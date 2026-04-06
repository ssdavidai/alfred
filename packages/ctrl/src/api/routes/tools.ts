import { addRoute, matchRoute } from "../server.js";
import type { ApiRequest } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { crossTenantAsk } from "./crossTenant.js";

// ---------------------------------------------------------------------------
// Tool definitions — each maps to an existing ctrl API endpoint
// ---------------------------------------------------------------------------

interface ToolParameter {
  type: string;
  required: boolean;
  enum?: string[];
}

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  endpoint: string; // e.g. "GET /api/v1/vault/records/{path}"
}

const TOOLS: ToolDef[] = [
  {
    name: "vault_read",
    description: "Read a vault record by path",
    parameters: { path: { type: "string", required: true } },
    endpoint: "GET /api/v1/vault/records/{path}",
  },
  {
    name: "vault_create",
    description: "Create a new vault record",
    parameters: {
      path: { type: "string", required: true },
      content: { type: "string", required: true },
      frontmatter: { type: "object", required: false },
    },
    endpoint: "POST /api/v1/vault/records",
  },
  {
    name: "vault_update",
    description: "Update a vault record's frontmatter",
    parameters: {
      path: { type: "string", required: true },
      set: { type: "object", required: true },
    },
    endpoint: "PATCH /api/v1/vault/records/{path}",
  },
  {
    name: "vault_search",
    description: "Search vault records by query",
    parameters: {
      query: { type: "string", required: true },
      type: { type: "string", required: false },
    },
    endpoint: "GET /api/v1/vault/search",
  },
  {
    name: "vault_list",
    description: "List vault records by type",
    parameters: { type: { type: "string", required: true } },
    endpoint: "GET /api/v1/vault/list/{type}",
  },
  {
    name: "stream_ingest",
    description: "Ingest an event into a stream",
    parameters: {
      stream_id: { type: "string", required: true },
      raw: { type: "object", required: true },
      summary: { type: "string", required: false },
    },
    endpoint: "POST /api/v1/streams/ingest",
  },
  {
    name: "credentials_list",
    description: "List configured credentials",
    parameters: {},
    endpoint: "GET /api/v1/admin/credentials",
  },
  {
    name: "service_restart",
    description: "Restart a Docker service",
    parameters: {
      service: { type: "string", required: true, enum: ["alfred", "openclaw", "ctrl-api", "alfred-learn"] },
    },
    endpoint: "POST /api/v1/admin/containers/{service}/restart",
  },
  // --- Vault extras ---
  {
    name: "vault_context",
    description: "Get an overview of all vault records grouped by type",
    parameters: {},
    endpoint: "GET /api/v1/vault/context",
  },
  {
    name: "vault_inbox",
    description: "List files in the vault inbox",
    parameters: {},
    endpoint: "GET /api/v1/vault/inbox",
  },
  {
    name: "vault_inbox_add",
    description: "Add an item to the vault inbox for curator processing",
    parameters: {
      filename: { type: "string", required: true },
      content: { type: "string", required: true },
    },
    endpoint: "POST /api/v1/vault/inbox",
  },
  {
    name: "vault_delete",
    description: "Delete a vault record by path",
    parameters: { path: { type: "string", required: true } },
    endpoint: "DELETE /api/v1/vault/records/{path}",
  },
  {
    name: "vault_graph",
    description: "Get the vault relationship graph",
    parameters: {},
    endpoint: "GET /api/v1/vault/graph",
  },
  {
    name: "vault_schema",
    description: "Get vault record types and their status enums",
    parameters: {},
    endpoint: "GET /api/v1/vault/schema",
  },
  // --- Learning & Intelligence ---
  {
    name: "learning_status",
    description: "Get learning system status (observations, instincts, reflections counts)",
    parameters: {},
    endpoint: "GET /api/v1/learning/status",
  },
  {
    name: "learning_observations",
    description: "List observations (behavioral patterns extracted from data)",
    parameters: {},
    endpoint: "GET /api/v1/learning/observations",
  },
  {
    name: "learning_instincts",
    description: "List instincts (learned action patterns)",
    parameters: {},
    endpoint: "GET /api/v1/learning/instincts",
  },
  {
    name: "learning_reflections",
    description: "List reflections (synthesized insights)",
    parameters: {},
    endpoint: "GET /api/v1/learning/reflections",
  },
  {
    name: "learning_sessions",
    description: "List conversation sessions tracked by the learning system",
    parameters: {},
    endpoint: "GET /api/v1/learning/sessions",
  },
  {
    name: "learning_queue",
    description: "Get items waiting in the learning processing queue",
    parameters: {},
    endpoint: "GET /api/v1/learning/queue",
  },
  {
    name: "learning_enable",
    description: "Enable the learning system",
    parameters: {},
    endpoint: "POST /api/v1/learning/enable",
  },
  {
    name: "learning_disable",
    description: "Disable the learning system",
    parameters: {},
    endpoint: "POST /api/v1/learning/disable",
  },
  // --- Streams ---
  {
    name: "streams_list",
    description: "List all configured data streams",
    parameters: {},
    endpoint: "GET /api/v1/streams",
  },
  {
    name: "streams_events",
    description: "List recent stream events",
    parameters: {},
    endpoint: "GET /api/v1/streams/events",
  },
  // --- Workflows (Temporal) ---
  {
    name: "workflows_list",
    description: "List active Temporal workflows",
    parameters: {},
    endpoint: "GET /api/v1/workflows",
  },
  {
    name: "workflows_get",
    description: "Get details of a specific workflow",
    parameters: { wfId: { type: "string", required: true } },
    endpoint: "GET /api/v1/workflows/{wfId}",
  },
  {
    name: "workflows_start",
    description: "Start a new Temporal workflow",
    parameters: {
      workflowType: { type: "string", required: true },
      workflowId: { type: "string", required: false },
      input: { type: "object", required: false },
    },
    endpoint: "POST /api/v1/workflows",
  },
  {
    name: "workflows_cancel",
    description: "Cancel a running workflow",
    parameters: { wfId: { type: "string", required: true } },
    endpoint: "POST /api/v1/workflows/{wfId}/cancel",
  },
  // --- Schedules (Temporal cron) ---
  {
    name: "schedules_list",
    description: "List all Temporal schedules",
    parameters: {},
    endpoint: "GET /api/v1/schedules",
  },
  {
    name: "schedules_trigger",
    description: "Manually trigger a schedule to run now",
    parameters: { schId: { type: "string", required: true } },
    endpoint: "POST /api/v1/schedules/{schId}/trigger",
  },
  {
    name: "schedules_pause",
    description: "Pause a schedule",
    parameters: { schId: { type: "string", required: true } },
    endpoint: "POST /api/v1/schedules/{schId}/pause",
  },
  {
    name: "schedules_unpause",
    description: "Unpause a schedule",
    parameters: { schId: { type: "string", required: true } },
    endpoint: "POST /api/v1/schedules/{schId}/unpause",
  },
  // --- Workers (vault daemons) ---
  {
    name: "workers_status",
    description: "Get status of vault worker daemons (curator, janitor, distiller)",
    parameters: {},
    endpoint: "GET /api/v1/workers/status",
  },
  {
    name: "workers_restart",
    description: "Restart vault worker daemons",
    parameters: {},
    endpoint: "POST /api/v1/workers/restart",
  },
  // --- Admin ---
  {
    name: "admin_dashboard",
    description: "Get a dashboard summary of the instance (health, containers, vault stats)",
    parameters: {},
    endpoint: "GET /api/v1/admin/dashboard",
  },
  {
    name: "admin_health",
    description: "Run a health check on the instance",
    parameters: {},
    endpoint: "GET /api/v1/admin/health",
  },
  {
    name: "admin_containers",
    description: "List all Docker containers and their status",
    parameters: {},
    endpoint: "GET /api/v1/admin/containers",
  },
  {
    name: "admin_system_info",
    description: "Get system information (CPU, memory, disk, uptime)",
    parameters: {},
    endpoint: "GET /api/v1/admin/system/info",
  },
  {
    name: "admin_activity",
    description: "Get recent activity log",
    parameters: {},
    endpoint: "GET /api/v1/admin/activity",
  },
  {
    name: "admin_models",
    description: "List available AI models",
    parameters: {},
    endpoint: "GET /api/v1/admin/models",
  },
  {
    name: "container_logs",
    description: "Get logs from a Docker container",
    parameters: {
      service: { type: "string", required: true, enum: ["alfred", "openclaw", "openclaw-workers", "ctrl-api", "alfred-learn", "temporal"] },
    },
    endpoint: "GET /api/v1/admin/containers/{service}/logs",
  },
];

// Cross-tenant tool — only registered when CROSS_TENANT_PEERS is configured
if (process.env.CROSS_TENANT_PEERS) {
  TOOLS.push({
    name: "ask_alfred",
    description:
      "Ask another tenant's Alfred a question. The question is sent to the target tenant's Alfred agent, " +
      "which processes it using that tenant's vault context and returns an answer. Admin-only.",
    parameters: {
      tenant: { type: "string", required: true },
      prompt: { type: "string", required: true },
      timeout_seconds: { type: "number", required: false },
    },
    endpoint: "__cross_tenant__", // special dispatch — not a real route
  });
}

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Internal dispatch — resolve a tool invocation to an internal route call
// ---------------------------------------------------------------------------

/**
 * Build the concrete URL path and HTTP method from a tool definition + args,
 * then dispatch to the matching internal route handler.
 */
async function dispatchTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ApiRequest,
): Promise<void> {
  // Special dispatch for cross-tenant tool
  if (tool.name === "ask_alfred") {
    const tenant = String(args.tenant || "");
    const prompt = String(args.prompt || "");
    const timeout = Number(args.timeout_seconds) || 300;
    const result = await crossTenantAsk(tenant, prompt, timeout);
    sendJson(ctx.res, 200, result);
    return;
  }

  const [method, pathTemplate] = tool.endpoint.split(" ", 2);

  // Substitute {param} placeholders in the path with arg values
  let resolvedPath = pathTemplate;
  for (const [key, value] of Object.entries(args)) {
    const placeholder = `{${key}}`;
    if (resolvedPath.includes(placeholder)) {
      resolvedPath = resolvedPath.replace(placeholder, encodeURIComponent(String(value)));
    }
  }

  // Build query params for GET endpoints (non-path args)
  const query = new URLSearchParams();
  if (method === "GET") {
    for (const [key, value] of Object.entries(args)) {
      if (!pathTemplate.includes(`{${key}}`) && value !== undefined) {
        query.set(key, String(value));
      }
    }
    // vault_search maps "query" arg -> "grep" query param
    if (tool.name === "vault_search") {
      const q = args.query;
      if (typeof q === "string") {
        query.set("grep", q);
        query.delete("query");
      }
    }
  }

  // Build body for POST/PATCH/PUT endpoints (non-path args)
  let body: unknown = undefined;
  if (method !== "GET") {
    const bodyObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (!pathTemplate.includes(`{${key}}`)) {
        bodyObj[key] = value;
      }
    }

    // Map tool-specific args to what the underlying route expects
    if (tool.name === "vault_create") {
      // POST /api/v1/vault/records expects: type, name, content
      // Tool args: path (e.g. "task/my-task.md"), content, frontmatter
      const p = String(args.path || "");
      const parts = p.replace(/\.md$/, "").split("/");
      bodyObj.type = parts[0] || "note";
      bodyObj.name = parts.slice(1).join("/") || parts[0];
      bodyObj.content = args.content;
      delete bodyObj.path;
      delete bodyObj.frontmatter;
    } else if (tool.name === "stream_ingest") {
      // POST /api/v1/streams/ingest expects stream_id, stream_type, raw, summary
      bodyObj.stream_type = "tool-ingest";
    }

    body = bodyObj;
  }

  // Match the internal route
  const matched = matchRoute(method, resolvedPath);
  if (!matched) {
    throw new NotFoundError(`No internal route for tool "${tool.name}": ${method} ${resolvedPath}`);
  }

  // Dispatch to the matched handler with a synthetic context
  await matched.handler({
    req: ctx.req,
    res: ctx.res,
    params: matched.params,
    body,
    query,
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerToolRoutes(): void {
  // GET /api/v1/tools — list available tools
  addRoute("GET", "/api/v1/tools", async ({ res }) => {
    sendJson(res, 200, { tools: TOOLS });
  });

  // POST /api/v1/tools/invoke — execute a tool by name
  addRoute("POST", "/api/v1/tools/invoke", async (ctx) => {
    const b = ctx.body as Record<string, unknown> | undefined;
    if (!b || typeof b.tool !== "string") {
      throw new ValidationError("tool (string) is required");
    }

    const toolName = b.tool as string;
    const args = (b.args && typeof b.args === "object" ? b.args : {}) as Record<string, unknown>;

    const tool = TOOL_MAP.get(toolName);
    if (!tool) {
      throw new NotFoundError(`Unknown tool: "${toolName}". Available: ${TOOLS.map((t) => t.name).join(", ")}`);
    }

    // Validate required parameters
    for (const [key, param] of Object.entries(tool.parameters)) {
      if (param.required && (args[key] === undefined || args[key] === null)) {
        throw new ValidationError(`Missing required parameter "${key}" for tool "${toolName}"`);
      }
      // Validate enum values
      if (param.enum && args[key] !== undefined) {
        if (!param.enum.includes(String(args[key]))) {
          throw new ValidationError(
            `Invalid value for "${key}": "${args[key]}". Allowed: ${param.enum.join(", ")}`,
          );
        }
      }
    }

    await dispatchTool(tool, args, ctx);
  });
}
