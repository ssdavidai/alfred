import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticate } from "./auth.js";
import { handleError, sendJson, ValidationError } from "./errors.js";
import { setCors, parseBody, logRequest } from "./middleware.js";
import { registerVaultRoutes } from "./routes/vault.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerLogRoutes } from "./routes/logs.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { registerWorkerRoutes } from "./routes/workers.js";
import { registerOpenClawRoutes } from "./routes/openclaw.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerCredentialRoutes } from "./routes/credentials.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerStreamRoutes } from "./routes/streams.js";
import { registerLearningRoutes } from "./routes/learning.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import { registerToolRoutes } from "./routes/tools.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerOmiRoutes } from "./routes/omi.js";

export interface RouteParams {
  [key: string]: string;
}

export interface ApiRequest {
  req: IncomingMessage;
  res: ServerResponse;
  params: RouteParams;
  body: unknown;
  query: URLSearchParams;
}

type RouteHandler = (ctx: ApiRequest) => Promise<void>;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

function pathToRegex(path: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = path
    .replace(/\/:(\w+)/g, (_match, key) => {
      keys.push(key);
      return "/([^/]+)";
    })
    .replace(/\/\*$/, () => {
      keys.push("path");
      return "/(.+)";
    });
  return { regex: new RegExp(`^${pattern}$`), keys };
}

const routes: Route[] = [];

export function addRoute(method: string, path: string, handler: RouteHandler): void {
  const { regex, keys } = pathToRegex(path);
  routes.push({ method, regex, keys, handler });
}

export function matchRoute(method: string, pathname: string): { handler: RouteHandler; params: RouteParams } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.regex);
    if (!match) continue;
    const params: RouteParams = {};
    for (let i = 0; i < route.keys.length; i++) {
      params[route.keys[i]] = decodeURIComponent(match[i + 1]);
    }
    return { handler: route.handler, params };
  }
  return null;
}

export function createApiServer(): http.Server {
  // Register all routes
  registerVaultRoutes();
  registerWorkerRoutes();
  registerWorkflowRoutes();
  registerDeviceRoutes();
  registerOpenClawRoutes();
  registerLogRoutes();
  registerAdminRoutes();
  registerCredentialRoutes();
  registerAgentRoutes();
  registerStreamRoutes();
  registerLearningRoutes();
  registerNotificationRoutes();
  registerModelRoutes();
  registerWorkspaceRoutes();
  registerToolRoutes();
  registerApprovalRoutes();
  registerOmiRoutes();

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const start = Date.now();
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    setCors(res);

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const qIdx = url.indexOf("?");
      const pathname = qIdx >= 0 ? url.slice(0, qIdx) : url;

      // Public routes that authenticate via their own mechanism (e.g. webhook token)
      const isPublic = pathname.startsWith("/api/v1/streams/omi/");
      if (!isPublic) {
        authenticate(req);
      }
      const query = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");

      const matched = matchRoute(method, pathname);
      if (!matched) {
        sendJson(res, 404, { error: { code: "NOT_FOUND", message: `No route: ${method} ${pathname}` } });
        logRequest(method, url, 404, Date.now() - start);
        return;
      }

      let body: unknown;
      try {
        body = await parseBody(req);
      } catch {
        throw new ValidationError("Invalid JSON body");
      }

      await matched.handler({
        req,
        res,
        params: matched.params,
        body,
        query,
      });

      logRequest(method, url, res.statusCode, Date.now() - start);
    } catch (err) {
      handleError(res, err);
      logRequest(method, url, res.statusCode, Date.now() - start);
    }
  });

  return server;
}
