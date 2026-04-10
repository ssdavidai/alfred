import { useState, useEffect, useCallback } from "react";
import {
  useQuery,
  getIntegrationCatalog,
  getConnectedIntegrations,
  getIntegrationCapabilities,
  initiateConnect,
  disconnectIntegration,
  enableIntegrationStream,
  enableIntegrationTool,
  disableIntegrationTool,
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
  status: string;
  auth_scheme: string;
  created_at: string;
}

interface ActionEntry {
  slug: string;
  description: string;
  enabled?: boolean;
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
  const [toast, setToast] = useState<string | null>(null);

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

  // Client-side filter (server also supports search, but we filter locally for speed)
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
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // ---------------------------------------------------------------------------
  // Connect flow
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
          // Poll for popup close
          if (popup) {
            const interval = setInterval(() => {
              if (popup.closed) {
                clearInterval(interval);
                setConnectingSlug(null);
                refetchConnected();
                setToast(`${toolkitSlug} connected!`);
              }
            }, 500);
            // Safety timeout
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
    [refetchConnected],
  );

  // Detect callback from popup redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("composio_callback") === "success") {
      const toolkit = params.get("toolkit") || "";
      setToast(toolkit ? `${toolkit} connected!` : "Integration connected!");
      refetchConnected();
      // Clean URL
      window.history.replaceState({}, "", "/dashboard/integrations");
    }
  }, [refetchConnected]);

  // ---------------------------------------------------------------------------
  // Disconnect
  // ---------------------------------------------------------------------------

  const handleDisconnect = useCallback(
    async (connId: string, toolkitName: string) => {
      if (!confirm(`Disconnect ${toolkitName}? This will remove all associated streams.`)) return;
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
                  onToggle={() =>
                    setExpandedConn(expandedConn === conn.id ? null : conn.id)
                  }
                  onDisconnect={() =>
                    handleDisconnect(conn.id, conn.toolkit_name || conn.toolkit)
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
// ConnectedCard — connected integration with expandable capabilities
// ---------------------------------------------------------------------------

function ConnectedCard({
  conn,
  isExpanded,
  onToggle,
  onDisconnect,
}: {
  conn: ConnectedIntegration;
  isExpanded: boolean;
  onToggle: () => void;
  onDisconnect: () => void;
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
                  {conn.status === "ACTIVE" ? "Active" : conn.status}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
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

      {isExpanded && <CapabilitiesDrawer connectionId={conn.id} />}
    </SpotlightCard>
  );
}

// ---------------------------------------------------------------------------
// CapabilitiesDrawer — stream/tool actions with toggles
// ---------------------------------------------------------------------------

function CapabilitiesDrawer({ connectionId }: { connectionId: string }) {
  const { data, isLoading } = useQuery(getIntegrationCapabilities, {
    connectionId,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const streamActions: ActionEntry[] = data?.stream_actions || [];
  const toolActions: ActionEntry[] = data?.tool_actions || [];

  const handleEnableStream = async (slug: string) => {
    setBusy(slug);
    try {
      await enableIntegrationStream({
        connectionId,
        action_slug: slug,
        poll_interval_seconds: 300,
      });
      setToast(`Stream enabled: ${slug}`);
    } catch (err: any) {
      setToast(`Failed: ${err?.message}`);
    }
    setBusy(null);
  };

  const handleToggleTool = async (slug: string, currentlyEnabled: boolean) => {
    setBusy(slug);
    try {
      if (currentlyEnabled) {
        await disableIntegrationTool({ action_slug: slug });
      } else {
        await enableIntegrationTool({ action_slug: slug });
      }
    } catch (err: any) {
      setToast(`Failed: ${err?.message}`);
    }
    setBusy(null);
  };

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  if (isLoading) {
    return (
      <div className="mt-3 flex justify-center py-4">
        <Loader2 className="h-4 w-4 animate-spin text-[#C9A84C]" />
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-4 border-t border-white/[0.06] pt-3">
      {/* Stream Actions */}
      {streamActions.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-1.5">
            <Radio className="h-3 w-3 text-blue-400" />
            <span className="text-[0.65rem] font-medium uppercase tracking-wider text-blue-400">
              Stream Actions ({streamActions.length})
            </span>
          </div>
          <div className="space-y-1">
            {streamActions.map((action) => (
              <div
                key={action.slug}
                className="flex items-center justify-between rounded-lg bg-white/[0.02] px-2.5 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-[#F0EDE8]">
                    {action.slug}
                  </span>
                  {action.description && (
                    <span className="block truncate text-[0.6rem] text-[#8A8680]">
                      {action.description.slice(0, 80)}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => handleEnableStream(action.slug)}
                  disabled={busy === action.slug || action.enabled}
                  className={`ml-2 flex-shrink-0 rounded px-2 py-0.5 text-[0.65rem] transition ${
                    action.enabled
                      ? "bg-emerald-500/10 text-emerald-400"
                      : "bg-blue-500/10 text-blue-400 hover:bg-blue-500/20"
                  } disabled:opacity-50`}
                >
                  {busy === action.slug ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : action.enabled ? (
                    "Active"
                  ) : (
                    "Enable"
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tool Actions */}
      {toolActions.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-1.5">
            <Wrench className="h-3 w-3 text-amber-400" />
            <span className="text-[0.65rem] font-medium uppercase tracking-wider text-amber-400">
              Tool Actions ({toolActions.length})
            </span>
          </div>
          <div className="space-y-1">
            {toolActions.map((action) => (
              <div
                key={action.slug}
                className="flex items-center justify-between rounded-lg bg-white/[0.02] px-2.5 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-[#F0EDE8]">
                    {action.slug}
                  </span>
                  {action.description && (
                    <span className="block truncate text-[0.6rem] text-[#8A8680]">
                      {action.description.slice(0, 80)}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => handleToggleTool(action.slug, !!action.enabled)}
                  disabled={busy === action.slug}
                  className={`ml-2 flex-shrink-0 rounded px-2 py-0.5 text-[0.65rem] transition ${
                    action.enabled
                      ? "bg-emerald-500/10 text-emerald-400 hover:bg-red-500/10 hover:text-red-400"
                      : "bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                  } disabled:opacity-50`}
                >
                  {busy === action.slug ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : action.enabled ? (
                    "Enabled"
                  ) : (
                    "Enable"
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {streamActions.length === 0 && toolActions.length === 0 && (
        <p className="text-center text-xs text-[#8A8680]">
          No actions available for this integration.
        </p>
      )}

      {toast && (
        <div className="rounded-lg bg-[#C9A84C]/10 px-3 py-2 text-xs text-[#C9A84C]">
          {toast}
        </div>
      )}
    </div>
  );
}
