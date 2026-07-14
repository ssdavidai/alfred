// B12 (ctrl half) — GET /api/v1/apps must return the real launchable sidecar
// apps the user can open in the merged single-VM stack, not the stale
// multi-tenant scheme. The merged-stack Caddyfile routes plane.{$DOMAIN} →
// plane-proxy:80, sure.{$DOMAIN} → sure-web:3000, vault.{$DOMAIN} →
// vaultwarden:80. The old route emitted an `openclaw` entry (now Hermes) and
// built {subdomain}-{app}.{domain} URLs off TENANT_SUBDOMAIN/TENANT_DOMAIN,
// which are unset on the merged stack → null URLs / wrong host.
//
// This must FAIL on the old apps.ts (openclaw present, no plane/sure/vault
// https://<app>.<domain> urls) and pass once the route is rebuilt around
// DOMAIN and the apex subdomain routes.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "apps-urls-"));
// Redirect data/vault/state paths that server.ts transitive imports touch at
// module load (streams.ts mkdirs ALFRED_DATA_DIR/streams).
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
// The real host of this tenant — URLs must resolve here, not the alfred.black
// default.
process.env.DOMAIN = "test.alfred.black";

const { matchRoute } = await import("../src/api/server.js");
const { registerAppsRoutes } = await import("../src/api/routes/apps.js");
registerAppsRoutes();

async function call(method: string, p: string): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(c: number) { status = c; return res; },
    end(j?: string) { payload = j ? JSON.parse(j) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({ req: { url: p } as any, res, params: m!.params, body: undefined, query: new URLSearchParams() });
  return { status, payload };
}

describe("GET /api/v1/apps — real launchable sidecar apps (B12)", () => {
  let apps: any[];

  before(async () => {
    const { status, payload } = await call("GET", "/api/v1/apps");
    assert.equal(status, 200, `expected 200, got ${status}`);
    apps = payload.apps;
    assert.ok(Array.isArray(apps), "apps must be an array");
  });

  it("includes Sure / Vault with apex https://<app>.<domain> urls", () => {
    const byId = new Map(apps.map((a) => [a.id, a]));

    for (const id of ["sure", "vault"]) {
      assert.ok(byId.has(id), `apps must include ${id}`);
    }
    assert.equal(byId.get("sure").url, "https://sure.test.alfred.black");
    assert.equal(byId.get("vault").url, "https://vault.test.alfred.black");
  });

  it("does NOT include an openclaw / chat entry", () => {
    for (const a of apps) {
      assert.notEqual(a.id, "openclaw", "openclaw entry must be dropped (runtime is Hermes)");
      assert.notEqual(a.id, "chat", "chat is a separate web thin-client, not a dock app");
    }
  });

  it("preserves the { id, name, url, icon, status } shape", () => {
    for (const a of apps) {
      for (const k of ["id", "name", "url", "icon", "status"]) {
        assert.ok(Object.prototype.hasOwnProperty.call(a, k), `app ${a.id} missing field ${k}`);
      }
      assert.ok(a.status === "up" || a.status === "down", `app ${a.id} status must be up|down`);
    }
  });
});
