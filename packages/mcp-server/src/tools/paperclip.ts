// Paperclip MCP tool catalogue — exposes the per-tenant Paperclip
// company/agent bootstrap surface to claude.ai. Every tool routes through
// ctrl-api's /api/v1/paperclip/admin/* endpoints (see
// packages/ctrl/src/api/routes/paperclip_admin.ts), which perform the
// privileged Paperclip calls server-side using the seed-credential
// Better-Auth cookie session. So the call chain is:
//
//   claude.ai  →  /paperclip/mcp (this server)
//                 → ctrl-api /api/v1/paperclip/admin/*
//                   → paperclip :3100 (Better-Auth cookie session)
//
// The skill `alfred-paperclip-bootstrap` (C4) depends on the tool NAMES
// below being frozen — do not rename without bumping the contract.
//
// Contract: docs/PAPERCLIP-BOOTSTRAP-CONTRACT.md, clause C2 (consumer).
// The C1 route shapes are frozen; this lane never needs ctrl-api code.

import { z } from "zod";
import type { ToolDef } from "./types.js";

export const ALL_PAPERCLIP_TOOLS: ToolDef[] = [
  // ── create company (idempotent by name) ─────────────────────────────────
  {
    name: "paperclip_create_company",
    description:
      "Create a Paperclip company (the org container for agents). Required: name + description. Idempotent by name — if a company with this name already exists, ctrl-api returns its id with created:false (no duplicate). Returns {companyId, created}. This is the FIRST step of the bootstrap flow; follow up with paperclip_create_agent for each agent and paperclip_register_user for the principal. Backing: POST /api/v1/paperclip/admin/companies.",
    inputSchema: z.object({
      name: z.string().min(1).describe("Company display name; the idempotency key"),
      description: z.string().describe("One-line description of what the company does"),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/paperclip/admin/companies",
      body: args,
    }),
  },

  // ── create agent (forced hermes_local; mints runtime key) ───────────────
  {
    name: "paperclip_create_agent",
    description:
      "Create an agent inside a Paperclip company. Required: companyId (from paperclip_create_company) + name + role (e.g. 'ceo', 'cfo', 'engineer'). Optional: title (human-readable job title) and capabilities (free-text summary of what the agent can do). ctrl-api FORCES adapterType 'hermes_local' and, on success, mints the agent's runtime key. Idempotent by (companyId, name). Returns {agentId, agentToken (the runtime key, or null if pre-existing), created}. By convention the first agent is the CEO (role:'ceo'). Backing: POST /api/v1/paperclip/admin/companies/:companyId/agents.",
    inputSchema: z.object({
      companyId: z.string().min(1).describe("The company id from paperclip_create_company"),
      name: z.string().min(1).describe("Agent name; idempotency key within the company"),
      role: z.string().min(1).describe("Agent role, e.g. 'ceo', 'cfo', 'engineer'"),
      title: z.string().optional().describe("Human-readable job title"),
      capabilities: z.string().optional().describe("Free-text summary of the agent's capabilities"),
    }),
    buildRequest: ({ companyId, ...body }) => ({
      method: "POST",
      path: `/api/v1/paperclip/admin/companies/${encodeURIComponent(companyId)}/agents`,
      body,
    }),
  },

  // ── register principal user (verified; idempotent by email) ─────────────
  {
    name: "paperclip_register_user",
    description:
      "Register a Paperclip user (the principal who will log into the company). Required: email + name. Optional: password — omit and ctrl-api generates a strong one (returned ONCE in the response, never persisted beyond it). The identity is marked verified server-side (tenants have no mailer). Idempotent by email — an existing email returns created:false (and password:null). Returns {userId, email, password (only when created/generated), loginUrl, created}. Report the loginUrl + password to the principal after the bootstrap completes. Backing: POST /api/v1/paperclip/admin/users.",
    inputSchema: z.object({
      email: z.string().min(1).describe("Principal's email; the idempotency key + login"),
      name: z.string().min(1).describe("Principal's display name"),
      password: z.string().optional().describe("Omit to have ctrl-api generate a strong password"),
    }),
    buildRequest: (args) => ({
      method: "POST",
      path: "/api/v1/paperclip/admin/users",
      body: args,
    }),
  },

  // ── grant the principal company access (membership) ─────────────────────
  {
    name: "paperclip_grant_company_access",
    description:
      "Grant a registered Paperclip user company-scoped MEMBERSHIP of a company so they can actually open it (e.g. /<COMPANY>/inbox/mine). Required: companyId (from paperclip_create_company) + email (the principal you registered with paperclip_register_user). Without this, a freshly registered user signs in but sees \"No company access\" — register_user creates the login but NOT membership of the company the seed identity owns. Adds an 'operator' membership; it is ADDITIVE (never removes the user's other memberships) and idempotent (re-running returns alreadyMember:true). Call this AFTER paperclip_register_user, as the access-grant step of the bootstrap. Returns {userId, companyId, granted, alreadyMember}. Backing: POST /api/v1/paperclip/admin/companies/:companyId/access.",
    inputSchema: z.object({
      companyId: z.string().min(1).describe("The company id from paperclip_create_company"),
      email: z.string().min(1).describe("The registered principal's email (must already exist — register first)"),
    }),
    buildRequest: ({ companyId, ...body }) => ({
      method: "POST",
      path: `/api/v1/paperclip/admin/companies/${encodeURIComponent(companyId)}/access`,
      body,
    }),
  },

  // ── list companies (read-back) ──────────────────────────────────────────
  {
    name: "paperclip_list_companies",
    description:
      "List all Paperclip companies on this tenant. Returns {companies: [{id, name}]}. Use to read back what exists before creating (or to resolve a company id by name). Cheap, idempotent. Backing: GET /api/v1/paperclip/admin/companies.",
    inputSchema: z.object({}),
    buildRequest: () => ({
      method: "GET",
      path: "/api/v1/paperclip/admin/companies",
    }),
  },

  // ── list agents in a company (read-back) ────────────────────────────────
  {
    name: "paperclip_list_agents",
    description:
      "List the agents in one Paperclip company. Required: companyId. Returns {agents: [{id, name, role}]}. Use as the post-bootstrap read-back step to confirm every agent landed before reporting to the principal. Cheap, idempotent. Backing: GET /api/v1/paperclip/admin/companies/:companyId/agents.",
    inputSchema: z.object({
      companyId: z.string().min(1).describe("The company id to list agents for"),
    }),
    buildRequest: ({ companyId }) => ({
      method: "GET",
      path: `/api/v1/paperclip/admin/companies/${encodeURIComponent(companyId)}/agents`,
    }),
  },
];
