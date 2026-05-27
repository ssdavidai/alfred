// Claude setup — single endpoint that returns everything Sir needs to wire
// up his claude.ai Custom Connectors + Custom Skills:
//
//   - Per-app MCP URL (https://<sub>.alfred.black/<app>/mcp)
//   - Approval secret (the value shown on the Vaultwarden /admin/invite
//     gate — the same secret across all apps on a tenant)
//   - Skill download URL (served from the SaaS app's public/mcp-skills/)
//
// Reachable from the dashboard's Settings page. Authentication piggybacks
// on the existing AAS_API_KEY bearer auth that wraps every other admin
// route, so the approval secret is never exposed without auth.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";
import { COMPOSE_DIR, dockerComposeCmd } from "../helpers.js";

const ENV_PATH = `${COMPOSE_DIR}/.env`;
const ROTATED_AT_KEY = "MCP_APPROVAL_SECRET_ROTATED_AT";

/** Read a single key's value from the tenant .env (best-effort). */
function readEnvKey(key: string): string | null {
  let content = "";
  try {
    content = fs.readFileSync(ENV_PATH, "utf-8");
  } catch {
    return null;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    if (trimmed.slice(0, eqIdx).trim() === key) return trimmed.slice(eqIdx + 1).trim();
  }
  return null;
}

/** Surgically update keys in the tenant .env, preserving comments/order/other
 *  keys. Mirrors credentials.ts patchEnv (kept local — small, no shared dep). */
function patchEnv(updates: Record<string, string>): void {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(ENV_PATH, "utf-8").split("\n");
  } catch {
    lines = [];
  }
  const remaining = new Map(Object.entries(updates));
  const result = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!remaining.has(key)) return line;
    const v = remaining.get(key)!;
    remaining.delete(key);
    return `${key}=${v}`;
  });
  for (const [key, value] of remaining) result.push(`${key}=${value}`);
  const content = result.join("\n");
  fs.writeFileSync(ENV_PATH, content.endsWith("\n") ? content : content + "\n", "utf-8");
}

interface McpApp {
  id: string;
  name: string;
  description: string;
  mcp_url: string | null;
  skill_url: string;
  enabled: boolean;
}

interface ComposioSkill {
  slug: string;        // e.g. "alfred-composio-gmail"
  toolkit: string;     // e.g. "gmail"
  name: string;        // display name from frontmatter
  description: string;
  // Full SKILL.md text content. Inlined (rather than served from a separate
  // endpoint) because the dashboard's session auth doesn't trivially extend
  // to one-off file downloads through Wasp; inlining keeps the entire bundle
  // shippable via the same getClaudeSetup query the rest of the page uses.
  // Files are typically 2–5 KB each; the whole tenant set is well under
  // 100 KB, comfortably below any reasonable response size.
  content: string;
}

// Composio skills live under the Hermes-canonical per-profile skills dir —
// the SAME location integrations.ts WRITES the alfred-composio-<toolkit>
// folders to AND that hermes-init writes the platform skill suite to AND
// that Hermes itself reads from. This reader MUST resolve to the writer's
// path or the bundle shows zero skills. The old `/mnt/encrypted/openclaw/
// workspace/skills` host path does not exist on the merged single-VM stack;
// the parallel `<profile>/workspace/skills/` dir used by older builds is
// no longer authoritative — see integrations.ts for the migration note.
const HERMES_HOME = process.env.HERMES_HOME ?? "/opt/data";
const HERMES_PROFILES_DIR =
  process.env.HERMES_CONFIG_DIR ?? `${HERMES_HOME}/profiles`;
const OPENCLAW_SKILLS_DIR = `${HERMES_PROFILES_DIR}/main/skills`;
const COMPOSIO_SKILL_PREFIX = "alfred-composio-";

// Exported for the path-resolution regression test (see
// tests/skills-soul-memory-paths.test.ts).
export const RESOLVED_SKILLS_DIR = OPENCLAW_SKILLS_DIR;

