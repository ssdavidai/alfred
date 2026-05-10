// ToolsPage2 — gateway allowlist viewer, restyled (#865).
//
// Reads getAllowedTools (the same op the legacy ToolsPage uses). Renders
// a flat audit of every tool the OpenClaw gateway will currently let
// through: per-app actions/streams + built-in primitives + MCP servers.
// Visual restyle only — no logic or data changes.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, getAllowedTools } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";

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

export default function ToolsPage2() {
  const { data, isLoading } = useQuery(getAllowedTools);
  const apps: AppEntry[] = (data?.apps ?? []) as AppEntry[];
  const builtins: BuiltinTool[] = (data?.builtin_tools ?? []) as BuiltinTool[];
  const mcps: McpTool[] = (data?.mcp_tools ?? []) as McpTool[];

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
          className="font-body text-[16px] max-w-[60ch] mb-10"
          style={{ color: "var(--marginalia)" }}
        >
          Every tool, stream, and MCP endpoint the gateway will currently
          let through. {totalCount > 0 ? `${totalCount} entries.` : ""}
        </p>

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

            {/* MCP tools */}
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
                  MCP servers
                </h2>
                <span
                  className="font-mono text-[10px] uppercase tracking-[0.28em]"
                  style={{ color: "var(--marginalia)" }}
                >
                  {filteredMcps.length}
                </span>
              </div>
              {filteredMcps.length === 0 ? (
                <p
                  className="font-body italic text-[14px]"
                  style={{ color: "var(--marginalia)" }}
                >
                  None.
                </p>
              ) : (
                <ul>
                  {filteredMcps.map((m) => (
                    <li
                      key={`${m.server}::${m.name}`}
                      className="grid grid-cols-[220px_140px_1fr] gap-4 py-3 border-b border-rule items-baseline"
                    >
                      <span className="font-mono text-[12px]">{m.name}</span>
                      <span
                        className="font-mono text-[10px] uppercase tracking-[0.22em]"
                        style={{ color: "var(--brass)" }}
                      >
                        {m.server}
                      </span>
                      <span
                        className="font-body text-[14px]"
                        style={{ color: "var(--marginalia)" }}
                      >
                        {m.description}
                      </span>
                    </li>
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
