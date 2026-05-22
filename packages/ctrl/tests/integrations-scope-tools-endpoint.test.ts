// F22 — the catalogue lookup that powers "tools I can act through" must query
// the LIVE endpoint /api/v3/tools?toolkit_slug=<slug> (Composio retired
// /api/v3/actions?apps=, which 404s and was silently swallowed → empty scope).
// Non-200s must be logged, not swallowed. gcal-scope-findings.md finding #3.
import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const fetchUrls: string[] = [];
const accounts: Record<string, any> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  fetchUrls.push(u);
  const method = (init?.method ?? "GET").toUpperCase();
  const m = u.match(/\/api\/v3\/connected_accounts\/([^?/]+)$/);
  if (method === "GET" && m) {
    const acct = accounts[decodeURIComponent(m[1])];
    if (!acct) return new Response("Not found", { status: 404 });
    return new Response(JSON.stringify(acct), { status: 200 });
  }
  // Retired endpoint — must NOT be queried any more.
  if (/\/api\/v3\/actions/.test(u)) return new Response("gone", { status: 404 });
  // The live tools endpoint.
  if (/\/api\/v3\/tools\?/.test(u)) {
    return new Response(JSON.stringify({ items: [
      { name: "GOOGLECALENDAR_EVENTS_LIST", displayName: "List events" },
      { name: "GOOGLECALENDAR_CREATE_EVENT", displayName: "Create event" },
    ] }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: "unmocked", url: u }), { status: 501 });
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
beforeEach(() => { fetchUrls.length = 0; for (const k of Object.keys(accounts)) delete accounts[k]; });

async function req(method: string, p: string): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: addr.port, path: p, method },
      (res) => { let raw = ""; res.on("data", (c) => { raw += c; }); res.on("end", () => { try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode!, data: raw }); } }); });
    r.on("error", reject); r.end();
  });
}

describe("F22 — catalogue lookup uses /api/v3/tools, not the dead actions endpoint", () => {
  it("queries /api/v3/tools?toolkit_slug= and surfaces available_tools", async () => {
    accounts["ca_x"] = {
      member_id: "alfred-test-user",
      toolkit: { slug: "googlecalendar" },
      authScheme: "OAUTH2",
      state: { val: { scope: "https://www.googleapis.com/auth/calendar" } },
    };
    const { status, data } = await req("GET", "/api/v1/integrations/ca_x/scope");
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.ok(
      fetchUrls.some((u) => /\/api\/v3\/tools\?toolkit_slug=googlecalendar/.test(u)),
      `expected a /api/v3/tools?toolkit_slug= query, got: ${fetchUrls.join(", ")}`,
    );
    assert.ok(
      !fetchUrls.some((u) => /\/api\/v3\/actions/.test(u)),
      "must not query the retired /api/v3/actions endpoint",
    );
    assert.ok(Array.isArray(data.available_tools) && data.available_tools.length === 2,
      `expected available_tools to be populated, got ${JSON.stringify(data.available_tools)}`);
  });
});
