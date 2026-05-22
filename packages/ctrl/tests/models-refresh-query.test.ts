// F66 — GET /api/v1/admin/models?refresh=true must bust the cache.
//
// The handler read `query?.refresh` on a URLSearchParams — always undefined —
// so forceRefresh was ALWAYS false. A warm (possibly empty) cache could never
// be force-refreshed from the UI; ?refresh=true served the stale cache in 0ms.
// Fix: `query.get("refresh") === "true"`.
//
// This test primes the cache (first GET), then GETs with ?refresh=true and
// asserts the response reports cached:false (a real re-fetch). No provider keys
// are configured so fetchAllModels returns [] without network calls.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "models-refresh-"));
process.env.COMPOSE_DIR = tmp;
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
fs.mkdirSync(path.join(tmp, "streams"), { recursive: true });

// Strip every provider key from the env so fetchAllModels makes no network call.
const PROVIDER_KEYS = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY", "KIMI_API_KEY"];
const SAVED: Record<string, string | undefined> = {};
for (const k of PROVIDER_KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }

const { matchRoute } = await import("../src/api/server.js");
const { registerModelRoutes } = await import("../src/api/routes/models.js");
registerModelRoutes();

async function call(pathname: string): Promise<{ status: number; payload: any }> {
  const qIdx = pathname.indexOf("?");
  const clean = qIdx >= 0 ? pathname.slice(0, qIdx) : pathname;
  const query = new URLSearchParams(qIdx >= 0 ? pathname.slice(qIdx + 1) : "");
  const m = matchRoute("GET", clean);
  assert.ok(m, `GET ${clean} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(json?: string) { payload = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({ req: { url: pathname } as any, res, params: m!.params, body: undefined, query });
  return { status, payload };
}

describe("GET /admin/models?refresh=true busts cache (F66)", () => {
  after(() => {
    for (const k of PROVIDER_KEYS) {
      if (SAVED[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED[k]!;
    }
  });

  it("primes then force-refreshes (cached:false)", async () => {
    const first = await call("/api/v1/admin/models");
    assert.equal(first.status, 200);
    // A second plain GET should serve the warm cache.
    const warm = await call("/api/v1/admin/models");
    assert.equal(warm.payload.cached, true, "warm GET should be cached");
    // ?refresh=true must bypass the cache.
    const refreshed = await call("/api/v1/admin/models?refresh=true");
    assert.equal(refreshed.payload.cached, false, "?refresh=true must force a re-fetch (cached:false)");
  });
});
