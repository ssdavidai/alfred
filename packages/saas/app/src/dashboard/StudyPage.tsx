// StudyPage — unified back office (#867 + #868).
//
// Six sections in a sidebar layout:
//
//   • Settings    — agent config (model + agent voice/tone), workspace
//                   files (RULES.md, AGENTS.md, SOUL.md), Vexa toggle.
//   • Credentials — getCredentials + updateCredentials (API keys for
//                   third-party services: Sure, Plane, OpenRouter, …).
//   • API keys    — listApiKeys / createApiKey / revokeApiKey for
//                   programmatic SaaS access.
//   • Audit       — getActivityFeed paginated 50.
//   • Ledger      — getLedgerEntries paginated 50.
//   • Theme       — light / dark toggle via the existing theme context.
//
// Standing rules editor: parses RULES.md as a bullet list, edits via
// updateWorkspaceFile (whole-file replace).
//
// Anchor support: ?section=<name> or #<name> deep-links from /claude
// and the legacy /back-office, /dashboard/settings, /dashboard/credentials,
// /dashboard/api-docs redirects.
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  useQuery,
  getAgentConfig,
  updateAgentConfig,
  updateAgentModel,
  getModelCatalog,
  getVexaAutoJoin,
  setVexaAutoJoin,
  getWorkspaceFile,
  updateWorkspaceFile,
  getCredentials,
  updateCredentials,
  listApiKeys,
  createApiKey,
  revokeApiKey,
  getActivityFeed,
  getLedgerEntries,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { useTheme } from "../client/lib/theme";

const SECTIONS = [
  "settings",
  "credentials",
  "api-keys",
  "audit",
  "ledger",
  "theme",
] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_LABEL: Record<Section, string> = {
  settings: "Settings",
  credentials: "Credentials",
  "api-keys": "API keys",
  audit: "Audit",
  ledger: "Ledger",
  theme: "Theme",
};

function H({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-display text-4xl tracking-tight mb-2">{children}</h2>
  );
}
function Sub({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="font-body italic mb-8"
      style={{ color: "var(--marginalia)" }}
    >
      {children}
    </p>
  );
}

