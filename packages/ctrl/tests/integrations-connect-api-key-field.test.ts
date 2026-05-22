// F19 — API-key connect keys the connected_account credential on the toolkit's
// REAL required field(s) (from connected_account_initiation.required), not the
// hardcoded api_key/token. SERP→generic_api_key; Firecrawl→generic_api_key+full.
// Sending val.api_key 400s with MissingRequiredFields (serp-apikey TEST C/D).
import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const composioCalls: Array<{ method: string; url: string; body?: any }> = [];
const TOOLKIT_REQUIRED: Record<string, Array<{ name: string }>> = {
  serpapi: [{ name: "generic_api_key" }],
  firecrawl: [{ name: "generic_api_key" }, { name: "full" }],
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  let body: any;
  if (init?.body) { try { body = JSON.parse(init.body); } catch { /* ignore */ } }
  composioCalls.push({ method, url: u, body });

  if (method === "GET" && /\/api\/v3\/auth_configs(?:\?|$)/.test(u))
    return new Response(JSON.stringify({ items: [] }), { status: 200 });

  const tk = u.match(/\/api\/v3\/toolkits\/([^?/]+)$/);
  if (method === "GET" && tk) {
    const slug = decodeURIComponent(tk[1]);
    const required = TOOLKIT_REQUIRED[slug] ?? [{ name: "generic_api_key" }];
    return new Response(JSON.stringify({
      slug,
      auth_config_details: [{ mode: "API_KEY", fields: { connected_account_initiation: { required } } }],
    }), { status: 200 });
  }
  if (method === "POST" && /\/api\/v3\/auth_configs$/.test(u))
    return new Response(JSON.stringify({ auth_config: { id: "ac_t" } }), { status: 201 });
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
beforeEach(() => { composioCalls.length = 0; });

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

function accountVal(): any {
  return composioCalls.find((c) => c.method === "POST" && /\/api\/v3\/connected_accounts$/.test(c.url))?.body?.connection?.state?.val;
}

describe("F19 — connect-api-key uses the toolkit's real credential field", () => {
  it("keys state.val on generic_api_key for SERP, not api_key", async () => {
    const { status } = await req("POST", "/api/v1/integrations/connect-api-key",
      { toolkit_slug: "serpapi", credential: "sk-dummy", auth_scheme: "API_KEY" });
    assert.strictEqual(status, 200);
    const val = accountVal();
    assert.strictEqual(val?.generic_api_key, "sk-dummy");
    assert.strictEqual(val?.api_key, undefined, "must NOT use the hardcoded api_key field");
  });

  it("populates ALL required fields for a multi-field toolkit (Firecrawl)", async () => {
    const { status } = await req("POST", "/api/v1/integrations/connect-api-key",
      { toolkit_slug: "firecrawl", credential: "fc-dummy", auth_scheme: "API_KEY" });
    assert.strictEqual(status, 200);
    const val = accountVal();
    assert.strictEqual(val?.generic_api_key, "fc-dummy");
    assert.ok(Object.prototype.hasOwnProperty.call(val, "full"), "second required field present");
  });
});
