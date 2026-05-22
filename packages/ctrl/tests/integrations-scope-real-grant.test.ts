// F21 — GET /integrations/:id/scope must report the connection's REAL granted
// OAuth scope (connected_account.state.val.scope, mirrored at data.scope /
// params.scope), classified read vs read+write — NOT a verb heuristic over the
// whole toolkit catalogue (which is identical for every connection of a toolkit
// and can't tell read-only from read+write). gcal-scope-findings.md.
import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// connId → the connected_account record the Composio GET returns.
const accounts: Record<string, any> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  const m = u.match(/\/api\/v3\/connected_accounts\/([^?/]+)$/);
  if (method === "GET" && m) {
    const acct = accounts[decodeURIComponent(m[1])];
    if (!acct) return new Response("Not found", { status: 404 });
    return new Response(JSON.stringify(acct), { status: 200 });
  }
  // The dead verb-heuristic catalogue endpoint — if the route still hits it,
  // return a 404 like the live box so a regression to the old path is visible.
  if (method === "GET" && /\/api\/v3\/actions/.test(u)) return new Response("gone", { status: 404 });
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
beforeEach(() => { for (const k of Object.keys(accounts)) delete accounts[k]; });

async function req(method: string, p: string): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: addr.port, path: p, method },
      (res) => { let raw = ""; res.on("data", (c) => { raw += c; }); res.on("end", () => { try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode!, data: raw }); } }); });
    r.on("error", reject); r.end();
  });
}

describe("F21 — scope reflects the real granted OAuth scope", () => {
  it("classifies a read+write GCal grant (no .readonly) as read+write", async () => {
    accounts["ca_rw"] = {
      member_id: "alfred-test-user",
      toolkit: { slug: "googlecalendar" },
      authScheme: "OAUTH2",
      state: { val: { scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar" } },
    };
    const { status, data } = await req("GET", "/api/v1/integrations/ca_rw/scope");
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.strictEqual(data.access, "read_write", `expected read_write, got ${data.access}`);
    assert.ok(Array.isArray(data.granted_scopes) && data.granted_scopes.length === 2,
      "granted_scopes should carry the two real scope URLs");
  });

  it("classifies a .readonly-only grant as read", async () => {
    accounts["ca_ro"] = {
      member_id: "alfred-test-user",
      toolkit: { slug: "googlecalendar" },
      authScheme: "OAUTH2",
      state: { val: { scope: "https://www.googleapis.com/auth/calendar.readonly" } },
    };
    const { status, data } = await req("GET", "/api/v1/integrations/ca_ro/scope");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.access, "read", `expected read, got ${data.access}`);
  });
});
