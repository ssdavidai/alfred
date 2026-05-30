// ToolsPage2 — Hermes tool allowlist viewer, restyled (#865, #31).
//
// Reads getAllowedTools (the same op the legacy ToolsPage uses). Renders
// a flat audit of every tool the Hermes runtime will currently let
// through: per-app actions/streams + built-in primitives + MCP servers.
// Also surfaces Hermes **command approval** — a parity gain over the old
// OpenClaw allowlist, where privileged commands now ask before running.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  useQuery,
  useAction,
  getAllowedTools,
  getToolDispositions,
  setToolDisposition,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";

// Phase B self-protected servers: flipping these to DELEGATED would break
// Alfred's ability to reach his own ctrl-api (alfred-ctrl), call his own
// briefing/decision tools (alfred), or run the Composio progressive-
// disclosure surface that Phase A optimised (execute). The backend
// allows the flip; the UI disables it so you don't trip yourself up.
const SELF_PROTECTED_SERVERS = new Set(["alfred", "alfred-ctrl", "execute"]);

interface ToolDispositionRow {
  server: string;
  disposition: "direct" | "delegated";
  updated_at: string;
  updated_by: string | null;
}

interface StreamEntry {
  slug: string;
  display_name: string;
  description: string;
  deprecated: boolean;
  enabled: boolean;
}

interface ActionEntry {
  slug: string;
  display_name: string;
  description: string;
  deprecated: boolean;
}

