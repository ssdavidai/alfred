import { addRoute, matchRoute } from "../server.js";
import type { ApiRequest } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";

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
];

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
