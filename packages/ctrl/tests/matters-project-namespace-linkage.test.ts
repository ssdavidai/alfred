// B1 — top-level Matters must contain ONLY canonical matter/<slug> records.
//
// A prior fix (F8) promoted BOTH matter/<slug> AND project/<Human Name> vault
// records into the top-level /matters list. On the live box that surfaced a
// pile of auto-generated project/ junk as "matters" ("App Discourse Call",
// "Suno Marketing Campaign", …). project/ records are NOT first-class matters,
// so B1 reverts that surfacing:
//   - the top-level /matters index lists ONLY matter/<slug> records, and
//   - a task that links only a [[project/<name>]] record does NOT roll up to a
//     matter (extractMatterRef no longer resolves the project/ prefix).
// This test seeds both namespaces plus a project-linked task and asserts the
// project record stays out of the index — while the existing MatterDetail
// fields (about/summary/vault_by_category) still come through for matter/.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "matters-project-"));
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";

const VAULT = process.env.VAULT_PATH;
fs.mkdirSync(path.join(VAULT, "matter"), { recursive: true });
fs.mkdirSync(path.join(VAULT, "project"), { recursive: true });
fs.mkdirSync(path.join(VAULT, "task"), { recursive: true });

const { matchRoute } = await import("../src/api/server.js");
const { registerMatterRoutes } = await import("../src/api/routes/matters.js");
registerMatterRoutes();

function write(rel: string, lines: string[]): void {
  fs.writeFileSync(path.join(VAULT, rel), lines.join("\n") + "\n", "utf-8");
}

function seed(): void {
  // A regular matter/<slug> record (the canonical namespace).
  write("matter/acme-deal.md", [
    "---",
    "type: matter",
    "name: Acme Deal",
    "summary: Closing the Acme account",
    "status: active",
    "---",
    "",
    "## Context",
    "Acme is a strategic account.",
  ]);
  // A legacy auto-generated project/<Human Name> record. This must NOT show up
  // as a top-level matter.
  write("project/Pulumi Infrastructure Support.md", [
    "---",
    "type: project",
    "name: Pulumi Infrastructure Support",
    "summary: Stand up the IaC pipeline",
    "status: active",
    "---",
    "",
    "## Context",
    "Ongoing infra engagement.",
  ]);
  // A task that links ONLY to the project record by its human name. With B1 it
  // does not roll up to any matter (project/ refs no longer resolve).
  write("task/wire-up-pulumi.md", [
    "---",
    "type: task",
    "name: Wire up the Pulumi stack",
    "state: in_progress",
    "as_of: 2026-05-22T09:00:00.000Z",
    "project: '[[project/Pulumi Infrastructure Support]]'",
    "---",
    "",
    "Body.",
  ]);
}

async function call(method: string, pathname: string): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, pathname);
  assert.ok(m, `${method} ${pathname} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(json?: string) { payload = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({ req: { url: pathname } as any, res, params: m!.params, body: undefined, query: new URLSearchParams() });
  return { status, payload };
}

describe("matters route — only matter/ records are top-level matters (B1)", () => {
  before(() => {
    seed();
  });

  it("lists matter/ records in the index", async () => {
    const { status, payload } = await call("GET", "/api/v1/matters");
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(payload)}`);
    const ids = (payload.matters as any[]).map((m) => m.id);
    assert.ok(ids.includes("acme-deal"),
      `canonical matter must surface; got ${JSON.stringify(ids)}`);
  });

  it("does NOT surface project/ records as matters in the index", async () => {
    const { status, payload } = await call("GET", "/api/v1/matters");
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(payload)}`);
    const ids = (payload.matters as any[]).map((m) => m.id);
    assert.ok(!ids.includes("Pulumi Infrastructure Support"),
      `project record must NOT appear as a matter; got ${JSON.stringify(ids)}`);
  });

  it("does not roll a project/-only-linked task up to any matter", async () => {
    const { payload } = await call("GET", "/api/v1/matters");
    // The only top-level matter is acme-deal; the pulumi task links only a
    // project/ record, so it must not be counted against any matter.
    for (const m of payload.matters as any[]) {
      assert.equal(m.id, "acme-deal", `unexpected matter ${m.id}`);
      assert.equal(m.counts.tasks, 0,
        `project-linked task must not roll up; got ${JSON.stringify(m.counts)}`);
    }
  });

  it("does not regress about/summary/vault_by_category on the detail", async () => {
    const { payload } = await call("GET", "/api/v1/matters/acme-deal");
    const m = payload.matter;
    assert.ok(typeof m.about === "string" && m.about.includes("Acme is a strategic account"),
      "about must carry the body");
    assert.equal(m.summary, "Closing the Acme account");
    assert.ok(m.vault_by_category && typeof m.vault_by_category === "object",
      "vault_by_category must be present");
  });
});
