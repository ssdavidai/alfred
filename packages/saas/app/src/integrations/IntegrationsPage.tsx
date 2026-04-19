import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  useQuery,
  getIntegrationCatalog,
  getConnectedIntegrations,
  getIntegrationCapabilities,
  initiateConnect,
  disconnectIntegration,
  autoConfigIntegration,
  enableIntegrationStream,
  disableIntegrationStream,
  enableIntegrationTool,
  disableIntegrationTool,
} from "wasp/client/operations";
import DashboardLayout from "../dashboard/DashboardLayout";
import { useOpenclawStatus } from "../shared/OpenclawStatusContext";
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

interface CapabilityAction {
  slug: string;
  description: string;
  enabled: boolean;
}

interface Capabilities {
  connection_id: string;
  toolkit: string;
  toolkit_name: string;
  stream_actions: CapabilityAction[];
  tool_actions: CapabilityAction[];
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

export default function IntegrationsPage() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [expandedConn, setExpandedConn] = useState<string | null>(null);
  const [connectingSlug, setConnectingSlug] = useState<string | null>(null);
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const prevConnectedRef = useRef<Set<string>>(new Set());
  const autoFiredRef = useRef<Set<string>>(new Set());
  const { markReconfiguring, reconfiguringUntil } = useOpenclawStatus();
  const isReconfiguring =
    reconfiguringUntil !== null && reconfiguringUntil > new Date();

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
        // If ctrl-api reports a gateway restart was triggered (i.e. tools.allow
        // actually changed), show the reconfiguring banner for ~60s so the user
        // doesn't see a 502 when they click into Alfred. Connecting a second
        // Composio app is a no-op at the openclaw layer and won't set this
        // flag — banner stays hidden.
        if (result?.gateway_restart_triggered) {
          markReconfiguring(toolkitName);
        }
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
    [markReconfiguring, refetchConnected],
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

