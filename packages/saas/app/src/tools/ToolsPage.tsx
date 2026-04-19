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
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AllowedTool {
  name: string;
  group: "builtin" | "mcp" | "composio";
  toolkit: string | null;
  toolkit_name: string | null;
  toolkit_icon: string | null;
  connection_id: string | null;
}

interface AllowedToolsResponse {
  tools: AllowedTool[];
  count: number;
  mcp_servers: string[];
  orphan_toolkits: string[];
}

// ---------------------------------------------------------------------------
// Short descriptions for known built-in + MCP tools. The tenant side doesn't
// ship these today, and fetching Composio's catalog for every page load would
// be expensive — so we hardcode the stable core set here and fall back to the
// tool name for anything we don't recognize.
// ---------------------------------------------------------------------------

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  web_search: "Search the web via the configured search provider.",
  web_fetch: "Fetch a URL and return the cleaned text contents.",
  composio_execute: "Dispatch any Composio action (Gmail, Slack, Notion, …).",
  sessions_list: "List active openclaw sessions on this tenant.",
  sessions_spawn: "Spawn a new openclaw session / agent.",
  sessions_send: "Send a message to a running openclaw session.",
  sessions_history: "Read the message history of an openclaw session.",
  sessions_delete: "Delete an openclaw session.",
  ctrl_composio_execute: "(legacy gateway entry, superseded by composio_execute)",
};

const MCP_DESCRIPTIONS: Record<string, string> = {
  self: "Call this tenant's ctrl-api. Alfred's primary hands.",
  tenant:
    "Call a peer tenant's ctrl-api over Tailscale. Alfred Prime only.",
  ask_alfred:
    "Hand a prompt to a peer tenant's Alfred and get their reasoned reply. Alfred Prime only.",
};

