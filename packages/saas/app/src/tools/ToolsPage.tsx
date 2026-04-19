import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, getAllowedTools } from "wasp/client/operations";
import DashboardLayout from "../dashboard/DashboardLayout";
import SpotlightCard from "../components/ui/SpotlightCard";
import {
  Wrench,
  Loader2,
  ExternalLink,
  Puzzle,
  Server,
  Terminal,
  Search,
  AlertCircle,
  Radio,
  ChevronDown,
  ChevronUp,
  Hammer,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types — mirror packages/saas/app/src/tools/operations.ts
// ---------------------------------------------------------------------------

interface StreamEntry {
  slug: string;
  display_name: string;
  description: string;
  deprecated: boolean;
  enabled: boolean;
  schedule_interval_seconds: number | null;
  last_event_at: string | null;
  event_count: number;
  last_pull_status: string | null;
}

interface ActionEntry {
  slug: string;
  display_name: string;
  description: string;
  deprecated: boolean;
}

interface StaleStream {
  stream_id: string;
  action: string;
  suggested_replacement: string | null;
}

interface AppEntry {
  connection_id: string;
  toolkit: string;
  toolkit_name: string;
  toolkit_icon: string | null;
  auto_config_state: "pending" | "running" | "configured" | "error";
  composio_execute_enabled: boolean;
  streams: StreamEntry[];
  actions: ActionEntry[];
  stale_streams: StaleStream[];
  error: string | null;
}

interface BuiltinTool {
  name: string;
  description: string | null;
}

interface McpTool {
  name: string;
  server: string;
  description: string;
  prime_only: boolean;
}

interface ToolsResponse {
  apps: AppEntry[];
  builtin_tools: BuiltinTool[];
  mcp_tools: McpTool[];
  prime_enabled: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function intervalLabel(seconds: number | null): string {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} hr`;
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

function appStatusColor(app: AppEntry): string {
  if (app.error) return "bg-red-400";
  if (app.auto_config_state === "error") return "bg-red-400";
  if (app.auto_config_state === "running" || app.auto_config_state === "pending") return "bg-amber-400";
  if (app.composio_execute_enabled) return "bg-emerald-400";
  return "bg-white/30";
}

function appStatusLabel(app: AppEntry): string {
  if (app.error) return `Error: ${app.error}`;
  if (app.auto_config_state === "error") return "Configuration failed";
  if (app.auto_config_state === "running") return "Configuring…";
  if (app.auto_config_state === "pending") return "Queued";
  if (!app.composio_execute_enabled) return "Connected but not wired to Alfred yet";
  const parts: string[] = [];
  if (app.streams.length) parts.push(`${app.streams.length} stream${app.streams.length === 1 ? "" : "s"}`);
  if (app.actions.length) parts.push(`${app.actions.length} action${app.actions.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" \u00b7 ") : "Connected";
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ToolsPage() {
  const { data, isLoading, error, refetch } = useQuery(getAllowedTools);
  const resp = data as ToolsResponse | undefined;
  const [search, setSearch] = useState("");
  const [expandedAppId, setExpandedAppId] = useState<string | null>(null);

  // Search: match on human-readable fields only. Raw slugs never pollute
  // the haystack — they're implementation detail.
  const filtered = useMemo(() => {
    if (!resp) return null;
    const q = search.trim().toLowerCase();
    if (!q) return resp;

    const matchAction = (e: { display_name: string; description: string }) =>
      (e.display_name || "").toLowerCase().includes(q) ||
      (e.description || "").toLowerCase().includes(q);

    const apps = resp.apps
      .map((app) => {
        const appNameMatches =
          app.toolkit_name.toLowerCase().includes(q) ||
          app.toolkit.toLowerCase().includes(q);
        if (appNameMatches) return app;
        const streams = app.streams.filter(matchAction);
        const actions = app.actions.filter(matchAction);
        if (streams.length || actions.length) {
          return { ...app, streams, actions };
        }
        return null;
      })
      .filter((x): x is AppEntry => x !== null);

    const builtin_tools = resp.builtin_tools.filter(
      (t) => t.name.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q),
    );
    const mcp_tools = resp.mcp_tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.server.toLowerCase().includes(q),
    );

    return { apps, builtin_tools, mcp_tools, prime_enabled: resp.prime_enabled };
  }, [resp, search]);

  const totalActions = resp?.apps.reduce(
    (sum, a) => sum + a.streams.length + a.actions.length,
    0,
  ) ?? 0;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Wrench className="h-5 w-5 text-[#C9A84C]" />
            <div>
              <h1 className="font-serif text-2xl font-light text-[#F0EDE8]">Tools</h1>
              <p className="mt-0.5 text-sm text-[#8A8680]">
                What Alfred can do on this tenant
                {resp
                  ? ` \u00b7 ${resp.apps.length} app${resp.apps.length === 1 ? "" : "s"} \u00b7 ${totalActions} action${totalActions === 1 ? "" : "s"}`
                  : ""}
              </p>
            </div>
          </div>
          <button
            onClick={() => refetch()}
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-xs text-[#8A8680] transition hover:text-[#F0EDE8]"
          >
            Refresh
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8A8680]" />
          <input
            type="text"
            placeholder="Search actions or apps…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-white/[0.06] bg-white/[0.02] py-2 pl-10 pr-4 text-sm text-[#F0EDE8] placeholder-[#8A8680]/60 outline-none transition focus:border-[#C9A84C]/30"
          />
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 py-8">
            <Loader2 className="h-5 w-5 animate-spin text-[#C9A84C]" />
            <span className="text-sm text-[#8A8680]">Loading tools…</span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-400" />
            <div className="text-xs text-[#F0EDE8]">
              Couldn't load the tool list from this tenant. {error.message || ""}
            </div>
          </div>
        )}

        {/* Connected apps */}
        {filtered && filtered.apps.length > 0 && (
          <section>
            <div className="mb-2 flex items-center gap-2">
              <Puzzle className="h-3.5 w-3.5 text-[#C9A84C]" />
              <h2 className="text-xs font-medium text-[#F0EDE8]">Connected Apps</h2>
              <span className="text-[0.6rem] text-[#8A8680]">
                What Alfred can read from and act on, per app
              </span>
            </div>
            <div className="space-y-2">
              {filtered.apps.map((app) => (
                <AppCard
                  key={app.connection_id}
                  app={app}
                  expanded={expandedAppId === app.connection_id}
                  onToggle={() =>
                    setExpandedAppId(
                      expandedAppId === app.connection_id ? null : app.connection_id,
                    )
                  }
                />
              ))}
            </div>
          </section>
        )}

        {filtered && filtered.apps.length === 0 && !search.trim() && (
          <SpotlightCard title="">
            <div className="py-4 text-center">
              <Puzzle className="mx-auto mb-2 h-8 w-8 text-[#8A8680]/30" />
              <p className="text-sm text-[#8A8680]">No apps connected yet.</p>
              <Link
                to="/dashboard/integrations"
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-[#C9A84C]/10 px-3 py-1.5 text-xs text-[#C9A84C] transition hover:bg-[#C9A84C]/20"
              >
                <ExternalLink className="h-3 w-3" />
                Browse apps
              </Link>
            </div>
          </SpotlightCard>
        )}

        {/* MCP */}
        {filtered && filtered.mcp_tools.length > 0 && (
          <ToolList
            icon={<Server className="h-3.5 w-3.5 text-blue-400" />}
            title="MCP Tools"
            description="Native tool calls Alfred makes through the Model Context Protocol"
            items={filtered.mcp_tools.map((t) => ({
              primary: t.name,
              secondary: t.description,
              badge: t.prime_only ? (
                <span className="rounded-sm bg-purple-500/10 px-1.5 py-0.5 font-mono text-[0.5rem] uppercase tracking-wider text-purple-400">
                  Prime
                </span>
              ) : null,
              hint: `via ${t.server}`,
            }))}
          />
        )}

        {/* Builtin */}
        {filtered && filtered.builtin_tools.length > 0 && (
          <ToolList
            icon={<Terminal className="h-3.5 w-3.5 text-[#C9A84C]" />}
            title="Built-in Tools"
            description="Core openclaw gateway tools (always available)"
            items={filtered.builtin_tools.map((t) => ({
              primary: t.name,
              secondary: t.description ?? "",
              badge: null,
              hint: null,
            }))}
          />
        )}

        {/* Empty search state */}
        {filtered &&
          filtered.apps.length === 0 &&
          filtered.builtin_tools.length === 0 &&
          filtered.mcp_tools.length === 0 &&
          search.trim() && (
            <SpotlightCard title="">
              <p className="py-4 text-center text-sm text-[#8A8680]">
                No tools match "{search}".
              </p>
            </SpotlightCard>
          )}
      </div>
    </DashboardLayout>
  );
}

