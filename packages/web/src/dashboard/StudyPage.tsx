// StudyPage — unified back office (#867 + #868).
//
// Sections in a sidebar layout:
//
//   • Settings    — agent config (model + agent voice/tone), workspace
//                   files (RULES.md, AGENTS.md, SOUL.md), Vexa toggle.
//   • Account     — billing portal + identity.
//   • API keys    — listApiKeys / createApiKey / revokeApiKey for
//                   programmatic SaaS access.
//   • Audit       — getAuditFeed paginated 50.
//   • Theme       — light / dark toggle via the existing theme context.
//
// Credentials (LLM/provider API keys) was retired as user-facing surface:
// it mixed real principal choices (which LLM to use) with operationally
// dangerous values (Vaultwarden master password) and competed with the
// vault as the source-of-truth for secrets. /dashboard/credentials still
// redirects here (lands on Settings since "credentials" is no longer a
// valid hash).
//
// Ledger was retired — the feature had no producer (no workflow ever
// wrote ledger_entry records); resurface only when there's a real
// financial-tracking surface to populate it.
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
  updateAgentModel,
  getModelCatalog,
  getVexaAutoJoin,
  setVexaAutoJoin,
  getWorkspaceFile,
  updateWorkspaceFile,
  listApiKeys,
  createApiKey,
  revokeApiKey,
  getAuditFeed,
} from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { ModelSelect, type CatalogGroup } from "./AssistantsPage";
import { useTheme } from "../client/lib/theme";
import { useAuth } from "wasp/client/auth";
import { config } from "wasp/client";
import { auditKindLabel } from "./auditLedgerCore";
import { apiBaseUrl } from "./apiKeysCore";

