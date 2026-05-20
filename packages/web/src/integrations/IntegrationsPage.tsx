import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Navigate } from "react-router-dom";
import {
  useQuery,
  getIntegrationCatalog,
  getConnectedIntegrations,
  getIntegrationCapabilities,
  initiateConnect,
  initiateApiKeyConnect,
  disconnectIntegration,
  autoConfigIntegration,
  enableIntegrationStream,
  disableIntegrationStream,
  migrateIntegrationStream,
} from "wasp/client/operations";
import DashboardLayout from "../dashboard/DashboardLayout";
import SpotlightCard from "../components/ui/SpotlightCard";
import {
  Search,
  Puzzle,
  Loader2,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Unplug,
  Radio,
  Wrench,
  Check,
  RefreshCw,
  Zap,
  Settings2,
  AlertCircle,
  Key,
  X as XIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Toolkit {
  slug: string;
  name: string;
  description: string;
  icon_url: string;
  category: string;
  auth_schemes: string[];
}

interface ConnectedIntegration {
  id: string;
  toolkit: string;
  toolkit_name: string;
  toolkit_icon: string;
  status: string;               // Composio status: INITIATED|ACTIVE|INACTIVE|ORPHAN
  auth_scheme: string;
  created_at: string;
  // SaaS-side auto-config lifecycle (PR 1). "pending" for freshly-connected,
  // "running" while auto-config is in flight, "configured" once streams/tools
  // are live, "error" if auto-config failed. See ComposioConnection model.
  auto_config_state?: "pending" | "running" | "configured" | "error";
  auto_config_error?: string | null;
  auto_configured_at?: string | null;
  streams_created?: number;
  tools_enabled?: number;
  skill_name?: string | null;
}

interface StreamCapability {
  slug: string;
  display_name: string;
  description: string;
  deprecated: boolean;
  enabled: boolean;
  stream_id: string | null;
  schedule_interval_seconds: number | null;
  last_pull_at: string | null;
  last_pull_status: string | null;
  event_count: number;
  last_event_at: string | null;
}

interface ToolCapability {
  slug: string;
  display_name: string;
  description: string;
  deprecated: boolean;
}

interface StaleStream {
  stream_id: string;
  action: string;
  interval_seconds: number;
  last_pull_status: string | null;
  event_count: number;
  last_event_at: string | null;
  suggested_replacement: string | null;
}

interface Capabilities {
  connection_id: string;
  toolkit: string;
  toolkit_name: string;
  toolkit_icon: string | null;
  composio_execute_enabled: boolean;
  stream_actions: StreamCapability[];
  tool_actions: ToolCapability[];
  stale_streams: StaleStream[];
}

// ---------------------------------------------------------------------------
// Category config
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<string, string> = {
  all: "All",
  communication: "Communication",
  productivity: "Productivity",
  "dev-tools": "Dev Tools",
  finance: "Finance",
  calendar: "Calendar",
  storage: "Storage",
  crm: "CRM",
  database: "Database",
  ecommerce: "E-Commerce",
  social: "Social",
  support: "Support",
  other: "Other",
};

const INTERVAL_PRESETS: Array<{ seconds: number; label: string }> = [
  { seconds: 60, label: "1 min" },
  { seconds: 300, label: "5 min" },
  { seconds: 900, label: "15 min" },
  { seconds: 3600, label: "1 hour" },
  { seconds: 21600, label: "6 hours" },
];

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

// M5 #863 — /dashboard/integrations redirects to /connections. The legacy
// implementation is preserved as LegacyIntegrationsPage so cutover can be
// reverted with one line.
export default function IntegrationsPage() {
  return <Navigate to="/connections" replace />;
}

function LegacyIntegrationsPage() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [expandedConn, setExpandedConn] = useState<string | null>(null);
  const [connectingSlug, setConnectingSlug] = useState<string | null>(null);
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // API-key modal state: a non-null toolkit means the modal is open for that
  // toolkit. Used for toolkits whose auth_schemes are API_KEY or
  // BEARER_TOKEN (no OAuth redirect).
  const [apiKeyModal, setApiKeyModal] = useState<Toolkit | null>(null);
  const prevConnectedRef = useRef<Set<string>>(new Set());
  const autoFiredRef = useRef<Set<string>>(new Set());

  const {
    data: catalogData,
    isLoading: catalogLoading,
  } = useQuery(getIntegrationCatalog, { search: "", category: "" });

  const {
    data: connectedData,
    refetch: refetchConnected,
  } = useQuery(getConnectedIntegrations);

  const toolkits: Toolkit[] = catalogData?.toolkits || [];
  const categories: string[] = catalogData?.categories || [];
  const connected: ConnectedIntegration[] = connectedData?.integrations || [];
  const connectedSlugs = new Set(connected.map((c) => c.toolkit));

  useEffect(() => {
    prevConnectedRef.current = new Set(connected.map((c) => c.id));
  }, [connected]);

  const filtered = toolkits.filter((t) => {
    if (category !== "all" && t.category !== category) return false;
    if (search) {
      const s = search.toLowerCase();
      return (
        t.slug.toLowerCase().includes(s) ||
        t.name.toLowerCase().includes(s) ||
        t.description.toLowerCase().includes(s)
      );
    }
    return true;
  });

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // ---------------------------------------------------------------------------
  // Auto-config helper
  // ---------------------------------------------------------------------------

  const runAutoConfig = useCallback(
    async (connectionId: string, toolkitName: string) => {
      setConfiguringId(connectionId);
      try {
        const result = await autoConfigIntegration({ connectionId });
        const parts: string[] = [];
        if (result?.stream_created) parts.push("stream active");
        if (result?.actions_count) parts.push(`${result.actions_count} actions`);
        if (result?.skill_generated) parts.push("skill generated");
        setToast(`${toolkitName} configured! ${parts.join(", ")}`);
      } catch (err: any) {
        setToast(`Auto-config failed: ${err?.message || "Unknown error"}`);
      }
      setConfiguringId(null);
      void refetchConnected();
    },
    [refetchConnected],
  );

  // ---------------------------------------------------------------------------
  // Auto-fire: any ACTIVE connection that isn't yet configured gets
  // auto-config'd automatically. Handles three cases the popup-close
  // handler misses:
  //   1. Composio was still INITIATED when the popup closed (status
  //      races to ACTIVE a few seconds later); this effect catches
  //      the transition on the next refetch.
  //   2. The user refreshed / navigated away before the popup-close
  //      handler could fire runAutoConfig.
  //   3. A connection was made from onboarding or another entry point
  //      and was never auto-configured at all.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!connected.length) return;
    const toFire = connected.filter(
      (c) =>
        c.status === "ACTIVE" &&
        (c.auto_config_state === "pending" ||
          c.auto_config_state === "error" ||
          c.auto_config_state === undefined) &&
        !autoFiredRef.current.has(c.id),
    );
    if (toFire.length === 0) return;
    for (const conn of toFire) {
      autoFiredRef.current.add(conn.id);
      runAutoConfig(conn.id, conn.toolkit_name || conn.toolkit).catch((err) => {
        console.error("[auto-fire] auto-config failed:", err);
      });
    }
  }, [connected, runAutoConfig]);

  // ---------------------------------------------------------------------------
  // Connect flow — now includes auto-config
  // ---------------------------------------------------------------------------

  // A toolkit uses the API-key flow iff its auth_schemes list contains
  // API_KEY or BEARER_TOKEN but NOT OAUTH2. When OAuth is available we
  // always prefer it (no user-managed credential to rotate, better UX).
  const resolveAuthFlow = useCallback(
    (toolkit: Toolkit | null | undefined): "oauth" | "api_key" | "bearer_token" | "unsupported" => {
      const schemes = new Set((toolkit?.auth_schemes ?? []).map((s) => String(s).toUpperCase()));
      if (schemes.has("OAUTH2") || schemes.has("OAUTH1") || schemes.has("OAUTH1A")) return "oauth";
      if (schemes.has("API_KEY")) return "api_key";
      if (schemes.has("BEARER_TOKEN")) return "bearer_token";
      // Many toolkits omit the field in the catalog response — default to
      // OAuth since that covers the majority of Composio's integrations.
      if (schemes.size === 0) return "oauth";
      return "unsupported";
    },
    [],
  );

  const handleConnect = useCallback(
    async (toolkitSlug: string) => {
      const toolkit = toolkits.find((t) => t.slug === toolkitSlug);
      const flow = resolveAuthFlow(toolkit);
      if (flow === "api_key" || flow === "bearer_token") {
        setApiKeyModal(toolkit ?? { slug: toolkitSlug, name: toolkitSlug, description: "", icon_url: "", category: "other", auth_schemes: [flow === "bearer_token" ? "BEARER_TOKEN" : "API_KEY"] });
        return;
      }
      if (flow === "unsupported") {
        setToast(`${toolkit?.name || toolkitSlug} uses an auth scheme Alfred doesn't support yet.`);
        return;
      }

      setConnectingSlug(toolkitSlug);
      try {
        const result = await initiateConnect({
          toolkit_slug: toolkitSlug,
          redirect_url: `${window.location.origin}/dashboard/integrations?composio_callback=success&toolkit=${toolkitSlug}`,
        });
        const connectUrl = result?.connect_url;
        if (connectUrl) {
          const popup = window.open(
            connectUrl,
            "composio-connect",
            "width=600,height=700,left=200,top=100",
          );
          if (popup) {
            const interval = setInterval(async () => {
              if (popup.closed) {
                clearInterval(interval);
                setConnectingSlug(null);
                // Poll up to 6x / 12s for the new connection to become
                // ACTIVE. Composio can race through INITIATED → ACTIVE over
                // a few seconds after the popup closes, and we don't want
                // to miss it — but we also fall through to the auto-fire
                // effect which catches any late arrivals on the next refetch.
                const prevIds = prevConnectedRef.current;
                for (let attempt = 0; attempt < 6; attempt++) {
                  const refreshed = await refetchConnected();
                  const newConns: ConnectedIntegration[] =
                    refreshed?.data?.integrations || [];
                  const newConn = newConns.find(
                    (c) =>
                      !prevIds.has(c.id) &&
                      c.toolkit === toolkitSlug &&
                      c.status === "ACTIVE",
                  );
                  if (newConn) {
                    await runAutoConfig(
                      newConn.id,
                      newConn.toolkit_name || newConn.toolkit,
                    );
                    return;
                  }
                  await new Promise((r) => setTimeout(r, 2000));
                }
                setToast(`${toolkitSlug} connected — configuring shortly…`);
              }
            }, 500);
            setTimeout(() => {
              clearInterval(interval);
              setConnectingSlug(null);
            }, 120000);
          }
        } else {
          setToast("Failed to get connection URL");
          setConnectingSlug(null);
        }
      } catch (err: any) {
        setToast(`Connection failed: ${err?.message || "Unknown error"}`);
        setConnectingSlug(null);
      }
    },
    [refetchConnected, runAutoConfig, toolkits, resolveAuthFlow],
  );

  // Submit handler for the API-key modal. Fires initiateApiKeyConnect, then
  // refetches the connected list; the existing auto-fire effect will kick
  // auto-config into gear once the new row is ACTIVE (which it is immediately
  // — no OAuth redirect).
  const handleApiKeyConnect = useCallback(
    async (toolkit: Toolkit, credential: string, authScheme: "API_KEY" | "BEARER_TOKEN") => {
      setConnectingSlug(toolkit.slug);
      try {
        const result: any = await initiateApiKeyConnect({
          toolkit_slug: toolkit.slug,
          credential,
          auth_scheme: authScheme,
        });
        const newId = result?.connection_id;
        setApiKeyModal(null);
        await refetchConnected();
        setToast(`${toolkit.name} connected — configuring shortly…`);

        // If Composio already reported ACTIVE (it does for API_KEY), fire
        // auto-config immediately instead of waiting for the effect.
        if (newId && result?.status === "ACTIVE") {
          await runAutoConfig(newId, toolkit.name);
        }
      } catch (err: any) {
        throw new Error(err?.message || "Failed to connect");
      } finally {
        setConnectingSlug(null);
      }
    },
    [refetchConnected, runAutoConfig],
  );

  // Detect callback from popup redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("composio_callback") === "success") {
      const toolkit = params.get("toolkit") || "";
      refetchConnected();
      window.history.replaceState({}, "", "/dashboard/integrations");
      if (!connectingSlug) {
        setToast(toolkit ? `${toolkit} connected!` : "Integration connected!");
      }
    }
  }, [refetchConnected, connectingSlug]);

  // ---------------------------------------------------------------------------
  // Disconnect
  // ---------------------------------------------------------------------------

  const handleDisconnect = useCallback(
    async (connId: string, toolkitName: string) => {
      if (!confirm(`Disconnect ${toolkitName}? This will remove the stream, skill, and all tool access.`)) return;
      try {
        await disconnectIntegration({ connectionId: connId });
        refetchConnected();
        setExpandedConn(null);
        setToast(`${toolkitName} disconnected`);
      } catch (err: any) {
        setToast(`Disconnect failed: ${err?.message}`);
      }
    },
    [refetchConnected],
  );

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-serif text-2xl font-light text-[#F0EDE8]">
              Connected Apps
            </h1>
            <p className="mt-1 text-sm text-[#8A8680]">
              {connected.length > 0
                ? `${connected.length} connected`
                : "Connect apps to enable streams and tools"}
              {catalogData?.total ? ` \u00b7 ${catalogData.total} available` : ""}
            </p>
          </div>
          <button
            onClick={() => refetchConnected()}
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2 text-[#8A8680] transition hover:text-[#F0EDE8]"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>

        {/* Recommended Section — show core apps not yet connected via Composio */}
        {(() => {
          const RECOMMENDED = [
            { slug: "gmail", name: "Gmail", why: "Persistent email access — never expires" },
            { slug: "notion", name: "Notion", why: "Sync pages and databases automatically" },
            { slug: "googlecalendar", name: "Google Calendar", why: "Calendar events with incremental sync" },
            { slug: "github", name: "GitHub", why: "Notifications and PR tracking" },
          ];
          const missing = RECOMMENDED.filter((r) => !connectedSlugs.has(r.slug));
          if (missing.length === 0) return null;
          return (
            <section>
              <h2 className="mb-3 font-mono text-xs font-light uppercase tracking-[0.2em] text-[#C9A84C]">
                Recommended
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {missing.map((r) => (
                  <div
                    key={r.slug}
                    className="flex items-center justify-between rounded-xl border border-[#C9A84C]/20 bg-[#C9A84C]/5 p-4"
                  >
                    <div>
                      <h3 className="text-sm font-medium text-[#F0EDE8]">{r.name}</h3>
                      <p className="text-xs text-[#8A8680]">{r.why}</p>
                    </div>
                    <button
                      onClick={() => handleConnect(r.slug)}
                      disabled={connectingSlug === r.slug}
                      className="rounded-lg bg-[#C9A84C]/10 px-3 py-1.5 text-xs text-[#C9A84C] transition hover:bg-[#C9A84C]/20 disabled:opacity-50"
                    >
                      {connectingSlug === r.slug ? "Connecting..." : "Connect"}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          );
        })()}

        {/* Connected Section */}
        {connected.length > 0 && (
          <section>
            <h2 className="mb-3 font-mono text-xs font-light uppercase tracking-[0.2em] text-[#8A8680]">
              Connected
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              {connected.map((conn) => (
                <ConnectedAppCard
                  key={conn.id}
                  conn={conn}
                  isExpanded={expandedConn === conn.id}
                  isConfiguring={configuringId === conn.id}
                  onToggle={() =>
                    setExpandedConn(expandedConn === conn.id ? null : conn.id)
                  }
                  onDisconnect={() =>
                    handleDisconnect(conn.id, conn.toolkit_name || conn.toolkit)
                  }
                  onReconfigure={() =>
                    runAutoConfig(conn.id, conn.toolkit_name || conn.toolkit)
                  }
                  onToast={setToast}
                />
              ))}
            </div>
          </section>
        )}

        {/* Catalog Section */}
        <section>
          <h2 className="mb-3 font-mono text-xs font-light uppercase tracking-[0.2em] text-[#8A8680]">
            Browse 1000+ Apps
          </h2>

          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8A8680]" />
              <input
                type="text"
                placeholder="Search Gmail, Slack, Notion, GitHub..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-white/[0.06] bg-white/[0.02] py-2 pl-10 pr-4 text-sm text-[#F0EDE8] placeholder-[#8A8680]/60 outline-none transition focus:border-[#C9A84C]/30"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {["all", ...categories.slice(0, 10)].map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  className={`rounded-full px-3 py-1 text-xs transition ${
                    category === cat
                      ? "bg-[#C9A84C]/20 text-[#C9A84C]"
                      : "bg-white/[0.03] text-[#8A8680] hover:text-[#F0EDE8]"
                  }`}
                >
                  {CATEGORY_LABELS[cat] || cat}
                </button>
              ))}
            </div>
          </div>

          {catalogLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-[#C9A84C]" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-[#8A8680]">
              No apps found{search ? ` for "${search}"` : ""}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filtered.slice(0, 60).map((toolkit) => (
                <ToolkitCard
                  key={toolkit.slug}
                  toolkit={toolkit}
                  isConnected={connectedSlugs.has(toolkit.slug)}
                  isConnecting={connectingSlug === toolkit.slug}
                  onConnect={() => handleConnect(toolkit.slug)}
                />
              ))}
            </div>
          )}

          {filtered.length > 60 && (
            <p className="mt-4 text-center text-xs text-[#8A8680]">
              Showing 60 of {filtered.length} results. Use search to narrow down.
            </p>
          )}
        </section>

        {apiKeyModal && (
          <ApiKeyConnectModal
            toolkit={apiKeyModal}
            authScheme={
              apiKeyModal.auth_schemes.map((s) => s.toUpperCase()).includes("BEARER_TOKEN") &&
              !apiKeyModal.auth_schemes.map((s) => s.toUpperCase()).includes("API_KEY")
                ? "BEARER_TOKEN"
                : "API_KEY"
            }
            onCancel={() => setApiKeyModal(null)}
            onSubmit={handleApiKeyConnect}
          />
        )}

        {toast && (
          <div className="fixed bottom-6 right-6 z-50 rounded-lg border border-[#C9A84C]/20 bg-black/90 px-4 py-3 text-sm text-[#F0EDE8] shadow-lg backdrop-blur-sm">
            {toast}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

// ---------------------------------------------------------------------------
// ToolkitCard — catalog grid card (browse view)
// ---------------------------------------------------------------------------

function ToolkitCard({
  toolkit,
  isConnected,
  isConnecting,
  onConnect,
}: {
  toolkit: Toolkit;
  isConnected: boolean;
  isConnecting: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 transition hover:border-white/[0.1]">
      <div className="mb-3 flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          {toolkit.icon_url ? (
            <img
              src={toolkit.icon_url}
              alt=""
              className="h-8 w-8 rounded-lg object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04]">
              <Puzzle className="h-4 w-4 text-[#8A8680]" />
            </div>
          )}
          <div>
            <h3 className="text-sm font-medium text-[#F0EDE8]">{toolkit.name}</h3>
            <span className="text-[0.65rem] text-[#8A8680]">
              {CATEGORY_LABELS[toolkit.category] || toolkit.category}
            </span>
          </div>
        </div>
      </div>

      {toolkit.description && (
        <p className="mb-3 flex-1 text-xs leading-relaxed text-[#8A8680]">
          {toolkit.description.slice(0, 100)}
          {toolkit.description.length > 100 ? "..." : ""}
        </p>
      )}

      {isConnected ? (
        <span className="inline-flex items-center gap-1 self-start rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-400">
          <Check className="h-3 w-3" /> Connected
        </span>
      ) : (
        <button
          onClick={onConnect}
          disabled={isConnecting}
          className="inline-flex items-center gap-1.5 self-start rounded-lg bg-[#C9A84C]/10 px-3 py-1.5 text-xs text-[#C9A84C] transition hover:bg-[#C9A84C]/20 disabled:opacity-50"
        >
          {isConnecting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <ExternalLink className="h-3 w-3" />
          )}
          {isConnecting ? "Connecting..." : "Connect"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConnectedAppCard — collapsed header + expandable AppDrawer
// ---------------------------------------------------------------------------

function ConnectedAppCard({
  conn,
  isExpanded,
  isConfiguring,
  onToggle,
  onDisconnect,
  onReconfigure,
  onToast,
}: {
  conn: ConnectedIntegration;
  isExpanded: boolean;
  isConfiguring: boolean;
  onToggle: () => void;
  onDisconnect: () => void;
  onReconfigure: () => void;
  onToast: (msg: string) => void;
}) {
  const state = conn.auto_config_state;
  const isRunning = state === "running";
  const isError = state === "error";
  const isConfigured = state === "configured";

  // Compact status summary for the collapsed header
  const statusSummary = useMemo(() => {
    if (isRunning || isConfiguring) return "Configuring…";
    if (isError) return "Configuration failed";
    if (isConfigured) {
      const parts: string[] = [];
      if (conn.streams_created) parts.push(`${conn.streams_created} stream`);
      if (conn.tools_enabled) parts.push(`${conn.tools_enabled} tools`);
      if (conn.skill_name) parts.push("skill");
      return parts.length ? parts.join(" \u00b7 ") : "Configured";
    }
    if (conn.status === "ORPHAN") return "Missing from Composio";
    if (conn.status === "ACTIVE") return "Queued…";
    return conn.status;
  }, [isRunning, isConfiguring, isError, isConfigured, conn]);

  const statusDotColor =
    isError
      ? "bg-red-400"
      : isRunning || isConfiguring
        ? "bg-amber-400"
        : isConfigured && conn.status === "ACTIVE"
          ? "bg-emerald-400"
          : "bg-white/30";

  return (
    <SpotlightCard className="" title="">
      {/* Header (clickable) */}
      <div
        onClick={onToggle}
        className="flex cursor-pointer items-center justify-between"
      >
        <div className="flex items-center gap-2.5">
          {conn.toolkit_icon ? (
            <img
              src={conn.toolkit_icon}
              alt=""
              className="h-8 w-8 rounded-lg object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04]">
              <Puzzle className="h-4 w-4 text-[#8A8680]" />
            </div>
          )}
          <div>
            <h3 className="text-sm font-medium text-[#F0EDE8]">
              {conn.toolkit_name || conn.toolkit}
            </h3>
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${statusDotColor}`} />
              <span className="text-[0.65rem] text-[#8A8680]">{statusSummary}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {(isRunning || isConfiguring) && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[#C9A84C]" />
          )}
          {isExpanded ? (
            <ChevronUp className="h-4 w-4 text-[#8A8680]" />
          ) : (
            <ChevronDown className="h-4 w-4 text-[#8A8680]" />
          )}
        </div>
      </div>

      {/* Expanded drawer */}
      {isExpanded && (
        <AppDrawer
          conn={conn}
          onDisconnect={onDisconnect}
          onReconfigure={onReconfigure}
          onToast={onToast}
        />
      )}
    </SpotlightCard>
  );
}

// ---------------------------------------------------------------------------
// AppDrawer — expanded per-app panel. Lazy-loads /capabilities on open.
//
// Sections:
//   1. stale_streams[] banner (visible only when Composio removed an action
//      that a live stream still points at — one-click Migrate fixes it)
//   2. Streams — per-action toggle + interval selector (this is the real
//      per-action binary state; backed by stream_configs + Temporal schedules)
//   3. Actions — informational list; all available once composio_execute is
//      in gateway.tools.allow; no per-action toggle (there's no mechanism to
//      scope by-action, and the old UI's toggle did nothing observable)
//   4. Skill — read-only reference
//   5. Advanced — Reconfigure + Disconnect
// ---------------------------------------------------------------------------

function AppDrawer({
  conn,
  onDisconnect,
  onReconfigure,
  onToast,
}: {
  conn: ConnectedIntegration;
  onDisconnect: () => void;
  onReconfigure: () => void;
  onToast: (msg: string) => void;
}) {
  const state = conn.auto_config_state;
  const isRunning = state === "running";
  const isError = state === "error";

  const {
    data: capabilities,
    isLoading: capLoading,
    error: capError,
    refetch: refetchCapabilities,
  } = useQuery(
    getIntegrationCapabilities,
    { connectionId: conn.id },
    { enabled: conn.status === "ACTIVE" },
  );

  const caps = capabilities as Capabilities | undefined;

  if (isRunning) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-4">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-[#C9A84C]" />
        <span className="text-xs text-[#F0EDE8]">
          Configuring… streams, actions, and skill are being set up on your tenant.
        </span>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-5 border-t border-white/[0.06] pt-4">
      {isError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-400" />
          <div className="flex-1 text-xs text-[#F0EDE8]">
            Configuration failed
            {conn.auto_config_error ? `: ${conn.auto_config_error}` : ""}. Use
            Retry below to try again.
          </div>
        </div>
      )}

      {/* Stale streams banner — Composio dropped an action slug we depend on */}
      {caps?.stale_streams && caps.stale_streams.length > 0 && (
        <StaleStreamsBanner
          connectionId={conn.id}
          staleStreams={caps.stale_streams}
          onMigrated={() => refetchCapabilities()}
          onToast={onToast}
        />
      )}

      {/* Streams */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <Radio className="h-3.5 w-3.5 text-blue-400" />
          <h4 className="text-xs font-medium text-[#F0EDE8]">Streams</h4>
          <span className="text-[0.65rem] text-[#8A8680]">
            Data Alfred collects from this app on a schedule
          </span>
        </div>
        {capLoading ? (
          <SectionSpinner />
        ) : capError ? (
          <SectionError message="Couldn't load actions for this app." />
        ) : !caps?.stream_actions?.length ? (
          <EmptySectionRow message="No streamable actions on this toolkit." />
        ) : (
          <div className="space-y-1">
            {caps.stream_actions.map((a) => (
              <StreamRow
                key={a.slug}
                action={a}
                connectionId={conn.id}
                onChanged={() => refetchCapabilities()}
                onToast={onToast}
              />
            ))}
          </div>
        )}
      </section>

      {/* Actions (informational — no toggle) */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <Wrench className="h-3.5 w-3.5 text-amber-400" />
          <h4 className="text-xs font-medium text-[#F0EDE8]">Actions</h4>
          <span className="text-[0.65rem] text-[#8A8680]">
            {caps?.composio_execute_enabled
              ? "Alfred can invoke these via composio_execute"
              : "Connect this app to let Alfred act on it"}
          </span>
        </div>
        {capLoading ? (
          <SectionSpinner />
        ) : capError ? (
          <SectionError message="Couldn't load actions for this app." />
        ) : !caps?.tool_actions?.length ? (
          <EmptySectionRow message="No callable actions on this toolkit." />
        ) : (
          <div className="space-y-1">
            {caps.tool_actions.map((a) => (
              <ActionRow key={a.slug} action={a} />
            ))}
          </div>
        )}
      </section>

      {/* Skill */}
      {conn.skill_name && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <Zap className="h-3.5 w-3.5 text-emerald-400" />
            <h4 className="text-xs font-medium text-[#F0EDE8]">Skill</h4>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
            <p className="text-xs text-[#F0EDE8]">
              Alfred loads the{" "}
              <code className="text-[0.65rem] text-[#C9A84C]">{conn.skill_name}</code>{" "}
              skill when reasoning about {conn.toolkit_name || conn.toolkit}.
            </p>
            {conn.auto_configured_at && (
              <p className="mt-1 text-[0.6rem] text-[#8A8680]">
                Generated {new Date(conn.auto_configured_at).toLocaleDateString()}
              </p>
            )}
          </div>
        </section>
      )}

      {/* Danger zone */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <Settings2 className="h-3.5 w-3.5 text-[#8A8680]" />
          <h4 className="text-xs font-medium text-[#F0EDE8]">Advanced</h4>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReconfigure();
            }}
            disabled={isRunning}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-[0.65rem] text-[#F0EDE8] transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className="h-3 w-3" />
            {isError ? "Retry configuration" : "Re-run configuration"}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDisconnect();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-1.5 text-[0.65rem] text-red-400 transition hover:bg-red-500/10"
          >
            <Unplug className="h-3 w-3" />
            Disconnect
          </button>
        </div>
        <p className="mt-2 text-[0.6rem] text-[#8A8680]/60">
          Connected {new Date(conn.created_at).toLocaleDateString()}
          {conn.auto_configured_at && ` · configured ${new Date(conn.auto_configured_at).toLocaleDateString()}`}
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StaleStreamsBanner — shows when Composio removed an action a stream uses
// ---------------------------------------------------------------------------

function StaleStreamsBanner({
  connectionId,
  staleStreams,
  onMigrated,
  onToast,
}: {
  connectionId: string;
  staleStreams: StaleStream[];
  onMigrated: () => void;
  onToast: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleMigrate = useCallback(
    async (stale: StaleStream) => {
      if (!stale.suggested_replacement) {
        onToast(
          `No replacement mapped for ${stale.action} — contact support to migrate manually.`,
        );
        return;
      }
      setBusy(true);
      try {
        const result: any = await migrateIntegrationStream({
          connectionId,
          old_action_slug: stale.action,
          new_action_slug: stale.suggested_replacement,
        });
        onToast(
          `Migrated ${stale.action} → ${result?.new_action || stale.suggested_replacement}`,
        );
        onMigrated();
      } catch (err: any) {
        onToast(`Migration failed: ${err?.message || "Unknown error"}`);
      } finally {
        setBusy(false);
      }
    },
    [connectionId, onMigrated, onToast],
  );

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
        <div className="flex-1">
          <p className="text-xs font-medium text-[#F0EDE8]">
            {staleStreams.length === 1
              ? "A stream action was removed from Composio's catalog"
              : `${staleStreams.length} stream actions were removed from Composio's catalog`}
          </p>
          <p className="mt-1 text-[0.65rem] text-[#8A8680]">
            Every pull for these streams is 404ing. Migrate to the replacement
            action to reconnect.
          </p>
          <div className="mt-2 space-y-1">
            {staleStreams.map((s) => (
              <div
                key={s.stream_id}
                className="flex items-center justify-between gap-2 rounded bg-black/20 px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <code className="block text-[0.6rem] text-amber-200 font-mono truncate">
                    {s.action}
                  </code>
                  {s.suggested_replacement ? (
                    <span className="text-[0.55rem] text-[#8A8680]">
                      → <code className="font-mono">{s.suggested_replacement}</code>
                    </span>
                  ) : (
                    <span className="text-[0.55rem] text-red-300">
                      no replacement mapped
                    </span>
                  )}
                </div>
                <button
                  onClick={() => handleMigrate(s)}
                  disabled={busy || !s.suggested_replacement}
                  className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-1 font-mono text-[0.55rem] uppercase tracking-wider text-amber-300 transition hover:bg-amber-500/25 disabled:opacity-40"
                >
                  {busy ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-2.5 w-2.5" />
                  )}
                  Migrate
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StreamRow — per-action toggle + interval editor
//
// Reads live config from capabilities: display_name, description,
// enabled, schedule_interval_seconds, last_event_at, event_count. Interval
// selector is always visible (greyed when disabled — pre-selects the value
// that applies on enable).
// ---------------------------------------------------------------------------

function StreamRow({
  action,
  connectionId,
  onChanged,
  onToast,
}: {
  action: StreamCapability;
  connectionId: string;
  onChanged: () => void;
  onToast: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  // Seed the interval from the live on-disk config when enabled, else a
  // sensible default from INTERVAL_PRESETS.
  const initialInterval = action.schedule_interval_seconds ?? 300;
  const [intervalSeconds, setIntervalSeconds] = useState<number>(initialInterval);
  // The currently-applied value on the tenant. Kept separate so we can
  // highlight the Apply button when the user picks a new value.
  const [appliedInterval, setAppliedInterval] = useState<number>(initialInterval);

  // If capabilities refetches after external changes, resync local state.
  useEffect(() => {
    const live = action.schedule_interval_seconds ?? 300;
    setIntervalSeconds(live);
    setAppliedInterval(live);
    // Only when the server-reported interval changes — local user-driven
    // picks stay sticky until the next mutation completes.
  }, [action.schedule_interval_seconds]);

  const humanName = action.display_name || slugToTitle(action.slug);
  const intervalDirty = action.enabled && intervalSeconds !== appliedInterval;

  const handleToggle = useCallback(async () => {
    setBusy(true);
    try {
      if (action.enabled) {
        await disableIntegrationStream({ connectionId, action_slug: action.slug });
        onToast(`${humanName} stream disabled`);
      } else {
        await enableIntegrationStream({
          connectionId,
          action_slug: action.slug,
          poll_interval_seconds: intervalSeconds,
        });
        setAppliedInterval(intervalSeconds);
        onToast(`${humanName} stream enabled`);
      }
      onChanged();
    } catch (err: any) {
      onToast(`${humanName} failed: ${err?.message || "Unknown error"}`);
    } finally {
      setBusy(false);
    }
  }, [action, connectionId, intervalSeconds, humanName, onChanged, onToast]);

  const handleApplyInterval = useCallback(async () => {
    setBusy(true);
    try {
      // disable + re-enable is the idempotent way to change interval without
      // leaving an orphan Temporal schedule. ctrl-api tears down the old
      // schedule on disable; enable creates a fresh one at the new cron.
      await disableIntegrationStream({ connectionId, action_slug: action.slug });
      await enableIntegrationStream({
        connectionId,
        action_slug: action.slug,
        poll_interval_seconds: intervalSeconds,
      });
      setAppliedInterval(intervalSeconds);
      onToast(`${humanName} interval updated to ${intervalLabel(intervalSeconds)}`);
      onChanged();
    } catch (err: any) {
      onToast(`Interval update failed: ${err?.message || "Unknown error"}`);
    } finally {
      setBusy(false);
    }
  }, [action, connectionId, intervalSeconds, humanName, onChanged, onToast]);

  const lastEventAgo = action.last_event_at ? timeAgo(action.last_event_at) : null;

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        action.enabled
          ? "border-blue-500/20 bg-blue-500/5"
          : "border-white/[0.04] bg-white/[0.01]"
      }`}
    >
      <div className="flex items-start gap-3">
        <Toggle checked={action.enabled} disabled={busy} onChange={handleToggle} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs text-[#F0EDE8]">{humanName}</span>
            {action.deprecated && (
              <span className="rounded-sm bg-red-500/10 px-1 py-0 font-mono text-[0.5rem] uppercase text-red-400">
                Deprecated
              </span>
            )}
            <code
              className="text-[0.55rem] text-[#8A8680]/60 font-mono truncate"
              title={action.slug}
            >
              {action.slug}
            </code>
          </div>
          {action.description && (
            <p className="mt-0.5 text-[0.65rem] leading-relaxed text-[#8A8680] line-clamp-2">
              {action.description}
            </p>
          )}
          {action.enabled && (
            <p className="mt-1 text-[0.55rem] text-[#8A8680]/80">
              {action.event_count} events collected
              {lastEventAgo ? ` · last ${lastEventAgo}` : ""}
              {action.last_pull_status && action.last_pull_status !== "ok" && action.last_pull_status !== "migrated"
                ? ` · status: ${action.last_pull_status}`
                : ""}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1.5">
            <select
              value={intervalSeconds}
              disabled={busy}
              onChange={(e) => setIntervalSeconds(parseInt(e.target.value, 10))}
              className="rounded border border-white/[0.06] bg-white/[0.02] px-1.5 py-1 text-[0.65rem] text-[#F0EDE8] outline-none disabled:opacity-50"
              title={action.enabled ? "Pull interval" : "Pull interval (on enable)"}
            >
              {INTERVAL_PRESETS.map((p) => (
                <option key={p.seconds} value={p.seconds}>
                  every {p.label}
                </option>
              ))}
            </select>
            {intervalDirty && (
              <button
                onClick={handleApplyInterval}
                disabled={busy}
                className="rounded bg-[#C9A84C]/10 px-2 py-1 text-[0.6rem] text-[#C9A84C] transition hover:bg-[#C9A84C]/20 disabled:opacity-50"
              >
                Apply
              </button>
            )}
          </div>
          {busy && <Loader2 className="h-3 w-3 animate-spin text-[#8A8680]" />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ActionRow — read-only action tile. No toggle (there's no per-action
// enablement — all actions dispatch through composio_execute).
// ---------------------------------------------------------------------------

function ActionRow({ action }: { action: ToolCapability }) {
  const humanName = action.display_name || slugToTitle(action.slug);
  return (
    <div className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-3 py-2">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-xs text-[#F0EDE8]">{humanName}</span>
        {action.deprecated && (
          <span className="rounded-sm bg-red-500/10 px-1 py-0 font-mono text-[0.5rem] uppercase text-red-400">
            Deprecated
          </span>
        )}
        <code className="text-[0.55rem] text-[#8A8680]/60 font-mono truncate">
          {action.slug}
        </code>
      </div>
      {action.description && (
        <p className="mt-0.5 text-[0.65rem] leading-relaxed text-[#8A8680] line-clamp-2">
          {action.description}
        </p>
      )}
    </div>
  );
}

function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  if (isNaN(diff) || diff < 0) return null;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Toggle — small controlled switch
// ---------------------------------------------------------------------------

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full border transition disabled:opacity-50 ${
        checked
          ? "border-[#C9A84C]/40 bg-[#C9A84C]/40"
          : "border-white/[0.08] bg-white/[0.06]"
      }`}
    >
      <span
        className={`inline-block h-3 w-3 transform rounded-full bg-[#F0EDE8] transition ${
          checked ? "translate-x-3.5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function SectionSpinner() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/[0.04] bg-white/[0.01] px-3 py-3">
      <Loader2 className="h-3 w-3 animate-spin text-[#8A8680]" />
      <span className="text-[0.65rem] text-[#8A8680]">Loading actions…</span>
    </div>
  );
}

function SectionError({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-3">
      <AlertCircle className="h-3 w-3 text-red-400" />
      <span className="text-[0.65rem] text-[#F0EDE8]">{message}</span>
    </div>
  );
}

function EmptySectionRow({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-3 py-3">
      <span className="text-[0.65rem] text-[#8A8680]">{message}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugToTitle(slug: string): string {
  // "GMAIL_FETCH_EMAILS" → "Fetch Emails"
  const parts = slug.split("_");
  if (parts.length > 1) parts.shift(); // drop toolkit prefix
  return parts
    .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))
    .join(" ")
    .trim() || slug;
}

function intervalLabel(seconds: number): string {
  const preset = INTERVAL_PRESETS.find((p) => p.seconds === seconds);
  if (preset) return preset.label;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

// ---------------------------------------------------------------------------
// ApiKeyConnectModal — collects a credential for non-OAuth Composio toolkits
// (Clockify, Tavily, PostHog, …). Single-field prompt; submits via the
// parent's onSubmit handler which wires initiateApiKeyConnect + auto-config.
// ---------------------------------------------------------------------------

function ApiKeyConnectModal({
  toolkit,
  authScheme,
  onCancel,
  onSubmit,
}: {
  toolkit: Toolkit;
  authScheme: "API_KEY" | "BEARER_TOKEN";
  onCancel: () => void;
  onSubmit: (toolkit: Toolkit, credential: string, authScheme: "API_KEY" | "BEARER_TOKEN") => Promise<void>;
}) {
  const [credential, setCredential] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fieldLabel = authScheme === "BEARER_TOKEN" ? "Bearer token" : "API key";
  const placeholder =
    authScheme === "BEARER_TOKEN" ? "Paste your bearer token" : "Paste your API key";

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = credential.trim();
    if (!trimmed) {
      setError("Please paste your credential first.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(toolkit, trimmed, authScheme);
    } catch (err: any) {
      setError(err?.message || "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl border border-white/[0.08] bg-[#0A0A0A] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            {toolkit.icon_url ? (
              <img
                src={toolkit.icon_url}
                alt=""
                className="h-10 w-10 rounded-lg object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.04]">
                <Key className="h-5 w-5 text-[#8A8680]" />
              </div>
            )}
            <div>
              <h3 className="font-serif text-lg font-light text-[#F0EDE8]">
                Connect {toolkit.name}
              </h3>
              <p className="text-xs text-[#8A8680]">
                {toolkit.name} uses an {fieldLabel.toLowerCase()}. Paste it below to finish connecting.
              </p>
            </div>
          </div>
          <button
            onClick={onCancel}
            disabled={submitting}
            className="rounded p-1 text-[#8A8680] transition hover:text-[#F0EDE8] disabled:opacity-50"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label
              htmlFor="api-key-input"
              className="mb-1.5 block text-xs font-medium text-[#F0EDE8]"
            >
              {fieldLabel}
            </label>
            <input
              id="api-key-input"
              type="password"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              value={credential}
              disabled={submitting}
              placeholder={placeholder}
              onChange={(e) => {
                setCredential(e.target.value);
                if (error) setError(null);
              }}
              className="w-full rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-sm text-[#F0EDE8] placeholder-[#8A8680]/60 outline-none transition focus:border-[#C9A84C]/40 disabled:opacity-50"
            />
            <p className="mt-1.5 text-[0.6rem] text-[#8A8680]">
              Stored securely by Composio — never touches Alfred's filesystem or git history.
              You can revoke it from {toolkit.name}'s settings at any time.
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 p-2.5">
              <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0 text-red-400" />
              <span className="text-xs text-[#F0EDE8]">{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-xs text-[#8A8680] transition hover:text-[#F0EDE8] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !credential.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#C9A84C]/15 px-3 py-1.5 text-xs text-[#C9A84C] transition hover:bg-[#C9A84C]/25 disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Connecting…
                </>
              ) : (
                <>
                  <Key className="h-3 w-3" />
                  Connect
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
