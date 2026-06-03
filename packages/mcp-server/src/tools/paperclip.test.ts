// Tests for the paperclip bootstrap tools (C2).
//
// Coverage:
//   1. schema validation — required vs optional fields per tool
//   2. buildRequest — method + path (incl. companyId URL-encoding) + body
//      shape proxies to the frozen C1 routes
//   3. registry wiring — `paperclip` is a supported app exposing exactly
//      the 5 frozen tool names

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ALL_PAPERCLIP_TOOLS } from "./paperclip.js";
import { getToolsForApp, isAppId, SUPPORTED_APPS } from "./registry.js";

function getTool(name: string) {
  const t = ALL_PAPERCLIP_TOOLS.find((x) => x.name === name);
  assert.ok(t, `tool ${name} not found`);
  return t;
}

const createCompany = getTool("paperclip_create_company");
const createAgent = getTool("paperclip_create_agent");
const registerUser = getTool("paperclip_register_user");
const listCompanies = getTool("paperclip_list_companies");
const listAgents = getTool("paperclip_list_agents");

// ─── registry wiring ─────────────────────────────────────────────────────────

test("registry · paperclip is a supported app", () => {
  assert.ok(isAppId("paperclip"));
  assert.ok((SUPPORTED_APPS as Set<string>).has("paperclip"));
});

test("registry · getToolsForApp('paperclip') returns the 5 frozen tools", () => {
  const tools = getToolsForApp("paperclip" as never);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "paperclip_create_agent",
    "paperclip_create_company",
    "paperclip_list_agents",
    "paperclip_list_companies",
    "paperclip_register_user",
  ]);
});

// ─── paperclip_create_company ───────────────────────────────────────────────

test("paperclip_create_company · name + description required", () => {
  assert.equal(createCompany.inputSchema.safeParse({}).success, false);
  assert.equal(
    createCompany.inputSchema.safeParse({ name: "Acme" }).success,
    false,
    "description is required",
  );
  assert.equal(
    createCompany.inputSchema.safeParse({ name: "Acme", description: "Widgets" }).success,
    true,
  );
});

test("paperclip_create_company · empty name rejected", () => {
  assert.equal(
    createCompany.inputSchema.safeParse({ name: "", description: "x" }).success,
    false,
  );
});

test("paperclip_create_company · POST /companies with body", () => {
  const req = createCompany.buildRequest({ name: "Acme", description: "Widgets Inc" });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/paperclip/admin/companies");
  assert.deepEqual(req.body, { name: "Acme", description: "Widgets Inc" });
});

// ─── paperclip_create_agent ─────────────────────────────────────────────────

test("paperclip_create_agent · companyId + name + role required", () => {
  assert.equal(
    createAgent.inputSchema.safeParse({ name: "CEO", role: "ceo" }).success,
    false,
    "companyId required",
  );
  assert.equal(
    createAgent.inputSchema.safeParse({ companyId: "c1", role: "ceo" }).success,
    false,
    "name required",
  );
  assert.equal(
    createAgent.inputSchema.safeParse({ companyId: "c1", name: "CEO" }).success,
    false,
    "role required",
  );
  assert.equal(
    createAgent.inputSchema.safeParse({ companyId: "c1", name: "CEO", role: "ceo" }).success,
    true,
  );
});

test("paperclip_create_agent · optional title + capabilities accepted", () => {
  const r = createAgent.inputSchema.safeParse({
    companyId: "c1",
    name: "CFO",
    role: "cfo",
    title: "Chief Financial Officer",
    capabilities: "Budgeting, forecasting",
  });
  assert.equal(r.success, true);
});

test("paperclip_create_agent · POST nested path; companyId stripped from body", () => {
  const req = createAgent.buildRequest({
    companyId: "c1",
    name: "CEO",
    role: "ceo",
    title: "Chief Exec",
    capabilities: "strategy",
  });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/paperclip/admin/companies/c1/agents");
  assert.deepEqual(req.body, {
    name: "CEO",
    role: "ceo",
    title: "Chief Exec",
    capabilities: "strategy",
  });
});

test("paperclip_create_agent · companyId is URL-encoded in path", () => {
  const req = createAgent.buildRequest({
    companyId: "weird/id with space",
    name: "CEO",
    role: "ceo",
  });
  assert.equal(
    req.path,
    "/api/v1/paperclip/admin/companies/weird%2Fid%20with%20space/agents",
  );
  // and not leaked into the body
  assert.equal((req.body as any).companyId, undefined);
});

// ─── paperclip_register_user ─────────────────────────────────────────────────

test("paperclip_register_user · email + name required, password optional", () => {
  assert.equal(
    registerUser.inputSchema.safeParse({ name: "Sir" }).success,
    false,
    "email required",
  );
  assert.equal(
    registerUser.inputSchema.safeParse({ email: "a@b.com" }).success,
    false,
    "name required",
  );
  assert.equal(
    registerUser.inputSchema.safeParse({ email: "a@b.com", name: "Sir" }).success,
    true,
    "password optional",
  );
  assert.equal(
    registerUser.inputSchema.safeParse({
      email: "a@b.com",
      name: "Sir",
      password: "hunter2hunter2",
    }).success,
    true,
  );
});

test("paperclip_register_user · POST /users with body (no password when omitted)", () => {
  const req = registerUser.buildRequest({ email: "a@b.com", name: "Sir" });
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/v1/paperclip/admin/users");
  assert.deepEqual(req.body, { email: "a@b.com", name: "Sir" });
});

test("paperclip_register_user · password forwarded when set", () => {
  const req = registerUser.buildRequest({
    email: "a@b.com",
    name: "Sir",
    password: "supersecret123",
  });
  assert.equal((req.body as any).password, "supersecret123");
});

// ─── paperclip_list_companies ────────────────────────────────────────────────

test("paperclip_list_companies · no args; GET /companies", () => {
  assert.equal(listCompanies.inputSchema.safeParse({}).success, true);
  const req = listCompanies.buildRequest({});
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/paperclip/admin/companies");
  assert.equal(req.body, undefined);
});

// ─── paperclip_list_agents ───────────────────────────────────────────────────

test("paperclip_list_agents · companyId required", () => {
  assert.equal(listAgents.inputSchema.safeParse({}).success, false);
  assert.equal(listAgents.inputSchema.safeParse({ companyId: "c1" }).success, true);
});

test("paperclip_list_agents · GET nested path; companyId URL-encoded", () => {
  const req = listAgents.buildRequest({ companyId: "c1" });
  assert.equal(req.method, "GET");
  assert.equal(req.path, "/api/v1/paperclip/admin/companies/c1/agents");

  const enc = listAgents.buildRequest({ companyId: "a/b" });
  assert.equal(enc.path, "/api/v1/paperclip/admin/companies/a%2Fb/agents");
});
