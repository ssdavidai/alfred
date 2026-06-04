// Lane CTRL — /api/v1/paperclip/admin/* coverage (contract C1).
//
// What's under test
// -----------------
// The request-shaping + idempotency logic of the Paperclip admin routes,
// with the Paperclip HTTP layer mocked via _setPaperclipTransportForTests.
// We assert:
//   * 503 paperclip_not_seeded when the seed-credentials file is absent
//   * sign-in is issued (cookie session) before any privileged call, and the
//     cookie jar is replayed on subsequent calls
//   * POST companies → {companyId, created:true}; existing name → created:false
//   * POST agents FORCES adapterType:hermes_local + mints "<name>-runtime" key
//   * POST agents idempotent by (companyId,name) → created:false, agentToken null
//   * POST users mints a strong password when omitted, never the seed password,
//     and EMAIL_TAKEN → created:false / password:null
//   * GET companies + GET agents read-back shapes
//
// Privacy: dummy pcp_test_… token shape, no real secrets (gitleaks-safe).

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-admin-"));
// Redirect the various data-dir module-load side effects (streams.ts etc.)
// into the temp dir so importing server.js doesn't try to mkdir /alfred-data.
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.DOMAIN = "admintest.alfred.black";
process.env.PAPERCLIP_INTERNAL_URL = "http://paperclip:3100";
process.env.VAULT_CLI_URL = "http://vault-cli.test";

const seedCredentialsFile = path.join(tmp, "paperclip-seed-credentials.json");
process.env.PAPERCLIP_SEED_CREDENTIALS_FILE = seedCredentialsFile;

const SEED = {
  email: "alfred@admintest.alfred.black",
  name: "Alfred",
  password: "seed-secret-never-leak",
};

function writeSeed(): void {
  fs.writeFileSync(seedCredentialsFile, JSON.stringify(SEED));
}
function removeSeed(): void {
  try {
    fs.unlinkSync(seedCredentialsFile);
  } catch {
    /* may not exist */
  }
}

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const {
  registerPaperclipAdminRoutes,
  _setPaperclipTransportForTests,
} = await import("../src/api/routes/paperclip_admin.js");
registerPaperclipAdminRoutes();

interface MockCall {
  method: string;
  path: string;
  body: unknown;
  cookies: string[];
}

let calls: MockCall[] = [];
type Responder = (c: MockCall) => {
  status: number;
  body: unknown;
  setCookies?: string[];
};
let responder: Responder = () => ({ status: 200, body: {} });

const originalFetch = globalThis.fetch;
const vaultItems: Record<string, any> = {};
let vaultFolders: Record<string, any>[] = [];
let vaultListItems: Record<string, any>[] = [];
const vaultFetches: { url: string; method: string }[] = [];

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.startsWith("http://vault-cli.test")) {
    vaultFetches.push({ url, method });
    const u = new URL(url);
    if (u.pathname === "/list/object/folders") {
      return new Response(JSON.stringify({ success: true, data: vaultFolders }), { status: 200 });
    }
    if (u.pathname === "/list/object/items") {
      return new Response(JSON.stringify({ success: true, data: vaultListItems }), { status: 200 });
    }
    const itemMatch = u.pathname.match(/^\/object\/item\/(.+)$/);
    if (itemMatch) {
      const item = vaultItems[decodeURIComponent(itemMatch[1])];
      return new Response(JSON.stringify({ success: true, data: item ?? null }), { status: item ? 200 : 404 });
    }
  }
  return originalFetch(input, init);
}) as typeof fetch;

function installMock(r: Responder): void {
  responder = r;
  _setPaperclipTransportForTests(async (method, p, body, cookies) => {
    const call: MockCall = { method, path: p, body, cookies: [...cookies] };
    calls.push(call);
    const out = responder(call);
    return {
      status: out.status,
      body: out.body,
      setCookies: out.setCookies ?? [],
    };
  });
}

async function invokeRoute(
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(c: number) {
      status = c;
      return res;
    },
    end(j?: string) {
      payload = j ? JSON.parse(j) : undefined;
    },
  } as unknown as ServerResponse;
  try {
    await m!.handler({
      req: { method, url: p, headers: {} } as any,
      res,
      params: m!.params,
      body,
      query: new URLSearchParams(),
    });
  } catch (err) {
    handleError(res, err);
  }
  return { status, payload };
}

