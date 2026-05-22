// ClaudePage — Claude Setup, restyled (#866).
//
// Reads getClaudeSetup. Renders five sections in a sidebar layout:
//
//   • MCP servers       — apps[].mcp_url, copy-revealable
//   • Approval secret   — approval_secret, copy-revealable
//   • Skill             — apps[].skill_url + custom_instructions.url
//   • Composio skills   — composio_skills (one per connected toolkit)
//   • Vault login       — vault_login (Vaultwarden bundle), gated on
//                         tenants that were provisioned with BW
//
// "Developer / API keys" lives at /study#credentials per the spec — we
// link to that section rather than duplicate it here.
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, getClaudeSetup } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";

const SECTIONS = [
  "MCP servers",
  "Approval secret",
  "Skill",
  "Composio skills",
  "Vault login",
] as const;
type Section = (typeof SECTIONS)[number];

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
  master_password: string;
}

interface ClaudeSetupResp {
  tenant_url: string | null;
  approval_secret: string | null;
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

export default function ClaudePage() {
  const { data, isLoading } = useQuery(getClaudeSetup);
  const setup = (data as ClaudeSetupResp | undefined) ?? {
    tenant_url: null,
    approval_secret: null,
    apps: [],
    custom_instructions: null,
    composio_skills: [],
    vault_login: null,
  };

  // Filter active sections.
  const availableSections: Section[] = SECTIONS.filter((s) => {
    if (s === "MCP servers") return setup.apps.length > 0;
    if (s === "Approval secret") return Boolean(setup.approval_secret);
    if (s === "Skill") return Boolean(setup.custom_instructions);
    if (s === "Composio skills")
      return Array.isArray(setup.composio_skills) && setup.composio_skills.length > 0;
    if (s === "Vault login") return Boolean(setup.vault_login);
    return false;
  });

  const [section, setSection] = useState<Section>(
    availableSections[0] ?? "MCP servers",
  );

  return (
    <Frame>
      <section className="mx-auto max-w-[1240px] px-8 py-12 grid md:grid-cols-[260px_1fr] gap-12 items-start">
        <aside className="md:sticky md:top-12">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
            style={{ color: "var(--brass)" }}
          >
            Claude Setup
          </div>
          <div className="font-display text-3xl italic mb-8">Hand off to Claude</div>
          <nav className="border-t border-rule">
            {availableSections.map((s) => (
              <button
                key={s}
                onClick={() => setSection(s)}
                className="w-full text-left py-3 border-b border-rule font-display italic text-[18px]"
                style={{
                  color: s === section ? "var(--ink)" : "var(--marginalia)",
                }}
              >
                {s}
              </button>
            ))}
          </nav>
          <div className="mt-8 pt-4 border-t border-rule">
            <Link
              to="/study#credentials"
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--brass)" }}
            >
              Developer / API keys →
            </Link>
          </div>
        </aside>

        <article>
          {isLoading ? (
            <p
              className="font-body italic text-[16px]"
              style={{ color: "var(--marginalia)" }}
            >
              Reading the setup file…
            </p>
          ) : availableSections.length === 0 ? (
            <p
              className="font-body italic text-[16px]"
              style={{ color: "var(--marginalia)" }}
            >
              Claude setup isn't ready yet — your tenant is still composing.
            </p>
          ) : (
            <>
              {section === "MCP servers" && (
                <div>
                  <h2 className="font-display text-4xl mb-2">MCP servers</h2>
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

              {section === "Approval secret" && setup.approval_secret && (
                <div>
                  <h2 className="font-display text-4xl mb-2">Approval secret</h2>
                  <p
                    className="font-body italic mb-8"
                    style={{ color: "var(--marginalia)" }}
                  >
                    Claude must include this in the X-Approval header on
                    write actions.
                  </p>
                  <CopyReveal value={setup.approval_secret} sensitive />
                </div>
              )}

              {section === "Skill" && setup.custom_instructions && (
                <div>
                  <h2 className="font-display text-4xl mb-2">Skill</h2>
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
                        <li
                          key={a.id}
                          className="py-4 border-b border-rule"
                        >
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

              {section === "Composio skills" &&
                Array.isArray(setup.composio_skills) &&
                setup.composio_skills.length > 0 && (
                  <div>
                    <h2 className="font-display text-4xl mb-2">
                      Composio skills
                    </h2>
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

              {section === "Vault login" && setup.vault_login && (
                <div>
                  <h2 className="font-display text-4xl mb-2">Vault login</h2>
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
                      <CopyReveal
                        value={setup.vault_login.master_password}
                        sensitive
                      />
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
            </>
          )}
        </article>
      </section>
    </Frame>
  );
}
