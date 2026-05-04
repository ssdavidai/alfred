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
import { addRoute } from "../server.js";
import { sendJson } from "../errors.js";

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

const OPENCLAW_SKILLS_DIR = "/mnt/encrypted/openclaw/workspace/skills";
const COMPOSIO_SKILL_PREFIX = "alfred-composio-";

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
    const subdomain = process.env.TENANT_SUBDOMAIN || "";
    const domain = process.env.TENANT_DOMAIN || "alfred.black";
    const tenantUrl = subdomain ? `https://${subdomain}.${domain}` : null;
    const approvalSecret = process.env.MCP_APPROVAL_SECRET || null;

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
        enabled: !!process.env.SURE_API_KEY,
      },
      {
        id: "plane",
        name: "Plane",
        description:
          "Project management — issues, comments, cycles, projects. v2 catalogue with sophisticated search.",
        mcp_url: tenantUrl ? `${tenantUrl}/plane/mcp` : null,
        skill_url: `${skillBase}/alfred-plane.md`,
        enabled: !!process.env.PLANE_API_TOKEN,
      },
      {
        id: "vaultwarden",
        name: "Vault",
        description:
          "Secrets manager — list, search, get, create, update, delete vault items. Also rotates secrets into the running services via vault_refresh.",
        mcp_url: tenantUrl ? `${tenantUrl}/vaultwarden/mcp` : null,
        skill_url: `${skillBase}/alfred-vaultwarden.md`,
        enabled: !!process.env.BW_USER,
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

    sendJson(res, 200, {
      tenant_url: tenantUrl,
      approval_secret: approvalSecret,
      apps,
      custom_instructions: customInstructions,
      composio_skills: composioSkills,
    });
  });
}
