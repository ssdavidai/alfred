import { HttpError, prisma } from "wasp/server";
import type {
  GetDashboardData,
  GetInboxItems,
  GetVaultRecords,
  GetVaultRecord,
  GetVaultGraph,
  GetNebulaData,
  GetWorkerStatus,
  GetDevices,
  GetContainerLogs,
  GetActivityFeed,
  GetAuditFeed,
  GetCredentials,
  GetAgentConfig,
  GetModelCatalog,
  GetWorkspaceFile,
  GetFirstBrief,
  GetOnboardingProgress,
  GetOnboardingGmailMode,
  GetInstalledApps,
  GetClaudeSetup,
} from "wasp/server/operations";
import type {
  SubmitInboxItem,
  TriggerWorker,
  ApproveDevice,
  RevokeDevice,
  UpdateCredentials,
  UpdateAgentConfig,
  UpdateAgentModel,
  UpdateWorkspaceFile,
  StartOnboarding,
} from "wasp/server/operations";
import { getUserInstance, proxyToTenant } from "../server/tenantProxy";
import {
  resolveOnboardingGmailMode,
  type OnboardingGmailMode,
} from "../server/onboardingGmailMode";
import { checkGmailConnection } from "../integrations/operations";

// ============================================================
// AgentPhone (Phase 8 — dashboard PhonePage)
// ============================================================

export const getPhoneConfig = async (_args: unknown, context: any) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { path: "/api/v1/phone/config" });
};

export const addAuthorizedNumber = async (
  args: { number: string },
  context: any,
) => {
  if (!args?.number) throw new HttpError(400, "number required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/phone/authorized-numbers",
    body: { number: args.number },
  });
};

export const removeAuthorizedNumber = async (
  args: { number: string },
  context: any,
) => {
  if (!args?.number) throw new HttpError(400, "number required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "DELETE",
    path: `/api/v1/phone/authorized-numbers/${encodeURIComponent(args.number)}`,
  });
};

// ============================================================
// Channel provisioning (F57 email · F58 phone · F77 approval secret)
// Thin proxies to the ctrl-api C14/C15/C16 endpoints. entities: [].
// ============================================================

/** F57/C14 — email channel status: { configured, inbox_address|null }. */
export const getEmailChannelStatus = async (_args: unknown, context: any) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { path: "/api/v1/email/status" });
};

/** F57/C14 — provision the AgentMail inbox from an API key. */
export const provisionEmail = async (
  args: { api_key: string },
  context: any,
) => {
  if (!args?.api_key) throw new HttpError(400, "api_key required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/email/provision",
    body: { api_key: args.api_key },
  });
};

/** F58/C15 — provision phone (BYO number; the buy: path is 4xx for now). */
export const provisionPhone = async (
  args: {
    openai_api_key: string;
    twilio_account_sid: string;
    twilio_auth_token: string;
    phone_number?: string;
  },
  context: any,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/phone/provision",
    body: args,
  });
};

/** F77/C16 — rotate the approval secret; returns { approval_secret } once. */
export const rotateApprovalSecret = async (_args: unknown, context: any) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/claude-setup/approval-secret/rotate",
  });
};

// Sir #8 — SSH info for the /channels Terminal card. Backed by ctrl-api
// GET /api/v1/system/ssh-info (Lane I owns the endpoint). Returns
// { hostname, port, user, pubkey, hermes_exec } — each may be null
// until SSH is provisioned. Shape mirrored in terminalCardCore.ts.
export const getSshInfo = async (_args: unknown, context: any) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { path: "/api/v1/system/ssh-info" });
};

// Lane III — Telegram channel on /channels. Backed by Lane I's ctrl-api
// endpoints under /api/v1/channels/telegram/*. Shape:
//   getTelegramChannelStatus → { configured, bot_handle, state, error,
//                                paired_chats: [{id,name,type}] }
//                              (state lives in telegramCardCore.TelegramState)
//   setTelegramBotToken      → 200 { ok, state }
//   sendTelegramTest         → 200 { ok, chat_id?, message_id?, error? }
//   revokeTelegramChat       → 200 { ok, revoked }
//   disconnectTelegram       → 200 { ok, state: "unconfigured" }
//
// Note: there is NO `pair` action. "Pair this chat" used to call a hermes
// CLI subcommand (`pairing mint`) that never existed and 500'd; the right
// model is "DM the bot, then it appears in paired_chats" — Hermes uses the
// TELEGRAM_ALLOWED_USERS allowlist, not pairing codes. Removed 2026-05-25.
export const getTelegramChannelStatus = async (
  _args: unknown,
  context: any,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    path: "/api/v1/channels/telegram/status",
  });
};

export const setTelegramBotToken = async (
  args: { token: string },
  context: any,
) => {
  if (!args?.token?.trim()) throw new HttpError(400, "token required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PUT",
    path: "/api/v1/channels/telegram/token",
    body: { token: args.token.trim() },
  });
};

export const sendTelegramTest = async (_args: unknown, context: any) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/channels/telegram/test",
  });
};

export const revokeTelegramChat = async (
  args: { chat_id: string },
  context: any,
) => {
  if (!args?.chat_id?.toString().trim()) {
    throw new HttpError(400, "chat_id required");
  }
  const instance = await getUserInstance(context);
  const safe = encodeURIComponent(args.chat_id.toString().trim());
  return proxyToTenant(instance, {
    method: "DELETE",
    path: `/api/v1/channels/telegram/chats/${safe}`,
  });
};

export const disconnectTelegram = async (_args: unknown, context: any) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "DELETE",
    path: "/api/v1/channels/telegram/token",
  });
};

// ============================================================
// Dashboard Home
// ============================================================

/** Derive an overall status from the healthcheck response. */
function deriveHealthStatus(
  health: any,
): "ok" | "degraded" | "down" | "unknown" {
  if (!health || !Array.isArray(health.containers)) return "unknown";
  const containers: any[] = health.containers;
  if (containers.length === 0) return "down";
  const running = containers.filter(
    (c: any) => c.State === "running" || (c.State === "exited" && c.ExitCode === 0),
  );
  if (running.length === containers.length) return "ok";
  if (running.length > 0) return "degraded";
  return "down";
}

/** Transform raw vault context into the shape the dashboard expects. */
function transformVaultContext(raw: any): {
  total_records: number;
  types: Record<string, number>;
} | null {
  if (!raw || raw.error || raw.raw) return null;
  const byType: Record<string, any[]> = raw.records_by_type || {};
  const types: Record<string, number> = {};
  for (const [type, records] of Object.entries(byType)) {
    types[type] = Array.isArray(records) ? records.length : 0;
  }
  return {
    total_records: raw.total ?? 0,
    types,
  };
}

