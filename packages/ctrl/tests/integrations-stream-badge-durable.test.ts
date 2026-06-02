// F26 — the "stream" badge (is_stream_source) must derive from DURABLE facts:
// an enabled composio-<toolkit>-* stream with a non-empty JSONL or last_event_at
// — NOT the reset-prone event_count counter (which auto-config / enable-stream /
// migrate-stream zero on every re-config, causing the badge to flicker). And
// re-config must PRESERVE the existing event_count/last_event_at, and write
// streams.json atomically (temp+rename). connections-stream-label-findings.md.
import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

let owned: any[] = [];
const composioConns: Record<string, any> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  const single = u.match(/\/api\/v3\/connected_accounts\/([^?/]+)$/);
  if (method === "GET" && single) {
    const a = composioConns[decodeURIComponent(single[1])];
    return a ? new Response(JSON.stringify(a), { status: 200 }) : new Response("nf", { status: 404 });
  }
  if (method === "GET" && /\/api\/v3\/connected_accounts(?:\?|$)/.test(u))
    return new Response(JSON.stringify({ items: owned, next_cursor: null }), { status: 200 });
  if (method === "GET" && /\/api\/v2\/actions/.test(u)) return new Response(JSON.stringify({ items: [] }), { status: 200 });
  return new Response(JSON.stringify({ error: "unmocked", url: u }), { status: 501 });
}) as typeof globalThis.fetch;

const memFs = new Map<string, string>();
const memDirs = new Set<string>();
const renameCalls: Array<[string, string]> = [];
const directStreamsWrites: string[] = [];
function children(dir: string): string[] {
  const norm = dir.replace(/\/+$/, ""); const out = new Set<string>();
  for (const f of memFs.keys()) if (f.startsWith(norm + "/")) { const t = f.slice(norm.length + 1).split("/")[0]; if (t) out.add(t); }
  return [...out];
}
const fsMock: any = {
  existsSync: (p: string) => memFs.has(p) || memDirs.has(p),
  readFileSync: (p: string) => { if (!memFs.has(p)) { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; } return memFs.get(p); },
  writeFileSync: (p: string, d: any) => { if (p.endsWith("/streams.json")) directStreamsWrites.push(p); memFs.set(p, typeof d === "string" ? d : String(d)); },
  mkdirSync: (p: string) => { memDirs.add(p); }, readdirSync: (p: string) => children(p),
  statSync: (p: string) => ({ size: (memFs.get(p) || "").length, mtimeMs: 0, isDirectory: () => false, isFile: () => true }),
  unlinkSync: (p: string) => { memFs.delete(p); },
  renameSync: (a: string, b: string) => { renameCalls.push([a, b]); if (memFs.has(a)) { memFs.set(b, memFs.get(a)!); memFs.delete(a); } },
  appendFileSync() {}, rmSync() {}, chownSync() {}, openSync: () => 0, readSync: () => 0, closeSync() {}, createReadStream: () => ({ pipe() {}, on() {} }),
  Dirent: class { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: async () => undefined, writeFile: async () => undefined },
};
mock.module("node:fs", { defaultExport: fsMock, namedExports: { ...fsMock } });
// execFileSync needed by src/api/routes/system.ts (ssh-keygen path, unused here).
mock.module("node:child_process", { namedExports: { execFile: (...a: any[]) => { (a[a.length - 1] as Function)(null, "{}", ""); }, execFileSync: () => "", spawn: () => ({ stderr: { on() {} }, stdin: { write() {}, end() {} }, on() {} }) } });

process.env.COMPOSIO_API_KEY = "test-composio-key";
process.env.COMPOSIO_USER_ID = "alfred-test-user";
process.env.ALFRED_DATA_DIR = "/alfred-data";
await import("../src/api/routes/integrations.js");
const { createApiServer } = await import("../src/api/server.js");

const STREAMS = "/alfred-data/streams";

