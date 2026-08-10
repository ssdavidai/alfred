// Guards for POST /api/v1/vault/promote-triage (CLAUDE.md §6.2 / §15.2).
// The route previously emitted `status: queued` — rejected by the alfred-vault
// daemon with HTTP 500 (same defect as 2026-05-24 backfill, commit eed3799).
// Writers must set BOTH `status` (alfred-vault vocab) AND `state` (matters-
// aggregator vocab).

import { mock, describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

// child_process mock must precede any server import so dockerExec is a no-op.
mock.module("node:child_process", {
  namedExports: {
    execFile: mock.fn((...args: any[]) => {
      const cb = args[args.length - 1] as Function;
      cb(null, '{"ok":true}', "");
    }),
    execFileSync: mock.fn(() => ""),
    spawn: mock.fn(() => ({
      stderr: { on: mock.fn() }, stdin: { write: mock.fn(), end: mock.fn() }, on: mock.fn(),
    })),
  },
});

// Real temp vault so we can read back what vault.ts actually wrote.
const tmp   = fs.mkdtempSync(path.join(os.tmpdir(), "promote-triage-"));
const VAULT = path.join(tmp, "vault");
fs.mkdirSync(path.join(VAULT, "task"),            { recursive: true });
fs.mkdirSync(path.join(VAULT, "needs_attention"), { recursive: true });
fs.mkdirSync(path.join(tmp, "alfred-data"),       { recursive: true });

process.env.VAULT_PATH      = VAULT;
process.env.ALFRED_DATA_DIR = path.join(tmp, "alfred-data");
process.env.STATE_DB_PATH   = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";

const { matchRoute }          = await import("../src/api/server.js");
const { handleError }         = await import("../src/api/errors.js");
const { registerVaultRoutes } = await import("../src/api/routes/vault.js");

before(() => { registerVaultRoutes(); });

// alfred-vault validator vocab (active|blocked|cancelled|done|todo).
const VALID_STATUS = new Set(["active", "blocked", "cancelled", "done", "todo"]);
// matters-aggregator vocab (pending|in_progress|done|archived).
const VALID_STATE  = new Set(["pending", "in_progress", "done", "archived"]);

let triageSeq = 0;
function seedTriage(name: string): string {
  const slug = `triage-${++triageSeq}`;
  const rel  = `needs_attention/${slug}.md`;
  fs.writeFileSync(
    path.join(VAULT, rel),
    `---\ntype: needs_attention\nname: ${name}\n---\nBody.\n`,
    "utf-8",
  );
  return rel;
}

async function call(body: unknown): Promise<{ status: number; payload: any }> {
  const m = matchRoute("POST", "/api/v1/vault/promote-triage");
  assert.ok(m, "route must be registered");
  let status = 0;
  let payload: any;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(json?: string) { payload = json ? JSON.parse(json) : undefined; },
    setHeader: () => {},
  } as unknown as ServerResponse;
  try {
    await m!.handler({ req: { url: "/api/v1/vault/promote-triage" } as any, res, params: m!.params, body, query: new URLSearchParams() });
  } catch (err) { handleError(res, err); }
  return { status, payload };
}

describe("POST /api/v1/vault/promote-triage", () => {
  it("returns 400 when triagePath is absent", async () => {
    const { status, payload } = await call({});
    assert.strictEqual(status, 400);
    assert.ok(payload?.error?.message?.includes("triagePath"));
  });

  it("returns 404 when triage file does not exist", async () => {
    const { status } = await call({ triagePath: "needs_attention/ghost.md" });
    assert.strictEqual(status, 404);
  });

  it("writes status: todo and state: pending — both required §6.2/§15.2 fields", async () => {
    const { status, payload } = await call({ triagePath: seedTriage("Status+state task") });
    assert.strictEqual(status, 201, JSON.stringify(payload));

    const content = fs.readFileSync(path.join(VAULT, payload.taskPath), "utf-8");
    const gotStatus = content.match(/^status:\s*(\S+)/m)?.[1];
    const gotState  = content.match(/^state:\s*(\S+)/m)?.[1];

    // Primary regression guard — queued caused HTTP 500 from the alfred daemon.
    assert.notStrictEqual(gotStatus, "queued",
      "status: queued is rejected by alfred-vault with HTTP 500 (regression from 2026-05-24)");
    assert.strictEqual(gotStatus, "todo", `expected status: todo, got: ${gotStatus}`);
    assert.strictEqual(gotState,  "pending", `expected state: pending, got: ${gotState}`);
  });

  it("GUARD — emitted status must be in the alfred-vault validator vocabulary", async () => {
    const { status, payload } = await call({ triagePath: seedTriage("Guard status") });
    assert.strictEqual(status, 201);
    const content = fs.readFileSync(path.join(VAULT, payload.taskPath), "utf-8");
    const got = content.match(/^status:\s*(\S+)/m)?.[1] ?? "(absent)";
    assert.ok(VALID_STATUS.has(got),
      `status '${got}' is outside the validator vocabulary (${[...VALID_STATUS]}). ` +
      "The daemon rejects unknown values with HTTP 500.");
  });

  it("GUARD — emitted state must be in the matters-aggregator vocabulary", async () => {
    const { status, payload } = await call({ triagePath: seedTriage("Guard state") });
    assert.strictEqual(status, 201);
    const content = fs.readFileSync(path.join(VAULT, payload.taskPath), "utf-8");
    const got = content.match(/^state:\s*(\S+)/m)?.[1] ?? "(absent)";
    assert.ok(VALID_STATE.has(got),
      `state '${got}' is outside the matters-aggregator vocabulary (${[...VALID_STATE]}).`);
  });

  it("writes parent_matter + matter_ref when matter slug is provided", async () => {
    const { status, payload } = await call({ triagePath: seedTriage("Linked task"), matter: "leaky-roof" });
    assert.strictEqual(status, 201);
    const content = fs.readFileSync(path.join(VAULT, payload.taskPath), "utf-8");
    assert.ok(content.includes("parent_matter:"), "must carry parent_matter");
    assert.ok(content.includes("matter_ref:"),    "must carry matter_ref");
    assert.ok(content.includes("matter/leaky-roof.md"), "must reference the slug path");
  });

  it("writes signal_sources and closure_predicate", async () => {
    const { status, payload } = await call({ triagePath: seedTriage("Links task") });
    assert.strictEqual(status, 201);
    const content = fs.readFileSync(path.join(VAULT, payload.taskPath), "utf-8");
    assert.ok(content.includes("signal_sources:"),    "must carry signal_sources");
    assert.ok(content.includes("closure_predicate:"), "must carry closure_predicate");
  });

  it("returns 201 with taskPath and status=promoted", async () => {
    const { status, payload } = await call({ triagePath: seedTriage("Shape task") });
    assert.strictEqual(status, 201);
    assert.ok(typeof payload.taskPath === "string");
    assert.strictEqual(payload.status, "promoted");
    assert.ok(payload.taskPath.startsWith("task/"));
  });
});