export const getDashboardData: GetDashboardData<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);

  // Single aggregated endpoint — one tunnel round-trip instead of six
  const raw = await proxyToTenant(instance, { path: "/api/v1/admin/dashboard" });

  const healthRaw = raw?.health ?? null;
  const vaultRaw = raw?.vault ?? null;
  const inboxRaw = raw?.inbox ?? null;
  const pairingRaw = raw?.pairing ?? null;
  const containersRaw = raw?.containers ?? null;

  // Build health object with derived status
  const health = healthRaw
    ? {
        status: deriveHealthStatus(healthRaw),
        containers: Array.isArray(healthRaw.containers)
          ? healthRaw.containers.filter((c: any) => c.State === "running")
          : [],
        disk_percent: healthRaw.disk_percent,
        memory_percent: healthRaw.memory_percent,
      }
    : null;

  // Inbox file count (exclude "processed" directory)
  const inboxFiles = Array.isArray(inboxRaw?.files)
    ? inboxRaw.files.filter((f: string) => f !== "processed")
    : [];

  // DM-pairing status. Hermes' `pairing list` emits human-readable text
  // (no JSON, no counts) — the dashboard carries the raw text so the
  // TopBar/DevicesPanel can render it as a read-only surface.
  const pairingText: string | null =
    typeof pairingRaw?.raw === "string" ? pairingRaw.raw : null;

  // Full container list
  const containers = containersRaw
    ? Array.isArray(containersRaw?.containers)
      ? containersRaw.containers
      : Array.isArray(containersRaw)
        ? containersRaw
        : []
    : null;

  // NOTE (issue #59): the `gatewayToken` field is gone. It read
  // `openclawCfg.gateway.auth.token` from the tenant /admin/dashboard
  // endpoint — an OpenClaw-era key the Hermes config schema does not
  // define, sourced from a config path that did not exist, so it was
  // always `null`. No component rendered it.

  return {
    health,
    vault: transformVaultContext(vaultRaw),
    instance: {
      status: instance!.status,
      tier: instance!.tier,
      tailscaleHostname: instance!.tailscaleHostname ?? null,
      subdomainUrl: (instance as any).subdomainUrl ?? null,
      agentmailInboxAddress: (instance as any).agentmailInboxAddress ?? null,
    },
    inbox: inboxRaw ? { count: inboxFiles.length } : null,
    pairing: pairingText !== null ? { raw: pairingText } : null,
    containers,
  };
};

// ============================================================
// Installed Apps (desktop-style grid on dashboard home)
// ============================================================

interface AppInfo {
  id: string;
  name: string;
  url: string | null;
  icon: string;
  status: "up" | "down";
}

export const getInstalledApps: GetInstalledApps<void, any> = async (
  _args: unknown,
  context: any,
): Promise<{ apps: AppInfo[] }> => {
  const instance = await getUserInstance(context);
  const raw: any = await proxyToTenant(instance, { path: "/api/v1/apps" });
  const apps = Array.isArray(raw?.apps) ? (raw.apps as AppInfo[]) : [];
  return { apps };
};

// ============================================================
// Claude Setup — connector URLs + approval secret + skill links
// ============================================================
export const getClaudeSetup: GetClaudeSetup<void, any> = async (
  _args: unknown,
  context: any,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { path: "/api/v1/claude-setup" });
};

// ============================================================
// Inbox
// ============================================================
export const getInboxItems: GetInboxItems<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { path: "/api/v1/vault/inbox" });
};

export const submitInboxItem: SubmitInboxItem<
  { title: string; content: string; type?: string; filename?: string; encoding?: string },
  any
> = async (args, context) => {
  // Validate the payload up front. A raw-file submit needs filename +
  // content; a text-note submit dereferences args.title. Without these
  // guards a malformed call threw (e.g. args.title.replace on undefined)
  // and surfaced as an HTTP 500 instead of a clean 400.
  if (args?.filename) {
    if (typeof args.content !== "string") {
      throw new HttpError(400, "content required for a file upload");
    }
  } else if (typeof args?.title !== "string" || args.title.trim() === "") {
    throw new HttpError(400, "title required");
  }

  const instance = await getUserInstance(context);

  // Raw file upload mode — preserve original filename and content as-is
  if (args.filename) {
    return proxyToTenant(instance, {
      method: "POST",
      path: "/api/v1/vault/inbox",
      body: {
        filename: args.filename,
        content: args.content,
        ...(args.encoding ? { encoding: args.encoding } : {}),
      },
      timeoutMs: 60_000,
    });
  }

  // Text note mode — wrap in markdown
  const filename = args.title.replace(/[\/\\:*?"<>|]/g, "_").replace(/\s+/g, "-") + ".md";
  const body = args.content
    ? `# ${args.title}\n\n${args.content}`
    : `# ${args.title}`;
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/vault/inbox",
    body: {
      filename,
      content: body,
    },
  });
};

// ============================================================
// Vault Browser
// ============================================================
export const getVaultRecords: GetVaultRecords<
  { type?: string; query?: string },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);

  if (args.query) {
    return proxyToTenant(instance, {
      path: "/api/v1/vault/search",
      query: { grep: args.query },
    });
  }

  if (args.type) {
    // Inbox is a special folder backed by /api/v1/vault/inbox instead of /list
    if (args.type === "inbox") {
      const inboxData: any = await proxyToTenant(instance, {
        path: "/api/v1/vault/inbox",
      });
      const files: string[] = Array.isArray(inboxData?.files)
        ? inboxData.files.filter((f: string) => f !== "processed")
        : [];
      return {
        results: files.map((f: string) => ({
          name: f.replace(/\.md$/, "").replace(/[-_]/g, " "),
          path: `inbox/${f}`,
          type: "inbox",
        })),
        count: files.length,
      };
    }

    const data: any = await proxyToTenant(instance, {
      path: `/api/v1/vault/list/${args.type}`,
    });
    // vault list results don't include 'type' — inject it from the request
    if (data && Array.isArray(data.results)) {
      data.results = data.results.map((r: any) => ({ ...r, type: args.type }));
    }
    return data;
  }

  return proxyToTenant(instance, { path: "/api/v1/vault/context" });
};

export const getVaultRecord: GetVaultRecord<{ path: string }, any> = async (
  args,
  context,
) => {
  // Validate path to prevent directory traversal
  if (!args.path) {
    throw new HttpError(400, "Record path is required");
  }
  const normalized = args.path.replace(/\\/g, "/");
  if (
    normalized.includes("..") ||
    normalized.startsWith("/") ||
    normalized.includes("\0")
  ) {
    throw new HttpError(400, "Invalid record path");
  }

  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    path: `/api/v1/vault/records/${encodeURIComponent(args.path)}`,
  });
};

// ============================================================
// Vault Graph (3D knowledge graph)
// ============================================================
// F55 — accept an optional `focus` (a vault record path). When present we
// forward it as the `?focus=` query param so ctrl-api returns the C19 backlink
// contract ({nodes, edges, activity, backlinks:[{path,name,rel}]}) for that
// record. The arg is optional, so existing call sites that pass nothing (e.g.
// VaultPage, which derives backlinks from edges client-side) keep working.
export const getVaultGraph: GetVaultGraph<{ focus?: string } | void, any> = async (
  args,
  context,
) => {
  const instance = await getUserInstance(context);
  const focus = (args as { focus?: string } | undefined)?.focus;
  return proxyToTenant(instance, {
    path: "/api/v1/vault/graph",
    ...(focus ? { query: { focus } } : {}),
  });
};

// ============================================================
// Vault Nebula (cluster + wikilink visualization)
// ============================================================
export const getNebulaData: GetNebulaData<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "GET",
    path: "/api/v1/vault/nebula-data",
    timeoutMs: 30_000,
  });
};

// ============================================================
// AI Assistants (Workers)
// ============================================================
export const getWorkerStatus: GetWorkerStatus<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);
  const [containers, health] = await Promise.all([
    proxyToTenant(instance, { path: "/api/v1/admin/containers" }),
    proxyToTenant(instance, { path: "/api/v1/admin/health" }),
  ]);
  return { containers, health };
};

export const triggerWorker: TriggerWorker<
  { action: string; service?: string },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);

  switch (args.action) {
    case "restart":
      return proxyToTenant(instance, {
        method: "POST",
        path: `/api/v1/admin/containers/${args.service || "alfred"}/restart`,
      });
    case "stop":
      return proxyToTenant(instance, {
        method: "POST",
        path: `/api/v1/admin/containers/${args.service || "alfred"}/stop`,
      });
    case "start":
      return proxyToTenant(instance, {
        method: "POST",
        path: `/api/v1/admin/containers/${args.service || "alfred"}/start`,
      });
    default:
      throw new HttpError(400, `Unknown action: ${args.action}`);
  }
};

