// #758 — Outlook / Microsoft 365 support in ctrl integrations.
//
// Two things that matter for read-only onboarding:
//   1. When ctrl creates a Composio-managed auth config for Outlook, it must
//      request the restricted scope set (offline_access,User.Read,Mail.Read),
//      not Composio's broad default. Gmail must keep the plain managed body.
//   2. The provider-neutral /identity alias resolves an Outlook connection's
//      mailbox address (from connection metadata, no live probe needed).

import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const composioCalls: Array<{ method: string; url: string; body?: any }> = [];
const realFetch = globalThis.fetch;

globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  let body: any;
  if (init?.body) { try { body = JSON.parse(init.body); } catch { /* ignore */ } }
  composioCalls.push({ method, url: u, body });

  // No existing auth config → force the create path.
  if (method === "GET" && /\/api\/v3\/auth_configs(?:\?|$)/.test(u)) {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  if (method === "POST" && /\/api\/v3\/auth_configs$/.test(u)) {
    return new Response(JSON.stringify({ auth_config: { id: "ac_out123" } }), {
      status: 201, headers: { "content-type": "application/json" },
    });
  }
  if (method === "POST" && /\/api\/v3\/connected_accounts$/.test(u)) {
    return new Response(JSON.stringify({ id: "ca_out456", status: "INITIATED", redirect_url: "https://x/y" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  // GET a specific connected account (ownership check + identity metadata).
  const one = u.match(/\/api\/v3\/connected_accounts\/([^?/]+)$/);
  if (method === "GET" && one) {
    return new Response(JSON.stringify({
      id: decodeURIComponent(one[1]),
      user_id: "alfred-test-user",
      toolkit: { slug: "outlook" },
      state: { val: { profile: { email: "sir@corp.onmicrosoft.com" } } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: "unmocked", url: u, method }), { status: 501 });
}) as typeof globalThis.fetch;

const fsMock = {
  existsSync: mock.fn(() => false),
  readFileSync: mock.fn(() => { const e = new Error("ENOENT") as any; e.code = "ENOENT"; throw e; }),
  writeFileSync: mock.fn(), mkdirSync: mock.fn(), readdirSync: mock.fn(() => []),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false })),
  unlinkSync: mock.fn(), renameSync: mock.fn(), appendFileSync: mock.fn(), rmSync: mock.fn(),
  chownSync: mock.fn(), openSync: mock.fn(() => 0), readSync: mock.fn(() => 0), closeSync: mock.fn(),
  createReadStream: mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() })),
  Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: mock.fn(async () => undefined), writeFile: mock.fn(async () => undefined) },
};
mock.module("node:fs", { defaultExport: fsMock, namedExports: { ...fsMock } });

process.env.COMPOSIO_API_KEY = "test-composio-key";
process.env.COMPOSIO_USER_ID = "alfred-test-user";

await import("../src/api/routes/integrations.js");
const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;
before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = realFetch;
});
beforeEach(() => { composioCalls.length = 0; });

async function req(method: string, pathname: string, body?: unknown): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port: addr.port, path: pathname, method,
        headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) } },
      (resp) => {
        let raw = "";
        resp.on("data", (c) => (raw += c));
        resp.on("end", () => { let d: any; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: resp.statusCode ?? 0, data: d }); });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

describe("#758 ctrl Outlook support", () => {
  it("creates the Outlook managed auth config with restricted read-only scopes", async () => {
    await req("POST", "/api/v1/integrations/connect", { toolkit_slug: "outlook" });
    const create = composioCalls.find((c) => c.method === "POST" && /\/auth_configs$/.test(c.url));
    assert.ok(create, "expected an auth_configs create call");
    assert.equal(create!.body?.auth_config?.type, "use_composio_managed_auth");
    assert.equal(create!.body?.auth_config?.credentials?.scopes, "offline_access,User.Read,Mail.Read");
    // never the broad-default managed body
    assert.equal(create!.body?.use_composio_auth, undefined);
  });

  it("leaves the Gmail managed auth config body unchanged", async () => {
    await req("POST", "/api/v1/integrations/connect", { toolkit_slug: "gmail" });
    const create = composioCalls.find((c) => c.method === "POST" && /\/auth_configs$/.test(c.url));
    assert.ok(create, "expected an auth_configs create call");
    assert.equal(create!.body?.use_composio_auth, true);
    assert.equal(create!.body?.auth_config, undefined);
  });

  it("resolves an Outlook connection's mailbox via the /identity alias", async () => {
    const { status, data } = await req("GET", "/api/v1/integrations/ca_out456/identity");
    assert.equal(status, 200);
    assert.equal(data.email, "sir@corp.onmicrosoft.com");
    assert.equal(data.source, "composio_metadata");
  });
});
