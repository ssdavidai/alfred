// F74 — multi-field API-key toolkits (Firecrawl) can be configured.
//   1. GET /api/v1/integrations/:toolkit/required-fields exposes the toolkit's
//      connected_account_initiation.required[] specs so the UI can render one
//      input per field.
//   2. POST /api/v1/integrations/connect-api-key accepts a per-field `fields`
//      map (each named field gets its own value) AND still accepts the legacy
//      single `credential` string (mapped onto every required field).
import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const composioCalls: Array<{ method: string; url: string; body?: any }> = [];
// SERP → one field; Firecrawl → two fields (the multi-field case F74 unblocks).
const TOOLKIT_REQUIRED: Record<string, Array<Record<string, unknown>>> = {
  serpapi: [{ name: "generic_api_key", displayName: "API Key", type: "string", required: true, is_secret: true }],
  firecrawl: [
    { name: "generic_api_key", displayName: "API Key", type: "string", required: true, is_secret: true },
    { name: "full", displayName: "Base URL", type: "string", required: true },
  ],
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

describe("F74 — GET required-fields exposes the toolkit credential field specs", () => {
  it("returns the single required field for SERP, with its spec surfaced faithfully", async () => {
    const { status, data } = await req("GET", "/api/v1/integrations/serpapi/required-fields");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.toolkit, "serpapi");
    assert.strictEqual(data.auth_scheme, "API_KEY");
    assert.strictEqual(data.fields.length, 1);
    assert.strictEqual(data.fields[0].name, "generic_api_key");
    // Extra Composio props pass through so the UI can render a labelled input.
    assert.strictEqual(data.fields[0].displayName, "API Key");
    assert.strictEqual(data.fields[0].is_secret, true);
  });

  it("returns BOTH required fields for a multi-field toolkit (Firecrawl)", async () => {
    const { status, data } = await req("GET", "/api/v1/integrations/firecrawl/required-fields");
    assert.strictEqual(status, 200);
    const names = data.fields.map((f: any) => f.name);
    assert.deepStrictEqual(names, ["generic_api_key", "full"]);
  });
});

describe("F74 — connect-api-key accepts a per-field map", () => {
  it("submits each named field's value for a multi-field toolkit", async () => {
    const { status } = await req("POST", "/api/v1/integrations/connect-api-key", {
      toolkit_slug: "firecrawl",
      auth_scheme: "API_KEY",
      fields: { generic_api_key: "fc-key", full: "https://api.firecrawl.dev" },
    });
    assert.strictEqual(status, 200);
    const val = accountVal();
    assert.strictEqual(val?.generic_api_key, "fc-key");
    assert.strictEqual(val?.full, "https://api.firecrawl.dev");
  });

  it("accepts `credentials` as an alias for `fields`", async () => {
    const { status } = await req("POST", "/api/v1/integrations/connect-api-key", {
      toolkit_slug: "firecrawl",
      credentials: { generic_api_key: "fc-key-2", full: "https://self.host" },
    });
    assert.strictEqual(status, 200);
    const val = accountVal();
    assert.strictEqual(val?.generic_api_key, "fc-key-2");
    assert.strictEqual(val?.full, "https://self.host");
  });

  it("400s when a required field is missing from the per-field map", async () => {
    const { status, data } = await req("POST", "/api/v1/integrations/connect-api-key", {
      toolkit_slug: "firecrawl",
      fields: { generic_api_key: "fc-key-only" }, // `full` omitted
    });
    assert.strictEqual(status, 400);
    assert.match(String(data.error?.message ?? data.error ?? data), /full/);
  });
});

describe("F74 — connect-api-key keeps full back-compat with the single credential string", () => {
  it("maps a single `credential` onto every required field (legacy SERP flow)", async () => {
    const { status } = await req("POST", "/api/v1/integrations/connect-api-key", {
      toolkit_slug: "serpapi", credential: "sk-dummy", auth_scheme: "API_KEY",
    });
    assert.strictEqual(status, 200);
    const val = accountVal();
    assert.strictEqual(val?.generic_api_key, "sk-dummy");
    assert.strictEqual(val?.api_key, undefined, "must NOT use the hardcoded api_key field");
  });

  it("still requires either a credential or a fields map", async () => {
    const { status } = await req("POST", "/api/v1/integrations/connect-api-key", {
      toolkit_slug: "serpapi",
    });
    assert.strictEqual(status, 400);
  });
});