// ============================================================
// DM pairing (Hermes-native — issue #42)
// ============================================================
// The old per-device-token surface (reject / remove / rotate) was an
// OpenClaw-era reinvention with no Hermes equivalent. Hermes pairs a
// messaging account by a one-hour pairing code. `getDevices` returns the
// raw `hermes pairing list` text ({ raw }); `approveDevice` / `revokeDevice`
// proxy the native `pairing approve|revoke` CLI.

export const getDevices: GetDevices<void, any> = async (_args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { path: "/api/v1/devices" });
};

export const approveDevice: ApproveDevice<
  { platform: string; code: string },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/devices/approve`,
    body: { platform: args.platform, code: args.code },
  });
};

export const revokeDevice: RevokeDevice<
  { platform: string; userId: string },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/devices/revoke`,
    body: { platform: args.platform, userId: args.userId },
  });
};

// ============================================================
// Activity Feed
// ============================================================
export const getActivityFeed: GetActivityFeed<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    path: "/api/v1/admin/activity",
    query: { limit: "50" },
  });
};

// Audit feed — F53/C12: reads the single state.db SQL ledger via
// GET /api/v1/admin/audit (one row per user action, not the legacy
// needs_attention_action + desk-action event-file twin). `includeAutomated`
// maps to ?include_automated=1 so the UI can surface steward/auto noise.
// Distinct from getActivityFeed, which scrapes the alfred container's logs.
export const getAuditFeed: GetAuditFeed<
  { includeAutomated?: boolean } | void,
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  const query: Record<string, string> = { limit: "50" };
  if (args && typeof args === "object" && args.includeAutomated) {
    query.include_automated = "1";
  }
  return proxyToTenant(instance, {
    path: "/api/v1/admin/audit",
    query,
  });
};

// ============================================================
// Container Logs
// ============================================================
export const getContainerLogs: GetContainerLogs<
  { service?: string; tail?: string },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  const service = args.service || "alfred";
  const tail = args.tail || "200";
  return proxyToTenant(instance, {
    path: `/api/v1/admin/containers/${service}/logs`,
    query: { tail },
  });
};

// ============================================================
// Credentials
// ============================================================
export const getCredentials: GetCredentials<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { path: "/api/v1/admin/credentials" });
};

export const updateCredentials: UpdateCredentials<
  Record<string, string | null>,
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PATCH",
    path: "/api/v1/admin/credentials",
    body: args,
  });
};

// ============================================================
// Vexa auto-join toggle
// ============================================================
// Bridges the Settings UI's switch to ctrl-api's vexa.ts route. Returns
// `{enabled, schedule_paused}`. The two values can disagree briefly
// while the toggle is mid-flight; the UI should treat `enabled` as
// authoritative and use `schedule_paused` only as a "did the temporal
// pause/unpause actually land" indicator.
export const getVexaAutoJoin: any = async (
  _args: void,
  context: any,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { path: "/api/v1/admin/vexa/auto-join" });
};

export const setVexaAutoJoin: any = async (
  args: { enabled: boolean },
  context: any,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/admin/vexa/auto-join",
    body: { enabled: args.enabled },
  });
};

// ============================================================
// Signal action mode — live / shadow toggle (Gap 3b)
// ============================================================
// Bridges the /study#settings "Agent autonomy" toggle to ctrl-api's
// settings/signal-action-mode route. Returns
//   { mode: "live"|"shadow", source: "default"|"settings_file"|"env_override",
//     env_override_active: boolean }
// — env var still wins for emergencies, so when env_override_active=true the
// UI disables the toggle (a flip would silently no-op until the env is unset).
export const getSignalActionMode: any = async (
  _args: void,
  context: any,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    path: "/api/v1/settings/signal-action-mode",
  });
};

export const setSignalActionMode: any = async (
  args: { mode: "live" | "shadow" },
  context: any,
) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PUT",
    path: "/api/v1/settings/signal-action-mode",
    body: { mode: args.mode },
  });
};

// ============================================================
// Agent autonomy — unified three-key settings (sir-matter-task #6)
// ============================================================
// Bridges the /study#settings "Agent autonomy" page to Lane I's unified
// settings endpoint. Replaces the per-key getSignalActionMode for the
// page load (one round-trip, three knobs) and adds a uniform PUT for
// the per-toggle flip.
//
// GET /api/v1/settings →
//   { settings: { signal_action_mode: {mode,source,env_override_active},
//                 state_mutator_mode:  {...},
//                 auto_task_create_mode: {...} } }
//
// PUT /api/v1/settings/:key body { mode: "live"|"shadow" } → updated row.
//
// The single-key getSignalActionMode/setSignalActionMode endpoints stay
// shipped (Lane I keeps them as backwards-compat) — they remain exported
// here for any other caller that wants just the one knob, but new code
// should use the unified pair below.
export const getAgentSettings: any = async (_args: void, context: any) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, { path: "/api/v1/settings" });
};

// `key` is a string at the wire so the SaaS proxy doesn't have to update
// every time Lane I adds another autonomy knob — validation of "is this
// a known key" lives in ctrl-api, and the UI side only ever sends one
// of the three keys it has descriptors for.
export const setAgentSetting: any = async (
  args: { key: string; mode: "live" | "shadow" },
  context: any,
) => {
  const instance = await getUserInstance(context);
  // Encode the key for the URL — these are well-known
  // `signal_action_mode`-style identifiers but the path can convert
  // underscores to hyphens transparently if the backend prefers either.
  // We pass the key verbatim and let ctrl-api accept the canonical form.
  return proxyToTenant(instance, {
    method: "PUT",
    path: `/api/v1/settings/${encodeURIComponent(args.key)}`,
    body: { mode: args.mode },
  });
};

// ============================================================
// Agent Config
// ============================================================
export const getModelCatalog: GetModelCatalog<
  { refresh?: boolean } | void,
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  const refresh = (args as any)?.refresh ? "true" : "false";
  return proxyToTenant(instance, {
    path: "/api/v1/admin/models",
    query: { refresh },
    timeoutMs: 30_000, // model fetching can be slow (multiple provider APIs)
  });
};

export const getAgentConfig: GetAgentConfig<
  { agentId?: string } | void,
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  const agentId = (args as any)?.agentId;
  const path = agentId
    ? `/api/v1/admin/agents/${encodeURIComponent(agentId)}`
    : "/api/v1/admin/agents";
  return proxyToTenant(instance, { path });
};

export const updateAgentConfig: UpdateAgentConfig<
  Record<string, any>,
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PATCH",
    path: "/api/v1/admin/agents",
    body: args,
  });
};

// ============================================================
// Agent Model (per-agent)
// ============================================================
export const updateAgentModel: UpdateAgentModel<
  { agentId: string; model: string; field?: string },
  any
> = async (args, context) => {
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PATCH",
    path: `/api/v1/admin/agents/${encodeURIComponent(args.agentId)}/model`,
    body: { model: args.model, field: args.field },
  });
};

// ============================================================
// Workspace Files
// ============================================================
const WORKSPACE_FILES = [
  "SOUL.md",
  "USER.md",
  "MEMORY.md",
  "AGENTS.md",
  "TOOLS.md",
  // M2-D #854 — household editor + M6 #867 standing-rules editor in /study.
  "RULES.md",
];

export const getWorkspaceFile: GetWorkspaceFile<
  { filename: string },
  any
> = async (args, context) => {
  if (!WORKSPACE_FILES.includes(args.filename)) {
    throw new HttpError(400, `Invalid workspace file: ${args.filename}`);
  }
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    path: `/api/v1/admin/workspace/${encodeURIComponent(args.filename)}`,
  });
};

export const updateWorkspaceFile: UpdateWorkspaceFile<
  { filename: string; content: string },
  any
> = async (args, context) => {
  if (!WORKSPACE_FILES.includes(args.filename)) {
    throw new HttpError(400, `Invalid workspace file: ${args.filename}`);
  }
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PUT",
    path: `/api/v1/admin/workspace/${encodeURIComponent(args.filename)}`,
    body: { content: args.content },
  });
};