export default function StudyPage() {
  const { hash } = useLocation();
  const initial = useMemo<Section>(() => {
    const want = hash.replace(/^#/, "").trim();
    return (SECTIONS as readonly string[]).includes(want)
      ? (want as Section)
      : "settings";
  }, [hash]);
  const [section, setSection] = useState<Section>(initial);

  // Sync hash when sidebar selection changes — preserves deep-link
  // semantics for the redirects.
  useEffect(() => {
    if (typeof window !== "undefined") {
      const next = `#${section}`;
      if (window.location.hash !== next) {
        window.history.replaceState(null, "", next);
      }
    }
  }, [section]);

  return (
    <Frame>
      <section className="mx-auto max-w-[1240px] px-8 py-12 grid md:grid-cols-[260px_1fr] gap-12 items-start">
        <aside className="md:sticky md:top-12">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
            style={{ color: "var(--brass)" }}
          >
            The Study
          </div>
          <div className="font-display text-3xl italic mb-8">Settings</div>
          <nav className="border-t border-rule">
            {SECTIONS.map((s) => {
              const active = s === section;
              return (
                <button
                  key={s}
                  onClick={() => setSection(s)}
                  className="w-full text-left py-3 pl-3 border-b border-rule font-display italic text-[18px]"
                  style={{
                    color: active ? "var(--ink)" : "var(--marginalia)",
                    borderLeft: active
                      ? "2px solid var(--brass)"
                      : "2px solid transparent",
                    background: active
                      ? "color-mix(in oklab, var(--brass) 6%, transparent)"
                      : "transparent",
                  }}
                >
                  {SECTION_LABEL[s]}
                </button>
              );
            })}
          </nav>
          <div className="mt-8">
            <Link
              to="/desk"
              className="font-mono text-[11px] uppercase tracking-[0.22em]"
              style={{ color: "var(--brass)" }}
            >
              ← Back to today
            </Link>
          </div>
        </aside>

        <article>
          {section === "settings" && <SettingsSection />}
          {section === "credentials" && <CredentialsSection />}
          {section === "api-keys" && <ApiKeysSection />}
          {section === "audit" && <AuditSection />}
          {section === "ledger" && <LedgerSection />}
          {section === "theme" && <ThemeSection />}
        </article>
      </section>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function SettingsSection() {
  const { data: agentCfg, refetch: refetchAgent } = useQuery(getAgentConfig, undefined, {
    retry: false,
  });
  const { data: catalog } = useQuery(getModelCatalog, undefined, { retry: false });
  const { data: vexa, refetch: refetchVexa } = useQuery(getVexaAutoJoin, undefined, {
    retry: false,
  });
  const { data: rulesData, refetch: refetchRules } = useQuery(
    getWorkspaceFile,
    { filename: "RULES.md" },
    { retry: false },
  );
  const rulesText = String((rulesData as any)?.content ?? "");

  const rules = useMemo(
    () =>
      rulesText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2).trim())
        .filter(Boolean),
    [rulesText],
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [savingRules, setSavingRules] = useState(false);

  function beginEdit() {
    setDraft(rules.length ? rules : [""]);
    setEditing(true);
  }
  async function saveRules() {
    setSavingRules(true);
    try {
      const cleaned = draft.map((r) => r.trim()).filter(Boolean);
      const content =
        cleaned.length === 0
          ? "# Standing rules\n"
          : `# Standing rules\n\n${cleaned.map((r) => `- ${r}`).join("\n")}\n`;
      await updateWorkspaceFile({ filename: "RULES.md", content });
      await refetchRules();
      setEditing(false);
    } catch (e) {
      console.error("save rules failed", e);
    } finally {
      setSavingRules(false);
    }
  }

  const currentModel = String((agentCfg as any)?.model ?? "");
  const models: string[] = Array.isArray((catalog as any)?.models)
    ? ((catalog as any).models as any[]).map((m) => String(m?.id ?? m))
    : [];
  const vexaEnabled = Boolean((vexa as any)?.enabled);

  async function changeModel(model: string) {
    if (!model || model === currentModel) return;
    try {
      // The agent config response carries `agents[].id` for every wired
      // agent. Default agent for the model picker is `alfred` (the
      // user-facing one); fall back to the first registered agent.
      const agents = Array.isArray((agentCfg as any)?.agents)
        ? ((agentCfg as any).agents as any[])
        : [];
      const target =
        agents.find((a) => String(a?.id ?? "") === "alfred") ?? agents[0];
      const agentId = String(target?.id ?? "alfred");
      await updateAgentModel({ agentId, model });
      await refetchAgent();
    } catch (e) {
      console.error("change model failed", e);
    }
  }

  async function toggleVexa() {
    try {
      await setVexaAutoJoin({ enabled: !vexaEnabled });
      await refetchVexa();
    } catch (e) {
      console.error("vexa toggle failed", e);
    }
  }

  return (
    <div>
      <H>Settings</H>
      <Sub>The arrangement, in plain words.</Sub>

      <ul className="border-t border-rule mb-12">
        <li className="grid grid-cols-[1fr_1fr_140px] gap-4 py-4 border-b border-rule items-baseline">
          <span className="font-display italic text-[18px]">Model</span>
          <select
            value={currentModel}
            onChange={(e) => changeModel(e.target.value)}
            className="bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
          >
            <option value={currentModel}>{currentModel || "—"}</option>
            {models
              .filter((m) => m !== currentModel)
              .map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
          </select>
          <span className="text-right">&nbsp;</span>
        </li>
        <li className="grid grid-cols-[1fr_1fr_140px] gap-4 py-4 border-b border-rule items-baseline">
          <span className="font-display italic text-[18px]">Meeting bot</span>
          <span
            className="font-body italic"
            style={{ color: "var(--marginalia)" }}
          >
            {vexaEnabled ? "Auto-joining" : "Off"}
          </span>
          <button onClick={toggleVexa} className="btn-link text-right">
            {vexaEnabled ? "Stop" : "Start"}
          </button>
        </li>
      </ul>

      <H>Standing rules</H>
      <Sub>One line per rule. Whatever you write here, I keep.</Sub>
      {!editing ? (
        <>
          {rules.length === 0 ? (
            <p
              className="font-body italic text-[15px] mb-4"
              style={{ color: "var(--marginalia)" }}
            >
              No standing rules yet.
            </p>
          ) : (
            <ul className="border-t border-rule mb-4">
              {rules.map((r, i) => (
                <li
                  key={`${i}-${r}`}
                  className="py-3 border-b border-rule font-body text-[16px]"
                >
                  {r}
                </li>
              ))}
            </ul>
          )}
          <button onClick={beginEdit} className="btn-ghost">
            Edit rules
          </button>
        </>
      ) : (
        <div>
          {draft.map((r, i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr_auto] gap-3 py-2 border-b border-rule items-baseline"
            >
              <input
                value={r}
                onChange={(e) =>
                  setDraft((d) => d.map((x, j) => (j === i ? e.target.value : x)))
                }
                className="bg-transparent border-b font-body text-[16px] outline-none pb-1"
                style={{ borderColor: "var(--rule)" }}
              />
              <button
                onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                className="btn-link"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            onClick={() => setDraft((d) => [...d, ""])}
            className="btn-link mt-3"
          >
            + Add a rule
          </button>
          <div className="mt-4 flex gap-3">
            <button
              onClick={saveRules}
              disabled={savingRules}
              className="btn-brass"
            >
              {savingRules ? "…" : "Save rules"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setDraft([]);
              }}
              className="btn-ghost"
              disabled={savingRules}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function CredentialsSection() {
  const { data: credsData, refetch } = useQuery(getCredentials, undefined, {
    retry: false,
  });
  const creds = (credsData as any)?.credentials ?? credsData ?? {};
  const entries = Object.entries(creds as Record<string, unknown>);

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const updates: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(drafts)) {
        updates[k] = v.trim() ? v.trim() : null;
      }
      await updateCredentials(updates);
      setDrafts({});
      await refetch();
    } catch (e) {
      console.error("update credentials failed", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <H>Credentials</H>
      <Sub>Keys to the third-party services I act through. Stored on your tenant.</Sub>
      {entries.length === 0 ? (
        <p
          className="font-body italic text-[15px]"
          style={{ color: "var(--marginalia)" }}
        >
          Nothing yet.
        </p>
      ) : (
        <ul className="border-t border-rule">
          {entries.map(([k, v]) => {
            const set = Boolean(v);
            return (
              <li
                key={k}
                className="grid grid-cols-[1fr_1fr_120px] gap-4 py-4 border-b border-rule items-baseline"
              >
                <span className="font-display italic text-[18px]">{k}</span>
                <input
                  type="password"
                  placeholder={set ? "•••••••• (set)" : "Not set"}
                  value={drafts[k] ?? ""}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [k]: e.target.value }))
                  }
                  className="bg-transparent border-b font-mono text-[12px] outline-none pb-1"
                  style={{ borderColor: "var(--rule)" }}
                />
                <span
                  className="font-mono text-[10px] uppercase tracking-[0.22em] text-right"
                  style={{ color: set ? "var(--brass)" : "var(--marginalia)" }}
                >
                  {set ? "set" : "—"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {Object.keys(drafts).length > 0 && (
        <button onClick={save} disabled={busy} className="btn-brass mt-6">
          {busy ? "…" : "Save credentials"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

function ApiKeysSection() {
  const { data, refetch } = useQuery(listApiKeys, undefined, { retry: false });
  const keys = (data as any)?.keys ?? data ?? [];
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) return;
    setBusy("create");
    try {
      const result: any = await createApiKey({ name: name.trim() });
      const token = String(result?.token ?? result?.key ?? "");
      if (token) setCreated(token);
      setName("");
      await refetch();
    } catch (e) {
      console.error("create key failed", e);
    } finally {
      setBusy(null);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this key?")) return;
    setBusy(id);
    try {
      await revokeApiKey({ id });
      await refetch();
    } catch (e) {
      console.error("revoke failed", e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <H>API keys</H>
      <Sub>For programmatic access to your Alfred SaaS account.</Sub>

      {created && (
        <div
          className="border border-rule p-4 mb-6"
          style={{ borderColor: "var(--brass)" }}
        >
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
            style={{ color: "var(--brass)" }}
          >
            Save this — it will not be shown again
          </div>
          <code className="font-mono text-[12px] block break-all">{created}</code>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(created);
            }}
            className="btn-ghost mt-3"
          >
            Copy
          </button>
          <button onClick={() => setCreated(null)} className="btn-link mt-3">
            Done
          </button>
        </div>
      )}

      <ul className="border-t border-rule mb-6">
        {(keys as any[]).length === 0 ? (
          <li className="py-4">
            <p
              className="font-body italic text-[15px]"
              style={{ color: "var(--marginalia)" }}
            >
              No keys yet.
            </p>
          </li>
        ) : (
          (keys as any[]).map((k) => (
            <li
              key={String(k.id)}
              className="grid grid-cols-[1fr_1fr_140px] gap-4 py-3 border-b border-rule items-baseline"
            >
              <span className="font-display italic text-[18px]">
                {String(k.name ?? "Untitled")}
              </span>
              <span
                className="font-mono text-[12px]"
                style={{ color: "var(--marginalia)" }}
              >
                {k.lastUsedAt ? `last used ${k.lastUsedAt}` : "unused"}
              </span>
              <button
                onClick={() => revoke(String(k.id))}
                disabled={busy === String(k.id)}
                className="btn-link text-right"
              >
                {busy === String(k.id) ? "…" : "Revoke"}
              </button>
            </li>
          ))
        )}
      </ul>

      <div className="flex gap-2 items-baseline">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key label, e.g. claude-cli"
          className="flex-1 bg-transparent border-b font-body text-[16px] outline-none pb-1"
          style={{ borderColor: "var(--rule)" }}
        />
        <button
          onClick={create}
          disabled={busy === "create" || !name.trim()}
          className="btn-brass"
        >
          {busy === "create" ? "…" : "Generate key"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function AuditSection() {
  const { data } = useQuery(getActivityFeed, undefined, {
    retry: false,
    refetchInterval: 60_000,
  });
  const rows = Array.isArray((data as any)?.results)
    ? (data as any).results
    : Array.isArray((data as any)?.events)
      ? (data as any).events
      : Array.isArray(data)
        ? (data as any)
        : [];

  return (
    <div>
      <H>Audit</H>
      <Sub>Every act Alfred has taken on your behalf.</Sub>
      {rows.length === 0 ? (
        <p
          className="font-body italic text-[15px]"
          style={{ color: "var(--marginalia)" }}
        >
          Nothing yet.
        </p>
      ) : (
        <table className="w-full font-mono text-[12px]">
          <thead>
            <tr
              className="border-y border-rule"
              style={{ color: "var(--marginalia)" }}
            >
              <th className="text-left py-2 uppercase tracking-[0.2em] text-[10px] font-normal">
                When
              </th>
              <th className="text-left py-2 uppercase tracking-[0.2em] text-[10px] font-normal">
                Act
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 50).map((a: any, i: number) => (
              <tr key={`${a?.id ?? i}`} className="border-b border-rule">
                <td className="py-3 pr-3 align-top" style={{ color: "var(--marginalia)" }}>
                  {String(a?.created_at ?? a?.timestamp ?? "")}
                </td>
                <td className="py-3 pr-3 font-body text-[15px]">
                  {String(
                    a?.summary ??
                      a?.title ??
                      a?.message ??
                      a?.event_type ??
                      "—",
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

function LedgerSection() {
  const { data } = useQuery(getLedgerEntries, undefined, {
    retry: false,
    refetchInterval: 60_000,
  });
  const rows = Array.isArray((data as any)?.results)
    ? (data as any).results
    : Array.isArray(data)
      ? (data as any)
      : [];

  return (
    <div>
      <H>Ledger</H>
      <Sub>Every transaction Alfred has logged.</Sub>
      {rows.length === 0 ? (
        <p
          className="font-body italic text-[15px]"
          style={{ color: "var(--marginalia)" }}
        >
          Nothing yet.
        </p>
      ) : (
        <table className="w-full font-mono text-[12px]">
          <thead>
            <tr
              className="border-y border-rule"
              style={{ color: "var(--marginalia)" }}
            >
              <th className="text-left py-2 uppercase tracking-[0.2em] text-[10px] font-normal">
                Date
              </th>
              <th className="text-left py-2 uppercase tracking-[0.2em] text-[10px] font-normal">
                Entry
              </th>
              <th className="text-right py-2 uppercase tracking-[0.2em] text-[10px] font-normal">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 50).map((e: any, i: number) => {
              const fm = e?.frontmatter ?? e ?? {};
              return (
                <tr
                  key={`${e?.path ?? i}`}
                  className="border-b border-rule"
                >
                  <td
                    className="py-3 pr-3 align-top"
                    style={{ color: "var(--marginalia)" }}
                  >
                    {String(fm.created ?? fm.date ?? "")}
                  </td>
                  <td className="py-3 pr-3 font-body text-[15px]">
                    {String(
                      fm.description ?? fm.summary ?? e?.name ?? "—",
                    )}
                  </td>
                  <td className="py-3 text-right">
                    {fm.amount != null ? String(fm.amount) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function ThemeSection() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <H>Hours of the day</H>
      <Sub>
        {theme === "dark"
          ? "After dark — wool and brass."
          : "Daylight — ivory and ink."}
      </Sub>
      <div className="flex gap-2">
        <button
          onClick={() => setTheme("light")}
          className="font-mono text-[10px] uppercase tracking-[0.22em] px-3 py-2 border"
          style={{
            borderColor: theme === "light" ? "var(--brass)" : "var(--rule)",
            color: theme === "light" ? "var(--brass)" : "var(--marginalia)",
          }}
        >
          Day
        </button>
        <button
          onClick={() => setTheme("dark")}
          className="font-mono text-[10px] uppercase tracking-[0.22em] px-3 py-2 border"
          style={{
            borderColor: theme === "dark" ? "var(--brass)" : "var(--rule)",
            color: theme === "dark" ? "var(--brass)" : "var(--marginalia)",
          }}
        >
          Night
        </button>
      </div>
    </div>
  );
}
