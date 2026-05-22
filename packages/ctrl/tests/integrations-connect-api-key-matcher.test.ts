// F20 — connect-api-key existing-config matcher must NOT reuse an OAuth (or
// scheme-less) auth_config for an API_KEY connection. The old matcher tolerated
// `scheme === ""`, so a managed-OAuth config (whose scheme is absent in the
// list payload) was reused for an API-key connect → scheme-mismatch on the
// connected_account create. Drop the empty-scheme tolerance: an API_KEY connect
// must only reuse an auth_config whose scheme is exactly API_KEY, else create
// a fresh one.
import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const composioCalls: Array<{ method: string; url: string; body?: any }> = [];
// The existing auth_configs the GET list returns for the toolkit under test.
let existingConfigs: any[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  let body: any;
  if (init?.body) { try { body = JSON.parse(init.body); } catch { /* ignore */ } }
  composioCalls.push({ method, url: u, body });

  if (method === "GET" && /\/api\/v3\/auth_configs(?:\?|$)/.test(u))
    return new Response(JSON.stringify({ items: existingConfigs }), { status: 200 });
  const tk = u.match(/\/api\/v3\/toolkits\/([^?/]+)$/);
  if (method === "GET" && tk)
    return new Response(JSON.stringify({
      slug: decodeURIComponent(tk[1]),
      auth_config_details: [{ mode: "API_KEY", fields: { connected_account_initiation: { required: [{ name: "generic_api_key" }] } } }],
    }), { status: 200 });
  if (method === "POST" && /\/api\/v3\/auth_configs$/.test(u))
    return new Response(JSON.stringify({ auth_config: { id: "ac_fresh" } }), { status: 201 });
  if (method === "POST" && /\/api\/v3\/connected_accounts$/.test(u))
    return new Response(JSON.stringify({ id: "ca_t", status: "ACTIVE" }), { status: 200 });
  return new Response(JSON.stringify({ error: "unmocked", url: u, method }), { status: 501 });
}) as typeof globalThis.fetch;

const fsMock: any = { existsSync: () => false, readFileSync: () => { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; }, writeFileSync() {}, mkdirSync() {}, readdirSync: () => [], statSync: () => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false }), unlinkSync() {}, renameSync() {}, appendFileSync() {}, rmSync() {}, chownSync() {}, openSync: () => 0, readSync: () => 0, closeSync() {}, createReadStream: () => ({ pipe() {}, on() {} }), Dirent: class { name = ""; isFile() { return true; } isDirectory() { return false; } }, promises: { mkdir: async () => undefined, writeFile: async () => undefined } };
mock.module("node:fs", { defaultExport: fsMock, namedExports: { ...fsMock } });

process.env.COMPOSIO_API_KEY = "test-composio-key";
process.env.COMPOSIO_USER_ID = "alfred-test-user";
await import("../src/api/routes/integrations.js");
const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;
before(async () => { server = createApiServer(); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); });
after(async () => { await new Promise<void>((r) => server.close(() => r())); globalThis.fetch = realFetch; });
beforeEach(() => { composioCalls.length = 0; existingConfigs = []; });

async function req(method: string, p: string, body?: unknown): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: addr.port, path: p, method,
      headers: payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {} },
      (res) => { let raw = ""; res.on("data", (c) => { raw += c; }); res.on("end", () => { try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode!, data: raw }); } }); });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
}

function connectedAccountAuthConfigId(): string | undefined {
  return composioCalls.find((c) => c.method === "POST" && /\/api\/v3\/connected_accounts$/.test(c.url))?.body?.auth_config?.id;
}
function createdFreshConfig(): boolean {
  return composioCalls.some((c) => c.method === "POST" && /\/api\/v3\/auth_configs$/.test(c.url));
}

describe("F20 — connect-api-key existing-config matcher", () => {
  it("does NOT reuse an OAuth auth_config for an API_KEY connection", async () => {
    existingConfigs = [{ id: "ac_oauth", is_disabled: false, auth_scheme: "OAUTH2" }];
    const { status } = await req("POST", "/api/v1/integrations/connect-api-key",
      { toolkit_slug: "serpapi", credential: "sk", auth_scheme: "API_KEY" });
    assert.strictEqual(status, 200);
    assert.ok(createdFreshConfig(), "should create a fresh API_KEY config, not reuse OAuth");
    assert.strictEqual(connectedAccountAuthConfigId(), "ac_fresh");
  });

  it("does NOT reuse a scheme-less auth_config for an API_KEY connection", async () => {
    existingConfigs = [{ id: "ac_blank", is_disabled: false }];
    const { status } = await req("POST", "/api/v1/integrations/connect-api-key",
      { toolkit_slug: "serpapi", credential: "sk", auth_scheme: "API_KEY" });
    assert.strictEqual(status, 200);
    assert.ok(createdFreshConfig(), "scheme-less config must not be reused for API_KEY");
    assert.strictEqual(connectedAccountAuthConfigId(), "ac_fresh");
  });

  it("DOES reuse a matching API_KEY auth_config", async () => {
    existingConfigs = [{ id: "ac_apikey", is_disabled: false, auth_scheme: "API_KEY" }];
    const { status } = await req("POST", "/api/v1/integrations/connect-api-key",
      { toolkit_slug: "serpapi", credential: "sk", auth_scheme: "API_KEY" });
    assert.strictEqual(status, 200);
    assert.strictEqual(createdFreshConfig(), false, "matching API_KEY config should be reused");
    assert.strictEqual(connectedAccountAuthConfigId(), "ac_apikey");
  });
});
