// F17 — (a) reject synthetic alfred-* slugs in POST /integrations/connect and
// /integrations/connect-api-key (posting alfred-omi to Composio fuzzy-resolves
// to a junk `cal` connection — the cal-junk landmine). (b) add an OMI-pair path
// that reuses createOrReuseOmiStream({source:"omi"}) and surfaces the composed
// device webhook_url, never touching Composio.
import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const composioCalls: Array<{ method: string; url: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  composioCalls.push({ method, url: u });
  // Anything that reaches Composio in this test is a bug — fail loud.
  return new Response(JSON.stringify({ error: "unexpected composio call", url: u }), { status: 599 });
}) as typeof globalThis.fetch;

// In-memory fs so the omi stream persists across requests within a test.
const memFs = new Map<string, string>();
const memDirs = new Set<string>();
const fsMock: any = {
  existsSync: (p: string) => memFs.has(p) || memDirs.has(p),
  readFileSync: (p: string) => { if (!memFs.has(p)) { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return memFs.get(p); },
  writeFileSync: (p: string, d: any) => { memFs.set(p, typeof d === "string" ? d : String(d)); },
  mkdirSync: (p: string) => { memDirs.add(p); },
  readdirSync: () => [],
  statSync: () => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false }),
  unlinkSync: (p: string) => { memFs.delete(p); },
  renameSync: (a: string, b: string) => { if (memFs.has(a)) { memFs.set(b, memFs.get(a)!); memFs.delete(a); } },
  appendFileSync() {}, rmSync() {}, chownSync() {},
  openSync: () => 0, readSync: () => 0, closeSync() {},
  createReadStream: () => ({ pipe() {}, on() {} }),
  Dirent: class { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: async () => undefined, writeFile: async () => undefined },
};
mock.module("node:fs", { defaultExport: fsMock, namedExports: { ...fsMock } });

process.env.COMPOSIO_API_KEY = "test-composio-key";
process.env.COMPOSIO_USER_ID = "alfred-test-user";
process.env.TENANT_BASE_URL = "https://test.alfred.black";
await import("../src/api/routes/streams.js");
await import("../src/api/routes/integrations.js");
const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;
before(async () => { server = createApiServer(); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); });
after(async () => { await new Promise<void>((r) => server.close(() => r())); globalThis.fetch = realFetch; });
beforeEach(() => { composioCalls.length = 0; memFs.clear(); memDirs.clear(); });

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

describe("F17 — synthetic slug guard", () => {
  for (const slug of ["alfred-omi", "alfred-webhook"]) {
    it(`rejects ${slug} on /integrations/connect with 400 and never calls Composio`, async () => {
      const { status } = await req("POST", "/api/v1/integrations/connect", { toolkit_slug: slug });
      assert.strictEqual(status, 400);
      assert.strictEqual(composioCalls.length, 0, "must not reach Composio");
    });
    it(`rejects ${slug} on /integrations/connect-api-key with 400`, async () => {
      const { status } = await req("POST", "/api/v1/integrations/connect-api-key",
        { toolkit_slug: slug, credential: "x", auth_scheme: "API_KEY" });
      assert.strictEqual(status, 400);
      assert.strictEqual(composioCalls.length, 0, "must not reach Composio");
    });
  }
});

describe("F17 — OMI pairing path", () => {
  it("creates a source:omi stream and returns a composed webhook_url", async () => {
    const { status, data } = await req("POST", "/api/v1/integrations/omi/pair");
    assert.strictEqual(status, 200, JSON.stringify(data));
    assert.ok(typeof data.webhook_url === "string" && data.webhook_url.includes("/api/v1/streams/omi/audio"),
      `expected an omi audio url, got ${data.webhook_url}`);
    assert.strictEqual(composioCalls.length, 0, "OMI pair must not touch Composio");
  });

  it("reuses the existing omi stream on a second pair call (idempotent)", async () => {
    const first = await req("POST", "/api/v1/integrations/omi/pair");
    const second = await req("POST", "/api/v1/integrations/omi/pair");
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.data.webhook_url, first.data.webhook_url, "same URL on reuse");
    assert.strictEqual(second.data.reused, true);
  });
});
