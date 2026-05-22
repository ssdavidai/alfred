// F11 (C19) — GET /api/v1/vault/graph?focus=<path> returns a backlinks array.
//
// The web matter-detail / vault backlink panel calls
//   GET /api/v1/vault/graph?focus=<path>
// and reads `graph.backlinks` (operations.ts:1571). But the route ignored
// `?focus=` and never returned a `backlinks` key — it returned {nodes, edges,
// activity} only, so backlinks were always [] → "Linked from: no record yet".
//
// C19 freezes the shape: with ?focus=<record_path>, return
//   { nodes, edges, activity, backlinks: [{ path, name, rel }] }
// where each backlink is a record that links TO the focused record.
//
// This test seeds a matter referenced by a person (related/wikilink) and a task
// (project:), focuses on the matter, and asserts the backlinks resolve with the
// linking record's path/name/rel. Without ?focus= the key is absent (or empty).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "graph-focus-"));
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";

const VAULT = process.env.VAULT_PATH;
for (const d of ["matter", "person", "task"]) {
  fs.mkdirSync(path.join(VAULT, d), { recursive: true });
}

const { matchRoute } = await import("../src/api/server.js");
const { registerVaultRoutes } = await import("../src/api/routes/vault.js");
registerVaultRoutes();

function writeRec(rel: string, fm: string, body = "body"): void {
  fs.writeFileSync(path.join(VAULT, rel), `---\n${fm}\n---\n\n${body}\n`, "utf-8");
}

async function call(method: string, pathname: string): Promise<{ status: number; payload: any }> {
  const qIdx = pathname.indexOf("?");
  const clean = qIdx >= 0 ? pathname.slice(0, qIdx) : pathname;
  const query = new URLSearchParams(qIdx >= 0 ? pathname.slice(qIdx + 1) : "");
  const m = matchRoute(method, clean);
  assert.ok(m, `${method} ${clean} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(json?: string) { payload = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({ req: { url: pathname } as any, res, params: m!.params, body: undefined, query });
  return { status, payload };
}

describe("vault graph ?focus → backlinks (F11/C19)", () => {
  before(() => {
    writeRec("matter/acme-deal.md", ['type: matter', 'name: Acme Deal'].join("\n"));
    writeRec(
      "person/Jane Doe.md",
      ['type: person', 'name: Jane Doe', 'related:', '  - "[[matter/acme-deal]]"'].join("\n"),
    );
    writeRec(
      "task/Close Acme.md",
      ['type: task', 'name: Close Acme', 'project: "[[matter/acme-deal]]"'].join("\n"),
    );
  });

  it("returns a backlinks array for the focused record", async () => {
    const { status, payload } = await call(
      "GET",
      "/api/v1/vault/graph?focus=" + encodeURIComponent("matter/acme-deal.md"),
    );
    assert.equal(status, 200);
    assert.ok(Array.isArray(payload.backlinks), "backlinks must be an array");
    const paths = payload.backlinks.map((b: any) => b.path).sort();
    assert.deepEqual(paths, ["person/Jane Doe.md", "task/Close Acme.md"]);
    const jane = payload.backlinks.find((b: any) => b.path === "person/Jane Doe.md");
    assert.equal(jane.name, "Jane Doe", "backlink carries the linking record's name");
    assert.equal(jane.rel, "related", "backlink carries the relation");
  });

  it("focus also accepts a path without the .md suffix", async () => {
    const { payload } = await call(
      "GET",
      "/api/v1/vault/graph?focus=" + encodeURIComponent("matter/acme-deal"),
    );
    assert.ok(Array.isArray(payload.backlinks));
    assert.equal(payload.backlinks.length, 2);
  });

  it("backlinks is empty (not absent) when no record links in", async () => {
    const { payload } = await call(
      "GET",
      "/api/v1/vault/graph?focus=" + encodeURIComponent("person/Jane Doe.md"),
    );
    assert.ok(Array.isArray(payload.backlinks), "backlinks must always be an array under focus");
    assert.equal(payload.backlinks.length, 0);
  });
});