interface AppEntry {
  toolkit: string;
  toolkit_name: string;
  streams: StreamEntry[];
  actions: ActionEntry[];
  auto_config_state: string;
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

interface McpServerInclusion {
  server: string;
  // 'whitelist' — tools.include in config.yaml lists explicit names → we
  //   know the exact catalogue and the count is meaningful.
  // 'all'       — no whitelist; Hermes passes through whatever the spawned
  //   MCP server advertises. ctrl-api can't enumerate without asking the
  //   running process, so render the count as unknown.
  // 'none'      — tools.include is an empty array (the DELEGATED shape from
  //   PR #178). Server still serves the workers profile, just hidden on main.
  mode: "whitelist" | "all" | "none";
  tool_count: number | null;
}

export default function ToolsPage2() {
  const { data, isLoading } = useQuery(getAllowedTools);
  const apps: AppEntry[] = (data?.apps ?? []) as AppEntry[];
  const builtins: BuiltinTool[] = (data?.builtin_tools ?? []) as BuiltinTool[];
  const mcps: McpTool[] = (data?.mcp_tools ?? []) as McpTool[];
  const mcpInclusion: McpServerInclusion[] =
    (data?.mcp_server_inclusion ?? []) as McpServerInclusion[];

  const { data: dispData, refetch: refetchDispositions } =
    useQuery(getToolDispositions);
  const dispositions: ToolDispositionRow[] =
    (dispData?.dispositions ?? []) as ToolDispositionRow[];
  const setDisposition = useAction(setToolDisposition);
  // "server slug → 'queued at epoch ms'": used to show the "Hermes is
  // restarting…" line for ~12s after a flip, then refetch the live state.
  const [restarts, setRestarts] = useState<Record<string, number>>({});
  const [flipError, setFlipError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();

  const filteredApps = useMemo(() => {
    if (!q) return apps;
    return apps
      .map((a) => ({
        ...a,
        streams: a.streams.filter(
          (s) =>
            s.slug.toLowerCase().includes(q) ||
            (s.display_name ?? "").toLowerCase().includes(q),
        ),
        actions: a.actions.filter(
          (s) =>
            s.slug.toLowerCase().includes(q) ||
            (s.display_name ?? "").toLowerCase().includes(q),
        ),
      }))
      .filter(
        (a) =>
          a.streams.length + a.actions.length > 0 ||
          a.toolkit.toLowerCase().includes(q) ||
          (a.toolkit_name ?? "").toLowerCase().includes(q),
      );
  }, [apps, q]);

  const filteredBuiltins = useMemo(
    () =>
      !q
        ? builtins
        : builtins.filter(
            (b) =>
              b.name.toLowerCase().includes(q) ||
              (b.description ?? "").toLowerCase().includes(q),
          ),
    [builtins, q],
  );
  const filteredMcps = useMemo(
    () =>
      !q
        ? mcps
        : mcps.filter(
            (m) =>
              m.name.toLowerCase().includes(q) ||
              m.server.toLowerCase().includes(q) ||
              (m.description ?? "").toLowerCase().includes(q),
          ),
    [mcps, q],
  );

  const totalCount =
    apps.reduce((s, a) => s + a.streams.length + a.actions.length, 0) +
    builtins.length +
    mcps.length;

  // Group filtered MCP tools by server, joined with the live disposition
  // row AND the per-server inclusion shape from config.yaml. Each server
  // card surfaces three orthogonal facts:
  //   • disposition (DIRECT vs DELEGATED, from state.db.tool_disposition)
  //   • inclusion shape (whitelist / all / none, from config.yaml mcp_servers)
  //   • per-tool detail (only meaningful when inclusion = whitelist)
  //
  // The two states the OLD UI conflated are now distinct:
  //   - disposition=DIRECT + inclusion=all  → "all tools available, count not
  //     surfaced". No misleading "0 tools / misconfigured" message.
  //   - disposition=DELEGATED                → inclusion will be 'none' after
  //     the debounced restart fires; we render 'delegated' regardless.
  const mcpServerGroups = useMemo(() => {
    const inclusionMap = new Map<string, McpServerInclusion>();
    for (const i of mcpInclusion) inclusionMap.set(i.server, i);

    const byServer = new Map<
      string,
      {
        server: string;
        tools: McpTool[];
        disposition: ToolDispositionRow | null;
        inclusion: McpServerInclusion | null;
      }
    >();
    for (const d of dispositions) {
      byServer.set(d.server, {
        server: d.server,
        tools: [],
        disposition: d,
        inclusion: inclusionMap.get(d.server) ?? null,
      });
    }
    for (const m of filteredMcps) {
      const existing = byServer.get(m.server);
      if (existing) {
        existing.tools.push(m);
      } else {
        byServer.set(m.server, {
          server: m.server,
          tools: [m],
          disposition: null,
          inclusion: inclusionMap.get(m.server) ?? null,
        });
      }
    }
    // Stable order: dispositions first (alphabetical), then orphan servers.
    return Array.from(byServer.values()).sort((a, b) =>
      a.server.localeCompare(b.server),
    );
  }, [dispositions, filteredMcps, mcpInclusion]);

  const handleFlip = async (
    server: string,
    next: "direct" | "delegated",
  ) => {
    setFlipError(null);
    try {
      await setDisposition({ server, disposition: next });
      setRestarts((r) => ({ ...r, [server]: Date.now() }));
      // Refetch once the debounced restart window closes (10s + 2s slack).
      setTimeout(() => {
        refetchDispositions();
        setRestarts((r) => {
          const { [server]: _drop, ...rest } = r;
          return rest;
        });
      }, 12_000);
    } catch (e: any) {
      setFlipError(
        `Couldn't flip ${server}: ${e?.message ?? "unknown error"}`,
      );
    }
  };

  return (
    <Frame>
      <section className="mx-auto max-w-[1100px] px-8 py-12">
        <div className="flex items-baseline justify-between mb-3">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--brass)" }}
          >
            Tools
          </div>
          <Link
            to="/connections"
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--brass)" }}
          >
            ← Apps catalogue
          </Link>
        </div>
        <h1 className="font-display text-5xl tracking-tight mb-3">
          What I'm permitted to do.
        </h1>
        <p
          className="font-body text-[16px] max-w-[60ch] mb-6"
          style={{ color: "var(--marginalia)" }}
        >
          Every tool, stream, and MCP endpoint the Hermes runtime will
          currently let through. {totalCount > 0 ? `${totalCount} entries.` : ""}
        </p>

        {/* Command approval — a Hermes parity gain over the OpenClaw
            allowlist. The allowlist below says what Alfred *may* reach;
            command approval governs what runs *without asking first*. */}
        <div className="border border-rule p-5 mb-10">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
            style={{ color: "var(--brass)" }}
          >
            Command approval
          </div>
          <p
            className="font-body text-[14px] max-w-[68ch]"
            style={{ color: "var(--marginalia)" }}
          >
            The allowlist below is what Alfred is <em>permitted</em> to
            reach. Hermes adds a second gate the OpenClaw gateway never
            had: a privileged command — a shell action, a write, a
            sensitive tool call — pauses for your approval before it runs.
            Pending approvals arrive on the{" "}
            <Link
              to="/dashboard/devices"
              style={{ color: "var(--brass)" }}
            >
              Devices
            </Link>{" "}
            page and on whichever channel raised them.
          </p>
        </div>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tools…"
          className="w-full bg-transparent outline-none border-b font-display italic text-[20px] pb-2 mb-8"
          style={{ borderColor: "var(--rule)" }}
        />

        {isLoading ? (
          <p
            className="font-body italic text-[15px]"
            style={{ color: "var(--marginalia)" }}
          >
            Reading the allowlist…
          </p>
        ) : (
          <div className="space-y-12">
            {/* Connected apps */}
            <section>
              <div className="border-b border-rule pb-3 mb-6 flex items-baseline justify-between">
                <h2
                  className="font-mono uppercase smallcaps"
                  style={{
                    fontSize: 14,
                    letterSpacing: "0.22em",
                    color: "var(--ink)",
                  }}
                >
                  Connected apps
                </h2>
                <span
                  className="font-mono text-[10px] uppercase tracking-[0.28em]"
                  style={{ color: "var(--marginalia)" }}
                >
                  {filteredApps.length}
                </span>
              </div>
              {filteredApps.length === 0 ? (
                <p
                  className="font-body italic text-[14px]"
                  style={{ color: "var(--marginalia)" }}
                >
                  Nothing connected yet.
                </p>
              ) : (
                <ul className="space-y-6">
                  {filteredApps.map((a) => (
                    <li key={a.toolkit} className="border border-rule p-5">
                      <div className="flex items-baseline justify-between mb-3">
                        <span className="font-display text-[22px]">
                          {a.toolkit_name || a.toolkit}
                        </span>
                        <span
                          className="font-mono text-[10px] uppercase tracking-[0.22em]"
                          style={{
                            color:
                              a.auto_config_state === "configured"
                                ? "var(--brass)"
                                : "var(--marginalia)",
                          }}
                        >
                          {a.auto_config_state}
                        </span>
                      </div>
                      <ColumnList title="Streams" rows={a.streams} />
                      <ColumnList title="Actions" rows={a.actions} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Built-in tools */}
            <section>
              <div className="border-b border-rule pb-3 mb-6 flex items-baseline justify-between">
                <h2
                  className="font-mono uppercase smallcaps"
                  style={{
                    fontSize: 14,
                    letterSpacing: "0.22em",
                    color: "var(--ink)",
                  }}
                >
                  Built-in
                </h2>
                <span
                  className="font-mono text-[10px] uppercase tracking-[0.28em]"
                  style={{ color: "var(--marginalia)" }}
                >
                  {filteredBuiltins.length}
                </span>
              </div>
              {filteredBuiltins.length === 0 ? (
                <p
                  className="font-body italic text-[14px]"
                  style={{ color: "var(--marginalia)" }}
                >
                  None.
                </p>
              ) : (
                <ul>
                  {filteredBuiltins.map((b) => (
                    <li
                      key={b.name}
                      className="grid grid-cols-[220px_1fr] gap-4 py-3 border-b border-rule items-baseline"
                    >
                      <span className="font-mono text-[12px]">{b.name}</span>
                      <span
                        className="font-body text-[14px]"
                        style={{ color: "var(--marginalia)" }}
                      >
                        {b.description ?? "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* MCP servers + dispositions (Phase B). Each server is a card
                with: name, tool count, current DIRECT/DELEGATED state,
                last-flipped-by/when, and the flip toggle. Three servers
                are SELF-PROTECTED (alfred, alfred-ctrl, execute) — flipping
                them would break Alfred's ability to talk to himself. */}
            <section>
              <div className="border-b border-rule pb-3 mb-3 flex items-baseline justify-between">
                <h2
                  className="font-mono uppercase smallcaps"
                  style={{
                    fontSize: 14,
                    letterSpacing: "0.22em",
                    color: "var(--ink)",
                  }}
                >
                  MCP servers
                </h2>
                <span
                  className="font-mono text-[10px] uppercase tracking-[0.28em]"
                  style={{ color: "var(--marginalia)" }}
                >
                  {mcpServerGroups.length}
                </span>
              </div>

              <p
                className="font-body text-[14px] max-w-[68ch] mb-6"
                style={{ color: "var(--marginalia)" }}
              >
                <strong>Direct</strong> — Alfred sees the server's tools
                inline every turn (fastest, costs tokens).{" "}
                <strong>Delegated</strong> — the tools are hidden on the main
                runtime; Alfred reaches them by spawning a focused
                sub-agent on the workers profile (cheaper model, +3-5s
                per use). Flipping queues a ~10-second Hermes restart.
                Default: Direct.
              </p>

              {flipError ? (
                <div
                  className="border border-rule p-3 mb-4 font-mono text-[12px]"
                  style={{ color: "var(--marginalia)" }}
                >
                  {flipError}
                </div>
              ) : null}

              {mcpServerGroups.length === 0 ? (
                <p
                  className="font-body italic text-[14px]"
                  style={{ color: "var(--marginalia)" }}
                >
                  None.
                </p>
              ) : (
                <ul className="space-y-4">
                  {mcpServerGroups.map((g) => (
                    <McpServerCard
                      key={g.server}
                      server={g.server}
                      tools={g.tools}
                      disposition={g.disposition}
                      inclusion={g.inclusion}
                      restartingSince={restarts[g.server] ?? null}
                      onFlip={handleFlip}
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </section>
    </Frame>
  );
}

function McpServerCard({
  server,
  tools,
  disposition,
  inclusion,
  restartingSince,
  onFlip,
}: {
  server: string;
  tools: McpTool[];
  disposition: ToolDispositionRow | null;
  inclusion: McpServerInclusion | null;
  restartingSince: number | null;
  onFlip: (server: string, next: "direct" | "delegated") => void | Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const current = disposition?.disposition ?? "direct";
  const isDelegated = current === "delegated";
  const selfProtected = SELF_PROTECTED_SERVERS.has(server);
  const restarting =
    restartingSince !== null && Date.now() - restartingSince < 12_000;
  const next: "direct" | "delegated" = isDelegated ? "direct" : "delegated";

  const updatedAt = disposition?.updated_at
    ? formatUpdated(disposition.updated_at)
    : null;
  const updatedBy = disposition?.updated_by ?? null;

  // Two facts the previous render conflated:
  //   1. How many tools does the LLM SEE on every turn? (from inclusion)
  //   2. Do we have a per-tool catalogue we can show? (depends on mode)
  //
  // mode='whitelist' → we know the exact count + the names; render both.
  // mode='all'       → ctrl-api enumerates the live catalogue via
  //                    `hermes mcp test <server>` (issue #185). When the
  //                    discovery succeeded we have the count + the names;
  //                    when it didn't, tool_count is null and we render
  //                    "all tools" as a fallback label.
  // mode='none'      → 0 tools on main; the server is being treated as
  //                    DELEGATED. Render "0 (delegated)" — never "misconfigured".
  // inclusion=null    → API older than 2026-05-30; fall back to the previous
  //                    catalogue-only behaviour, but DON'T say "misconfigured".
  const inclusionMode = inclusion?.mode ?? null;
  const inclusionCount = inclusion?.tool_count ?? null;
  const countLabel: string =
    (inclusionMode === "whitelist" || inclusionMode === "all") &&
    inclusionCount !== null
      ? `${inclusionCount} ${inclusionCount === 1 ? "tool" : "tools"}`
      : inclusionMode === "all"
        ? "all tools"
        : inclusionMode === "none"
          ? "0 tools (delegated)"
          : tools.length > 0
            ? `${tools.length} ${tools.length === 1 ? "tool" : "tools"}`
            : "—";

  return (
    <li className="border border-rule p-5">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div className="flex items-baseline gap-3">
          <span className="font-display text-[22px]">{server}</span>
          <span
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            {countLabel}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{
              color: isDelegated ? "var(--marginalia)" : "var(--brass)",
            }}
            aria-label={`Current disposition: ${current}`}
          >
            {current}
          </span>
          {selfProtected ? (
            <span
              className="font-mono text-[10px] uppercase tracking-[0.22em] px-2 py-1 border border-rule"
              style={{ color: "var(--marginalia)" }}
              title="Self-protected — delegating this server would break Alfred's ability to talk to himself."
            >
              locked
            </span>
          ) : restarting ? (
            <span
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--marginalia)" }}
            >
              hermes restarting…
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onFlip(server, next)}
              className="font-mono text-[10px] uppercase tracking-[0.22em] px-3 py-1 border border-rule"
              style={{ color: "var(--ink)" }}
              aria-label={`Flip ${server} to ${next}`}
            >
              flip to {next}
            </button>
          )}
        </div>
      </div>

      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em] mt-2"
        style={{ color: "var(--marginalia)" }}
      >
        {updatedAt
          ? `last flipped ${updatedAt}${updatedBy ? ` by ${updatedBy}` : ""}`
          : "not yet recorded"}
      </div>

      {tools.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="font-mono text-[10px] uppercase tracking-[0.22em] mt-4"
            style={{ color: "var(--brass)" }}
          >
            {expanded ? "hide tools ▾" : "show tools ▸"}
          </button>
          {expanded ? (
            <ul className="mt-3">
              {tools.map((t) => (
                <li
                  key={`${t.server}::${t.name}`}
                  className="grid grid-cols-[220px_1fr] gap-4 py-2 border-b border-rule items-baseline"
                >
                  <span className="font-mono text-[12px]">{t.name}</span>
                  <span
                    className="font-body text-[14px]"
                    style={{ color: "var(--marginalia)" }}
                  >
                    {t.description}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : inclusionMode === "all" ? (
        // Live discovery failed for this `all`-mode server. The card still
        // says "all tools" but we can't show the names. This is the
        // pre-#185 fallback shape — it should be rare now (Hermes-restart
        // window, container missing, parser mismatch).
        <p
          className="font-body italic text-[13px] mt-3"
          style={{ color: "var(--marginalia)" }}
        >
          Every tool this MCP server advertises is passed through to the
          main runtime. The live catalogue couldn't be read just now —
          Hermes may be restarting; refresh in a few seconds.
        </p>
      ) : inclusionMode === "none" ? (
        <p
          className="font-body italic text-[13px] mt-3"
          style={{ color: "var(--marginalia)" }}
        >
          Tools hidden from main. The server still runs and is reachable
          via <code>delegate_to_focused_agent</code> on the workers profile.
        </p>
      ) : (
        <p
          className="font-body italic text-[13px] mt-3"
          style={{ color: "var(--marginalia)" }}
        >
          (catalogue not yet surfaced — disposition control still works)
        </p>
      )}
    </li>
  );
}

// "2026-05-30 13:27:09" → "today 13:27" / "Wed 13:27" / "2026-05-30"
function formatUpdated(iso: string): string {
  const t = Date.parse(iso.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const now = new Date();
  const sameDay =
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  if (sameDay) return `today ${hh}:${mm} UTC`;
  const days = Math.round((now.getTime() - t) / 86_400_000);
  if (days < 7) {
    return `${d.toUTCString().slice(0, 3)} ${hh}:${mm} UTC`;
  }
  return iso;
}

function ColumnList({
  title,
  rows,
}: {
  title: string;
  rows: { slug: string; display_name: string; description: string; deprecated: boolean }[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3">
      <div
        className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
        style={{ color: "var(--brass)" }}
      >
        {title} · {rows.length}
      </div>
      <ul>
        {rows.map((r) => (
          <li
            key={r.slug}
            className="grid grid-cols-[220px_1fr] gap-4 py-2 border-b border-rule items-baseline"
            style={{ opacity: r.deprecated ? 0.5 : 1 }}
          >
            <span className="font-mono text-[12px]">
              {r.slug}
              {r.deprecated ? " (deprecated)" : ""}
            </span>
            <span
              className="font-body text-[14px]"
              style={{ color: "var(--marginalia)" }}
            >
              {r.description || r.display_name}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