// ============================================================
// First Brief (Onboarding Brief)
// ============================================================

export const getFirstBrief: GetFirstBrief<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);

  // Search for the onboarding First Brief. The onboarding pipeline writes
  // it as a `briefing` record (a canonical vault type) — it used to be
  // written as `event`, which the promotion contract rejects (#75). List
  // `briefing` records and pick the onboarding First Brief by name.
  try {
    const data: any = await proxyToTenant(instance, {
      path: "/api/v1/vault/list/briefing",
    });

    if (data && Array.isArray(data.results)) {
      // Look for the onboarding brief — it has "first-brief" or "onboarding" in its name
      const briefRecord = data.results.find(
        (r: any) =>
          r.name?.toLowerCase().includes("first-brief") ||
          r.name?.toLowerCase().includes("first brief") ||
          r.name?.toLowerCase().includes("onboarding-brief") ||
          r.path?.toLowerCase().includes("first-brief") ||
          r.path?.toLowerCase().includes("first brief"),
      );

      if (briefRecord) {
        // Fetch the full content
        const fullRecord: any = await proxyToTenant(instance, {
          path: `/api/v1/vault/records/${encodeURIComponent(briefRecord.path || `briefing/${briefRecord.name}`)}`,
        });

        return {
          brief: fullRecord?.content ?? fullRecord?.body ?? null,
          path: briefRecord.path || `briefing/${briefRecord.name}`,
          name: briefRecord.name,
        };
      }
    }
  } catch (e) {
    // Vault may not be available yet — return empty
    console.error("Failed to fetch first brief:", e);
  }

  return { brief: null, path: null, name: null };
};

export const startOnboarding: StartOnboarding<
  { streamId?: string },
  any
