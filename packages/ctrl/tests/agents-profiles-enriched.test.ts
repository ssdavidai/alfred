// F68 (C17) — enriched agent list + GET /api/v1/admin/profiles.
//
// The list endpoint (GET /api/v1/admin/agents) returned only {id,label,
// description}, so the model-config matrix UI had to N+1 to /agents/:id per
// agent to learn each profile's model. C17 requires the model-config matrix to
// render in one round-trip:
//   - the list carries `profile` + `default_model` per agent;
//   - GET /api/v1/admin/profiles returns the 3 profiles (main/workers/heavy)
//     each with {id, gateway_port, default_model, resolved_model, description,
//     agents:[...]} + surveyor.
//
// We seed real Hermes profile config.yaml files and read them via readProfileModel
// (no docker). The surveyor reads config.yaml via python3 — unavailable here —
// so we tolerate its default fallback.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agents-profiles-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
process.env.HERMES_CONFIG_DIR = path.join(tmp, "profiles");
fs.mkdirSync(path.join(tmp, "streams"), { recursive: true });

function seedProfile(name: string, model: string): void {
  const dir = path.join(tmp, "profiles", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), `model:\n  default: ${model}\n`, "utf-8");
}
seedProfile("main", "x-ai/grok-4.3");
seedProfile("workers", "openai/gpt-4.1-nano");
seedProfile("heavy", "anthropic/claude-opus-4-6");

const { matchRoute } = await import("../src/api/server.js");
const { registerAgentRoutes } = await import("../src/api/routes/agents.js");
registerAgentRoutes();

async function call(pathname: string): Promise<{ status: number; payload: any }> {
  const m = matchRoute("GET", pathname);
  assert.ok(m, `GET ${pathname} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(json?: string) { payload = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({ req: { url: pathname } as any, res, params: m!.params, body: undefined, query: new URLSearchParams() });
  return { status, payload };
}

describe("enriched agent list (F68/C17)", () => {
  it("carries profile + default_model per agent", async () => {
    const { status, payload } = await call("/api/v1/admin/agents");
    assert.equal(status, 200);
    const main = payload.agents.find((a: any) => a.id === "main");
    assert.equal(main.profile, "main", "list must carry profile");
    assert.equal(main.default_model, "x-ai/grok-4.3", "list must carry default_model");
    const heavy = payload.agents.find((a: any) => a.profile === "heavy");
    assert.ok(heavy, "heavy-profile agent must be present");
    assert.equal(heavy.default_model, "anthropic/claude-opus-4-6");
  });
});

describe("GET /api/v1/admin/profiles (F68/C17)", () => {
  let data: any;
  before(async () => {
    const r = await call("/api/v1/admin/profiles");
    assert.equal(r.status, 200);
    data = r.payload;
  });

  it("returns the three Hermes profiles with the C17 shape", () => {
    assert.ok(Array.isArray(data.profiles), "profiles must be an array");
    const ids = data.profiles.map((p: any) => p.id).sort();
    assert.deepEqual(ids, ["heavy", "main", "workers"]);
  });

  it("each profile carries id/gateway_port/default_model/resolved_model/description/agents", () => {
    const heavy = data.profiles.find((p: any) => p.id === "heavy");
    assert.equal(heavy.gateway_port, 18791);
    assert.equal(heavy.default_model, "anthropic/claude-opus-4-6");
    assert.equal(heavy.resolved_model, "anthropic/claude-opus-4-6");
    assert.ok(typeof heavy.description === "string" && heavy.description.length > 0);
    assert.ok(Array.isArray(heavy.agents) && heavy.agents.length >= 1, "heavy must list its agents");
  });

  it("main maps to :18789, workers to :18790", () => {
    assert.equal(data.profiles.find((p: any) => p.id === "main").gateway_port, 18789);
    assert.equal(data.profiles.find((p: any) => p.id === "workers").gateway_port, 18790);
  });

  it("includes the surveyor block", () => {
    assert.ok(data.surveyor, "profiles response must include surveyor");
    assert.ok(typeof data.surveyor.labeler_model === "string");
  });
});