// ---------------------------------------------------------------------------
// AppCard — per-app card with expandable Streams + Actions list
// ---------------------------------------------------------------------------

function AppCard({
  app,
  expanded,
  onToggle,
}: {
  app: AppEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const dotColor = appStatusColor(app);
  const statusText = appStatusLabel(app);

  return (
    <SpotlightCard className="" title="">
      <div
        onClick={onToggle}
        className="flex cursor-pointer items-center justify-between"
      >
        <div className="flex items-center gap-2.5">
          {app.toolkit_icon ? (
            <img
              src={app.toolkit_icon}
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
            <h3 className="text-sm font-medium text-[#F0EDE8]">{app.toolkit_name}</h3>
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
              <span className="text-[0.65rem] text-[#8A8680]">{statusText}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Link
            to="/dashboard/integrations"
            onClick={(e) => e.stopPropagation()}
            className="rounded p-1 text-[#8A8680] transition hover:text-[#F0EDE8]"
            title="Manage in Integrations"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-[#8A8680]" />
          ) : (
            <ChevronDown className="h-4 w-4 text-[#8A8680]" />
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-4 space-y-5 border-t border-white/[0.06] pt-4">
          {/* Stale streams warning */}
          {app.stale_streams.length > 0 && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
                <div className="text-xs text-[#F0EDE8]">
                  {app.stale_streams.length === 1
                    ? `Stream action ${app.stale_streams[0].action} was removed from Composio's catalog.`
                    : `${app.stale_streams.length} stream actions were removed from Composio's catalog.`}{" "}
                  Open the{" "}
                  <Link
                    to="/dashboard/integrations"
                    className="underline underline-offset-2 hover:text-[#C9A84C]"
                  >
                    Integrations drawer
                  </Link>{" "}
                  and click Migrate to reconnect.
                </div>
              </div>
            </div>
          )}

          {/* Streams section */}
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Radio className="h-3.5 w-3.5 text-blue-400" />
              <h4 className="text-xs font-medium text-[#F0EDE8]">Streams</h4>
              <span className="text-[0.6rem] text-[#8A8680]">
                Data Alfred collects on a schedule
              </span>
            </div>
            {app.streams.length === 0 ? (
              <p className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-3 py-2 text-[0.65rem] text-[#8A8680]">
                No streamable actions on this app.
              </p>
            ) : (
              <div className="space-y-1">
                {app.streams.map((s) => (
                  <StreamListRow key={s.slug} stream={s} />
                ))}
              </div>
            )}
          </div>

          {/* Actions section */}
          <div>
            <div className="mb-2 flex items-center gap-2">
              <Hammer className="h-3.5 w-3.5 text-amber-400" />
              <h4 className="text-xs font-medium text-[#F0EDE8]">Actions</h4>
              <span className="text-[0.6rem] text-[#8A8680]">
                {app.composio_execute_enabled
                  ? "Alfred can invoke these via composio_execute"
                  : "Requires composio_execute in gateway.tools.allow"}
              </span>
            </div>
            {app.actions.length === 0 ? (
              <p className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-3 py-2 text-[0.65rem] text-[#8A8680]">
                No callable actions on this app.
              </p>
            ) : (
              <div className="space-y-1">
                {app.actions.map((a) => (
                  <ActionListRow key={a.slug} action={a} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </SpotlightCard>
  );
}

function StreamListRow({ stream }: { stream: StreamEntry }) {
  const last = timeAgo(stream.last_event_at);
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        stream.enabled
          ? "border-blue-500/20 bg-blue-500/5"
          : "border-white/[0.04] bg-white/[0.01]"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-xs text-[#F0EDE8]">
              {stream.display_name || stream.slug}
            </span>
            {stream.enabled && (
              <span className="rounded-sm bg-blue-500/15 px-1.5 py-0.5 font-mono text-[0.5rem] uppercase tracking-wider text-blue-300">
                Live · every {intervalLabel(stream.schedule_interval_seconds)}
              </span>
            )}
          </div>
          {stream.description && (
            <p className="mt-0.5 text-[0.6rem] text-[#8A8680] line-clamp-2">
              {stream.description}
            </p>
          )}
          {stream.enabled && (
            <p className="mt-1 text-[0.55rem] text-[#8A8680]/80">
              {stream.event_count} events collected
              {last ? ` · last ${last}` : ""}
              {stream.last_pull_status && stream.last_pull_status !== "ok"
                ? ` · status: ${stream.last_pull_status}`
                : ""}
            </p>
          )}
          <code className="mt-0.5 inline-block text-[0.55rem] text-[#8A8680]/60 font-mono">
            {stream.slug}
          </code>
        </div>
      </div>
    </div>
  );
}

function ActionListRow({ action }: { action: ActionEntry }) {
  return (
    <div className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-[#F0EDE8]">
          {action.display_name || action.slug}
        </span>
        {action.deprecated && (
          <span className="rounded-sm bg-red-500/10 px-1.5 py-0.5 font-mono text-[0.5rem] uppercase tracking-wider text-red-400">
            Deprecated
          </span>
        )}
      </div>
      {action.description && (
        <p className="mt-0.5 text-[0.6rem] text-[#8A8680] line-clamp-2">
          {action.description}
        </p>
      )}
      <code className="mt-0.5 inline-block text-[0.55rem] text-[#8A8680]/60 font-mono">
        {action.slug}
      </code>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolList — MCP + Builtin sections share the same shape
// ---------------------------------------------------------------------------

function ToolList({
  icon,
  title,
  description,
  items,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  items: Array<{
    primary: string;
    secondary: string;
    badge: React.ReactNode;
    hint: string | null;
  }>;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <h2 className="text-xs font-medium text-[#F0EDE8]">{title}</h2>
        <span className="text-[0.6rem] text-[#8A8680]">{description}</span>
      </div>
      <div className="space-y-1 rounded-lg border border-white/[0.06] bg-white/[0.02] p-1.5">
        {items.map((item) => (
          <div
            key={item.primary + (item.hint ?? "")}
            className="rounded px-2.5 py-2 transition hover:bg-white/[0.02]"
          >
            <div className="flex items-baseline gap-2">
              <code className="text-xs text-[#F0EDE8] font-mono">{item.primary}</code>
              {item.badge}
              {item.hint && (
                <span className="text-[0.55rem] text-[#8A8680]/70">{item.hint}</span>
              )}
            </div>
            {item.secondary && (
              <p className="mt-0.5 text-[0.6rem] text-[#8A8680] line-clamp-2">
                {item.secondary}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