function readComposioSkills(): ComposioSkill[] {
  if (!fs.existsSync(OPENCLAW_SKILLS_DIR)) return [];
  const entries = fs.readdirSync(OPENCLAW_SKILLS_DIR, { withFileTypes: true });
  const skills: ComposioSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(COMPOSIO_SKILL_PREFIX)) continue;
    const skillFile = path.join(OPENCLAW_SKILLS_DIR, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const toolkit = entry.name.slice(COMPOSIO_SKILL_PREFIX.length);
    let content = "";
    try {
      content = fs.readFileSync(skillFile, "utf8");
    } catch {
      continue;
    }
    let displayName = toolkit;
    let description = `Composio ${toolkit} integration — auto-generated skill describing the available actions.`;
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    if (m) {
      const fm = m[1];
      const nameLine = fm.match(/^name:\s*(.+)$/m);
      const descLine = fm.match(/^description:\s*(.+)$/m);
      if (nameLine) displayName = nameLine[1].trim().replace(/^["']|["']$/g, "");
      if (descLine) description = descLine[1].trim().replace(/^["']|["']$/g, "");
    }
    skills.push({
      slug: entry.name,
      toolkit,
      name: displayName,
      description,
      content,
    });
  }
  return skills.sort((a, b) => a.toolkit.localeCompare(b.toolkit));
}

export function registerClaudeSetupRoutes(): void {
  addRoute("GET", "/api/v1/claude-setup", async ({ res }) => {
    // The user-facing MCP server is reachable at mcp.${DOMAIN} (Caddy routes
    // mcp.{$DOMAIN} → mcp-server; the apex DOMAIN/<app>/mcp is NOT routed
    // there). The old TENANT_SUBDOMAIN/TENANT_DOMAIN scheme is unset on the
    // merged single-VM stack → null URLs → empty /claude list. Rebuild around
    // mcp.${DOMAIN}. (F62)
    const domain = process.env.DOMAIN || process.env.TENANT_DOMAIN || "";
    const tenantUrl = domain ? `https://mcp.${domain}` : null;
    // F63/C16 — NEVER echo the approval secret on a normal page load. It is a
    // long-lived bearer secret; returning it on every GET (the old behaviour)
    // leaks it to anything that can read the authenticated owner response.
    // Surface only whether one is set + when it was last rotated; the value is
    // returned exactly once by the rotate endpoint below.
    const approvalSecretSet = !!(process.env.MCP_APPROVAL_SECRET || readEnvKey("MCP_APPROVAL_SECRET"));
    const lastRotatedAt = readEnvKey(ROTATED_AT_KEY);

    // SaaS app serves these as static assets — see
    // packages/saas/app/public/mcp-skills/. The names mirror the MCP catalogue
    // ids; canonical content lives in packages/mcp-server/skills/.
    const skillBase = "/mcp-skills";

    // Per-app gating. Vaultwarden MCP is only available on tenants where
    // the BW_USER bootstrap entry is present (= Vaultwarden was provisioned).
    // Sure / Plane gate the same way as the dock tile (apps.ts).
    const apps: McpApp[] = [
      {
        id: "alfred",
        name: "Alfred",
        description:
          "Vault read/write, agent delegation, workflow orchestration, OpenClaw diagnostics. The general-purpose Alfred surface from claude.ai.",
        mcp_url: tenantUrl ? `${tenantUrl}/alfred/mcp` : null,
        skill_url: `${skillBase}/alfred-mcp.md`,
        enabled: true,
      },
      {
        id: "sure",
        name: "Sure",
        description:
          "Personal-finance app — accounts, transactions, transfers, budgets, holdings. ~80 tools wrapping the Sure Rails app.",
        mcp_url: tenantUrl ? `${tenantUrl}/sure/mcp` : null,
        skill_url: `${skillBase}/alfred-sure.md`,
        // Merged single-VM stack: sure-web is a sibling container in the same
        // docker network; the stdio MCP bundle reaches it directly at
        // http://sure-web:3000 without a per-tenant API token. (Pre-merge
        // SaaS world gated on SURE_API_KEY; here that env var doesn't exist,
        // so the gate hid the toolkit even though it was fully wired.)
        enabled: true,
      },
      {
        id: "plane",
        name: "Plane",
        description:
          "Project management — issues, comments, cycles, projects. v2 catalogue with sophisticated search.",
        mcp_url: tenantUrl ? `${tenantUrl}/plane/mcp` : null,
        skill_url: `${skillBase}/alfred-plane.md`,
        // Same as Sure: plane-api is a sibling container reached at
        // http://plane-api:8000; no per-tenant PLANE_API_TOKEN on merged stack.
        enabled: true,
      },
      {
        id: "vaultwarden",
        name: "Vaultwarden",
        description:
          "Secrets manager — list, search, get, create, update, delete vault items. Also rotates secrets into the running services via vault_refresh.",
        mcp_url: tenantUrl ? `${tenantUrl}/vaultwarden/mcp` : null,
        skill_url: `${skillBase}/alfred-vaultwarden.md`,
        // Merged stack provisions VAULTWARDEN_BW_PASSWORD (not BW_USER). (F62)
        enabled: !!(process.env.VAULTWARDEN_BW_PASSWORD || process.env.BW_USER),
      },
      {
        id: "execute",
        name: "Execute",
        description:
          "Composio surface — every connected third-party app (Gmail, GitHub, Notion, Slack, Calendar, Drive, Linear, Zoom, …) through one execute primitive. Six tools: list_composio_tools, composio_execute, list_connections, create_connection, reconnect_connection, delete_connection.",
        mcp_url: tenantUrl ? `${tenantUrl}/execute/mcp` : null,
        skill_url: `${skillBase}/alfred-execute.md`,
        enabled: !!process.env.COMPOSIO_API_KEY,
      },
    ];

    // Auto-generated alfred-composio-* skills, one per connected toolkit.
    // Tenant-specific (each contains the connected_account id), so served live
    // from /api/v1/claude-setup/composio-skills/:slug rather than vendored
    // into the SaaS public/ directory.
    const composioSkills = readComposioSkills();

    // Custom Instructions: not per-app — a single file Sir pastes into
    // claude.ai's profile-level Personalisation field. Identity transfer
    // (Claude becomes Alfred) plus operating discipline. Same vendoring
    // pattern as the skills (canonical in mcp-server, copy in saas/public).
    const customInstructions = {
      url: `${skillBase}/alfred-custom-instructions.md`,
      filename: "alfred-custom-instructions.md",
    };

    // Vaultwarden login bundle. Surfaces the master password the user
    // needs to log into the per-tenant Vaultwarden web UI — without
    // this, the password lives only in /opt/alfred/compose/.env on the
    // tenant VPS, which the user has no SSH access to. Returned in
    // FULL (not masked) because you need the entire password string to
    // type into Vaultwarden's login form. The dashboard hides it
    // behind a Reveal toggle, same pattern as the approval secret.
    //
    // Gated on the Vaultwarden password being provisioned. On the merged
    // single-VM stack the password is VAULTWARDEN_BW_PASSWORD and the web UI
    // is served at vault.${DOMAIN} (no per-tenant subdomain prefix). (F62)
    const bwUser = process.env.BW_USER || process.env.OWNER_EMAIL || null;
    const bwPassword = process.env.VAULTWARDEN_BW_PASSWORD || process.env.BW_PASSWORD || null;
    // Surface the Vaultwarden master password to the dashboard. The
    // earlier F63/C16-style "reveal-once" treatment was wrong for this
    // credential: unlike the approval secret (which gets rotated and
    // re-issued), the master password is something the principal needs
    // to retrieve every time they sign into Vaultwarden — so it must
    // be readable from /settings#agent behind a Reveal toggle, the same
    // way every other persistent secret in that panel works. The
    // dashboard already implements the Reveal + Copy UX (SettingsPage
    // around the Vault Login card); this route just needs to actually
    // send the value. `master_password_set` stays for older clients
    // that gated UI on it. Rotation for it is still out of scope.
    const vaultLogin = bwPassword && domain
      ? {
          url: `https://vault.${domain}`,
          email: bwUser,
          master_password: bwPassword,
          master_password_set: true,
        }
      : null;

    sendJson(res, 200, {
      tenant_url: tenantUrl,
      approval_secret: null,
      approval_secret_set: approvalSecretSet,
      last_rotated_at: lastRotatedAt,
      apps,
      custom_instructions: customInstructions,
      composio_skills: composioSkills,
      vault_login: vaultLogin,
    });
  });

  // POST /api/v1/claude-setup/approval-secret/rotate — owner-initiated rotation.
  // Mints a fresh 256-bit hex secret (matching bootstrap.sh's openssl rand -hex
  // 32), writes it + a rotated-at timestamp to the tenant .env, restarts the
  // mcp-server so /approve validates against the new value, and returns the new
  // secret EXACTLY ONCE (C16). The dashboard shows it in a copy-it-now panel.
  addRoute("POST", "/api/v1/claude-setup/approval-secret/rotate", async ({ res }) => {
    const secret = crypto.randomBytes(32).toString("hex"); // 64 hex chars
    const rotatedAt = new Date().toISOString();
    patchEnv({ MCP_APPROVAL_SECRET: secret, [ROTATED_AT_KEY]: rotatedAt });
    // Keep this process's view current so a subsequent GET reports set=true.
    process.env.MCP_APPROVAL_SECRET = secret;
    // Restart mcp-server so it re-reads MCP_APPROVAL_SECRET (env_file: .env).
    // Best-effort — the secret is already persisted; the next deploy/restart
    // also picks it up.
    try {
      await dockerComposeCmd(["up", "-d", "--no-deps", "--force-recreate", "mcp-server"]);
    } catch {
      // Restart is best-effort; the .env write is the source of truth.
    }
    sendJson(res, 200, { approval_secret: secret, last_rotated_at: rotatedAt });
  });
}
