// F62 — /api/v1/claude-setup must build per-app MCP URLs from the real public
// host mcp.${DOMAIN} (Caddy only routes mcp.{$DOMAIN} → mcp-server), NOT the
// unset TENANT_SUBDOMAIN/TENANT_DOMAIN scheme that produced null URLs and an
// empty /claude list. And `enabled` gating must use the env names the merged
// stack actually sets: VAULTWARDEN_BW_PASSWORD (not BW_USER), SURE_API_KEY.
// mcp-servers-findings.md P0 + P2.
import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const fsMock: any = { existsSync: () => false, readFileSync: () => { const e: any = new Error("ENOENT"); e.code = "ENOENT"; throw e; }, writeFileSync() {}, mkdirSync() {}, readdirSync: () => [], statSync: () => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false }), unlinkSync() {}, renameSync() {}, appendFileSync() {}, rmSync() {}, chownSync() {}, openSync: () => 0, readSync: () => 0, closeSync() {}, createReadStream: () => ({ pipe() {}, on() {} }), Dirent: class { name = ""; isFile() { return true; } isDirectory() { return false; } }, promises: { mkdir: async () => undefined, writeFile: async () => undefined } };
mock.module("node:fs", { defaultExport: fsMock, namedExports: { ...fsMock } });

// The merged single-VM env model: DOMAIN set, no TENANT_* vars; provisioned
// creds use the merged names.
process.env.DOMAIN = "test.alfred.black";
delete process.env.TENANT_SUBDOMAIN;
delete process.env.TENANT_DOMAIN;
process.env.SURE_API_KEY = "sure-key-present";
process.env.VAULTWARDEN_BW_PASSWORD = "x".repeat(64);
process.env.COMPOSIO_API_KEY = "composio-present";
delete process.env.BW_USER;
delete process.env.PLANE_API_TOKEN;

await import("../src/api/routes/claudeSetup.js");
const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;
before(async () => { server = createApiServer(); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); });
after(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function req(method: string, p: string): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: addr.port, path: p, method },
      (res) => { let raw = ""; res.on("data", (c) => { raw += c; }); res.on("end", () => { try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode!, data: raw }); } }); });
    r.on("error", reject); r.end();
  });
}

describe("F62 — claude-setup MCP URLs + gating", () => {
  it("builds per-app mcp_url from mcp.${DOMAIN}", async () => {
    const { status, data } = await req("GET", "/api/v1/claude-setup");
    assert.strictEqual(status, 200, JSON.stringify(data));
    const byId: Record<string, any> = {};
    for (const a of data.apps) byId[a.id] = a;
    assert.strictEqual(byId.alfred.mcp_url, "https://mcp.test.alfred.black/alfred/mcp");
    assert.strictEqual(byId.execute.mcp_url, "https://mcp.test.alfred.black/execute/mcp");
    assert.strictEqual(data.tenant_url, "https://mcp.test.alfred.black");
  });

  it("gates vaultwarden on VAULTWARDEN_BW_PASSWORD and sure on SURE_API_KEY", async () => {
    const { data } = await req("GET", "/api/v1/claude-setup");
    const byId: Record<string, any> = {};
    for (const a of data.apps) byId[a.id] = a;
    assert.strictEqual(byId.vaultwarden.enabled, true, "vaultwarden enabled via VAULTWARDEN_BW_PASSWORD");
    assert.strictEqual(byId.sure.enabled, true, "sure enabled via SURE_API_KEY");
    assert.strictEqual(byId.plane.enabled, false, "plane not provisioned");
    assert.strictEqual(byId.execute.enabled, true);
    assert.strictEqual(byId.alfred.enabled, true);
  });
});