  const handleConnect = useCallback(
    async (toolkitSlug: string) => {
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
        const result: any = await disconnectIntegration({ connectionId: connId });
        if (result?.gateway_restart_triggered) {
          markReconfiguring(toolkitName);
        }
        refetchConnected();
        setExpandedConn(null);
        setToast(`${toolkitName} disconnected`);
      } catch (err: any) {
        setToast(`Disconnect failed: ${err?.message}`);
      }
    },
    [refetchConnected, markReconfiguring],
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
                      disabled={connectingSlug === r.slug || isReconfiguring}
                      title={isReconfiguring ? "Waiting for the gateway to finish restarting…" : undefined}
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
                  isReconfiguring={isReconfiguring}
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
  isReconfiguring,
  onConnect,
}: {
  toolkit: Toolkit;
  isConnected: boolean;
  isConnecting: boolean;
  isReconfiguring: boolean;
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
          disabled={isConnecting || isReconfiguring}
          title={isReconfiguring ? "Waiting for the gateway to finish restarting…" : undefined}
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
// AppDrawer — expanded per-app panel. Fetches capabilities once on open,
// then renders the Streams / Tools / Skill / Danger sections.
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

  // Running / error state takes precedence — no point showing empty tables
  if (isRunning) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-4">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-[#C9A84C]" />
        <span className="text-xs text-[#F0EDE8]">
          Configuring… streams, tools, and skill are being set up on your tenant.
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

      {/* Streams */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <Radio className="h-3.5 w-3.5 text-blue-400" />
          <h4 className="text-xs font-medium text-[#F0EDE8]">Streams</h4>
          <span className="text-[0.65rem] text-[#8A8680]">
            Data collected automatically on a schedule
          </span>
        </div>
        {capLoading ? (
          <SectionSpinner />
        ) : capError ? (
          <SectionError message="Couldn't load actions for this app." />
        ) : !caps?.stream_actions?.length ? (
          <EmptySectionRow message="No stream actions available for this toolkit." />
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

      {/* Tools */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <Wrench className="h-3.5 w-3.5 text-amber-400" />
          <h4 className="text-xs font-medium text-[#F0EDE8]">Tools</h4>
          <span className="text-[0.65rem] text-[#8A8680]">
            Actions Alfred can invoke on this app
          </span>
        </div>
        {capLoading ? (
          <SectionSpinner />
        ) : capError ? (
          <SectionError message="Couldn't load actions for this app." />
        ) : !caps?.tool_actions?.length ? (
          <EmptySectionRow message="No tool actions available for this toolkit." />
        ) : (
          <div className="space-y-1">
            {caps.tool_actions.map((a) => (
              <ToolRow
                key={a.slug}
                action={a}
                onChanged={() => refetchCapabilities()}
                onToast={onToast}
              />
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
// StreamRow — per-action toggle + interval editor
// ---------------------------------------------------------------------------

function StreamRow({
  action,
  connectionId,
  onChanged,
  onToast,
}: {
  action: CapabilityAction;
  connectionId: string;
  onChanged: () => void;
  onToast: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [intervalSeconds, setIntervalSeconds] = useState<number>(300);
  // Track the interval currently on the tenant — starts at the default;
  // we don't fetch the live value because enable-stream is idempotent and
  // the user can always apply again with a new value.
  const [appliedInterval, setAppliedInterval] = useState<number>(300);

  const pretty = slugToTitle(action.slug);
  const intervalDirty = action.enabled && intervalSeconds !== appliedInterval;

  const handleToggle = useCallback(async () => {
    setBusy(true);
    try {
      if (action.enabled) {
        await disableIntegrationStream({
          connectionId,
          action_slug: action.slug,
        });
        onToast(`${pretty} stream disabled`);
      } else {
        await enableIntegrationStream({
          connectionId,
          action_slug: action.slug,
          poll_interval_seconds: intervalSeconds,
        });
        setAppliedInterval(intervalSeconds);
        onToast(`${pretty} stream enabled`);
      }
      onChanged();
    } catch (err: any) {
      onToast(`${pretty} failed: ${err?.message || "Unknown error"}`);
    } finally {
      setBusy(false);
    }
  }, [action, connectionId, intervalSeconds, pretty, onChanged, onToast]);

  const handleApplyInterval = useCallback(async () => {
    setBusy(true);
    try {
      // Idempotent: enable-stream overwrites the config with the new interval
      // and recreates the schedule on the SaaS side.
      await disableIntegrationStream({
        connectionId,
        action_slug: action.slug,
      });
      await enableIntegrationStream({
        connectionId,
        action_slug: action.slug,
        poll_interval_seconds: intervalSeconds,
      });
      setAppliedInterval(intervalSeconds);
      onToast(`${pretty} interval updated to ${intervalLabel(intervalSeconds)}`);
      onChanged();
    } catch (err: any) {
      onToast(`Interval update failed: ${err?.message || "Unknown error"}`);
    } finally {
      setBusy(false);
    }
  }, [action, connectionId, intervalSeconds, pretty, onChanged, onToast]);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/[0.04] bg-white/[0.01] px-3 py-2">
      <Toggle
        checked={action.enabled}
        disabled={busy}
        onChange={handleToggle}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-[#F0EDE8]">{pretty}</span>
          <code className="text-[0.6rem] text-[#8A8680]/70 font-mono truncate">
            {action.slug}
          </code>
        </div>
        {action.description && (
          <p className="mt-0.5 text-[0.6rem] text-[#8A8680] line-clamp-1">
            {action.description}
          </p>
        )}
      </div>
      {action.enabled && (
        <div className="flex items-center gap-1.5">
          <select
            value={intervalSeconds}
            disabled={busy}
            onChange={(e) => setIntervalSeconds(parseInt(e.target.value, 10))}
            className="rounded border border-white/[0.06] bg-white/[0.02] px-1.5 py-1 text-[0.65rem] text-[#F0EDE8] outline-none disabled:opacity-50"
          >
            {INTERVAL_PRESETS.map((p) => (
              <option key={p.seconds} value={p.seconds}>
                {p.label}
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
      )}
      {busy && <Loader2 className="h-3 w-3 animate-spin text-[#8A8680]" />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolRow — per-action toggle (no interval)
// ---------------------------------------------------------------------------

function ToolRow({
  action,
  onChanged,
  onToast,
}: {
  action: CapabilityAction;
  onChanged: () => void;
  onToast: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const pretty = slugToTitle(action.slug);

  const handleToggle = useCallback(async () => {
    setBusy(true);
    try {
      if (action.enabled) {
        await disableIntegrationTool({ action_slug: action.slug });
        onToast(`${pretty} tool disabled`);
      } else {
        await enableIntegrationTool({ action_slug: action.slug });
        onToast(`${pretty} tool enabled`);
      }
      onChanged();
    } catch (err: any) {
      onToast(`${pretty} failed: ${err?.message || "Unknown error"}`);
    } finally {
      setBusy(false);
    }
  }, [action, pretty, onChanged, onToast]);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/[0.04] bg-white/[0.01] px-3 py-2">
      <Toggle checked={action.enabled} disabled={busy} onChange={handleToggle} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-[#F0EDE8]">{pretty}</span>
          <code className="text-[0.6rem] text-[#8A8680]/70 font-mono truncate">
            {action.slug}
          </code>
        </div>
        {action.description && (
          <p className="mt-0.5 text-[0.6rem] text-[#8A8680] line-clamp-1">
            {action.description}
          </p>
        )}
      </div>
      {busy && <Loader2 className="h-3 w-3 animate-spin text-[#8A8680]" />}
    </div>
  );
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
