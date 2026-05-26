// #229 — matters list `counts.tasks` must equal matters detail `tasks.length`.
//
// Bug: Pass-3 dropped archived tasks from counts.tasks (via
// isArchivedTaskFm) but the tasks[] composition loop accepted everything.
// A matter with one open task and one archived task ended up with
// counts.tasks=1 and detail.matter.tasks.length=2 — the UI showed two
// different numbers on the index vs the detail card.
//
// This test seeds a matter with one open + one archived task and asserts
// the two endpoints agree.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "matters-taskcount-"));
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";

const VAULT = process.env.VAULT_PATH!;
for (const d of ["matter", "task"]) fs.mkdirSync(path.join(VAULT, d), { recursive: true });

const { matchRoute } = await import("../src/api/server.js");
const { registerMatterRoutes } = await import("../src/api/routes/matters.js");
registerMatterRoutes();

const write = (rel: string, lines: string[]): void =>
  fs.writeFileSync(path.join(VAULT, rel), lines.join("\n") + "\n", "utf-8");

function seed(): void {
  write("matter/leaky-roof.md", [
    "---",
    "type: matter",
    "name: Leaky roof",
    "summary: Find a roofer",
    "status: active",
    "---",
    "## Context",
    "Water is dripping in the attic.",
  ]);
  // Open task — counts and tasks[] both include this.
  write("task/get-quotes.md", [
    "---",
    "type: task",
    "name: Get three quotes",
    "matter: '[[matter/leaky-roof]]'",
    "state: open",
    "current_state: open",
    "as_of: 2026-05-26",
    "---",
  ]);
  // Archived task via the `state: archived` convention — counts must drop,
  // tasks[] must also drop (the bug was tasks[] keeping it).
  write("task/old-tarp.md", [
    "---",
    "type: task",
    "name: Buy emergency tarp",
    "matter: '[[matter/leaky-roof]]'",
    "state: archived",
    "current_state: archived",
    "as_of: 2026-04-01",
    "---",
  ]);
  // Archived via the `status: cancelled` legacy alias — same expectation.
  write("task/cancelled-survey.md", [
    "---",
    "type: task",
    "name: Drone survey",
    "matter: '[[matter/leaky-roof]]'",
    "status: cancelled",
    "as_of: 2026-03-20",
    "---",
  ]);
  // Archived via the `archived: true` boolean — same expectation.
  write("task/old-estimate.md", [
    "---",
    "type: task",
    "name: Old verbal estimate",
    "matter: '[[matter/leaky-roof]]'",
    "archived: true",
    "as_of: 2026-02-10",
    "---",
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
  await m!.handler({
    req: { url: pathname } as any,
    res,
    params: m!.params,
    body: undefined,
    query: new URLSearchParams(),
  });
  return { status, payload };
}

describe("matters task-count consistency (#229)", () => {
  before(() => seed());

  it("list.counts.tasks equals detail.matter.tasks.length", async () => {
    const list = await call("GET", "/api/v1/matters");
    assert.equal(list.status, 200);
    const row = list.payload.matters.find((m: any) => m.id === "leaky-roof");
    assert.ok(row, "leaky-roof matter must appear in list");

    const detail = await call("GET", "/api/v1/matters/leaky-roof");
    assert.equal(detail.status, 200);

    assert.equal(
      row.counts.tasks,
      detail.payload.matter.tasks.length,
      `list.counts.tasks (${row.counts.tasks}) must equal detail.tasks.length (${detail.payload.matter.tasks.length})`,
    );
    // The single open task is the one that survives the archived filter.
    assert.equal(row.counts.tasks, 1, "only the open task should count");
    assert.equal(detail.payload.matter.tasks[0].id, "get-quotes");
  });

  it("vault_by_category.tasks keeps the browseable links for all four", async () => {
    // Browseability is intentional — archived tasks vanish from the count and
    // the structured array, but remain reachable from the matter detail page.
    const detail = await call("GET", "/api/v1/matters/leaky-roof");
    const links = detail.payload.matter.vault_by_category.tasks;
    assert.equal(links.length, 4, "all four task records should appear in vault_by_category");
  });
});