beforeEach(() => {
  calls = [];
  vaultFolders = [];
  vaultListItems = [];
  for (const k of Object.keys(vaultItems)) delete vaultItems[k];
  vaultFetches.length = 0;
  writeSeed();
});
after(() => {
  _setPaperclipTransportForTests(null);
  globalThis.fetch = originalFetch;
});

describe("paperclip admin — seeding gate", () => {
  it("returns 503 paperclip_not_seeded when creds are absent", async () => {
    removeSeed();
    installMock(() => ({ status: 200, body: {} }));
    const r = await invokeRoute("GET", "/api/v1/paperclip/admin/companies");
    assert.equal(r.status, 503);
    // C1: exact frozen shape — a plain string `error`, not the wrapped
    // {error:{code,message}} envelope.
    assert.deepEqual(r.payload, { error: "paperclip_not_seeded" });
  });

  it("signs in with seed creds before any privileged call", async () => {
    installMock((c) => {
      if (c.path === "/api/auth/sign-in/email") {
        return {
          status: 200,
          body: {},
          setCookies: ["__Secure-pc.session_token=abc123"],
        };
      }
      return { status: 200, body: [] };
    });
    await invokeRoute("GET", "/api/v1/paperclip/admin/companies");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].path, "/api/auth/sign-in/email");
    assert.deepEqual(calls[0].body, {
      email: SEED.email,
      password: SEED.password,
    });
    // The cookie jar must be replayed on the list call.
    assert.ok(
      calls[1].cookies.includes("__Secure-pc.session_token=abc123"),
      "session cookie should be replayed on subsequent calls",
    );
  });
});

describe("paperclip admin — companies", () => {
  it("creates a company and returns {companyId, created:true}", async () => {
    installMock((c) => {
      if (c.path === "/api/auth/sign-in/email") {
        return { status: 200, body: {}, setCookies: ["s=1"] };
      }
      if (c.method === "POST" && c.path === "/api/companies/") {
        return { status: 200, body: { id: "cmp_new", name: "Acme" } };
      }
      return { status: 200, body: {} };
    });
    const r = await invokeRoute("POST", "/api/v1/paperclip/admin/companies", {
      name: "Acme",
      description: "test co",
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { companyId: "cmp_new", created: true });
    const create = calls.find((c) => c.path === "/api/companies/");
    assert.deepEqual(create!.body, { name: "Acme", description: "test co" });
  });

  it("is idempotent: existing name → looked up, created:false", async () => {
    installMock((c) => {
      if (c.path === "/api/auth/sign-in/email") {
        return { status: 200, body: {}, setCookies: ["s=1"] };
      }
      if (c.method === "POST" && c.path === "/api/companies/") {
        return { status: 409, body: { code: "COMPANY_EXISTS" } };
      }
      if (c.method === "GET" && c.path === "/api/companies/") {
        return {
          status: 200,
          body: [{ id: "cmp_exist", name: "Acme" }],
        };
      }
      return { status: 200, body: {} };
    });
    const r = await invokeRoute("POST", "/api/v1/paperclip/admin/companies", {
      name: "Acme",
      description: "x",
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, { companyId: "cmp_exist", created: false });
  });

  it("returns 502 when create fails non-idempotently", async () => {
    installMock((c) => {
      if (c.path === "/api/auth/sign-in/email") {
        return { status: 200, body: {}, setCookies: ["s=1"] };
      }
      if (c.method === "POST" && c.path === "/api/companies/") {
        return { status: 500, body: { code: "BOOM" } };
      }
      return { status: 200, body: {} };
    });
    const r = await invokeRoute("POST", "/api/v1/paperclip/admin/companies", {
      name: "Acme",
      description: "x",
    });
    assert.equal(r.status, 502);
  });

  it("validates name is required", async () => {
    installMock(() => ({ status: 200, body: {} }));
    const r = await invokeRoute("POST", "/api/v1/paperclip/admin/companies", {
      description: "x",
    });
    assert.equal(r.status, 400);
  });

  it("GET companies returns {companies:[{id,name}]}", async () => {
    installMock((c) => {
      if (c.path === "/api/auth/sign-in/email") {
        return { status: 200, body: {}, setCookies: ["s=1"] };
      }
      return {
        status: 200,
        body: [
          { id: "c1", name: "One", extra: "ignored" },
          { id: "c2", name: "Two" },
          { name: "no-id-skipped" },
        ],
      };
    });
    const r = await invokeRoute("GET", "/api/v1/paperclip/admin/companies");
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      companies: [
        { id: "c1", name: "One" },
        { id: "c2", name: "Two" },
      ],
    });
  });
});

