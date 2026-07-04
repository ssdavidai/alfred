// ClaudeSetupSections — the Claude Setup body (#866; relocated F84).
//
// F84 — the standalone /claude page was folded into Settings → Agent
// Configuration. This module no longer has a default page export; it exports
// <ClaudeSetupSections /> which StudyPage renders below the model matrix at
// /settings#agent. The section JSX, getClaudeSetup query, rotate handler, and
// copy/reveal state are unchanged — only the wrapper (Frame + sidebar nav) was
// dropped; the sections now stack vertically.
//
// Reads getClaudeSetup. Renders these sections (when their data is present):
//
//   • MCP servers       — apps[].mcp_url, copy-revealable
//   • Approval secret   — approval_secret, reveal-once rotate (F77/C16)
//   • Skill             — apps[].skill_url + custom_instructions.url
//   • Composio skills   — composio_skills (one per connected toolkit)
//   • Vault login       — vault_login (Vaultwarden bundle), gated on
//                         tenants that were provisioned with BW
//
// F82 — "Developer / API keys" lives under Settings → API keys; not here.
import { useState, useEffect } from "react";
import {
  useQuery,
  getClaudeSetup,
  rotateApprovalSecret,
  getMcpTokens,
  mintMcpToken,
  rotateMcpToken,
  deleteMcpToken,
} from "wasp/client/operations";

// F77/C16 — the rotate action returns the fresh secret exactly once.
interface RotateApprovalSecretResp {
  approval_secret: string;
}

interface McpApp {
  id: string;
  name: string;
  description: string;
  mcp_url: string | null;
  skill_url: string;
  enabled: boolean;
}

// F75 — the backend returns `{ slug, toolkit, name, description, content }`
// (the full SKILL.md body inlined), NOT a `url`. The page previously declared
// `url` and CopyReveal'd `undefined`.
interface ComposioSkill {
  slug: string;
  toolkit?: string;
  name: string;
  description?: string;
  content: string;
}

interface VaultLogin {
  url: string;
  email: string;
  // F63/C16 — the master password is never echoed on a normal load; the page
  // surfaces only that it is set.
  master_password: string | null;
  master_password_set?: boolean;
}

interface ClaudeSetupResp {
  tenant_url: string | null;
  // F63/C16 — the approval secret is NEVER echoed on a page load. The value is
  // always null here; branch on `approval_secret_set` instead, and surface the
  // value exactly once from the rotate endpoint (see the Approval secret
  // section). `last_rotated_at` is an ISO timestamp or null.
  approval_secret: null;
  approval_secret_set: boolean;
  last_rotated_at: string | null;
  apps: McpApp[];
  custom_instructions: { url: string; filename: string } | null;
  composio_skills: ComposioSkill[] | null;
  vault_login: VaultLogin | null;
}

