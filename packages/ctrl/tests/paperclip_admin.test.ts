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
  writeSeed();
});
after(() => {
  _setPaperclipTransportForTests(null);
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