describe("paperclip admin — agents", () => {
  it("forces adapterType:hermes_local and mints <name>-runtime key", async () => {
    installMock((c) => {
      if (c.path === "/api/auth/sign-in/email") {
        return { status: 200, body: {}, setCookies: ["s=1"] };
      }
      if (c.method === "POST" && c.path === "/api/companies/cmp1/agents") {
        return { status: 200, body: { id: "agt1", name: "ceo" } };
      }
      if (c.method === "POST" && c.path === "/api/agents/agt1/keys") {
        return { status: 200, body: { token: "pcp_test_RUNTIMEKEY000000" } };
      }
      return { status: 200, body: {} };
    });
    const r = await invokeRoute(
      "POST",
      "/api/v1/paperclip/admin/companies/cmp1/agents",
      { name: "ceo", role: "ceo", title: "Chief", capabilities: "all" },
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      agentId: "agt1",
      agentToken: "pcp_test_RUNTIMEKEY000000",
      created: true,
    });
    const create = calls.find(
      (c) => c.path === "/api/companies/cmp1/agents",
    );
    const cb = create!.body as Record<string, unknown>;
    assert.equal(cb.adapterType, "hermes_local");
    assert.equal(cb.title, "Chief");
    assert.equal(cb.capabilities, "all");
    const keyCall = calls.find((c) => c.path === "/api/agents/agt1/keys");
    assert.deepEqual(keyCall!.body, { name: "ceo-runtime" });
  });

  it("ignores a caller-supplied adapterType (always hermes_local)", async () => {
    installMock((c) => {
      if (c.path === "/api/auth/sign-in/email") {
        return { status: 200, body: {}, setCookies: ["s=1"] };
      }
      if (c.method === "POST" && c.path === "/api/companies/cmp1/agents") {
        return { status: 200, body: { id: "agt1" } };
      }
      return { status: 200, body: { token: "pcp_test_K" } };
    });
    await invokeRoute("POST", "/api/v1/paperclip/admin/companies/cmp1/agents", {
      name: "x",
      role: "worker",
      adapterType: "openclaw_gateway",
    });
    const create = calls.find((c) => c.path === "/api/companies/cmp1/agents");
    assert.equal(
      (create!.body as Record<string, unknown>).adapterType,
      "hermes_local",
    );
  });

  it("is idempotent: existing agent → created:false, agentToken null, no key mint", async () => {
    installMock((c) => {
      if (c.path === "/api/auth/sign-in/email") {
        return { status: 200, body: {}, setCookies: ["s=1"] };
      }
      if (c.method === "POST" && c.path === "/api/companies/cmp1/agents") {
        return { status: 409, body: { code: "AGENT_EXISTS" } };
      }
      if (c.method === "GET" && c.path === "/api/companies/cmp1/agents") {
        return { status: 200, body: [{ id: "agt_exist", name: "ceo" }] };
      }
      return { status: 200, body: {} };
    });
    const r = await invokeRoute(
      "POST",
      "/api/v1/paperclip/admin/companies/cmp1/agents",
      { name: "ceo", role: "ceo" },
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      agentId: "agt_exist",
      agentToken: null,
      created: false,
    });
    assert.ok(
      !calls.some((c) => c.path.endsWith("/keys")),
      "no key should be minted for an existing agent",
    );
  });

  it("GET agents returns {agents:[{id,name,role}]}", async () => {
    installMock((c) => {
      if (c.path === "/api/auth/sign-in/email") {
        return { status: 200, body: {}, setCookies: ["s=1"] };
      }
      return {
        status: 200,
        body: { data: [{ id: "a1", name: "ceo", role: "ceo" }] },
      };
    });
    const r = await invokeRoute(
      "GET",
      "/api/v1/paperclip/admin/companies/cmp1/agents",
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      agents: [{ id: "a1", name: "ceo", role: "ceo" }],
    });
  });
});