> = async (_args, context) => {
  if (!context.user) throw new HttpError(401);
  const instance = await getUserInstance(context);
  const userId = context.user.id;

  // ─────────────────────────────────────────────────────────────────────
  // Composio-managed Gmail onboarding (#69, P2). Resolve the Gmail mode
  // server-side, exactly once, here at workflow start — never inside the
  // Temporal workflow (env reads inside a workflow break replay
  // determinism). The resolved mode is stamped into OnboardingInput (via
  // ctrl-api's onboarding/start body) so P3's learn pipeline branches on a
  // field decided once, here.
  //
  //   composio — gate on an ACTIVE `gmail` Composio connection; the stream
  //              is a Composio-archetype stream (composio_action
  //              GMAIL_FETCH_EMAILS), no Wasp OAuthCredential involved.
  //   google   — gate on a `google` OAuthCredential (the legacy path,
  //              unchanged); the stream is a direct Gmail-API HTTP pull.
  //   none     — neither COMPOSIO_API_KEY nor GOOGLE_CLIENT_* configured;
  //              onboarding's Gmail step genuinely cannot run.
  // ─────────────────────────────────────────────────────────────────────
  const gmailMode = resolveOnboardingGmailMode();

  if (gmailMode === "none") {
    // No auth path is configured — fail fast rather than starting a
    // pipeline that can never fetch email and will stall.
    throw new HttpError(
      412,
      "Gmail onboarding is not configured on this deployment — set COMPOSIO_API_KEY (recommended) or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET.",
    );
  }

  if (gmailMode === "composio") {
    // Gate on the Composio Gmail connection — re-run the same check the
    // getGmailConnectionStatus query uses (shared helper), server-side, so
    // a client that calls startOnboarding without a real ACTIVE
    // connection is rejected here rather than starting a stalling pipeline.
    let gmailConn: { connected: boolean; status: string | null };
    try {
      gmailConn = await checkGmailConnection(instance);
    } catch (e: any) {
      throw new HttpError(
        502,
        `Could not verify the Gmail connection with the tenant: ${e?.message ?? String(e)}`,
      );
    }
    if (!gmailConn.connected) {
      throw new HttpError(
        412,
        gmailConn.status
          ? `The Gmail connection is not active (status: ${gmailConn.status}). Finish connecting Gmail before starting onboarding.`
          : "No Gmail connection found. Connect Gmail before starting onboarding.",
      );
    }
  }

  // Track per-step outcomes so the dashboard can see which sub-steps
  // failed even if startOnboarding returns successfully overall (the
  // function intentionally returns "started" once the SaaS-side stream
  // exists, because the tenant-side reconcile is best-effort: a flaky
  // tunnel shouldn't block the user from progressing).
  const stepResults: Record<string, { ok: boolean; error?: string }> = {};
  const recordStep = (name: string, ok: boolean, error?: string) => {
    stepResults[name] = error ? { ok, error } : { ok };
    if (!ok) {
      console.error(`[startOnboarding] step=${name} failed: ${error}`);
    }
  };

  // Step 1: SaaS-DB Stream row (lazy-create on first call, idempotent).
  let gmailStream = await context.entities.Stream.findFirst({
    where: { userId, source: "gmail" },
  });

  // The SaaS-DB Stream `config` blob — mode-specific. For `google` it is
  // the legacy direct Gmail-API HTTP-pull config (unchanged). For
  // `composio` it is a Composio-archetype config carrying
  // composio_action="GMAIL_FETCH_EMAILS" with the verbose:false fetch
  // intent — Composio holds the token, so there is no oauth2 auth block.
  // This blob is mirrored to the tenant by the Step 3 PATCH below.
  const streamConfig =
    gmailMode === "composio"
      ? {
          transport: "composio",
          parser: "composio",
          // P3's learn pipeline reads composio_action off the stream row
          // to drive the Composio fetch path. verbose:false keeps the
          // GMAIL_FETCH_EMAILS payload small enough to paginate a backfill.
          composio: {
            action: "GMAIL_FETCH_EMAILS",
            toolkit: "gmail",
            args: { userId: "me", verbose: false, max_results: 500 },
          },
        }
      : {
          transport: "pull",
          parser: "gmail",
          pull: {
            endpoint:
              "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10",
            method: "GET",
            intervalSeconds: 300,
            detailEndpoint:
              "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full",
            detailIdField: "messages[*].id",
          },
        };

  if (!gmailStream) {
    // Step 1a: in `google` mode we need a Google OAuthCredential to even
    // attempt the rest. In `composio` mode the equivalent gate — an
    // ACTIVE `gmail` Composio connection — already ran up-front (above);
    // the token lives in Composio's backend, no OAuthCredential exists.
    if (gmailMode === "google") {
      const credential = await context.entities.OAuthCredential.findFirst({
        where: { userId, provider: "google" },
      });
      if (!credential) {
        return { status: "no_credential", message: "No Google credential found" };
      }
    }

    // Step 1b: Create the SaaS-DB Stream row. The tenant-side reconcile
    // below ALWAYS runs, regardless of whether we just created the row
    // or it pre-existed — that's the fix for the silent-fail bug where
    // a partial first run left the SaaS row but never finished tenant
    // setup, blocking every subsequent call from re-trying.
    const crypto = await import("crypto");
    gmailStream = await context.entities.Stream.create({
      data: {
        userId,
        name: "Gmail",
        type: "scheduled",
        source: "gmail",
        config: streamConfig,
        webhookToken: crypto.randomBytes(24).toString("hex"),
      },
    });
    recordStep("saas_stream_created", true);
  } else {
    recordStep("saas_stream_existing", true);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Tenant-side reconcile — ALWAYS runs, regardless of whether SaaS row
  // existed before this call. Each step is idempotent server-side, and
  // a failure in one doesn't block the rest. Surfaced via `stepResults`
  // so the dashboard can show meaningful diagnostics if onboarding stalls.
  //
  // Surfaced 2026-05-08 on daveszab: prior version of this function
  // gated steps 2-5 below on `if (!gmailStream)`. When step 2 succeeded
  // but step 3 (PATCH config) and step 4 (POST schedule) failed silently
  // on the very first call, every subsequent call hit the existing
  // SaaS-DB row and skipped the entire reconcile — leaving the tenant
  // permanently stuck with an idle stream and no puller schedule.
  // ─────────────────────────────────────────────────────────────────────

  // Step 2: Ensure stream record exists on tenant (POST /api/v1/streams
  // is idempotent — re-posting the same id is a no-op).
  try {
    await proxyToTenant(instance, {
      method: "POST",
      path: "/api/v1/streams",
      body: {
        id: gmailStream.id,
        name: "Gmail",
        type: "scheduled",
        source: "gmail",
        config: gmailStream.config,
        enabled: true,
      },
    });
    recordStep("tenant_stream_post", true);
  } catch (e: any) {
    recordStep("tenant_stream_post", false, e?.message ?? String(e));
  }

  // Step 3: Patch the tenant stream config (the critical step that was
  // silently failing). PATCH is idempotent. The body is mode-specific:
  //
  //   google   — direct Gmail-API HTTP-pull config + an oauth2 auth_config.
  //              user_id MUST be the SaaS User.id — alfred-learn's
  //              resolve_auth_header activity calls back to
  //              /api/internal/oauth2/token with that exact id to fetch a
  //              fresh access token from the encrypted refresh token in
  //              the SaaS DB. UNCHANGED from the pre-#69 behaviour.
  //   composio — a Composio-archetype config: composio_action
  //              "GMAIL_FETCH_EMAILS" (+ composio_toolkit / composio_args
  //              with the verbose:false fetch intent). No auth_type /
  //              auth_config — Composio holds the token. This is the
  //              stream-row contract P3's learn pipeline reads to drive
  //              the Composio fetch path.
  const streamPatchBody: Record<string, unknown> =
    gmailMode === "composio"
      ? {
          type: "composio",
          parser: "composio",
          // P3 contract — the onboarding stream row carries the Composio
          // action + toolkit + args. `verbose:false` keeps the
          // GMAIL_FETCH_EMAILS payload small enough for a paginated
          // backfill (per the scope doc).
          composio_action: "GMAIL_FETCH_EMAILS",
          composio_toolkit: "gmail",
          composio_args: { userId: "me", verbose: false, max_results: 500 },
          schedule_interval_seconds: 300,
        }
      : {
          pull_endpoint:
            "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10",
          pull_method: "GET",
          detail_endpoint:
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full",
          detail_id_field: "id",
          parser: "gmail",
          auth_type: "oauth2",
          auth_config: { provider: "google", user_id: userId },
          schedule_interval_seconds: 300,
        };
  try {
    await proxyToTenant(instance, {
      method: "PATCH",
      path: `/api/v1/streams/${gmailStream.id}`,
      body: streamPatchBody,
    });
    recordStep("tenant_stream_patch", true);
  } catch (e: any) {
    recordStep("tenant_stream_patch", false, e?.message ?? String(e));
  }

  // Step 4: (#53) No per-stream Temporal schedule is created. The
  // gmail stream config written in step 3 carries
  // schedule_interval_seconds=300; the tenant's single al-stream-sweep
  // schedule (StreamSweepWorkflow, registered once by alfred-learn,
  // 2-min interval) reads every stream config on each tick and pulls
  // any stream whose interval has elapsed. There used to be a
  // dedicated `al-stream-pull-gmail` schedule here.
  recordStep("tenant_schedule_post", true, "stream-sweep (no per-stream schedule, #53)");

  // Step 5: Kick an immediate first pull so the user sees fresh data
  // without waiting up to 2 min for the next al-stream-sweep tick.
  // We start a one-off StreamPullerWorkflow run (the per-stream
  // workflow is kept registered as an ad-hoc-callable tombstone in
  // #53). Best-effort — failures are non-blocking because the sweep
  // will pull the stream on its own within ~2 min.
  try {
    await proxyToTenant(instance, {
      method: "POST",
      path: "/api/v1/workflows",
      body: {
        workflow_type: "StreamPullerWorkflow",
        task_queue: "alfred-learn",
        input: { stream_id: gmailStream.id },
      },
    });
    recordStep("tenant_schedule_trigger", true);
  } catch (e: any) {
    recordStep("tenant_schedule_trigger", false, e?.message ?? String(e));
  }

  // Step 6: Trigger the onboarding workflow ONLY if not already running.
  // Skip if the tenant reports an in-flight stage already.
  try {
    const progress = await proxyToTenant(instance, {
      path: "/api/v1/onboarding/progress",
    });
    const stage = progress?.stage;
    if (stage && stage !== "not_started" && stage !== "unknown") {
      console.info(
        `[startOnboarding] Onboarding already at stage=${stage}, skipping workflow trigger`,
      );
      return {
        status: "already_running",
        stage,
        streamId: gmailStream.id,
        steps: stepResults,
      };
    }
  } catch {
    // Progress endpoint not available — proceed with trigger
  }

  try {
    await proxyToTenant(instance, {
      method: "POST",
      path: "/api/v1/workflows/onboarding/start",
      // `gmail_mode` is the P2→P3 workflow-start contract. ctrl-api
      // forwards it into OnboardingInput so P3's OnboardingPipelineWorkflow
      // branches on a value resolved once here (replay-safe — the workflow
      // must never read env itself). `composio_action` is carried for the
      // Composio path so the learn pipeline knows the exact Composio fetch
      // action without re-reading the stream row.
      body: {
        user_id: userId,
        stream_id: gmailStream.id,
        gmail_mode: gmailMode,
        ...(gmailMode === "composio"
          ? { composio_action: "GMAIL_FETCH_EMAILS" }
          : {}),
      },
      timeoutMs: 30_000,
    });
    recordStep("onboarding_workflow_start", true);
  } catch (e: any) {
    recordStep("onboarding_workflow_start", false, e?.message ?? String(e));
  }

  return {
    status: "started",
    streamId: gmailStream.id,
    gmailMode,
    steps: stepResults,
  };
};

// ============================================================
// Onboarding Progress (v2)
// ============================================================

export const getOnboardingProgress: GetOnboardingProgress<void, any> = async (
  _args,
  context,
) => {
  const instance = await getUserInstance(context);

  try {
    return await proxyToTenant(instance, {
      path: "/api/v1/onboarding/progress",
    });
  } catch (e) {
    console.error("Failed to fetch onboarding progress:", e);
    // A proxy/transport error must NOT read as "not_started" — that bounced an
    // already-onboarded principal back to the Start-onboarding CTA on a transient
    // ctrl-api hiccup (FAILURE-MODES web bug #4). Return a distinct sentinel the
    // gate treats as indeterminate (keep the Desk); the 5s poll retries.
    return {
      stage: "fetch_error",
      progress: { current_day: 0, total_days: 0, facts_count: 0, patterns_count: 0 },
      facts_count: 0,
      patterns_count: 0,
      automations_count: 0,
      brief: "",
    };
  }
};

// ============================================================
// Onboarding Gmail mode (#67 — Composio-managed Gmail onboarding, P0)
// ============================================================
//
// Server-readable signal telling the client which OAuth path onboarding's
// "connect Gmail" step uses. Flag only — no behaviour change in P0.
//
// A dedicated query (rather than folding the field into
// getOnboardingProgress) is the cleaner option here: the mode is derived
// purely from server env, so it needs no tenant round-trip and no
// entities, and it must not be lost when getOnboardingProgress falls back
// to its tenant-unreachable default. P1's DeskOnboardingGate reads this to
// pick the right CTA; startOnboarding computes the same value directly via
// resolveOnboardingGmailMode() (no query) when it later stamps the mode
// into OnboardingInput.

export const getOnboardingGmailMode: GetOnboardingGmailMode<
  void,
  { mode: OnboardingGmailMode }
> = async (_args, context) => {
  if (!context.user) throw new HttpError(401);
  return { mode: resolveOnboardingGmailMode() };
};

// ============================================================
// Phase 6 — NeedsAttention surface (#160)
// ============================================================
//
// All four endpoints proxy to ctrl-api /api/v1/admin/needs-attention*
// (see packages/ctrl/src/api/routes/attention.ts). The list endpoint
// must degrade gracefully — older tenants don't have the route yet,
// so we silently return an empty list on any failure.

export const getNeedsAttention = async (
  _args: void,
  context: any,
): Promise<{ records: any[]; count: number }> => {
  try {
    const instance = await getUserInstance(context);
    const data: any = await proxyToTenant(instance, {
      path: "/api/v1/admin/needs-attention",
    });
    return {
      records: Array.isArray(data?.records) ? data.records : [],
      count: Number(data?.count ?? 0),
    };
  } catch {
    // Tenants without the route (older ctrl-api), unreachable, etc.
    // The dashboard should still render — just hide the card.
    return { records: [], count: 0 };
  }
};

export const resolveNeedsAttentionDone = async (
  args: { id: string; note?: string },
  context: any,
): Promise<any> => {
  if (!args?.id) throw new HttpError(400, "id required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/admin/needs-attention/${encodeURIComponent(args.id)}/done`,
    body: { note: args.note ?? "" },
  });
};

