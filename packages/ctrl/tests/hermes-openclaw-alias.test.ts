// C7 (bug: /api/v1/openclaw/* retired but ~7 callers still hit it → 404).
//
// hermes.ts registers handlers under /api/v1/hermes/* only. The MCP alfred.ts
// tools and learn briefing.py:1711 still call /api/v1/openclaw/* and 404. The
// frozen fix (FIX-CONTRACTS C7) is to restore the /api/v1/openclaw/* alias as a
// thin forward to the same handlers. This test registers the hermes routes and
// asserts both prefixes resolve to a handler — and to the SAME handler — so the
// alias is a genuine forward, not a divergent copy.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// server.js transitively imports every route module; a few do module-level
// mkdir / db-open at import time. Point them at a throwaway dir so the import
// is side-effect-safe in the test sandbox.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-alias-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { matchRoute } = await import("../src/api/server.js");
const { registerHermesRoutes } = await import("../src/api/routes/hermes.js");

registerHermesRoutes();

describe("hermes /api/v1/openclaw/* alias (C7)", () => {
  for (const suffix of ["health", "ready", "status", "agents/ephemeral"]) {
    it(`GET /api/v1/openclaw/${suffix} resolves to the same handler as the hermes one`, () => {
      const hermes = matchRoute("GET", `/api/v1/hermes/${suffix}`);
      const openclaw = matchRoute("GET", `/api/v1/openclaw/${suffix}`);
      assert.ok(hermes, `hermes /${suffix} must resolve`);
      assert.ok(openclaw, `openclaw alias /${suffix} must resolve (would 404 without C7)`);
      assert.equal(
        openclaw!.handler,
        hermes!.handler,
        "alias must forward to the identical handler",
      );
    });
  }

  it("POST /api/v1/openclaw/restart resolves like the hermes one", () => {
    const hermes = matchRoute("POST", "/api/v1/hermes/restart");
    const openclaw = matchRoute("POST", "/api/v1/openclaw/restart");
    assert.ok(hermes);
    assert.ok(openclaw);
    assert.equal(openclaw!.handler, hermes!.handler);
  });
});