let server: http.Server;
before(async () => { server = createApiServer(); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); });
after(async () => { await new Promise<void>((r) => server.close(() => r())); globalThis.fetch = realFetch; });
beforeEach(() => { owned = []; for (const k of Object.keys(composioConns)) delete composioConns[k]; memFs.clear(); memDirs.clear(); renameCalls.length = 0; directStreamsWrites.length = 0; });

async function req(method: string, p: string, body?: unknown): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: addr.port, path: p, method, headers: payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {} },
      (res) => { let raw = ""; res.on("data", (c) => { raw += c; }); res.on("end", () => { try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode!, data: raw }); } }); });
    r.on("error", reject); if (payload) r.write(payload); r.end();
  });
}

describe("F26 — stream badge derived from durable facts", () => {
  it("badges a stream with event_count=0 but a non-empty JSONL", async () => {
    owned = [{ id: "ca_gmail", member_id: "alfred-test-user", status: "ACTIVE", toolkit: { slug: "gmail" }, createdAt: "2026-05-20T11:00:00Z" }];
    memFs.set(`${STREAMS}/streams.json`, JSON.stringify([
      { id: "composio-gmail-gmail-fetch-emails", source: "composio:gmail", enabled: true, event_count: 0, last_event_at: null },
    ]));
    memFs.set(`${STREAMS}/composio-gmail-gmail-fetch-emails.jsonl`, "{\"id\":1}\n{\"id\":2}\n");
    const { status, data } = await req("GET", "/api/v1/integrations");
    assert.strictEqual(status, 200, JSON.stringify(data));
    const gmail = data.integrations.find((r: any) => r.id === "ca_gmail");
    assert.strictEqual(gmail.is_stream_source, true, "non-empty JSONL must light the badge despite event_count=0");
  });

  it("does NOT badge a disabled stream with an empty JSONL", async () => {
    owned = [{ id: "ca_gmail", member_id: "alfred-test-user", status: "ACTIVE", toolkit: { slug: "gmail" }, createdAt: "2026-05-20T11:00:00Z" }];
    memFs.set(`${STREAMS}/streams.json`, JSON.stringify([
      { id: "composio-gmail-gmail-fetch-emails", source: "composio:gmail", enabled: false, status: "migrated-to-composio", event_count: 0, last_event_at: null },
    ]));
    const { status, data } = await req("GET", "/api/v1/integrations");
    assert.strictEqual(status, 200);
    const gmail = data.integrations.find((r: any) => r.id === "ca_gmail");
    assert.strictEqual(gmail.is_stream_source, false);
  });
});

describe("F26 — re-config preserves the counter + writes atomically", () => {
  it("enable-stream preserves an existing event_count/last_event_at and writes via rename", async () => {
    owned = [{ id: "ca_gmail", member_id: "alfred-test-user", status: "ACTIVE", toolkit: { slug: "gmail" } }];
    composioConns["ca_gmail"] = owned[0];
    const streamId = "composio-gmail-gmail-fetch-emails";
    memFs.set(`${STREAMS}/streams.json`, JSON.stringify([
      { id: streamId, source: "composio:gmail", enabled: true, event_count: 4242, last_event_at: "2026-05-22T06:48:00Z" },
    ]));
    const { status } = await req("POST", `/api/v1/integrations/ca_gmail/enable-stream`,
      { action_slug: "GMAIL_FETCH_EMAILS" });
    assert.ok(status === 200 || status === 201, `enable-stream status ${status}`);
    const streams = JSON.parse(memFs.get(`${STREAMS}/streams.json`)!);
    const entry = streams.find((s: any) => s.id === streamId);
    assert.strictEqual(entry.event_count, 4242, "event_count must be preserved on re-config, not zeroed");
    assert.strictEqual(entry.last_event_at, "2026-05-22T06:48:00Z", "last_event_at preserved");
    // Atomic: streams.json was committed via a rename, not a direct write to the live path.
    assert.ok(renameCalls.some(([, to]) => to.endsWith("/streams.json")),
      "streams.json must be written atomically (temp+rename)");
    assert.strictEqual(directStreamsWrites.length, 0, "no direct writeFileSync to the live streams.json");
  });
});
