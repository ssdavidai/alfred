import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticate } from "./auth.js";
import { handleError, sendJson, ValidationError } from "./errors.js";
import { setCors, parseBody, readRawBody, logRequest } from "./middleware.js";
import { registerVaultRoutes } from "./routes/vault.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerLogRoutes } from "./routes/logs.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { registerWorkerRoutes } from "./routes/workers.js";
import { registerHermesRoutes } from "./routes/hermes.js";
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
import { registerIntegrationRoutes } from "./routes/integrations.js";
import { registerInboundWebhookRoutes } from "./routes/webhooksInbound.js";
import { registerOmiRoutes } from "./routes/omi.js";
import { registerCrossTenantRoutes } from "./routes/crossTenant.js";
import { registerChoreRoutes } from "./routes/chores.js";
import { registerPhoneRoutes } from "./routes/phone.js";
import { registerAuthSendersRoutes } from "./routes/authSenders.js";
import { registerEmailRoutes } from "./routes/email.js";
import { registerChannelsEmailRoutes } from "./routes/channelsEmail.js";
import { registerChannelsAttachmentRoutes } from "./routes/channelsAttachment.js";
import { registerPlaneRoutes } from "./routes/plane.js";
import { registerSureRoutes } from "./routes/sure.js";
import { registerSureAssistantRoutes } from "./routes/sureAssistant.js";
import { registerAppsRoutes } from "./routes/apps.js";
import { registerVaultwardenRoutes } from "./routes/vaultwarden.js";
import { registerClaudeSetupRoutes } from "./routes/claudeSetup.js";
import { registerContextRoutes } from "./routes/context.js";
import { registerStewardRoutes } from "./routes/steward.js";
import { registerVexaRoutes } from "./routes/vexa.js";
import { registerAttentionRoutes } from "./routes/attention.js";
import { registerBriefingsRoutes } from "./routes/briefings.js";
import { registerMatterRoutes } from "./routes/matters.js";
import { registerDecisionRoutes } from "./routes/decisions.js";
import { registerStateChangeRoutes } from "./routes/stateChanges.js";
import { registerTodoRoutes } from "./routes/todos.js";
import { registerPlaneStewardWebhookRoute } from "./routes/webhooks/plane.js";
import { registerVexaWebhookRoute } from "./routes/webhooks/vexa.js";
import { registerStateRoutes } from "./routes/state.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerVaultIndexRoutes } from "./routes/vaultIndex.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerTelegramRoutes } from "./routes/telegram.js";
import { registerSlackRoutes } from "./routes/slack.js";
import { registerSmsRoutes } from "./routes/sms.js";
import { registerVoiceRoutes } from "./routes/voice.js";
import { registerOmiChannelRoutes } from "./routes/channels_omi.js";
import { registerPaperclipChannelRoutes } from "./routes/channels_paperclip.js";
import { registerComposioWebhookRoutes } from "./routes/composioWebhook.js";
import { registerAlfredJournalRoutes } from "./routes/alfredJournal.js";
import { registerAlfredDeliverRoutes } from "./routes/alfredDeliver.js";

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
  registerHermesRoutes();
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
  registerIntegrationRoutes();
  registerInboundWebhookRoutes();
  registerOmiRoutes();
  registerCrossTenantRoutes();
  registerChoreRoutes();
  registerPhoneRoutes();
  registerAuthSendersRoutes();
  registerEmailRoutes();
  registerChannelsEmailRoutes();
  registerChannelsAttachmentRoutes();
  registerPlaneRoutes();
  registerSureRoutes();
  registerSureAssistantRoutes();
  registerAppsRoutes();
  registerVaultwardenRoutes();
  registerClaudeSetupRoutes();
  registerContextRoutes();
  registerStewardRoutes();
  registerVexaRoutes();
  registerAttentionRoutes();
  registerBriefingsRoutes();
  registerMatterRoutes();
  registerDecisionRoutes();
  registerStateChangeRoutes();
  registerTodoRoutes();
  registerPlaneStewardWebhookRoute();
  registerVexaWebhookRoute();
  // Four-store architecture (PLAN.md Part I): state.db + ingest.db surfaces.
  registerStateRoutes();
  registerIngestRoutes();
  registerVaultIndexRoutes();
  registerSystemRoutes();
  registerSettingsRoutes();
  registerTelegramRoutes();
  registerSlackRoutes();
  registerSmsRoutes();
  registerVoiceRoutes();
  registerOmiChannelRoutes();
  registerPaperclipChannelRoutes();
  registerComposioWebhookRoutes();
  // The one-Alfred continuity layer — alfred_journal + principal mapping
  // (the persistence + lookup surface) plus alfred-deliver (the unified
  // outbound delivery endpoint). Sir-facing UX invariant: there is only
  // ONE Alfred, always. See docs/design/one-alfred.md.
  registerAlfredJournalRoutes();
  registerAlfredDeliverRoutes();

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

      // Unauthenticated liveness probe. Used by the container HEALTHCHECK and
      // by compose `depends_on: service_healthy` gating. Returns 200 as long
      // as the event loop is responsive — no auth, no DB, no docker exec.
      if (method === "GET" && (pathname === "/api/v1/health" || pathname === "/healthz")) {
        sendJson(res, 200, { ok: true, service: "ctrl-api", ts: new Date().toISOString() });
        logRequest(method, url, 200, Date.now() - start);
        return;
      }

      // Public routes that authenticate via their own mechanism (e.g. webhook token,
      // HMAC signature).
      //
      // /api/v1/channels/email/inbound is the AgentMail webhook target. AgentMail
      // does not sign its webhook payloads (their docs cover REST + webhooks but no
      // signature scheme), so the handler enforces a shared-secret `?token=` query
      // param against AGENTMAIL_WEBHOOK_TOKEN — same model as OMI's inbound stream.
      const isPublic =
        pathname.startsWith("/api/v1/streams/omi/") ||
        pathname === "/api/v1/plane/webhook" ||
        pathname === "/api/v1/webhooks/plane/steward" ||
        pathname === "/api/v1/webhooks/vexa" ||
        pathname.startsWith("/api/v1/webhooks/in/") ||
        pathname === "/api/v1/channels/email/inbound" ||
        // Paperclip heartbeat is HMAC-validated (X-Paperclip-Signature over
        // <ts>.<raw-body>), not bearer-authed. Lane V's Caddy
        // @public_webhooks matcher passes /api/v1/channels/paperclip/* through.
        pathname === "/api/v1/channels/paperclip/heartbeat" ||
        // Composio webhook is HMAC-validated against COMPOSIO_WEBHOOK_SECRET
        // (Standard-Webhooks scheme on `webhook-signature` / older shape on
        // `x-composio-signature`). Composio cannot send a Bearer header so
        // the global auth gate must not pre-empt the HMAC check. See
        // routes/composioWebhook.ts for the full auth model.
        pathname === "/api/v1/composio/webhook";
      if (!isPublic) {
        // Pass method+pathname so the scoped-token path can check the
        // route allowlist (see auth.ts VOICE_BRIDGE_ALLOWLIST). The master
        // key path ignores this argument.
        authenticate(req, { method, pathname });
      }

      // Cross-tenant auth is bearer-token only; X-Tenant-ID is NOT a real
      // header in this platform. If an Alfred hallucinates one (it has happened),
      // fail loudly with a clear message instead of letting the request proceed
      // — otherwise the symptom looks like a tenant-identity mismatch and wastes
      // an investigation cycle. See docs/cross-tenant-auth in the SKILL.md for
      // alfred-prime-federation.
      if (req.headers["x-tenant-id"]) {
        sendJson(res, 400, {
          error: {
            code: "X_TENANT_ID_NOT_SUPPORTED",
            message:
              "X-Tenant-ID header is not used by this platform. " +
              "Cross-tenant auth uses Authorization: Bearer <peer.apiKey> only. " +
              "Remove the header and route through the MCP `tenant` tool or `crossTenantProxy`.",
          },
        });
        logRequest(method, url, 400, Date.now() - start);
        return;
      }
      // Routes that receive exact-byte payloads and do their own parsing
      // (needed for HMAC-over-raw-body signature schemes).
      const isRawBody =
        pathname === "/api/v1/plane/webhook" ||
        pathname === "/api/v1/webhooks/plane/steward" ||
        pathname === "/api/v1/webhooks/vexa" ||
        // Composio's Standard-Webhooks scheme signs the raw body, so the
        // handler must see the exact bytes — see routes/composioWebhook.ts.
        pathname === "/api/v1/composio/webhook";
      const query = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");

      const matched = matchRoute(method, pathname);
      if (!matched) {
        sendJson(res, 404, { error: { code: "NOT_FOUND", message: `No route: ${method} ${pathname}` } });
        logRequest(method, url, 404, Date.now() - start);
        return;
      }

      let body: unknown;
      if (isRawBody) {
        try {
          body = await readRawBody(req);
        } catch {
          throw new ValidationError("Failed to read request body");
        }
      } else {
        try {
          body = await parseBody(req);
        } catch {
          throw new ValidationError("Invalid JSON body");
        }
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
