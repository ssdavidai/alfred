// F8 — matter↔project linkage across the matter/ vs project/ namespace split.
//
// debug/0522/matters-findings.md §4/§7-P1: the onboarding pipeline created
// matters under /vault/matter/<slug>.md, but every task links a *parallel* set
// of records under /vault/project/<Human Name>.md (legacy `project:` field with
// human-readable names). The aggregator only walked matter/ and only resolved
// refs that began `matter/` — so:
//   (a) project/ dir records were invisible to /matters entirely
//       (matters.ts:417 `if (!display.startsWith("matter/")) continue;`), and
//   (b) a `project: '[[project/Foo]]'` ref resolved to null because
//       extractMatterRef stripped only the `matter/` prefix, leaving a slash.
// Net effect: 0 of 21 live tasks linked to a matter; all counts permanently 0.
//
// Fix: also build matter skeletons from project/ records and resolve
// `project/<stem>` refs to that stem. This test seeds both namespaces and a
// task that points at the project record by its human name, and asserts the
// project surfaces as a matter with the task binned to it — while the existing
// MatterDetail fields (about/summary/vault_by_category) still come through.
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
  // A regular matter/<slug> record (the onboarding namespace).
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
  // A legacy project/<Human Name> record (the parallel namespace the tasks
  // actually point at). Note the human-readable filename / stem.
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
  // A task that links to the project record by its human name (the live
  // pattern: `project: '[[project/Pulumi Infrastructure Support]]'`).
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

describe("matters route — project/ namespace linkage (F8)", () => {
  before(() => {
    seed();
  });

  it("surfaces project/ records as matters in the index", async () => {
    const { status, payload } = await call("GET", "/api/v1/matters");
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(payload)}`);
    const ids = (payload.matters as any[]).map((m) => m.id);
    assert.ok(ids.includes("Pulumi Infrastructure Support"),
      `project record must surface as a matter; got ${JSON.stringify(ids)}`);
  });

  it("bins a task that references the project by [[project/<name>]]", async () => {
    const { status, payload } = await call("GET", "/api/v1/matters/Pulumi Infrastructure Support");
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(payload)}`);
    const m = payload.matter;
    assert.equal(m.counts.tasks, 1, `task must be counted; got ${JSON.stringify(m.counts)}`);
    const taskLinks = m.vault_by_category.tasks as any[];
    assert.ok(taskLinks.some((t) => t.path === "task/wire-up-pulumi.md"),
      `task must appear in vault_by_category.tasks; got ${JSON.stringify(taskLinks)}`);
    assert.ok((m.tasks as any[]).some((t) => t.id === "wire-up-pulumi"),
      `task must appear in tasks[]; got ${JSON.stringify(m.tasks)}`);
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