export const resolveNeedsAttentionDispatch = async (
  args: { id: string; note?: string },
  context: any,
): Promise<any> => {
  if (!args?.id) throw new HttpError(400, "id required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/admin/needs-attention/${encodeURIComponent(args.id)}/dispatch`,
    body: { note: args.note ?? "" },
  });
};

export const resolveNeedsAttentionSkip = async (
  args: { id: string; note?: string },
  context: any,
): Promise<any> => {
  if (!args?.id) throw new HttpError(400, "id required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/admin/needs-attention/${encodeURIComponent(args.id)}/skip`,
    body: { note: args.note ?? "" },
  });
};

// Every Desk-card click writes an audit event regardless of source.
// The per-source endpoints (resolveNeedsAttentionDispatch etc., or the
// approvals endpoints) still mutate the underlying record; this is
// additive and guarantees the action lands in the activity ledger.
// "Do" is the only action with no per-source endpoint — this becomes
// its only server call.
export const recordDeskAction = async (
  args: {
    source: "needs_attention" | "approval" | "judgment" | "pattern_proposal";
    sourceId: string;
    action: "delegate" | "defer" | "delete" | "do" | "noise";
    note?: string;
  },
  context: any,
): Promise<any> => {
  if (!args?.source) throw new HttpError(400, "source required");
  if (!args?.sourceId) throw new HttpError(400, "sourceId required");
  if (!args?.action) throw new HttpError(400, "action required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/admin/desk-action",
    body: {
      source: args.source,
      source_id: args.sourceId,
      action: args.action,
      note: args.note ?? "",
    },
  });
};

// ============================================================
// Decisions — first-class records of every Desk click.
// ============================================================
//
// recordDecision writes a decision/<ts>.md record. The
// DecisionRouterWorkflow on alfred-learn picks it up within ~60s and
// fans out the side effects (status flips, signal re-arm, to_do spawn).
// Every click on the Desk now goes through this; the older
// recordDeskAction remains as a parallel audit format for backwards
// compat with the /decisions page.

export const recordDecision = async (
  args: {
    source:
      | "needs_attention"
      | "approval"
      | "judgment"
      | "to_do"
      | "desk_originated"
      | "pattern_proposal";
    sourceRecord: string;
    intent: "delegate" | "defer" | "done" | "take_mine" | "noise";
    note?: string;
    matterRef?: string;
    taskRef?: string;
    sourceHeadline?: string;
    timeToDecisionMs?: number;
  },
  context: any,
): Promise<any> => {
  if (!args?.source) throw new HttpError(400, "source required");
  if (!args?.sourceRecord) throw new HttpError(400, "sourceRecord required");
  if (!args?.intent) throw new HttpError(400, "intent required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/decisions",
    body: {
      source: args.source,
      source_record: args.sourceRecord,
      intent: args.intent,
      note: args.note ?? "",
      matter_ref: args.matterRef ?? "",
      task_ref: args.taskRef ?? "",
      source_headline: args.sourceHeadline ?? "",
      time_to_decision_ms: args.timeToDecisionMs ?? null,
    },
  });
};

export const getRecentDecisions = async (
  args: { state?: string; source?: string; limit?: number } | void,
  context: any,
): Promise<any> => {
  const instance = await getUserInstance(context);
  const query: Record<string, string> = {};
  if (args && typeof args === "object") {
    if (args.state) query.state = args.state;
    if (args.source) query.source = args.source;
    if (typeof args.limit === "number") query.limit = String(args.limit);
  }
  try {
    return await proxyToTenant(instance, {
      method: "GET",
      path: "/api/v1/decisions",
      query: Object.keys(query).length ? query : undefined,
    });
  } catch {
    // Older ctrl-api without the route → empty list so the page renders.
    return { decisions: [], count: 0 };
  }
};

export const reverseDecision = async (
  args: { id: string },
  context: any,
): Promise<any> => {
  if (!args?.id) throw new HttpError(400, "id required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "POST",
    path: `/api/v1/decisions/${encodeURIComponent(args.id)}/reverse`,
  });
};

// ============================================================
// to_do — persistent personal queue (replaces the in-React Backstage).
// ============================================================

export const getMyTodos = async (
  args: { state?: string; limit?: number } | void,
  context: any,
): Promise<any> => {
  const instance = await getUserInstance(context);
  const query: Record<string, string> = {};
  if (args && typeof args === "object") {
    if (args.state) query.state = args.state;
    if (typeof args.limit === "number") query.limit = String(args.limit);
  }
  try {
    return await proxyToTenant(instance, {
      method: "GET",
      path: "/api/v1/todos",
      query: Object.keys(query).length ? query : undefined,
    });
  } catch {
    return { todos: [], count: 0 };
  }
};

export const completeMyTodo = async (
  args: { id: string },
  context: any,
): Promise<any> => {
  if (!args?.id) throw new HttpError(400, "id required");
  const instance = await getUserInstance(context);
  return proxyToTenant(instance, {
    method: "PATCH",
    path: `/api/v1/todos/${encodeURIComponent(args.id)}`,
    body: { state: "completed" },
  });
};

// In-flight decisions — the live activity feed. Returns decisions
// whose work hasn't fully settled yet (state=open / scheduled /
// executing). The Desk strip polls this every ~10s so the principal
// can watch Alfred work through a batch they just delegated.
export const getInFlightDecisions = async (
  args: { limit?: number } | void,
  context: any,
): Promise<any> => {
  const instance = await getUserInstance(context);
  const query: Record<string, string> = {};
  if (args && typeof args === "object" && typeof args.limit === "number") {
    query.limit = String(args.limit);
  }
  try {
    return await proxyToTenant(instance, {
      method: "GET",
      path: "/api/v1/decisions/in-flight",
      query: Object.keys(query).length ? query : undefined,
    });
  } catch {
    return { decisions: [], count: 0 };
  }
};

// Pattern proposals — proposed standing rules. The principal's
// Delegate click on one of these adopts it as an active instinct;
// Delete rejects it. Surfaced on /desk alongside needs_attention etc.
export const getPatternProposals = async (
  args: { limit?: number } | void,
  context: any,
): Promise<any> => {
  const instance = await getUserInstance(context);
  const query: Record<string, string> = {};
  if (args && typeof args === "object" && typeof args.limit === "number") {
    query.limit = String(args.limit);
  }
  try {
    return await proxyToTenant(instance, {
      method: "GET",
      path: "/api/v1/admin/pattern-proposals",
      query: Object.keys(query).length ? query : undefined,
    });
  } catch {
    return { proposals: [], count: 0 };
  }
};

