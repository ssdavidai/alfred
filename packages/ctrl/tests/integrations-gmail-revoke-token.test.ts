// F23 — Revoking a Google connection (gmail, googlecalendar, …) must also
// revoke the upstream Google OAuth token at https://oauth2.googleapis.com/revoke
// so the grant disappears from the principal's Google account. Composio's
// DELETE only drops its stored credential. gmail-revoke-findings.md finding #1.
import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const accounts: Record<string, any> = {};
const calls: Array<{ method: string; url: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  calls.push({ method, url: u });

  // Google's revoke endpoint.
  if (/oauth2\.googleapis\.com\/revoke/.test(u)) return new Response("", { status: 200 });

  const get = u.match(/\/api\/v3\/connected_accounts\/([^?/]+)$/);
  if (method === "GET" && get) {
    const acct = accounts[decodeURIComponent(get[1])];
    if (!acct) return new Response("Not found", { status: 404 });
    return new Response(JSON.stringify(acct), { status: 200 });
  }
  const del = u.match(/\/api\/v3\/connected_accounts\/([^?/]+)$/);
  if (method === "DELETE" && del) return new Response(JSON.stringify({ deleted: true }), { status: 200 });
  // Owned-accounts list for lastOfToolkit (return only the deleted one's siblings = none).
  if (method === "GET" && /\/api\/v3\/connected_accounts(?:\?|$)/.test(u))
    return new Response(JSON.stringify({ items: Object.values(accounts), next_cursor: null }), { status: 200 });
  if (method === "GET" && /\/api\/v2\/actions/.test(u))
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  return new Response(JSON.stringify({ error: "unmocked", url: u }), { status: 501 });
}) as typeof globalThis.fetch;

const memFs = new Map<string, string>();
const memDirs = new Set<string>();
const fsMock: any = {
  existsSync: (p: string) => memFs.has(p) || memDirs.has(p),
  readFileSync: (p: string) => { if (!memFs.has(p)) { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return memFs.get(p); },
  writeFileSync: (p: string, d: any) => { memFs.set(p, typeof d === "string" ? d : String(d)); },
  mkdirSync: (p: string) => { memDirs.add(p); }, readdirSync: () => [],
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
await import("../src/api/routes/integrations.js");
const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;
before(async () => { server = createApiServer(); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); });
after(async () => { await new Promise<void>((r) => server.close(() => r())); globalThis.fetch = realFetch; });
beforeEach(() => { calls.length = 0; for (const k of Object.keys(accounts)) delete accounts[k]; memFs.clear(); memDirs.clear(); });

async function req(method: string, p: string): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: addr.port, path: p, method },
      (res) => { let raw = ""; res.on("data", (c) => { raw += c; }); res.on("end", () => { try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode!, data: raw }); } }); });
    r.on("error", reject); r.end();
  });
}

describe("F23 — Gmail revoke also revokes the Google OAuth token", () => {
  it("calls oauth2.googleapis.com/revoke for a Google connection", async () => {
    accounts["ca_gmail"] = {
      id: "ca_gmail", member_id: "alfred-test-user", status: "ACTIVE",
      toolkit: { slug: "gmail" },
      state: { val: { access_token: "ya29-dummy", refresh_token: "1//refresh-dummy" } },
    };
    const { status, data } = await req("DELETE", "/api/v1/integrations/ca_gmail");
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.ok(calls.some((c) => /oauth2\.googleapis\.com\/revoke/.test(c.url)),
      `expected a Google revoke call, got: ${calls.map((c) => c.url).join(", ")}`);
    assert.strictEqual(data.google_token_revoked, true);
  });

  it("does NOT call Google revoke for a non-Google toolkit", async () => {
    accounts["ca_notion"] = {
      id: "ca_notion", member_id: "alfred-test-user", status: "ACTIVE",
      toolkit: { slug: "notion" },
      state: { val: { access_token: "secret_notion" } },
    };
    const { status } = await req("DELETE", "/api/v1/integrations/ca_notion");
    assert.strictEqual(status, 200);
    assert.ok(!calls.some((c) => /oauth2\.googleapis\.com\/revoke/.test(c.url)),
      "must not revoke a Google token for a non-Google connection");
  });
});