describe("paperclip admin — users", () => {
  it("generates a strong password (not the seed password) when omitted", async () => {
    installMock((c) => {
      if (c.path === "/api/auth/sign-in/email") {
        return { status: 200, body: {}, setCookies: ["s=1"] };
      }
      if (c.path === "/api/auth/sign-up/email") {
        return { status: 200, body: { user: { id: "usr1" } } };
      }
      return { status: 200, body: {} };
    });
    const r = await invokeRoute("POST", "/api/v1/paperclip/admin/users", {
      email: "p@admintest.alfred.black",
      name: "Principal",
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.userId, "usr1");
    assert.equal(r.payload.email, "p@admintest.alfred.black");
    assert.equal(r.payload.created, true);
    assert.equal(
      r.payload.loginUrl,
      "https://paperclip.admintest.alfred.black/sign-in",
    );
    assert.ok(
      typeof r.payload.password === "string" && r.payload.password.length >= 16,
      "a strong password should be generated",
    );
    assert.notEqual(r.payload.password, SEED.password);
    // The minted password must be what was sent to Paperclip's sign-up.
    const signup = calls.find((c) => c.path === "/api/auth/sign-up/email");
    assert.equal(
      (signup!.body as Record<string, unknown>).password,
      r.payload.password,
    );
  });

  it("echoes a caller-supplied password", async () => {
    installMock((c) => {
      if (c.path === "/api/auth/sign-in/email") {
        return { status: 200, body: {}, setCookies: ["s=1"] };
      }
      if (c.path === "/api/auth/sign-up/email") {
        return { status: 200, body: { id: "usr2" } };
      }
      return { status: 200, body: {} };
    });
    const r = await invokeRoute("POST", "/api/v1/paperclip/admin/users", {
      email: "q@admintest.alfred.black",
      name: "Q",
      password: "CallerChosenP@ss123",
    });
    assert.equal(r.payload.password, "CallerChosenP@ss123");
    assert.equal(r.payload.userId, "usr2");
  });

  it("is idempotent: EMAIL_TAKEN → created:false, userId null, password null", async () => {
    installMock((c) => {
      if (c.path === "/api/auth/sign-in/email") {
        return { status: 200, body: {}, setCookies: ["s=1"] };
      }
      if (c.path === "/api/auth/sign-up/email") {
        return { status: 422, body: { code: "USER_EMAIL_ALREADY_EXISTS" } };
      }
      return { status: 200, body: {} };
    });
    const r = await invokeRoute("POST", "/api/v1/paperclip/admin/users", {
      email: "dupe@admintest.alfred.black",
      name: "Dupe",
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      userId: null,
      email: "dupe@admintest.alfred.black",
      password: null,
      loginUrl: "https://paperclip.admintest.alfred.black/sign-in",
      created: false,
    });
  });

  it("returns 502 on a non-idempotent sign-up failure", async () => {
    installMock((c) => {
      if (c.path === "/api/auth/sign-in/email") {
        return { status: 200, body: {}, setCookies: ["s=1"] };
      }
      if (c.path === "/api/auth/sign-up/email") {
        return { status: 500, body: { code: "BOOM" } };
      }
      return { status: 200, body: {} };
    });
    const r = await invokeRoute("POST", "/api/v1/paperclip/admin/users", {
      email: "x@admintest.alfred.black",
      name: "X",
    });
    assert.equal(r.status, 502);
  });
});

describe("paperclip admin — company access grant (#246)", () => {
  // Helper: a responder that resolves a user by email and tracks the PUT.
  function accessResponder(opts: {
    users?: { id: string; email: string }[];
    existingCompanyIds?: string[];
    putStatus?: number;
  }): Responder {
    const users = opts.users ?? [{ id: "usr1", email: "p@admintest.alfred.black" }];
    const existing = opts.existingCompanyIds ?? [];
    return (c) => {
      if (c.path === "/api/auth/sign-in/email") {
        return { status: 200, body: {}, setCookies: ["s=1"] };
      }
      if (c.method === "GET" && c.path.startsWith("/api/admin/users?query=")) {
        return { status: 200, body: users };
      }
      if (
        c.method === "GET" &&
        /\/api\/admin\/users\/[^/]+\/company-access$/.test(c.path)
      ) {
        return {
          status: 200,
          body: {
            user: { id: "usr1" },
            companyAccess: existing.map((id) => ({
              companyId: id,
              status: "active",
            })),
          },
        };
      }
      if (
        c.method === "PUT" &&
        /\/api\/admin\/users\/[^/]+\/company-access$/.test(c.path)
      ) {
        return { status: opts.putStatus ?? 200, body: { companyAccess: [] } };
      }
      return { status: 200, body: {} };
    };
  }

  it("grants access: unions the new companyId, PUTs it, returns granted:true", async () => {
    installMock(accessResponder({ existingCompanyIds: [] }));
    const r = await invokeRoute(
      "POST",
      "/api/v1/paperclip/admin/companies/cmpA/access",
      { email: "p@admintest.alfred.black" },
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload, {
      userId: "usr1",
      companyId: "cmpA",
      granted: true,
      alreadyMember: false,
    });
    const put = calls.find(
      (c) => c.method === "PUT" && c.path.endsWith("/company-access"),
    );
    assert.ok(put, "a PUT to company-access must be issued");
    assert.deepEqual(put!.body, { companyIds: ["cmpA"] });
  });

  it("preserves existing memberships (union, never shrink)", async () => {
    installMock(accessResponder({ existingCompanyIds: ["cmpExisting"] }));
    const r = await invokeRoute(
      "POST",
      "/api/v1/paperclip/admin/companies/cmpA/access",
      { email: "p@admintest.alfred.black" },
    );
    assert.equal(r.status, 200);
    const put = calls.find(
      (c) => c.method === "PUT" && c.path.endsWith("/company-access"),
    );
    assert.deepEqual(put!.body, { companyIds: ["cmpExisting", "cmpA"] });
  });

  it("idempotent: already a member → alreadyMember:true, set unchanged", async () => {
    installMock(accessResponder({ existingCompanyIds: ["cmpA", "cmpB"] }));
    const r = await invokeRoute(
      "POST",
      "/api/v1/paperclip/admin/companies/cmpA/access",
      { email: "p@admintest.alfred.black" },
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.alreadyMember, true);
    const put = calls.find(
      (c) => c.method === "PUT" && c.path.endsWith("/company-access"),
    );
    assert.deepEqual(put!.body, { companyIds: ["cmpA", "cmpB"] });
  });

  it("URL-encodes the resolved userId in the access paths", async () => {
    installMock(
      accessResponder({
        users: [{ id: "weird/id", email: "p@admintest.alfred.black" }],
        existingCompanyIds: [],
      }),
    );
    await invokeRoute(
      "POST",
      "/api/v1/paperclip/admin/companies/cmpA/access",
      { email: "p@admintest.alfred.black" },
    );
    const put = calls.find((c) => c.method === "PUT");
    assert.equal(put!.path, "/api/admin/users/weird%2Fid/company-access");
  });

  it("matches email exactly (case-insensitive), ignoring substring collisions", async () => {
    installMock(
      accessResponder({
        users: [
          { id: "other", email: "other-p@admintest.alfred.black" },
          { id: "target", email: "P@admintest.alfred.black" },
        ],
        existingCompanyIds: [],
      }),
    );
    const r = await invokeRoute(
      "POST",
      "/api/v1/paperclip/admin/companies/cmpA/access",
      { email: "p@admintest.alfred.black" },
    );
    assert.equal(r.payload.userId, "target");
  });

  it("404 when no user matches the email (register first)", async () => {
    installMock(accessResponder({ users: [], existingCompanyIds: [] }));
    const r = await invokeRoute(
      "POST",
      "/api/v1/paperclip/admin/companies/cmpA/access",
      { email: "ghost@admintest.alfred.black" },
    );
    assert.equal(r.status, 404);
    assert.ok(
      !calls.some((c) => c.method === "PUT"),
      "no PUT when the user can't be resolved",
    );
  });

  it("email is required", async () => {
    installMock(accessResponder({}));
    const r = await invokeRoute(
      "POST",
      "/api/v1/paperclip/admin/companies/cmpA/access",
      {},
    );
    assert.equal(r.status, 400);
  });

  it("returns 502 when the PUT grant fails", async () => {
    installMock(accessResponder({ existingCompanyIds: [], putStatus: 403 }));
    const r = await invokeRoute(
      "POST",
      "/api/v1/paperclip/admin/companies/cmpA/access",
      { email: "p@admintest.alfred.black" },
    );
    assert.equal(r.status, 502);
  });

  it("503 paperclip_not_seeded when creds are absent", async () => {
    removeSeed();
    installMock(accessResponder({}));
    const r = await invokeRoute(
      "POST",
      "/api/v1/paperclip/admin/companies/cmpA/access",
      { email: "p@admintest.alfred.black" },
    );
    assert.equal(r.status, 503);
    assert.deepEqual(r.payload, { error: "paperclip_not_seeded" });
  });


describe("paperclip admin — Vaultwarden secret sync", () => {
  it("syncs selected Vaultwarden folder items to Paperclip without returning values", async () => {
    vaultFolders = [{ id: "folder-paperclip", name: "paperclip" }];
    vaultListItems = [
      { id: "item1", name: "OPENAI_API_KEY" },
      { id: "item2", name: "other-company/IGNORED" },
      { id: "item3", name: "cmp_secret/PAPERCLIP_ONLY" },
      { id: "item4", name: "NO_PASSWORD" },
    ];
    vaultItems.item1 = { id: "item1", name: "OPENAI_API_KEY", revisionDate: "2026-06-04T10:00:00Z", login: { password: "secret-value-one" } };
    vaultItems.item3 = { id: "item3", name: "cmp_secret/PAPERCLIP_ONLY", revisionDate: "2026-06-04T10:01:00Z", login: { password: "secret-value-two" } };
    vaultItems.item4 = { id: "item4", name: "NO_PASSWORD", login: { username: "x" } };
    installMock((c) => {
      if (c.path === "/api/auth/sign-in/email") return { status: 200, body: {}, setCookies: ["s=1"] };
      if (c.method === "GET" && c.path === "/api/companies/cmp_secret/secrets") {
        return { status: 200, body: [] };
      }
      if (c.method === "POST" && c.path === "/api/companies/cmp_secret/secrets") {
        const key = (c.body as Record<string, unknown>).key as string;
        return { status: 201, body: { id: `sec_${key}`, key, name: key, latestVersion: 1 } };
      }
      if (c.method === "PATCH" && c.path.startsWith("/api/secrets/sec_")) {
        return { status: 200, body: { ok: true } };
      }
      return { status: 500, body: { unexpected: c.path } };
    });

    const r = await invokeRoute(
      "POST",
      "/api/v1/paperclip/admin/companies/cmp_secret/secrets/sync",
      {},
    );

    if (r.status !== 200) console.error(JSON.stringify(r.payload));
    assert.equal(r.status, 200);
    assert.equal(r.payload.synced, 2);
    assert.deepEqual(r.payload.keys, ["OPENAI_API_KEY", "PAPERCLIP_ONLY"]);
    const wire = JSON.stringify(r.payload);
    assert.equal(wire.includes("secret-value-one"), false);
    assert.equal(wire.includes("secret-value-two"), false);

    const creates = calls.filter((c) => c.method === "POST" && c.path === "/api/companies/cmp_secret/secrets");
    assert.equal(creates.length, 2);
    assert.equal((creates[0].body as Record<string, unknown>).key, "OPENAI_API_KEY");
    assert.equal((creates[0].body as Record<string, unknown>).provider, "local_encrypted");
    assert.equal((creates[0].body as Record<string, unknown>).managedMode, "paperclip_managed");
    assert.equal((creates[0].body as Record<string, unknown>).value, "secret-value-one");
    assert.equal((creates[1].body as Record<string, unknown>).key, "PAPERCLIP_ONLY");
    assert.equal((creates[1].body as Record<string, unknown>).value, "secret-value-two");
    const metadataPatches = calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/api/secrets/sec_"));
    assert.equal(metadataPatches.length, 2);
    assert.equal(
      ((metadataPatches[0].body as Record<string, any>).providerMetadata as Record<string, unknown>).source,
      "vaultwarden",
    );
  });

  it("supports dry_run without signing into or writing Paperclip", async () => {
    vaultFolders = [{ id: "folder-paperclip", name: "paperclip" }];
    vaultListItems = [{ id: "item1", name: "OPENAI_API_KEY" }];
    vaultItems.item1 = { id: "item1", login: { password: "secret-value-one" } };
    installMock(() => ({ status: 500, body: { should_not_call: true } }));

    const r = await invokeRoute(
      "POST",
      "/api/v1/paperclip/admin/companies/cmp_secret/secrets/sync",
      { dry_run: true },
    );

    assert.equal(r.status, 200);
    assert.equal(r.payload.synced, 1);
    assert.equal(r.payload.dry_run, true);
    assert.equal(calls.length, 0);
  });

  it("is additive-only and rejects prune=true", async () => {
    installMock(() => ({ status: 200, body: {} }));
    const r = await invokeRoute(
      "POST",
      "/api/v1/paperclip/admin/companies/cmp_secret/secrets/sync",
      { prune: true },
    );
    assert.equal(r.status, 400);
  });
});
