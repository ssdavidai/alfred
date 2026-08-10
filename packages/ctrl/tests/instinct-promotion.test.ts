// POST /api/v1/learning/instincts/:slug/promotion (#452/#459)
// approve, decline, 404 (missing instinct), 409 (no pending promotion).

import { mock, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

// Mock helpers before any await import so learning.ts gets the stub.
let lastDockerCall: { container: string; args: string[] } | null = null;
let dockerExecReturn = "";
// Import the REAL module and override only what we stub. Enumerating exports
// by hand does not work: mock.module replaces the module for EVERY importer in
// the graph, so any export used by an unrelated route (logs.ts wants
// COMPOSE_DIR, others want HERMES_CMD) must still be present or that route
// fails to link. Two CI runs were spent discovering this one export at a time.
const realHelpers = await import("../src/api/helpers.js");
mock.module("../src/api/helpers.js", {
  namedExports: {
    ...realHelpers,
    dockerExec: async (container: string, args: string[]) => {
      lastDockerCall = { container, args };
      return dockerExecReturn;
    },
    dockerComposeCmd: async () => "",
  },
});

// VAULT_PATH must be set before learning.ts is evaluated.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "instinct-promo-"));
process.env.VAULT_PATH = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.ALFRED_DATA_DIR = tmp;
process.env.SQLITE_VEC_PATH = "";
fs.mkdirSync(path.join(tmp, "instinct"), { recursive: true });

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { registerLearningRoutes } = await import("../src/api/routes/learning.js");
registerLearningRoutes();

function writeInstinct(slug: string, pendingPromotion?: string): void {
  const lines = ["---", `name: Test ${slug}`, "status: active", "tier: Confirming"];
  if (pendingPromotion) lines.push(`pending_promotion: ${pendingPromotion}`);
  lines.push("---", "Body.");
  fs.writeFileSync(path.join(tmp, "instinct", `${slug}.md`), lines.join("\n"), "utf-8");
}

async function invokePromotion(slug: string, approved: boolean): Promise<{ status: number; payload: any }> {
  const urlPath = `/api/v1/learning/instincts/${slug}/promotion`;
  const m = matchRoute("POST", urlPath);
  assert.ok(m, `POST ${urlPath} must be registered`);
  let status = 0; let payload: any;
  const res = {
    setHeader() {},
    writeHead(c: number) { status = c; return res; },
    end(j?: string) { payload = j ? JSON.parse(j) : undefined; },
  } as unknown as ServerResponse;
  try {
    await m!.handler({
      req: { method: "POST", url: urlPath, headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any,
      res, params: m!.params, body: { approved }, query: new URLSearchParams(""),
    });
  } catch (err) { handleError(res, err); }
  return { status, payload };
}

describe("POST /api/v1/learning/instincts/:slug/promotion", () => {
  it("approve: 200, tier=Acting, pending_promotion=null, dockerExec called with True", async () => {
    writeInstinct("approve-ok", "Acting");
    dockerExecReturn = JSON.stringify({ path: "instinct/approve-ok.md", applied: true, tier: "Acting" });
    lastDockerCall = null;
    const { status, payload } = await invokePromotion("approve-ok", true);
    assert.equal(status, 200);
    assert.equal(payload.tier, "Acting");
    assert.equal(payload.pending_promotion, null);
    assert.equal(lastDockerCall!.container, "alfred-learn");
    assert.ok(lastDockerCall!.args.join(" ").includes("True"), "script must pass True");
  });

  it("decline: 200, tier=Confirming, pending_promotion=null, dockerExec called with False", async () => {
    writeInstinct("decline-ok", "Acting");
    dockerExecReturn = JSON.stringify({ path: "instinct/decline-ok.md", applied: false, tier: "Confirming" });
    lastDockerCall = null;
    const { status, payload } = await invokePromotion("decline-ok", false);
    assert.equal(status, 200);
    assert.equal(payload.tier, "Confirming");
    assert.equal(payload.pending_promotion, null);
    assert.ok(lastDockerCall!.args.join(" ").includes("False"), "script must pass False");
  });

  it("missing instinct: 404", async () => {
    const { status, payload } = await invokePromotion("zzz-no-such-instinct", true);
    assert.equal(status, 404);
    assert.equal(payload.error.code, "NOT_FOUND");
  });

  it("no pending_promotion field: 409 without calling dockerExec", async () => {
    writeInstinct("no-pending");
    lastDockerCall = null;
    const { status, payload } = await invokePromotion("no-pending", true);
    assert.equal(status, 409);
    assert.equal(payload.error.code, "CONFLICT");
    assert.equal(lastDockerCall, null, "dockerExec must NOT be called when pending is absent");
  });
});