// ============================================================
// Phase 6 — Steward feed (#160)
// ============================================================
//
// Pulls vault/event/ records and surfaces the Phase 6 audit
// prefixes (steward-action-, signal-action-, auto-task-created-,
// needs_attention_action-). The page does its own filtering — we
// just hand it the raw list. Returns {results: []} on failure so
// the page renders an empty feed without breaking the dashboard.

export const getStewardFeed = async (
  _args: void,
  context: any,
): Promise<{ results: any[]; count: number }> => {
  try {
    const instance = await getUserInstance(context);
    const data: any = await proxyToTenant(instance, {
      path: "/api/v1/vault/list/event",
      query: { preview: "300" },
    });
    return {
      results: Array.isArray(data?.results) ? data.results : [],
      count: Number(data?.count ?? 0),
    };
  } catch {
    return { results: [], count: 0 };
  }
};

// Submit fact corrections and trigger brief generation.
//
// The ctrl-api endpoint /api/v1/onboarding/corrections atomically:
//   (1) writes corrections to onboard.json,
//   (2) advances stage to "brief", and
//   (3) starts the brief-stage OnboardingPipelineWorkflow with the
//       FULL contract — workflow_id="onboarding-<user_id>-brief-<ts>",
//       gmail_mode + composio_action carried forward off onboard.json,
//       resume_stage="brief" (#74).
//
// We must NOT additionally spawn a workflow from here: doing so used to
// create a parallel "onboarding-brief-<ts>" workflow (no user_id prefix)
// with default gmail_mode="google" and no resume_stage, which then
// immediately failed on the legacy direct-Gmail fetch_email_metadata
// (no GOOGLE_CLIENT_* in alfred-black single-VM deploys). The ctrl-api
// call alone is the contract.
export const submitFactCorrections: any = async (
  args: { corrections: Record<string, string> },
  context: any,
) => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  const instance = await getUserInstance(context);

  // Write corrections to onboard.json AND start the brief workflow.
  await proxyToTenant(instance, {
    method: "POST",
    path: "/api/v1/onboarding/corrections",
    body: { corrections: args.corrections },
  });

  return { status: "brief_generating" };
};

// ============================================================
// Vault title-index (#873) — wraps GET /api/v1/vault/index on the
// tenant-side ctrl-api. Consumed by client/components/ab/Markdown.tsx
// for live wikilink resolution.
// ============================================================

// ============================================================
// Matters aggregator (#859) — GET /api/v1/matters[/:id] on tenant
// ctrl-api. The aggregator walks the vault once and surfaces a per-
// matter tally (counts of conversations/decisions/tasks/drafts) plus
// — for the detail endpoint — a recent-decisions list and a
// per-category vault link list. Both endpoints degrade to empty
// payloads on tenant errors so older ctrl-api builds don't break the
// page.
// ============================================================

export const getMattersIndex = async (
  _args: void,
  context: any,
): Promise<{
  matters: Array<{
    id: string;
    path: string;
    name: string;
    summary: string;
    last: string;
    next: string;
    counts: {
      conversations: number;
      decisions: number;
      tasks: number;
      drafts: number;
    };
  }>;
  count: number;
}> => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  const instance = await getUserInstance(context);
  // Prefer the rich /api/v1/matters aggregator if the tenant ctrl-api has it.
  try {
    const data: any = await proxyToTenant(instance, { path: "/api/v1/matters" });
    const matters = Array.isArray(data?.matters) ? data.matters : [];
    if (matters.length > 0 || data?.matters !== undefined) {
      return { matters, count: Number(data?.count ?? matters.length) };
    }
  } catch (err) {
    // 404 from older ctrl-api builds → fall through to vault list shim
    console.warn(
      "[getMattersIndex] /api/v1/matters not available, falling back to /vault/list/matter:",
      (err as Error)?.message,
    );
  }
  // Fallback: list raw matter/* records from the existing vault endpoint.
  // Counts are unknown (0) until the tenant runs a ctrl-api with the aggregator.
  try {
    const list: any = await proxyToTenant(instance, {
      path: "/api/v1/vault/list/matter",
    });
    const results: any[] = Array.isArray(list?.results) ? list.results : [];
    const matters = results.map((r) => {
      const fm = r?.frontmatter ?? {};
      const stem = String(r?.path ?? "").replace(/^matter\//, "").replace(/\.md$/, "");
      return {
        id: stem,
        path: r?.path ?? "",
        name: r?.name || stem,
        summary: String(fm.description ?? fm.summary ?? ""),
        last: String(fm.updated ?? fm.modified ?? fm.created ?? ""),
        next: String(fm.next ?? fm.next_action ?? ""),
        counts: { conversations: 0, decisions: 0, tasks: 0, drafts: 0 },
      };
    });
    return { matters, count: matters.length };
  } catch (err) {
    console.warn(
      "[getMattersIndex] vault/list/matter fallback failed:",
      (err as Error)?.message,
    );
    return { matters: [], count: 0 };
  }
};

// RFC #884 — Living narratives. matters and tasks gain `current_state`,
// `as_of` (last-rewrite ISO-8601 datetime), and matters also carry a
// `signal_count_24h` bookkeeping counter. The aggregator endpoint is the
// canonical source; the fallback path here maps frontmatter directly so the
// UI stays renderable against older ctrl-api builds that don't yet emit the
// new shape.
type TaskState = "pending" | "in_progress" | "done" | "archived";

interface MatterTimelineEntry {
  when: string;
  kind: "signal" | "task_transition" | "action";
  headline: string;
  path: string;
}

interface MatterTaskRow {
  id: string;
  name: string;
  state: TaskState;
  current_state: string | null;
  as_of: string | null;
}

