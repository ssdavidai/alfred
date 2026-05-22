// F24 — when revoking the LAST account of a toolkit, the stream cleanup must
// also sweep legacy/unbound stream configs matched by composio_toolkit or
// source (e.g. a "migrated-to-composio" Gmail config with NO
// composio_connection_id), not just configs bound to the deleted connection id.
// gmail-revoke-findings.md finding #2.
import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const accounts: Record<string, any> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (/oauth2\.googleapis\.com\/revoke/.test(u)) return new Response("", { status: 200 });
  const single = u.match(/\/api\/v3\/connected_accounts\/([^?/]+)$/);
  if (single) {
    if (method === "DELETE") { delete accounts[decodeURIComponent(single[1])]; return new Response(JSON.stringify({ deleted: true }), { status: 200 }); }
    const acct = accounts[decodeURIComponent(single[1])];
    if (!acct) return new Response("Not found", { status: 404 });
    return new Response(JSON.stringify(acct), { status: 200 });
  }
  if (method === "GET" && /\/api\/v3\/connected_accounts(?:\?|$)/.test(u))
    return new Response(JSON.stringify({ items: Object.values(accounts), next_cursor: null }), { status: 200 });
  if (method === "GET" && /\/api\/v2\/actions/.test(u)) return new Response(JSON.stringify({ items: [] }), { status: 200 });
  return new Response(JSON.stringify({ error: "unmocked", url: u }), { status: 501 });
}) as typeof globalThis.fetch;

const memFs = new Map<string, string>();
const memDirs = new Set<string>();
function children(dir: string): string[] {
  const norm = dir.replace(/\/+$/, ""); const out = new Set<string>();
  for (const f of memFs.keys()) if (f.startsWith(norm + "/")) { const t = f.slice(norm.length + 1).split("/")[0]; if (t) out.add(t); }
  return [...out];
}
const fsMock: any = {
  existsSync: (p: string) => memFs.has(p) || memDirs.has(p),
  readFileSync: (p: string) => { if (!memFs.has(p)) { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return memFs.get(p); },
  writeFileSync: (p: string, d: any) => { memFs.set(p, typeof d === "string" ? d : String(d)); },
  mkdirSync: (p: string) => { memDirs.add(p); },
  readdirSync: (p: string) => children(p),
  statSync: () => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false }),
  unlinkSync: (p: string) => { memFs.delete(p); }, renameSync() {}, appendFileSync() {}, rmSync() {}, chownSync() {},
  openSync: () => 0, readSync: () => 0, closeSync() {}, createReadStream: () => ({ pipe() {}, on() {} }),
  Dirent: class { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: async () => undefined, writeFile: async () => undefined },
};
mock.module("node:fs", { defaultExport: fsMock, namedExports: { ...fsMock } });
mock.module("node:child_process", { namedExports: { execFile: (...a: any[]) => { (a[a.length - 1] as Function)(null, "{}", ""); }, spawn: () => ({ stderr: { on() {} }, stdin: { write() {}, end() {} }, on() {} }) } });

process.env.COMPOSIO_API_KEY = "test-composio-key";
process.env.COMPOSIO_USER_ID = "alfred-test-user";
process.env.ALFRED_DATA_DIR = "/alfred-data";
await import("../src/api/routes/integrations.js");
const { createApiServer } = await import("../src/api/server.js");

const CONFIGS = "/alfred-data/streams/configs";

let server: http.Server;
before(async () => { server = createApiServer(); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); });
after(async () => { await new Promise<void>((r) => server.close(() => r())); globalThis.fetch = realFetch; });
beforeEach(() => { for (const k of Object.keys(accounts)) delete accounts[k]; memFs.clear(); memDirs.clear(); });

async function req(method: string, p: string): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: addr.port, path: p, method },
      (res) => { let raw = ""; res.on("data", (c) => { raw += c; }); res.on("end", () => { try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode!, data: raw }); } }); });
    r.on("error", reject); r.end();
  });
}

describe("F24 — revoke sweeps legacy/unbound streams of the toolkit", () => {
  it("removes a migrated Gmail config with no composio_connection_id when last account goes", async () => {
    accounts["ca_gmail"] = { id: "ca_gmail", member_id: "alfred-test-user", status: "ACTIVE", toolkit: { slug: "gmail" }, state: { val: {} } };
    // Legacy stream config: NO composio_connection_id, matched only by toolkit/source.
    memFs.set(`${CONFIGS}/legacy-gmail.json`, JSON.stringify({ id: "legacy-gmail", source: "gmail", composio_toolkit: "gmail", status: "migrated-to-composio" }));
    // A bound config for the deleted connection.
    memFs.set(`${CONFIGS}/composio-gmail-fetch.json`, JSON.stringify({ id: "composio-gmail-fetch", composio_connection_id: "ca_gmail", composio_toolkit: "gmail" }));

    const { status, data } = await req("DELETE", "/api/v1/integrations/ca_gmail");
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.ok(!memFs.has(`${CONFIGS}/legacy-gmail.json`), "legacy unbound gmail config must be swept (last account)");
    assert.ok(!memFs.has(`${CONFIGS}/composio-gmail-fetch.json`), "bound gmail config must be swept");
  });

  it("does NOT sweep toolkit-matched configs while a sibling account survives", async () => {
    accounts["ca_gmail_a"] = { id: "ca_gmail_a", member_id: "alfred-test-user", status: "ACTIVE", toolkit: { slug: "gmail" }, state: { val: {} } };
    accounts["ca_gmail_b"] = { id: "ca_gmail_b", member_id: "alfred-test-user", status: "ACTIVE", toolkit: { slug: "gmail" }, state: { val: {} } };
    memFs.set(`${CONFIGS}/legacy-gmail.json`, JSON.stringify({ id: "legacy-gmail", source: "gmail", composio_toolkit: "gmail" }));
    memFs.set(`${CONFIGS}/bound-a.json`, JSON.stringify({ id: "bound-a", composio_connection_id: "ca_gmail_a", composio_toolkit: "gmail" }));

    const { status } = await req("DELETE", "/api/v1/integrations/ca_gmail_a");
    assert.strictEqual(status, 200);
    assert.ok(memFs.has(`${CONFIGS}/legacy-gmail.json`), "legacy config must survive while a sibling gmail account remains");
    assert.ok(!memFs.has(`${CONFIGS}/bound-a.json`), "the deleted connection's bound config is still removed");
  });
});
