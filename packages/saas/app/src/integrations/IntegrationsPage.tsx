import { useState, useEffect, useCallback, useRef } from "react";
import {
  useQuery,
  getIntegrationCatalog,
  getConnectedIntegrations,
  initiateConnect,
  disconnectIntegration,
  autoConfigIntegration,
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

interface AutoConfigResult {
  toolkit: string;
  composio_execute_enabled: boolean;
  stream_created: string | null;
  schedule_created?: string;
  skill_generated: string;
  actions_count: number;
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

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function IntegrationsPage() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [expandedConn, setExpandedConn] = useState<string | null>(null);
  const [connectingSlug, setConnectingSlug] = useState<string | null>(null);
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [configResults, setConfigResults] = useState<Record<string, AutoConfigResult>>({});
  const [toast, setToast] = useState<string | null>(null);
  const prevConnectedRef = useRef<Set<string>>(new Set());
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

  // Track previous connected IDs to detect new connections
  useEffect(() => {
    prevConnectedRef.current = new Set(connected.map((c) => c.id));
  }, [connected]);

  // Client-side filter
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

  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // ---------------------------------------------------------------------------
  // Auto-config helper
  // ---------------------------------------------------------------------------

  const runAutoConfig = useCallback(async (connectionId: string, toolkitName: string) => {
    setConfiguringId(connectionId);
    try {
      const result = await autoConfigIntegration({ connectionId });
      setConfigResults((prev) => ({ ...prev, [connectionId]: result }));
      // If ctrl-api reports a gateway restart was triggered (i.e. tools.allow
      // actually changed), tell the DashboardLayout to show the reconfiguring
      // banner for ~60s so the user doesn't see a 502 when they click into
      // Alfred. Connecting a second Composio app is a no-op at the openclaw
      // layer and won't set this flag — banner stays hidden.
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
  }, [markReconfiguring]);

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
                // Refetch to find the new connection
                const refreshed = await refetchConnected();
                const newConns: ConnectedIntegration[] = refreshed?.data?.integrations || [];
                const prevIds = prevConnectedRef.current;
                const newConn = newConns.find(
                  (c) => !prevIds.has(c.id) && c.toolkit === toolkitSlug && c.status === "ACTIVE",
                );
                if (newConn) {
                  // Auto-configure the new connection
                  await runAutoConfig(newConn.id, newConn.toolkit_name || newConn.toolkit);
                } else {
                  setToast(`${toolkitSlug} connected!`);
                }
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
      // Auto-config will be triggered by the popup close handler above
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
        // Disconnect can mutate gateway.tools.allow (toolkit tool removal
        // and/or ctrl_composio_execute removal on last disconnect). Show the
        // banner only when ctrl-api confirms a restart was triggered.
        if (result?.gateway_restart_triggered) {
          markReconfiguring(toolkitName);
        }
        setConfigResults((prev) => {
          const next = { ...prev };
          delete next[connId];
          return next;
        });
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
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {connected.map((conn) => (
                <ConnectedCard
                  key={conn.id}
                  conn={conn}
                  isExpanded={expandedConn === conn.id}
                  isConfiguring={configuringId === conn.id}
                  configResult={configResults[conn.id]}
                  onToggle={() =>
                    setExpandedConn(expandedConn === conn.id ? null : conn.id)
                  }
                  onDisconnect={() =>
                    handleDisconnect(conn.id, conn.toolkit_name || conn.toolkit)
                  }
                  onReconfigure={() =>
                    runAutoConfig(conn.id, conn.toolkit_name || conn.toolkit)
                  }
                />
              ))}
            </div>
          </section>
        )}

        {/* Catalog Section */}
        <section>
          <h2 className="mb-3 font-mono text-xs font-light uppercase tracking-[0.2em] text-[#8A8680]">
            App Catalog
          </h2>

          {/* Search + Category filter */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8A8680]" />
              <input
                type="text"
                placeholder="Search 1000+ apps..."
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

          {/* Grid */}
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

        {/* Toast */}
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
// ToolkitCard — catalog grid card
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
// ConnectedCard — auto-configured integration with status display
// ---------------------------------------------------------------------------

function ConnectedCard({
  conn,
  isExpanded,
  isConfiguring,
  configResult,
  onToggle,
  onDisconnect,
  onReconfigure,
}: {
  conn: ConnectedIntegration;
  isExpanded: boolean;
  isConfiguring: boolean;
  configResult?: AutoConfigResult;
  onToggle: () => void;
  onDisconnect: () => void;
  onReconfigure: () => void;
}) {
  return (
    <SpotlightCard className="cursor-pointer" title="">
      <div onClick={onToggle}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            {conn.toolkit_icon ? (
              <img
                src={conn.toolkit_icon}
                alt=""
                className="h-7 w-7 rounded-lg object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            ) : (
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.04]">
                <Puzzle className="h-3.5 w-3.5 text-[#8A8680]" />
              </div>
            )}
            <div>
              <h3 className="text-sm font-medium text-[#F0EDE8]">
                {conn.toolkit_name || conn.toolkit}
              </h3>
              <div className="flex items-center gap-1.5">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    conn.status === "ACTIVE" ? "bg-emerald-400" : "bg-amber-400"
                  }`}
                />
                <span className="text-[0.65rem] text-[#8A8680]">
                  {isConfiguring ? "Configuring..." : conn.status === "ACTIVE" ? "Active" : conn.status}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isConfiguring && <Loader2 className="h-3.5 w-3.5 animate-spin text-[#C9A84C]" />}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDisconnect();
              }}
              className="rounded p-1 text-[#8A8680] transition hover:text-red-400"
              title="Disconnect"
            >
              <Unplug className="h-3.5 w-3.5" />
            </button>
            {isExpanded ? (
              <ChevronUp className="h-4 w-4 text-[#8A8680]" />
            ) : (
              <ChevronDown className="h-4 w-4 text-[#8A8680]" />
            )}
          </div>
        </div>
      </div>

      {isExpanded && (
        <ConfigStatus
          conn={conn}
          configResult={configResult}
          onReconfigure={onReconfigure}
        />
      )}
    </SpotlightCard>
  );
}

// ---------------------------------------------------------------------------
// ConfigStatus — replaces old CapabilitiesDrawer with read-only status
// ---------------------------------------------------------------------------

function ConfigStatus({
  conn,
  configResult,
  onReconfigure,
}: {
  conn: ConnectedIntegration;
  configResult?: AutoConfigResult;
  onReconfigure: () => void;
}) {
  return (
    <div className="mt-3 space-y-2.5 border-t border-white/[0.06] pt-3">
      {configResult ? (
        <>
          {/* Stream status */}
          {configResult.stream_created && (
            <div className="flex items-center gap-2 rounded-lg bg-blue-500/5 px-3 py-2">
              <Radio className="h-3.5 w-3.5 text-blue-400" />
              <span className="text-xs text-[#F0EDE8]">
                Stream active — polling every 5 min
              </span>
            </div>
          )}

          {/* Actions count */}
          <div className="flex items-center gap-2 rounded-lg bg-amber-500/5 px-3 py-2">
            <Wrench className="h-3.5 w-3.5 text-amber-400" />
            <span className="text-xs text-[#F0EDE8]">
              {configResult.actions_count} actions available via <code className="text-[0.65rem] text-[#C9A84C]">composio_execute</code>
            </span>
          </div>

          {/* Skill file */}
          {configResult.skill_generated && (
            <div className="flex items-center gap-2 rounded-lg bg-emerald-500/5 px-3 py-2">
              <Zap className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-xs text-[#F0EDE8]">
                Skill: <code className="text-[0.65rem] text-[#8A8680]">{configResult.skill_generated}</code>
              </span>
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center gap-2 rounded-lg bg-white/[0.02] px-3 py-2">
          <Settings2 className="h-3.5 w-3.5 text-[#8A8680]" />
          <span className="text-xs text-[#8A8680]">
            Not yet configured — click Reconfigure to set up stream + skill
          </span>
        </div>
      )}

      {/* Reconfigure button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onReconfigure();
        }}
        className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.03] px-3 py-1.5 text-[0.65rem] text-[#8A8680] transition hover:bg-white/[0.06] hover:text-[#F0EDE8]"
      >
        <RefreshCw className="h-3 w-3" />
        {configResult ? "Reconfigure" : "Configure"}
      </button>

      {/* Created at */}
      <p className="text-[0.6rem] text-[#8A8680]/60">
        Connected {new Date(conn.created_at).toLocaleDateString()}
      </p>
    </div>
  );
}
