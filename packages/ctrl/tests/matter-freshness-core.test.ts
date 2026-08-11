// #543 — narrative provenance on matter/task records (extends #318).
// Rules: (1) unknown never → fresh; (2) observed_at is as_of verbatim, never now().

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { classifyNarrativeProvenance } from "../src/api/lib/matter_freshness.js";

const NOW_MS = new Date("2026-08-11T08:00:00Z").getTime();

describe("classifyNarrativeProvenance — unit", () => {
  it("null/undefined/empty as_of → unknown, source null, observed_at null (rules 1+2)", () => {
    for (const v of [null, undefined, ""] as const) {
      const p = classifyNarrativeProvenance(v, NOW_MS);
      assert.equal(p.freshness, "unknown");
      assert.notEqual(p.freshness, "fresh");  // rule 1
      assert.equal(p.source, null);
      assert.equal(p.observed_at, null);      // rule 2 — no substitution
    }
  });

  it("recent as_of → fresh / nightly_narrative / observed_at is the as_of not now()", () => {
    const twelveHoursAgo = new Date(NOW_MS - 12 * 60 * 60 * 1000).toISOString();
    const p = classifyNarrativeProvenance(twelveHoursAgo, NOW_MS);
    assert.equal(p.freshness, "fresh");
    assert.equal(p.source, "nightly_narrative");
    assert.equal(p.observed_at, twelveHoursAgo);
    assert.notEqual(p.observed_at, new Date(NOW_MS).toISOString()); // rule 2
  });

  it("three-week-old as_of → stale / observed_at preserved", () => {
    const old = new Date(NOW_MS - 21 * 24 * 60 * 60 * 1000).toISOString();
    const p = classifyNarrativeProvenance(old, NOW_MS);
    assert.equal(p.freshness, "stale");
    assert.equal(p.source, "nightly_narrative");
    assert.equal(p.observed_at, old);
  });

  it("unparseable as_of → unknown, observed_at null (rule 2 — no fabrication)", () => {
    const p = classifyNarrativeProvenance("not-a-date", NOW_MS);
    assert.equal(p.freshness, "unknown");
    assert.equal(p.observed_at, null);
  });
});

// ---------------------------------------------------------------------------
// Integration — matters endpoints carry narrative_provenance
// ---------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "matter-fresh-"));
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";

const V = process.env.VAULT_PATH!;
for (const d of ["matter", "task"]) fs.mkdirSync(path.join(V, d), { recursive: true });

const { matchRoute } = await import("../src/api/server.js");
const { registerMatterRoutes } = await import("../src/api/routes/matters.js");
registerMatterRoutes();

const wv = (rel: string, lines: string[]) =>
  fs.writeFileSync(path.join(V, rel), lines.join("\n") + "\n", "utf-8");

async function call(method: string, url: string): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, url);
  assert.ok(m, `${method} ${url} must be registered`);
  let status = 0; let payload: any;
  const res = {
    writeHead(c: number) { status = c; return res; },
    end(j?: string) { payload = j ? JSON.parse(j) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({ req: { url } as any, res, params: m!.params,
    body: undefined, query: new URLSearchParams() });
  return { status, payload };
}

describe("matters narrative_provenance — integration (#543)", () => {
  before(() => {
    wv("matter/active-m.md", ["---", "type: matter", "name: Active matter",
      "summary: Test", "current_state: Going well.", "as_of: '2099-12-31T00:00:00Z'", "---"]);
    wv("matter/no-narrative.md", ["---", "type: matter", "name: No narrative",
      "summary: Test", "---"]);
    wv("task/fresh-t.md", ["---", "type: task", "name: Fresh task",
      "matter: '[[matter/active-m]]'", "state: pending", "status: todo",
      "as_of: '2099-12-31T00:00:00Z'", "---"]);
    wv("task/bare-t.md", ["---", "type: task", "name: Bare task",
      "matter: '[[matter/active-m]]'", "state: pending", "status: todo", "---"]);
  });

  it("list carries narrative_provenance with valid freshness on every matter", async () => {
    const { status, payload } = await call("GET", "/api/v1/matters");
    assert.equal(status, 200);
    for (const m of payload.matters) {
      assert.ok("narrative_provenance" in m, `${m.id} must carry narrative_provenance`);
      assert.ok(["fresh", "stale", "unknown"].includes(m.narrative_provenance.freshness));
    }
  });

  it("far-future as_of → fresh, observed_at is the as_of (not now — rule 2)", async () => {
    const { payload } = await call("GET", "/api/v1/matters");
    const row = payload.matters.find((m: any) => m.id === "active-m");
    assert.ok(row);
    assert.equal(row.narrative_provenance.freshness, "fresh");
    assert.equal(row.narrative_provenance.observed_at, "2099-12-31T00:00:00Z");
  });

  it("no as_of → unknown, never fresh, observed_at null (rules 1+2)", async () => {
    const { payload } = await call("GET", "/api/v1/matters");
    const row = payload.matters.find((m: any) => m.id === "no-narrative");
    assert.ok(row);
    assert.equal(row.narrative_provenance.freshness, "unknown");
    assert.notEqual(row.narrative_provenance.freshness, "fresh");  // rule 1
    assert.equal(row.narrative_provenance.observed_at, null);      // rule 2
  });

  it("detail tasks carry narrative_provenance; bare task → unknown (rule 1+2)", async () => {
    const { payload } = await call("GET", "/api/v1/matters/active-m");
    const fresh = payload.matter.tasks.find((t: any) => t.id === "fresh-t");
    const bare = payload.matter.tasks.find((t: any) => t.id === "bare-t");
    assert.ok(fresh && bare);
    assert.equal(fresh.narrative_provenance.freshness, "fresh");
    assert.equal(fresh.narrative_provenance.observed_at, "2099-12-31T00:00:00Z");
    assert.equal(bare.narrative_provenance.freshness, "unknown");
    assert.equal(bare.narrative_provenance.observed_at, null);
  });

  it("pre-existing response fields unchanged — narrative_provenance is additive", async () => {
    const { payload } = await call("GET", "/api/v1/matters");
    const row = payload.matters.find((m: any) => m.id === "active-m");
    assert.ok(row);
    assert.equal(typeof row.id, "string");
    assert.equal(typeof row.counts, "object");
    assert.equal(row.current_state, "Going well.");
    assert.ok("narrative_provenance" in row);
  });
});