function CopyReveal({ value, sensitive = false }: { value: string; sensitive?: boolean }) {
  const [shown, setShown] = useState(!sensitive);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 font-mono text-[12px] border border-rule p-2 truncate">
        {shown ? value : "•".repeat(Math.min(value.length, 24))}
      </code>
      {sensitive && (
        <button onClick={() => setShown((s) => !s)} className="btn-ghost">
          {shown ? "Hide" : "Reveal"}
        </button>
      )}
      <button
        onClick={() => {
          navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="btn-ghost"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

// F75 — a skill is a markdown file to download, not a path string to copy.
// Catalogue apps + custom instructions live as SaaS static assets at
// `skill_url` (same-origin, browser-reachable): render a Download anchor +
// an optional "Copy contents" that fetches the body. Lifted from the legacy
// ClaudeSetupContent (SettingsPage), which did this correctly.
function SkillDownload({
  url,
  filename,
  description,
}: {
  url: string;
  filename: string;
  description?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copyContents() {
    try {
      const text = await (await fetch(url)).text();
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* fetch/clipboard blocked — the Download anchor still works */
    }
  }
  return (
    <div>
      {description && (
        <p className="font-body text-[14px] mb-2" style={{ color: "var(--marginalia)" }}>
          {description}
        </p>
      )}
      <div className="flex items-center gap-3">
        <a href={url} download={filename} className="btn-ghost">
          Download .md
        </a>
        <button onClick={copyContents} className="btn-ghost">
          {copied ? "Copied" : "Copy contents"}
        </button>
      </div>
    </div>
  );
}

// F75 — Composio skills carry their full SKILL.md as inlined `content`
// (tenant-specific, no static asset). Offer a Blob download of that body.
function BlobDownload({
  content,
  filename,
  description,
}: {
  content: string;
  filename: string;
  description?: string;
}) {
  const [copied, setCopied] = useState(false);
  function download() {
    const blob = new Blob([content], { type: "text/markdown" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(href);
  }
  async function copyContents() {
    try {
      await navigator.clipboard?.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }
  return (
    <div>
      {description && (
        <p className="font-body text-[14px] mb-2" style={{ color: "var(--marginalia)" }}>
          {description}
        </p>
      )}
      <div className="flex items-center gap-3">
        <button onClick={download} className="btn-ghost">
          Download .md
        </button>
        <button onClick={copyContents} className="btn-ghost">
          {copied ? "Copied" : "Copy contents"}
        </button>
      </div>
    </div>
  );
}

// F63/C16 — Approval secret section. The secret is a long-lived bearer value
// the *mcp-server* checks at its `/approve` endpoint (the device- and
// command-approval gate, also surfaced on the Vaultwarden /admin/invite page)
// — it is NOT an "X-Approval header on write actions" (the prior copy was
// wrong). The value is never echoed on load: surface only that it is set + when
// it was last rotated. A fresh value is shown exactly once after a rotation,
// then we fall back to the set/rotated state.
function ApprovalSecretSection({
  isSet,
  lastRotatedAt,
  onRotated,
}: {
  isSet: boolean;
  lastRotatedAt: string | null;
  onRotated: () => void;
}) {
  // The freshly-rotated value, surfaced exactly once. Never sourced from the
  // page load — only from a deliberate rotate.
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const rotatedLabel = lastRotatedAt
    ? new Date(lastRotatedAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  async function rotate() {
    setBusy(true);
    setError(null);
    try {
      const resp = (await rotateApprovalSecret({})) as RotateApprovalSecretResp;
      setRevealed(resp.approval_secret);
    } catch (e: any) {
      setError(e?.message ?? e?.data?.error ?? "Rotation failed.");
    } finally {
      setBusy(false);
    }
  }

  // Collapse the reveal-once panel back to the set/rotated state; refetch
  // getClaudeSetup so `last_rotated_at` is current.
  function dismiss() {
    setRevealed(null);
    setCopied(false);
    onRotated();
  }

  return (
    <div>
      <h2 className="font-display text-4xl mb-2">Approval secret</h2>
      <p
        className="font-body italic mb-8"
        style={{ color: "var(--marginalia)" }}
      >
        The shared secret Alfred checks before it executes a sensitive action —
        device pairing, command approval, and the Vaultwarden invite gate. Keep
        it private; it is the key to approving actions on your behalf.
      </p>

      {revealed ? (
        // F77/C16 — reveal-once panel. The value is shown a single time after
        // the rotation; it is never persisted in the page or fetched again.
        <div className="border border-rule p-4">
          <p className="font-body text-[15px] mb-3">
            Your new approval secret — copy it now.{" "}
            <strong>It won't be shown again.</strong>
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-[12px] border border-rule p-2 break-all">
              {revealed}
            </code>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(revealed);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="btn-ghost"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button onClick={dismiss} className="btn-ghost mt-4">
            Done — I've copied it
          </button>
        </div>
      ) : (
        <>
          <p className="font-body text-[16px] mb-2">
            {isSet ? "An approval secret is set." : "No approval secret yet."}
          </p>
          {rotatedLabel && (
            <p
              className="font-mono text-[11px] uppercase tracking-[0.18em] mb-6"
              style={{ color: "var(--marginalia)" }}
            >
              Last rotated {rotatedLabel}
            </p>
          )}
          <button onClick={rotate} disabled={busy} className="btn-brass">
            {busy ? "Generating…" : "Generate new approval secret"}
          </button>
          {error && (
            <p
              className="font-body italic text-[13px] mt-3"
              style={{ color: "var(--brass)" }}
            >
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── MCP access tokens ──────────────────────────────────────────────────────
// Per-app scoped bearer tokens for third-party clients that can't do the
// browser OAuth flow (ElevenLabs / LiveKit voice agents, scripts). Each token
// is bound to a single app; mint one per client so it can be rotated/revoked
// in isolation. The raw token is shown exactly once (mint + rotate); the list
// only carries metadata. Backed by getMcpTokens / mintMcpToken /
// rotateMcpToken / deleteMcpToken → ctrl-api → mcp-server /manage/tokens.
interface McpTokenRow {
  id: string;
  app: string;
  label: string;
  prefix: string;
  url: string;
  created_at: number;
  last_used_at: number | null;
  revoked: boolean;
}
interface McpTokensResp {
  tenant?: string;
  public_url?: string;
  transport?: string;
  apps: string[];
  tokens: McpTokenRow[];
}
interface MintTokenResp {
  id: string;
  app: string;
  label: string;
  prefix: string;
  url: string;
  token: string;
}

function fmtTs(ms: number | null): string {
  if (!ms) return "never";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function McpTokensSection() {
  const { data, isLoading, refetch } = useQuery(getMcpTokens);
  const resp = data as McpTokensResp | undefined;
  const apps = resp?.apps ?? [];
  const tokens = resp?.tokens ?? [];

  const [app, setApp] = useState<string>("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<MintTokenResp | null>(null);

  // Default the app picker to the first app once the list loads.
  useEffect(() => {
    if (!app && apps.length > 0) setApp(apps[0]);
  }, [apps, app]);

  function copy(key: string, value: string) {
    navigator.clipboard?.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  }

  async function mint() {
    if (!app || !label.trim()) {
      setError("Pick an app and give the token a label.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = (await mintMcpToken({ app, label: label.trim() })) as MintTokenResp;
      setRevealed(r);
      setLabel("");
      await refetch();
    } catch (e: any) {
      setError(e?.message ?? "Could not mint the token.");
    } finally {
      setBusy(false);
    }
  }

  async function rotate(id: string) {
    setRowBusy(id);
    setError(null);
    try {
      const r = (await rotateMcpToken({ id })) as MintTokenResp;
      setRevealed(r);
      await refetch();
    } catch (e: any) {
      setError(e?.message ?? "Rotation failed.");
    } finally {
      setRowBusy(null);
    }
  }

  async function remove(id: string) {
    setRowBusy(id);
    setError(null);
    try {
      await deleteMcpToken({ id });
      await refetch();
    } catch (e: any) {
      setError(e?.message ?? "Delete failed.");
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <div>
      <h3 className="font-display text-3xl mb-2">MCP access tokens</h3>
      <p className="font-body italic mb-8" style={{ color: "var(--marginalia)" }}>
        Long-lived bearer tokens for connecting one app to a client that can't do the
        browser OAuth flow — a voice agent (ElevenLabs, LiveKit), a script, anything else.
        Each token is scoped to a single app; mint one per client so you can rotate or
        delete it on its own.
      </p>

      {/* Reveal-once panel — the raw token is never shown again. */}
      {revealed && (
        <div className="border border-rule p-4 mb-8">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
            style={{ color: "var(--brass)" }}
          >
            New token for {revealed.app} — “{revealed.label}” · copy it now, it won't be shown again
          </div>
          <div
            className="font-mono text-[10px] uppercase tracking-[0.18em] mb-1"
            style={{ color: "var(--marginalia)" }}
          >
            Token (send as Authorization: Bearer …)
          </div>
          <div className="flex items-center gap-2 mb-3">
            <code className="flex-1 font-mono text-[12px] border border-rule p-2 break-all">
              {revealed.token}
            </code>
            <button onClick={() => copy("tok", revealed.token)} className="btn-ghost">
              {copied === "tok" ? "Copied" : "Copy"}
            </button>
          </div>
          <div
            className="font-mono text-[10px] uppercase tracking-[0.18em] mb-1"
            style={{ color: "var(--marginalia)" }}
          >
            Server URL (transport: Streamable HTTP)
          </div>
          <div className="flex items-center gap-2 mb-4">
            <code className="flex-1 font-mono text-[12px] border border-rule p-2 break-all">
              {revealed.url}
            </code>
            <button onClick={() => copy("url", revealed.url)} className="btn-ghost">
              {copied === "url" ? "Copied" : "Copy"}
            </button>
          </div>
          <button onClick={() => setRevealed(null)} className="btn-ghost">
            Done — I've saved it
          </button>
        </div>
      )}

      {/* Generate control */}
      <div className="border border-rule p-4 mb-8">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
          style={{ color: "var(--marginalia)" }}
        >
          Generate a token
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={app}
            onChange={(e) => setApp(e.target.value)}
            className="bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
            aria-label="app"
          >
            {apps.length === 0 && <option value="">(loading apps…)</option>}
            {apps.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. 'ElevenLabs prod')"
            className="flex-1 min-w-[180px] bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
            onKeyDown={(e) => {
              if (e.key === "Enter") void mint();
            }}
          />
          <button onClick={() => void mint()} disabled={busy || !app} className="btn-brass">
            {busy ? "Generating…" : "Generate"}
          </button>
        </div>
      </div>

      {/* Existing tokens */}
      {isLoading ? (
        <p className="font-body italic text-[15px]" style={{ color: "var(--marginalia)" }}>
          Reading tokens…
        </p>
      ) : tokens.length === 0 ? (
        <p className="font-body italic text-[15px]" style={{ color: "var(--marginalia)" }}>
          No tokens yet. Generate one above to connect a voice agent or script.
        </p>
      ) : (
        <ul className="border-t border-rule">
          {tokens.map((t) => (
            <li
              key={t.id}
              className="grid grid-cols-[100px_1fr_auto] gap-4 py-3 border-b border-rule items-center"
            >
              <span className="font-mono text-[11px] uppercase tracking-[0.14em]">{t.app}</span>
              <div className="min-w-0">
                <div className="font-display italic text-[16px] truncate">{t.label}</div>
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.12em]"
                  style={{ color: "var(--marginalia)" }}
                >
                  {t.prefix}… · added {fmtTs(t.created_at)} · last used {fmtTs(t.last_used_at)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => copy(`url-${t.id}`, t.url)} className="btn-link">
                  {copied === `url-${t.id}` ? "Copied URL" : "Copy URL"}
                </button>
                <button
                  onClick={() => void rotate(t.id)}
                  disabled={rowBusy === t.id}
                  className="btn-link"
                >
                  {rowBusy === t.id ? "…" : "Rotate"}
                </button>
                <button
                  onClick={() => void remove(t.id)}
                  disabled={rowBusy === t.id}
                  className="btn-link"
                  style={{ color: "var(--brass)" }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="font-body italic text-[13px] mt-3" style={{ color: "var(--brass)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

// F84 — the Claude Setup body, rendered inline within Settings → Agent
// Configuration (StudyPage). No Frame, no sidebar nav: each section renders
// only when its data is present, and the sections stack vertically.
export function ClaudeSetupSections() {
  const { data, isLoading, refetch } = useQuery(getClaudeSetup);
  const setup = (data as ClaudeSetupResp | undefined) ?? {
    tenant_url: null,
    approval_secret: null,
    approval_secret_set: false,
    last_rotated_at: null,
    apps: [],
    custom_instructions: null,
    composio_skills: [],
    vault_login: null,
  };

  const hasMcp = setup.apps.length > 0;
  // F63/C16 — surface the section whenever a secret is configured (the value
  // is never present on load), so the principal can see its status / rotate.
  const hasApproval = setup.approval_secret_set;
  const hasSkill = Boolean(setup.custom_instructions);
  const hasComposio =
    Array.isArray(setup.composio_skills) && setup.composio_skills.length > 0;
  const hasVaultLogin = Boolean(setup.vault_login);
  const hasAny =
    hasMcp || hasApproval || hasSkill || hasComposio || hasVaultLogin;

  return (
    <div>
      <h2 className="font-display text-4xl tracking-tight mb-2">Hand off to Claude</h2>
      <p className="font-body italic mb-8" style={{ color: "var(--marginalia)" }}>
        MCP servers, the approval secret, and the skills Claude reads.
      </p>

      {isLoading ? (
        <p
          className="font-body italic text-[16px]"
          style={{ color: "var(--marginalia)" }}
        >
          Reading the setup file…
        </p>
      ) : !hasAny ? (
        <p
          className="font-body italic text-[16px]"
          style={{ color: "var(--marginalia)" }}
        >
          Claude setup isn't ready yet — your tenant is still composing.
        </p>
      ) : (
        <div className="flex flex-col gap-16">
          {hasMcp && (
            <div>
              <h3 className="font-display text-3xl mb-2">MCP servers</h3>
              <p
                className="font-body italic mb-8"
                style={{ color: "var(--marginalia)" }}
              >
                Connect Claude to your household. Add each URL as an MCP
                server in Claude.ai's settings.
              </p>
              <ul className="border-t border-rule">
                {setup.apps
                  .filter((a) => a.enabled && a.mcp_url)
                  .map((a) => (
                    <li
                      key={a.id}
                      className="grid grid-cols-[180px_1fr] gap-6 py-4 border-b border-rule items-center"
                    >
                      <div>
                        <div className="font-display italic text-[20px]">
                          {a.name}
                        </div>
                        <div
                          className="font-mono text-[10px] uppercase tracking-[0.22em]"
                          style={{ color: "var(--marginalia)" }}
                        >
                          {a.id}
                        </div>
                      </div>
                      <CopyReveal value={a.mcp_url!} />
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <McpTokensSection />

          {hasApproval && (
            <ApprovalSecretSection
              isSet={setup.approval_secret_set}
              lastRotatedAt={setup.last_rotated_at}
              onRotated={() => {
                void refetch();
              }}
            />
          )}

          {hasSkill && setup.custom_instructions && (
            <div>
              <h3 className="font-display text-3xl mb-2">Skill</h3>
              <p
                className="font-body italic mb-8"
                style={{ color: "var(--marginalia)" }}
              >
                The instructions Claude reads at the start of every
                turn — paste into your claude.ai profile's
                Personalisation field.
              </p>
              <ul className="border-t border-rule">
                <li className="py-4 border-b border-rule">
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
                    style={{ color: "var(--marginalia)" }}
                  >
                    Custom instructions
                  </div>
                  <SkillDownload
                    url={setup.custom_instructions.url}
                    filename={setup.custom_instructions.filename}
                    description="Paste into your claude.ai profile's Personalisation field."
                  />
                </li>
                {setup.apps
                  .filter((a) => a.enabled && a.skill_url)
                  .map((a) => (
                    <li key={a.id} className="py-4 border-b border-rule">
                      <div
                        className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
                        style={{ color: "var(--marginalia)" }}
                      >
                        {a.name} skill
                      </div>
                      <SkillDownload
                        url={a.skill_url}
                        filename={`alfred-${a.id}.md`}
                        description={a.description}
                      />
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {hasComposio &&
            Array.isArray(setup.composio_skills) &&
            setup.composio_skills.length > 0 && (
              <div>
                <h3 className="font-display text-3xl mb-2">Composio skills</h3>
                <p
                  className="font-body italic mb-8"
                  style={{ color: "var(--marginalia)" }}
                >
                  One per connected toolkit. Each contains the
                  tenant-specific connection id — regenerated when you
                  reconnect.
                </p>
                <ul className="border-t border-rule">
                  {setup.composio_skills.map((s) => (
                    <li
                      key={s.slug}
                      className="grid grid-cols-[180px_1fr] gap-6 py-4 border-b border-rule items-start"
                    >
                      <span className="font-display italic text-[18px]">
                        {s.name || s.slug}
                      </span>
                      <BlobDownload
                        content={s.content}
                        filename={`${s.slug}.md`}
                        description={s.description}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}

          {hasVaultLogin && setup.vault_login && (
            <div>
              <h3 className="font-display text-3xl mb-2">Vault login</h3>
              <p
                className="font-body italic mb-8"
                style={{ color: "var(--marginalia)" }}
              >
                Your private Vaultwarden web UI, with the master
                password Alfred provisioned.
              </p>
              <ul className="border-t border-rule">
                <li className="py-4 border-b border-rule">
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
                    style={{ color: "var(--marginalia)" }}
                  >
                    URL
                  </div>
                  <CopyReveal value={setup.vault_login.url} />
                </li>
                <li className="py-4 border-b border-rule">
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
                    style={{ color: "var(--marginalia)" }}
                  >
                    Email
                  </div>
                  <CopyReveal value={setup.vault_login.email} />
                </li>
                <li className="py-4 border-b border-rule">
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
                    style={{ color: "var(--marginalia)" }}
                  >
                    Master password
                  </div>
                  {/* F63/C16 — the master password is never echoed on load.
                      Show only that it is set; recovery happens through
                      Vaultwarden's own flow. */}
                  {setup.vault_login.master_password ? (
                    <CopyReveal
                      value={setup.vault_login.master_password}
                      sensitive
                    />
                  ) : (
                    <p
                      className="font-body text-[14px]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      {setup.vault_login.master_password_set
                        ? "Set — recover it from your Vaultwarden account settings if you lose it."
                        : "Not provisioned."}
                    </p>
                  )}
                </li>
              </ul>
              <a
                href={setup.vault_login.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-brass mt-6 inline-block"
              >
                Open the vault →
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