function normalizeTaskState(value: unknown): TaskState {
  const s = String(value ?? "").toLowerCase();
  if (s === "in_progress" || s === "in-progress" || s === "active") return "in_progress";
  if (s === "done" || s === "complete" || s === "completed") return "done";
  if (s === "archived" || s === "cancelled" || s === "canceled") return "archived";
  return "pending";
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

export const getMatterDetail = async (
  args: { id: string },
  context: any,
): Promise<{
  matter: any | null;
}> => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  if (!args?.id) throw new HttpError(400, "id required");
  const instance = await getUserInstance(context);
  // Prefer the rich aggregator endpoint when available.
  try {
    const data: any = await proxyToTenant(instance, {
      path: `/api/v1/matters/${encodeURIComponent(args.id)}`,
    });
    if (data?.matter) {
      // Aggregator path: trust the server shape but defensively fill in the
      // RFC-884 fields if an older ctrl-api forgot them so the UI never sees
      // `undefined`.
      const m = data.matter;
      return {
        matter: {
          ...m,
          current_state:
            m.current_state === undefined ? null : m.current_state,
          as_of: m.as_of === undefined ? null : m.as_of,
          signal_count_24h:
            typeof m.signal_count_24h === "number" ? m.signal_count_24h : 0,
          timeline: Array.isArray(m.timeline) ? m.timeline : [],
          tasks: Array.isArray(m.tasks) ? m.tasks : [],
        },
      };
    }
  } catch (err) {
    console.warn(
      "[getMatterDetail] /api/v1/matters not available, falling back to /vault/record:",
      (err as Error)?.message,
    );
  }
  // Fallback: read the raw matter record + its backlinks via existing endpoints.
  try {
    const cleanId = String(args.id).replace(/^matter\//, "").replace(/\.md$/, "");
    const recordPath = `matter/${cleanId}.md`;
    const rec: any = await proxyToTenant(instance, {
      path: `/api/v1/vault/records/${encodeURIComponent(recordPath)}`,
    });
    if (!rec || (rec.error && !rec.body && !rec.frontmatter)) {
      return { matter: null };
    }
    const fm = rec.frontmatter ?? {};
    const body: string = String(rec.body ?? rec.content ?? "");
    // Strip the YAML frontmatter from the body if it's included
    const stripped = body.replace(/^---[\s\S]*?---\s*/, "").trim();
    // Extract the first H1 as the human name (records endpoint doesn't return name/title)
    const h1 = stripped.match(/^\s*#\s+(.+?)\s*$/m);
    const extractedName = h1 ? h1[1].trim() : "";
    // Drop the H1 line from the about body so the page doesn't show the title twice
    const about = h1 ? stripped.replace(h1[0], "").trim() : stripped;
    // Best-effort backlinks via the graph endpoint
    let backlinks: any[] = [];
    try {
      const graph: any = await proxyToTenant(instance, {
        path: `/api/v1/vault/graph?focus=${encodeURIComponent(recordPath)}`,
      });
      backlinks = Array.isArray(graph?.backlinks) ? graph.backlinks : [];
    } catch {
      /* ignore — graph is optional for fallback */
    }
    const bin = (type: string) =>
      backlinks
        .filter((b) => String(b?.type ?? b?.path ?? "").toLowerCase().includes(type))
        .map((b) => ({ title: b.title ?? b.name ?? b.path, path: b.path, date: b.updated ?? b.created ?? "" }));
    const conversations = bin("conversation");
    const decisions = bin("decision");
    const tasks = bin("task");
    const drafts = bin("draft");
    // RFC #884 fallback fields. Older ctrl-api builds won't have written
    // `current_state`/`as_of` into the matter frontmatter yet, so leave them
    // null and let the UI render an empty-state. `timeline` and `tasks` are
    // empty — the aggregator endpoint is the only place that joins those.
    const fallbackTimeline: MatterTimelineEntry[] = [];
    const fallbackTasks: MatterTaskRow[] = [];
    return {
      matter: {
        id: cleanId,
        path: recordPath,
        name: rec.name || fm.title || extractedName || cleanId,
        summary: String(fm.description ?? fm.summary ?? ""),
        last: String(fm.updated ?? fm.modified ?? fm.created ?? ""),
        next: String(fm.next ?? fm.next_action ?? ""),
        about,
        counts: {
          conversations: conversations.length,
          decisions: decisions.length,
          tasks: tasks.length,
          drafts: drafts.length,
        },
        recent_decisions: decisions.slice(0, 10).map((d: any) => ({
          date: d.date ?? "",
          label: d.title,
          outcome: "Handled",
          path: d.path,
        })),
        vault_by_category: { conversations, decisions, tasks, drafts },
        // Living narrative fields (RFC #884) — fallback maps directly off
        // raw frontmatter; absent values become null so the UI surfaces an
        // empty-state copy rather than crashing.
        current_state: nullableString(fm.current_state),
        as_of: nullableString(fm.as_of),
        signal_count_24h:
          typeof fm.signal_count_24h === "number" ? fm.signal_count_24h : 0,
        timeline: fallbackTimeline,
        tasks: fallbackTasks,
      },
    };
  } catch (err) {
    console.warn(
      "[getMatterDetail] vault/record fallback failed:",
      (err as Error)?.message,
    );
    return { matter: null };
  }
};

// RFC #884 — per-chore living-narrative detail. Separate from the existing
// `getChoreSource` so we don't disturb the M4 source-audit endpoint.
//
// The ctrl-api `/api/v1/chores/:slug` endpoint (cf20192) embeds the new
// RFC-884 `chore` block alongside the legacy `{slug, frontmatter, body}`
// payload, so we pull that and pass it through. Older ctrl-api builds that
// only return `frontmatter` are handled by mapping raw frontmatter; a final
// fallback reads the chore vault record directly.
//
// Return type is intentionally `any | null` to satisfy Wasp's SuperJSON
// serialisation constraint (which rejects strict interface types without an
// index signature) — the client narrows the shape locally.
export const getChoreDetail2 = async (
  args: { id: string },
  context: any,
): Promise<{ chore: any | null }> => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  if (!args?.id) throw new HttpError(400, "id required");
  const instance = await getUserInstance(context);
  const cleanId = String(args.id)
    .replace(/^chore\//, "")
    .replace(/^task\//, "")
    .replace(/\.md$/, "");
  // Try the chore detail endpoint — embeds RFC-884 fields when available.
  try {
    const data: any = await proxyToTenant(instance, {
      path: `/api/v1/chores/${encodeURIComponent(cleanId)}`,
    });
    if (data?.chore) {
      const c = data.chore;
      return {
        chore: {
          id: String(c.id ?? cleanId),
          path: String(c.path ?? `chore/${cleanId}.md`),
          name: String(c.name ?? cleanId),
          state: normalizeTaskState(c.state),
          current_state:
            c.current_state === undefined ? null : nullableString(c.current_state),
          as_of: c.as_of === undefined ? null : nullableString(c.as_of),
          timeline: Array.isArray(c.timeline) ? c.timeline : [],
        },
      };
    }
    // Older ctrl-api: only `frontmatter` is present, no `chore` block. Map
    // the raw frontmatter into the new shape so the UI degrades gracefully.
    if (data?.frontmatter) {
      const fm = data.frontmatter ?? {};
      return {
        chore: {
          id: cleanId,
          path: String(data.path ?? `chore/${cleanId}.md`),
          name: String(fm.name ?? data.slug ?? cleanId),
          state: normalizeTaskState(fm.state),
          current_state: nullableString(fm.current_state),
          as_of: nullableString(fm.as_of),
          timeline: [],
        },
      };
    }
  } catch (err) {
    console.warn(
      "[getChoreDetail2] /api/v1/chores/:slug not available, falling back to /vault/record:",
      (err as Error)?.message,
    );
  }
  // Final fallback: read the chore vault record directly. Tries `chore/`
  // first (spec-canonical location), then `task/` (legacy).
  for (const folder of ["chore", "task"]) {
    try {
      const recordPath = `${folder}/${cleanId}.md`;
      const rec: any = await proxyToTenant(instance, {
        path: `/api/v1/vault/records/${encodeURIComponent(recordPath)}`,
      });
      if (!rec || (rec.error && !rec.body && !rec.frontmatter)) continue;
      const fm = rec.frontmatter ?? {};
      const body: string = String(rec.body ?? rec.content ?? "");
      const stripped = body.replace(/^---[\s\S]*?---\s*/, "").trim();
      const h1 = stripped.match(/^\s*#\s+(.+?)\s*$/m);
      const extractedName = h1 ? h1[1].trim() : "";
      return {
        chore: {
          id: cleanId,
          path: recordPath,
          name: rec.name || fm.title || fm.name || extractedName || cleanId,
          state: normalizeTaskState(fm.state),
          current_state: nullableString(fm.current_state),
          as_of: nullableString(fm.as_of),
          timeline: [],
        },
      };
    } catch (err) {
      console.warn(
        `[getChoreDetail2] vault/${folder} fallback failed:`,
        (err as Error)?.message,
      );
    }
  }
  return { chore: null };
};

export const getVaultTitleIndex = async (
  _args: void,
  context: any,
): Promise<{ titles: Array<{ title: string; slug: string; type: string }> }> => {
  if (!context.user) throw new HttpError(401, "Not authenticated");
  try {
    const instance = await getUserInstance(context);
    const data: any = await proxyToTenant(instance, {
      path: "/api/v1/vault/index",
    });
    const titles = Array.isArray(data?.titles) ? data.titles : [];
    return { titles };
  } catch (err) {
    // Older ctrl-api builds may not have the route yet; degrade quietly so
    // the Markdown renderer simply doesn't get a resolver and falls back
    // to its existing "no-prop" behaviour. The caller is fine without it.
    console.warn(
      "[getVaultTitleIndex] proxyToTenant failed:",
      (err as Error)?.message,
    );
    return { titles: [] };
  }
};
