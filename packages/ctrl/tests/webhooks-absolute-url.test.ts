// F27 — custom webhooks must expose a fully-qualified absolute URL
// (https://<TENANT_BASE_URL host>/api/v1/webhooks/in/<token>) on create AND
// list, not a bare relative path; and the integrations row for a webhook must
// carry url + token so it's retrievable after the create-flow toast.
// custom-webhook-findings.md bugs 1 & 2 (durable half).
import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any) => {
  const u = String(url);
  // The integrations list calls Composio for connected accounts — return none.
  if (/\/api\/v3\/connected_accounts/.test(u)) return new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 });
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
  existsSync: (p: string) => memFs.has(p) || memDirs.has(p) || [...memFs.keys()].some((f) => f.startsWith(p + "/")),
  readFileSync: (p: string) => { if (!memFs.has(p)) { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return memFs.get(p); },
  writeFileSync: (p: string, d: any) => { memFs.set(p, typeof d === "string" ? d : String(d)); },
  mkdirSync: (p: string) => { memDirs.add(p); }, readdirSync: (p: string) => children(p),
  statSync: (p: string) => ({ size: (memFs.get(p) || "").length, mtimeMs: 0, isDirectory: () => false, isFile: () => true }),
  unlinkSync: (p: string) => { memFs.delete(p); }, renameSync() {}, appendFileSync() {}, rmSync() {}, chownSync() {},
  openSync: () => 0, readSync: () => 0, closeSync() {}, createReadStream: () => ({ pipe() {}, on() {} }),
  Dirent: class { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: async () => undefined, writeFile: async () => undefined },
};
mock.module("node:fs", { defaultExport: fsMock, namedExports: { ...fsMock } });

process.env.COMPOSIO_API_KEY = "test-composio-key";
process.env.COMPOSIO_USER_ID = "alfred-test-user";
process.env.TENANT_BASE_URL = "https://test.alfred.black";
process.env.VAULT_PATH = "/vault";
await import("../src/api/routes/webhooksInbound.js");
await import("../src/api/routes/integrations.js");
const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;
before(async () => { server = createApiServer(); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); });
after(async () => { await new Promise<void>((r) => server.close(() => r())); globalThis.fetch = realFetch; });
beforeEach(() => { memFs.clear(); memDirs.clear(); });

async function req(method: string, p: string, body?: unknown): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: addr.port, path: p, method, headers: payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {} },
      (res) => { let raw = ""; res.on("data", (c) => { raw += c; }); res.on("end", () => { try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode!, data: raw }); } }); });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
}

describe("F27 — custom webhook absolute URL + integrations row exposure", () => {
  it("create returns an absolute URL with the tenant host", async () => {
    const { status, data } = await req("POST", "/api/v1/webhooks/inbound", { label: "test" });
    assert.strictEqual(status, 201, JSON.stringify(data));
    assert.match(data.url, /^https:\/\/test\.alfred\.black\/api\/v1\/webhooks\/in\/[0-9a-f]+$/,
      `expected absolute URL, got ${data.url}`);
    assert.ok(data.token, "token must be present");
  });

  it("list returns the absolute URL too", async () => {
    await req("POST", "/api/v1/webhooks/inbound", { label: "test2" });
    const { status, data } = await req("GET", "/api/v1/webhooks/inbound");
    assert.strictEqual(status, 200);
    assert.ok(data.webhooks.length >= 1);
    assert.match(data.webhooks[0].url, /^https:\/\/test\.alfred\.black\/api\/v1\/webhooks\/in\//);
  });

  it("integrations row for a webhook carries url + token", async () => {
    const created = await req("POST", "/api/v1/webhooks/inbound", { label: "wh-row" });
    const token = created.data.token;
    const { status, data } = await req("GET", "/api/v1/integrations");
    assert.strictEqual(status, 200, JSON.stringify(data));
    const row = data.integrations.find((r: any) => r.id === `webhook:${token}`);
    assert.ok(row, "webhook row must be listed in integrations");
    assert.strictEqual(row.token, token, "row must expose the token");
    assert.match(row.url, /^https:\/\/test\.alfred\.black\/api\/v1\/webhooks\/in\//,
      `row must expose the absolute url, got ${row.url}`);
  });
});
