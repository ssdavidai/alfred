// F25 — GET /api/v1/integrations must dedup connected accounts BY TOOLKIT: when
// a toolkit has more than one ACTIVE account (Sir re-authed Gmail without
// disconnecting the first), stamp the newest as primary and the older stale
// duplicate(s) with is_primary:false + duplicate_of:<primary id>, so the UI can
// group/collapse them instead of showing N confusing rows. Rows are NOT
// destructively dropped (each still holds a live grant the user may revoke).
// gmail-revoke-findings.md finding #4.
import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

let owned: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" && /\/api\/v3\/connected_accounts(?:\?|$)/.test(u))
    return new Response(JSON.stringify({ items: owned, next_cursor: null }), { status: 200 });
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
beforeEach(() => { owned = []; });

async function req(method: string, p: string): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: addr.port, path: p, method },
      (res) => { let raw = ""; res.on("data", (c) => { raw += c; }); res.on("end", () => { try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode!, data: raw }); } }); });
    r.on("error", reject); r.end();
  });
}

describe("F25 — connected-accounts list dedups by toolkit", () => {
  it("marks the newest as primary and the older Gmail as a duplicate", async () => {
    owned = [
      { id: "ca_old", member_id: "alfred-test-user", status: "ACTIVE", toolkit: { slug: "gmail" }, createdAt: "2026-05-20T11:56:00Z" },
      { id: "ca_new", member_id: "alfred-test-user", status: "ACTIVE", toolkit: { slug: "gmail" }, createdAt: "2026-05-20T13:16:00Z" },
      { id: "ca_gcal", member_id: "alfred-test-user", status: "ACTIVE", toolkit: { slug: "googlecalendar" }, createdAt: "2026-05-22T06:43:00Z" },
    ];
    const { status, data } = await req("GET", "/api/v1/integrations");
    assert.strictEqual(status, 200, JSON.stringify(data));
    const byId: Record<string, any> = {};
    for (const r of data.integrations) byId[r.id] = r;
    // No rows are dropped.
    assert.ok(byId.ca_old && byId.ca_new && byId.ca_gcal, "all rows present");
    // Newest gmail is primary; older gmail is the duplicate pointing at it.
    assert.strictEqual(byId.ca_new.is_primary, true);
    assert.strictEqual(byId.ca_old.is_primary, false);
    assert.strictEqual(byId.ca_old.duplicate_of, "ca_new");
    assert.strictEqual(byId.ca_new.duplicate_of ?? null, null);
    // Sole-account toolkits are primary with no duplicate.
    assert.strictEqual(byId.ca_gcal.is_primary, true);
    assert.strictEqual(byId.ca_gcal.duplicate_of ?? null, null);
  });
});
