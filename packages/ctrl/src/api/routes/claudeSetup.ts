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
    ];

    sendJson(res, 200, {
      tenant_url: tenantUrl,
      approval_secret: approvalSecret,
      apps,
    });
  });
}