const SECTIONS = [
  "settings",
  "account",
  "api-keys",
  "audit",
  "theme",
] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_LABEL: Record<Section, string> = {
  settings: "Settings",
  account: "Account",
  "api-keys": "API keys",
  audit: "Audit",
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
          {section === "account" && <AccountSection />}
          {section === "api-keys" && <ApiKeysSection />}
          {section === "audit" && <AuditSection />}
          {section === "theme" && <ThemeSection />}
        </article>
      </section>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Settings — model-config matrix (F78 / contract C17)
// ---------------------------------------------------------------------------
//
// The matrix groups every wired agent by its Hermes *profile* (main /
// workers / heavy). Changing a profile's model changes every agent riding
// it, because Hermes binds the model per-profile, not per-agent.
//
// Data sources (both already-shipped, frozen shapes — see C17):
//   • getModelCatalog  → GET /api/v1/admin/models  → { groups: [...] }
//        (read `groups`, NOT `models` — the old SettingsSection read the
//         wrong key, so the picker was always empty.)
//   • getAgentConfig   → GET /api/v1/admin/agents   → { agents: [...], surveyor }
//        where each agent (F68-enriched) carries `profile` + `default_model`
//        (read per-agent `default_model`, NOT a single top-level `.model`).
//   • updateAgentModel → PATCH /api/v1/admin/agents/:agentId/model {model,field?}
//
// Per-profile description + gateway port mirror the frozen ctrl PROFILES list
// (packages/ctrl/src/api/routes/agents.ts). Ordered main → workers → heavy so
// the `heavy` profile (Opus-class, F67) always renders.

interface AgentEntry {
  id: string;
  label: string;
  description: string;
  profile: string;
  default_model: string | null;
}

interface AgentConfigResp {
  agents?: AgentEntry[];
  surveyor?: { labeler_model?: string; embedder_model?: string; embedder_source?: string };
}

interface ModelCatalogResp {
  groups?: CatalogGroup[];
  cached?: boolean;
  fetchedAt?: string;
}

const PROFILE_META: { id: string; label: string; description: string }[] = [
  {
    id: "main",
    label: "Alfred",
    description:
      "Your conversational Alfred on every channel (Slack/Telegram/SMS), with memory.",
  },
  {
    id: "workers",
    label: "Workers",
    description:
      "Clerk (event classification/extraction/reflection), chore execution, surveyor labeling — cheap, high-volume.",
  },
  {
    id: "heavy",
    label: "Heavy",
    description:
      "Onboarding facts/patterns + chore heavy-reasoning — Opus-class, slow and expensive, used sparingly.",
  },
];

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

  // C17 — read `groups` (NOT `.models`), and per-agent `default_model` (NOT a
  // single top-level `.model`). Build a profile → model → riders matrix.
  const cfg = agentCfg as AgentConfigResp | undefined;
  const cat = catalog as ModelCatalogResp | undefined;
  const groups: CatalogGroup[] = Array.isArray(cat?.groups) ? cat!.groups! : [];
  const agents: AgentEntry[] = Array.isArray(cfg?.agents) ? cfg!.agents! : [];

  // Each profile's current model is the default_model of any agent riding it
  // (they share the profile's model). Render in PROFILE_META order so `heavy`
  // always appears even if its rider set changes.
  const profileRows = PROFILE_META.map((p) => {
    const riders = agents.filter((a) => a.profile === p.id);
    const model = riders.find((a) => a.default_model)?.default_model ?? "";
    return { ...p, riders, model };
  }).filter((p) => p.riders.length > 0 || p.model);

  const vexaEnabled = Boolean((vexa as any)?.enabled);
  const [savingProfile, setSavingProfile] = useState<string | null>(null);

  async function changeProfileModel(profileId: string, model: string) {
    const row = profileRows.find((p) => p.id === profileId);
    if (!row || !model || model === row.model) return;
    // PATCH per rider — Hermes binds the model per profile, so every agent on
    // this profile moves together. The endpoint returns {default_model}.
    setSavingProfile(profileId);
    try {
      for (const rider of row.riders) {
        await updateAgentModel({ agentId: rider.id, model });
      }
      await refetchAgent();
    } catch (e) {
      console.error("change model failed", e);
    } finally {
      setSavingProfile(null);
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

      {/* Model-config matrix (C17): one row per Hermes profile. Changing a
          profile's model moves every agent riding it. */}
      <ul className="border-t border-rule mb-12">
        {profileRows.map((p) => (
          <li
            key={p.id}
            className="grid grid-cols-[200px_1fr] gap-6 py-5 border-b border-rule items-start"
          >
            <div>
              <div className="font-display italic text-[18px]">{p.label}</div>
              <p
                className="font-body text-[13px] mt-1"
                style={{ color: "var(--marginalia)" }}
              >
                {p.description}
              </p>
              {p.riders.length > 0 && (
                <p
                  className="font-mono text-[10px] uppercase tracking-[0.18em] mt-2"
                  style={{ color: "var(--brass)" }}
                >
                  {p.riders.map((r) => r.label).join(" · ")}
                </p>
              )}
            </div>
            <div>
              <ModelSelect
                value={p.model}
                onSelect={(model) => changeProfileModel(p.id, model)}
                groups={groups}
                isLoading={!catalog}
                placeholder="Select a model…"
              />
              {savingProfile === p.id && (
                <p
                  className="font-body italic text-[12px] mt-1"
                  style={{ color: "var(--marginalia)" }}
                >
                  Saving…
                </p>
              )}
            </div>
          </li>
        ))}
        <li className="grid grid-cols-[200px_1fr] gap-6 py-5 border-b border-rule items-baseline">
          <span className="font-display italic text-[18px]">Meeting bot</span>
          <div className="flex items-baseline gap-4">
            <span
              className="font-body italic flex-1"
              style={{ color: "var(--marginalia)" }}
            >
              {vexaEnabled ? "Auto-joining" : "Off"}
            </span>
            <button onClick={toggleVexa} className="btn-link">
              {vexaEnabled ? "Stop" : "Start"}
            </button>
          </div>
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
// API keys
// ---------------------------------------------------------------------------

function ApiKeysSection() {
  const { data, refetch } = useQuery(listApiKeys, undefined, { retry: false });
  // The op returns the array directly. Don't do `data?.keys` — Array
  // has a `.keys` PROTOTYPE METHOD, so `data?.keys` on a real array is
  // a bound function (truthy, length=0), which falls through the
  // nullish-coalescing fallback and lies that the list is empty.
  const keys: any[] = Array.isArray(data)
    ? data
    : Array.isArray((data as any)?.keys)
      ? (data as any).keys
      : [];
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

  // F76 — programmatic base = the Wasp server host (api. subdomain), NOT the
  // apex SPA host and NOT the dead /user-api. e.g. https://api.alfred.black.
  const apiBase = apiBaseUrl(config.apiUrl);
  const [showQuickStart, setShowQuickStart] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <H>API keys</H>
        <a
          href="https://docs.alfred.black"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost font-mono text-[10px] uppercase tracking-[0.22em] whitespace-nowrap"
        >
          Docs ↗
        </a>
      </div>
      {/* F76 — drop "SaaS". */}
      <Sub>For programmatic access to your Alfred.</Sub>

      {/* F76 — expandable quick-start with a verified curl against the api.
          subdomain (api/v1, NOT /user-api). */}
      <div className="mb-6">
        <button
          onClick={() => setShowQuickStart((s) => !s)}
          className="btn-link font-mono text-[11px] uppercase tracking-[0.22em]"
        >
          {showQuickStart ? "Quick start ▾" : "Quick start ▸"}
        </button>
        {showQuickStart && (
          <pre
            className="font-mono text-[12px] mt-3 p-4 overflow-x-auto whitespace-pre"
            style={{ background: "rgba(0,0,0,0.04)", border: "1px solid var(--rule)" }}
          >
{`# Test your key (200 = key works, 401 = bad key)
curl ${apiBase}/api/v1/health \\
  -H "Authorization: Bearer alf_your_key_here"

# Read your vault summary (record counts by type)
curl ${apiBase}/api/v1/vault/context \\
  -H "Authorization: Bearer alf_your_key_here"

# Create a note
curl -X POST ${apiBase}/api/v1/vault/records \\
  -H "Authorization: Bearer alf_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"note","name":"My Note","body":"Content here"}'`}
          </pre>
        )}
      </div>

      {created && (
        <div
          className="border-2 p-5 mb-6"
          style={{
            borderColor: "var(--brass)",
            background: "var(--paper)",
          }}
        >
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2 font-extrabold"
            style={{ color: "var(--brass)" }}
          >
            Copy this now — it will never be shown again
          </div>
          <p
            className="font-body italic text-[13px] mb-3"
            style={{ color: "var(--marginalia)" }}
          >
            This banner stays until you click Done. Once dismissed, the
            full key is gone forever — only the prefix below remains for
            identification. If you lose the key, revoke it and create a
            new one.
          </p>
          <code
            className="font-mono text-[13px] block break-all p-3 mb-3"
            style={{
              background: "rgba(0,0,0,0.04)",
              border: "1px solid var(--rule)",
            }}
          >
            {created}
          </code>
          <div className="flex gap-3 items-center">
            <button
              onClick={() => {
                navigator.clipboard?.writeText(created);
              }}
              className="btn-brass"
            >
              Copy to clipboard
            </button>
            <button onClick={() => setCreated(null)} className="btn-link">
              I've saved it — dismiss
            </button>
          </div>
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
              className="grid grid-cols-[1fr_180px_180px_100px] gap-4 py-3 border-b border-rule items-baseline"
            >
              <span className="font-display italic text-[18px] truncate">
                {String(k.name ?? "Untitled")}
              </span>
              <code
                className="font-mono text-[12px]"
                style={{ color: "var(--marginalia)" }}
                title="Key prefix (last 24 chars hidden — only shown once at creation)"
              >
                {String(k.keyPrefix ?? "")}
                {k.keyPrefix ? "…" : ""}
              </code>
              <span
                className="font-mono text-[11px]"
                style={{ color: "var(--marginalia)" }}
              >
                {formatKeyDate(k.createdAt)}
                {k.lastUsedAt ? ` · used ${formatKeyDate(k.lastUsedAt)}` : ""}
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

// F53/C12 — the C12 audit-ledger item shape (one row per user action).
interface AuditItem {
  id: string;
  ts: string;
  action_type: string;
  actor: string | null;
  headline: string | null;
  note: string | null;
  source: string | null;
  reversible: boolean;
  reversed_at: string | null;
}

function AuditSection() {
  // F53 — UI toggle for ?include_automated=1 (steward/auto noise hidden by
  // default; the principal can now reach it from the page).
  const [includeAutomated, setIncludeAutomated] = useState(false);
  const { data } = useQuery(
    getAuditFeed,
    { includeAutomated },
    { retry: false, refetchInterval: 60_000 },
  );
  // F53/C12 — single SQL ledger: {items:[{id,ts,action_type,headline,note,…}]}.
  // One row per action — no more needs_attention_action + desk-action twin.
  const items = Array.isArray((data as any)?.items)
    ? ((data as any).items as AuditItem[])
    : [];

  return (
    <div>
      <H>Audit</H>
      <Sub>Every act Alfred has taken on your behalf.</Sub>
      <label
        className="flex items-center gap-2 mb-4 font-mono text-[10px] uppercase tracking-[0.2em] cursor-pointer"
        style={{ color: "var(--marginalia)" }}
      >
        <input
          type="checkbox"
          checked={includeAutomated}
          onChange={(e) => setIncludeAutomated(e.target.checked)}
        />
        Show automated activity
      </label>
      {items.length === 0 ? (
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
                Kind
              </th>
              <th className="text-left py-2 uppercase tracking-[0.2em] text-[10px] font-normal">
                Act
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id} className="border-b border-rule">
                <td
                  className="py-3 pr-3 align-top whitespace-nowrap"
                  style={{ color: "var(--marginalia)" }}
                >
                  {formatAuditWhen(a.ts)}
                </td>
                <td
                  className="py-3 pr-3 align-top whitespace-nowrap uppercase tracking-[0.18em] text-[10px]"
                  style={{ color: "var(--brass)" }}
                >
                  {auditKindLabel(a.action_type)}
                </td>
                <td className="py-3 pr-3 font-body text-[15px]">
                  {a.headline || "(no headline)"}
                  {a.note ? (
                    <span style={{ color: "var(--marginalia)" }}> — {a.note}</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function formatKeyDate(value: unknown): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return "—";
  // "13 May 2026" — letterpress-style, matches the Connections table.
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}

function formatAuditWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

function AccountSection() {
  const { data: user } = useAuth();

  if (!user) return null;
  // Single-VM: no billing, no subscription plan. The account is identified
  // by email and role (owner vs member).
  const role = (user as any).isOwner ? "Owner" : "Member";

  return (
    <div>
      <H>Your account</H>
      <Sub>The standing details — email and role on this household.</Sub>

      <dl className="grid grid-cols-[140px_1fr] gap-y-4 font-body text-[15px] max-w-[560px]">
        <dt className="font-mono text-[10px] uppercase tracking-[0.22em] pt-1" style={{ color: "var(--marginalia)" }}>
          Email
        </dt>
        <dd>{user.email ?? "—"}</dd>

        {(user as any).username && (
          <>
            <dt className="font-mono text-[10px] uppercase tracking-[0.22em] pt-1" style={{ color: "var(--marginalia)" }}>
              Username
            </dt>
            <dd>{(user as any).username}</dd>
          </>
        )}

        <dt className="font-mono text-[10px] uppercase tracking-[0.22em] pt-1" style={{ color: "var(--marginalia)" }}>
          Role
        </dt>
        <dd>{role}</dd>
      </dl>
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