function humanActionName(slug: string): string {
  // GMAIL_FETCH_EMAILS → "Fetch Emails"
  const parts = slug.split("_");
  if (parts.length > 1) parts.shift();
  return parts
    .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))
    .join(" ") || slug;
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ToolsPage() {
  const { data, isLoading, error, refetch } = useQuery(getAllowedTools);
  const resp = data as AllowedToolsResponse | undefined;
  const [search, setSearch] = useState("");

  const grouped = useMemo(() => {
    const builtin: AllowedTool[] = [];
    const mcp: AllowedTool[] = [];
    const composioByToolkit = new Map<string, AllowedTool[]>();

    for (const t of resp?.tools ?? []) {
      if (t.group === "builtin") builtin.push(t);
      else if (t.group === "mcp") mcp.push(t);
      else if (t.group === "composio" && t.toolkit) {
        const arr = composioByToolkit.get(t.toolkit) ?? [];
        arr.push(t);
        composioByToolkit.set(t.toolkit, arr);
      }
    }

    return { builtin, mcp, composioByToolkit };
  }, [resp?.tools]);

  const filtered = useMemo(() => {
    if (!search.trim()) return grouped;
    const q = search.trim().toLowerCase();
    const matches = (t: AllowedTool) =>
      t.name.toLowerCase().includes(q) ||
      (t.toolkit_name ?? "").toLowerCase().includes(q) ||
      (t.toolkit ?? "").toLowerCase().includes(q);

    const composioByToolkit = new Map<string, AllowedTool[]>();
    for (const [k, arr] of grouped.composioByToolkit.entries()) {
      const kept = arr.filter(matches);
      if (kept.length || k.toLowerCase().includes(q)) {
        composioByToolkit.set(k, kept.length ? kept : arr);
      }
    }

    return {
      builtin: grouped.builtin.filter(matches),
      mcp: grouped.mcp.filter(matches),
      composioByToolkit,
    };
  }, [grouped, search]);

  const totalShown =
    filtered.builtin.length +
    filtered.mcp.length +
    Array.from(filtered.composioByToolkit.values()).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Wrench className="h-5 w-5 text-[#C9A84C]" />
            <div>
              <h1 className="font-serif text-2xl font-light text-[#F0EDE8]">
                Tools
              </h1>
              <p className="mt-0.5 text-sm text-[#8A8680]">
                Everything Alfred can invoke on this tenant
                {typeof resp?.count === "number"
                  ? ` \u00b7 ${resp.count} tools registered`
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
            placeholder="Filter by name, toolkit..."
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
              Couldn't load the tool list from this tenant.{" "}
              {error.message || ""}
            </div>
          </div>
        )}

        {resp && totalShown === 0 && (
          <SpotlightCard title="">
            <p className="py-4 text-center text-sm text-[#8A8680]">
              {search.trim()
                ? `No tools match "${search}".`
                : "No tools are registered on this tenant yet."}
            </p>
          </SpotlightCard>
        )}

        {/* Orphan warning */}
        {resp?.orphan_toolkits && resp.orphan_toolkits.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
            <div className="text-xs text-[#F0EDE8]">
              Orphan toolkits in allowlist:{" "}
              <code className="text-[0.7rem] text-amber-300">
                {resp.orphan_toolkits.join(", ")}
              </code>
              . These tool entries don't match any connected Composio account —
              disconnect them from the{" "}
              <Link
                to="/dashboard/integrations"
                className="underline underline-offset-2 hover:text-[#C9A84C]"
              >
                Integrations page
              </Link>{" "}
              to clean up.
            </div>
          </div>
        )}

        {/* MCP */}
        {filtered.mcp.length > 0 && (
          <ToolGroup
            icon={<Server className="h-3.5 w-3.5 text-blue-400" />}
            title="MCP Tools"
            description="Native tool calls routed through the Model Context Protocol server"
          >
            {filtered.mcp.map((t) => (
              <ToolRow
                key={t.name}
                name={t.name}
                primary={t.name}
                secondary={MCP_DESCRIPTIONS[t.name]}
                badge={null}
                right={null}
              />
            ))}
          </ToolGroup>
        )}

        {/* Builtin */}
        {filtered.builtin.length > 0 && (
          <ToolGroup
            icon={<Terminal className="h-3.5 w-3.5 text-[#C9A84C]" />}
            title="Built-in Tools"
            description="Core openclaw gateway tools (always available)"
          >
            {filtered.builtin.map((t) => (
              <ToolRow
                key={t.name}
                name={t.name}
                primary={t.name}
                secondary={BUILTIN_DESCRIPTIONS[t.name]}
                badge={null}
                right={null}
              />
            ))}
          </ToolGroup>
        )}

        {/* Composio, grouped by toolkit */}
        {Array.from(filtered.composioByToolkit.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([toolkit, tools]) => {
            const first = tools[0];
            const label = first?.toolkit_name ?? toolkit;
            const icon = first?.toolkit_icon ?? null;
            return (
              <ToolGroup
                key={toolkit}
                icon={
                  icon ? (
                    <img
                      src={icon}
                      alt=""
                      className="h-3.5 w-3.5 rounded object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <Puzzle className="h-3.5 w-3.5 text-[#8A8680]" />
                  )
                }
                title={label}
                description={`${tools.length} action${tools.length === 1 ? "" : "s"} available via composio_execute`}
                right={
                  <Link
                    to="/dashboard/integrations"
                    className="inline-flex items-center gap-1 rounded-sm border border-[#C9A84C]/30 bg-[#C9A84C]/5 px-2 py-1 font-mono text-[0.55rem] text-[#C9A84C] transition hover:bg-[#C9A84C]/10"
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                    Manage
                  </Link>
                }
              >
                {tools.map((t) => (
                  <ToolRow
                    key={t.name}
                    name={t.name}
                    primary={humanActionName(t.name)}
                    secondary={null}
                    badge={
                      <code className="text-[0.55rem] text-[#8A8680]/70 font-mono">
                        {t.name}
                      </code>
                    }
                    right={null}
                  />
                ))}
              </ToolGroup>
            );
          })}
      </div>
    </DashboardLayout>
  );
}

// ---------------------------------------------------------------------------
// ToolGroup — section wrapper
// ---------------------------------------------------------------------------

function ToolGroup({
  icon,
  title,
  description,
  children,
  right,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-xs font-medium text-[#F0EDE8]">{title}</h2>
          <span className="text-[0.6rem] text-[#8A8680]">{description}</span>
        </div>
        {right}
      </div>
      <div className="space-y-1 rounded-lg border border-white/[0.06] bg-white/[0.02] p-1.5">
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ToolRow
// ---------------------------------------------------------------------------

function ToolRow({
  name,
  primary,
  secondary,
  badge,
  right,
}: {
  name: string;
  primary: string;
  secondary: string | null | undefined;
  badge: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <div
      key={name}
      className="flex items-center gap-3 rounded px-2.5 py-2 transition hover:bg-white/[0.02]"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-[#F0EDE8]">{primary}</span>
          {badge}
        </div>
        {secondary ? (
          <p className="mt-0.5 text-[0.6rem] text-[#8A8680] line-clamp-1">
            {secondary}
          </p>
        ) : null}
      </div>
      {right}
    </div>
  );
}
