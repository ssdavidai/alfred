// nar-entries.test.ts — NAR entry persistence + statement endpoints (#584).
// Covers: (1) upsert idempotency; (2) CHECK violation → 4xx not 500;
//         (3) empty day → 200 zeros not 404; (4) unrated populated;
//         (5) rates echoes the arithmetic table used.

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nar-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH   = path.join(tmp, "state.db");
process.env.VAULT_PATH      = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
["needs_attention", "decision", "event"].forEach((d) =>
  fs.mkdirSync(path.join(tmp, "vault", d), { recursive: true }),
);

const { getStateDb } = await import("../src/db/state.js");
const { registerStateRoutes } = await import("../src/api/routes/state.js");
const { registerAttentionRoutes } = await import("../src/api/routes/attention.js");
const { matchRoute } = await import("../src/api/server.js");

registerStateRoutes();
registerAttentionRoutes();
const db = getStateDb();

let _seq = 0;
function entry(ov: Record<string, unknown> = {}): Record<string, unknown> {
  _seq++;
  return {
    id: `01NARTEST${String(_seq).padStart(6,"0")}XXXXXXXXX`,
    dedup_key: `dk-${_seq}`,
    occurred_at: "2026-08-14T09:00:00Z",
    action_class: "suppression",
    summary: "CI noise suppressed",
    evidence_kind: "audit", evidence_ref: "aud_abc",
    estimation_method: "standard-time",
    displaced_minutes: 0.5,
    acceptance: "accepted", acceptance_path: "explicit",
    ...ov,
  };
}

async function postEntries(body: unknown): Promise<{ status: number; p: any }> {
  const m = matchRoute("POST", "/api/v1/state/nar-entries");
  assert.ok(m, "route must be registered");
  let status = 0; let p: any = {};
  const res = { writeHead(s: number) { status = s; return res; }, end(j?: string) { if (j) p = JSON.parse(j); } } as unknown as ServerResponse;
  try { await m.handler({ req: {} as any, res, params: {}, body, query: new URLSearchParams() }); }
  catch (e: any) { if (typeof e?.statusCode === "number") { status = e.statusCode; p = { error: e.message }; } else throw e; }
  return { status, p };
}

async function getStatement(qs: string): Promise<{ status: number; p: any }> {
  const m = matchRoute("GET", "/api/v1/attention/statement");
  assert.ok(m, "route must be registered");
  let status = 0; let p: any = {};
  const res = { writeHead(s: number) { status = s; return res; }, end(j?: string) { if (j) p = JSON.parse(j); } } as unknown as ServerResponse;
  try { await m.handler({ req: {} as any, res, params: {}, body: null, query: new URLSearchParams(qs) }); }
  catch (e: any) { if (typeof e?.statusCode === "number") { status = e.statusCode; p = { error: e.message }; } else throw e; }
  return { status, p };
}

describe("POST /api/v1/state/nar-entries", () => {
  before(() => db);
  beforeEach(() => db.prepare("DELETE FROM nar_entry").run());

  it("upsert idempotency: same dedup_key updates, never duplicates", async () => {
    await postEntries({ entries: [entry({ dedup_key: "stable", displaced_minutes: 5 })] });
    const { status, p } = await postEntries({ entries: [entry({ dedup_key: "stable", displaced_minutes: 10 })] });
    assert.strictEqual(status, 201);
    assert.strictEqual(p.upserted, 0);
    assert.strictEqual(p.updated, 1);
    assert.strictEqual((db.prepare("SELECT COUNT(*) AS n FROM nar_entry").get() as any).n, 1);
    const row = db.prepare("SELECT displaced_minutes FROM nar_entry WHERE dedup_key='stable'").get() as any;
    assert.strictEqual(row.displaced_minutes, 10, "update must apply new value");
  });

  it("CHECK: displaced_minutes without estimation_method → 400 not 500", async () => {
    const { status, p } = await postEntries({ entries: [entry({ displaced_minutes: 30, estimation_method: null })] });
    assert.strictEqual(status, 400, "must be 400 (client error) not 500");
    assert.ok(p.error?.includes("estimation_method") || p.error?.includes("displaced_minutes"),
      "error message must name the violated constraint");
    assert.strictEqual((db.prepare("SELECT COUNT(*) AS n FROM nar_entry").get() as any).n, 0,
      "no row inserted on violation");
  });

  it("CHECK: invalid acceptance value → 400", async () => {
    const { status } = await postEntries({ entries: [entry({ acceptance: "maybe" })] });
    assert.strictEqual(status, 400);
  });

  it("null displaced_minutes with no method is allowed (no claim)", async () => {
    const { status } = await postEntries({ entries: [entry({ displaced_minutes: null, estimation_method: null, acceptance: "unknown", acceptance_path: null })] });
    assert.strictEqual(status, 201, "null claim with no method is a valid not-established entry");
  });
});

describe("GET /api/v1/attention/statement", () => {
  before(() => db);
  beforeEach(() => db.prepare("DELETE FROM nar_entry").run());

  it("empty day → 200 with zeros, not 404", async () => {
    const { status, p } = await getStatement("date=2026-08-01");
    assert.strictEqual(status, 200, "must be 200 not 404");
    assert.strictEqual(p.date, "2026-08-01");
    assert.strictEqual(p.nar_hours, 0);
    assert.strictEqual(p.displaced.total_hours, 0);
    assert.deepStrictEqual(p.displaced.explicit.items, []);
    assert.deepStrictEqual(p.displaced.inferred.items, []);
    assert.deepStrictEqual(p.displaced.autonomous.items, []);
    assert.deepStrictEqual(p.unrated, []);
  });

  it("rates field echoes the constants used in arithmetic", async () => {
    const { p } = await getStatement("date=2026-08-01");
    assert.ok(p.rates, "rates must be present");
    assert.strictEqual(p.rates.suppression_minutes_per_item, 0.5);
    assert.strictEqual(p.rates.interruption_minutes, 2);
    assert.deepStrictEqual(p.rates.bucket_minutes, { S: 5, M: 20, L: 60, XL: 120 });
  });

  it("unrated populated for action_class with no agreed rate", async () => {
    await postEntries({ entries: [entry({ action_class: "desk_decision_done", displaced_minutes: null, estimation_method: null, acceptance: "unknown", acceptance_path: null })] });
    const { p } = await getStatement("date=2026-08-14");
    const classes = p.unrated.map((u: any) => u.action_class);
    assert.ok(classes.includes("desk_decision_done"),
      `desk_decision_done must appear in unrated; got: ${JSON.stringify(p.unrated)}`);
  });

  it("suppression entries accumulate into explicit items with correct arithmetic", async () => {
    // 2 entries × 0.5 min/item = 1 min explicit
    await postEntries({ entries: [
      entry({ dedup_key: "s1", occurred_at: "2026-08-14T08:00:00Z" }),
      entry({ dedup_key: "s2", occurred_at: "2026-08-14T08:01:00Z" }),
    ]});
    const { p } = await getStatement("date=2026-08-14");
    const sup = p.displaced.explicit.items.find((i: any) => i.count === 2);
    assert.ok(sup, "explicit items must have an entry with count=2");
    assert.strictEqual(sup.rate_minutes, 0.5, "rate must match the rate card");
    assert.strictEqual(sup.minutes, 1, "2 × 0.5 = 1 min");
    // rates matches the arithmetic — the rate echoed in the response is what was multiplied
    assert.strictEqual(p.rates.suppression_minutes_per_item, sup.rate_minutes);
  });

  it("empty day → stats block present with all-zero values, never undefined", async () => {
    const { status, p } = await getStatement("date=2026-08-02");
    assert.strictEqual(status, 200);
    assert.ok(p.stats !== undefined, "stats must be present even for an empty day");
    assert.strictEqual(p.stats.sessions, 0);
    assert.strictEqual(p.stats.turns, 0);
    assert.strictEqual(p.stats.self_corrections, 0);
    assert.strictEqual(p.stats.blocked, 0);
    assert.strictEqual(p.stats.hard_failures, 0);
    assert.strictEqual(p.stats.return_ratio, 0);
    assert.strictEqual(p.stats.autonomous_artifacts, 0);
  });

  it("day with entries → stats block has every required key with non-negative integers", async () => {
    await postEntries({ entries: [
      entry({ dedup_key: "e1", session_ref: "sess-a", occurred_at: "2026-08-14T08:00:00Z" }),
      entry({ dedup_key: "e2", session_ref: "sess-a", occurred_at: "2026-08-14T08:01:00Z" }),
      entry({ dedup_key: "e3", session_ref: "sess-b", occurred_at: "2026-08-14T09:00:00Z",
               acceptance: "rejected" }),
    ]});
    const { status, p } = await getStatement("date=2026-08-14");
    assert.strictEqual(status, 200);
    const s = p.stats;
    assert.ok(s !== undefined, "stats must be present");
    // Every key present
    for (const k of ["sessions","turns","self_corrections","blocked","hard_failures",
                      "return_ratio","autonomous_artifacts"]) {
      assert.ok(k in s, `stats.${k} must be present`);
    }
    // Derivable values
    assert.strictEqual(s.sessions, 2, "two distinct session_refs");
    assert.strictEqual(s.blocked, 1, "one rejected entry");
    assert.ok(Number.isFinite(s.return_ratio), "return_ratio must be finite");
    assert.ok(s.return_ratio >= 0, "return_ratio must be non-negative");
  });

  it("return_ratio is 0 (not NaN/Infinity) when engaged and interruption are both zero", async () => {
    // Insert a single entry on a date with no Hermes sessions and no audit decisions.
    await postEntries({ entries: [
      entry({ dedup_key: "rr-zero", occurred_at: "2026-08-03T10:00:00Z",
               displaced_minutes: 5, estimation_method: "standard-time" }),
    ]});
    const { p } = await getStatement("date=2026-08-03");
    assert.strictEqual(p.stats.return_ratio, 0, "return_ratio must be 0 when denominator is zero");
    assert.ok(Number.isFinite(p.stats.return_ratio), "return_ratio must be finite");
  });

  it("range query returns one object per day with totals", async () => {
    const m = matchRoute("GET", "/api/v1/attention/statement");
    assert.ok(m);
    let status = 0; let p: any = {};
    const res = { writeHead(s: number) { status = s; return res; }, end(j?: string) { if (j) p = JSON.parse(j); } } as unknown as ServerResponse;
    const qs = "from=2026-08-01&to=2026-08-03";
    await m.handler({ req: {} as any, res, params: {}, body: null, query: new URLSearchParams(qs) });
    assert.strictEqual(status, 200);
    assert.strictEqual(p.days.length, 3, "3 days inclusive");
    assert.ok(p.totals, "totals must be present");
  });
});

// mode='replace' — atomic day-replace (#584)
describe("POST /api/v1/state/nar-entries — mode='replace'", () => {
  before(() => db);
  beforeEach(() => db.prepare("DELETE FROM nar_entry").run());

  it("replace removes rows for that date absent from the payload", async () => {
    await postEntries({ entries: [
      entry({ dedup_key: "keep",  occurred_at: "2026-07-15T09:00:00Z" }),
      entry({ dedup_key: "stale", occurred_at: "2026-07-15T10:00:00Z" }),
    ]});
    const { status, p } = await postEntries({
      mode: "replace",
      date: "2026-07-15",
      entries: [entry({ dedup_key: "keep", occurred_at: "2026-07-15T09:00:00Z" })],
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(p.deleted, 1, "stale row must be deleted");
    assert.strictEqual(p.updated, 1, "'keep' row already exists → updated");
    assert.strictEqual(p.upserted, 0);
    const rows = db.prepare("SELECT dedup_key FROM nar_entry WHERE date(occurred_at)='2026-07-15'").all() as any[];
    assert.deepStrictEqual(rows.map((r: any) => r.dedup_key), ["keep"]);
  });

  it("replace leaves rows for OTHER dates untouched", async () => {
    await postEntries({ entries: [
      entry({ dedup_key: "day-a-1", occurred_at: "2026-07-14T09:00:00Z" }),
      entry({ dedup_key: "day-b-1", occurred_at: "2026-07-15T09:00:00Z" }),
      entry({ dedup_key: "day-b-2", occurred_at: "2026-07-15T10:00:00Z" }),
    ]});
    const { status, p } = await postEntries({
      mode: "replace",
      date: "2026-07-15",
      entries: [entry({ dedup_key: "day-b-new", occurred_at: "2026-07-15T11:00:00Z" })],
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(p.deleted, 2, "both 2026-07-15 rows absent from payload deleted");
    const day14 = db.prepare("SELECT COUNT(*) AS n FROM nar_entry WHERE date(occurred_at)='2026-07-14'").get() as any;
    assert.strictEqual(day14.n, 1, "row on other date must survive");
    const day15 = db.prepare("SELECT dedup_key FROM nar_entry WHERE date(occurred_at)='2026-07-15'").all() as any[];
    assert.deepStrictEqual(day15.map((r: any) => r.dedup_key), ["day-b-new"]);
  });

  it("replace with empty entries clears exactly that day, nothing else", async () => {
    await postEntries({ entries: [
      entry({ dedup_key: "target",   occurred_at: "2026-07-15T09:00:00Z" }),
      entry({ dedup_key: "survivor", occurred_at: "2026-07-14T09:00:00Z" }),
    ]});
    const { status, p } = await postEntries({ mode: "replace", date: "2026-07-15", entries: [] });
    assert.strictEqual(status, 201);
    assert.strictEqual(p.deleted, 1, "target row must be deleted");
    assert.deepStrictEqual({ upserted: p.upserted, updated: p.updated }, { upserted: 0, updated: 0 });
    const total = db.prepare("SELECT COUNT(*) AS n FROM nar_entry").get() as any;
    assert.strictEqual(total.n, 1, "only the survivor on other date remains");
    const rem = db.prepare("SELECT dedup_key FROM nar_entry").all() as any[];
    assert.strictEqual(rem[0].dedup_key, "survivor");
  });

  it("replace without date returns 400", async () => {
    const { status, p } = await postEntries({
      mode: "replace",
      entries: [entry({ occurred_at: "2026-07-15T09:00:00Z" })],
    });
    assert.strictEqual(status, 400);
    assert.ok(String(p.error).toLowerCase().includes("date"), "error must mention 'date'");
  });

  it("upsert mode (default) does not delete any rows", async () => {
    await postEntries({ entries: [entry({ dedup_key: "existing", occurred_at: "2026-07-15T09:00:00Z" })] });
    const { status, p } = await postEntries({
      entries: [entry({ dedup_key: "new-entry", occurred_at: "2026-07-15T10:00:00Z" })],
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(p.deleted, 0, "upsert must never delete rows");
    assert.strictEqual((db.prepare("SELECT COUNT(*) AS n FROM nar_entry").get() as any).n, 2);
  });

  it("response counts match what actually changed", async () => {
    await postEntries({ entries: [
      entry({ dedup_key: "r1", occurred_at: "2026-07-15T08:00:00Z" }),
      entry({ dedup_key: "r2", occurred_at: "2026-07-15T09:00:00Z" }),
      entry({ dedup_key: "r3", occurred_at: "2026-07-15T10:00:00Z" }),
      entry({ dedup_key: "other", occurred_at: "2026-07-14T09:00:00Z" }),
    ]});
    // Replace 2026-07-15: r1 (update), r4 (insert); r2+r3 should be deleted.
    const { p } = await postEntries({
      mode: "replace",
      date: "2026-07-15",
      entries: [
        entry({ dedup_key: "r1", occurred_at: "2026-07-15T08:00:00Z" }),
        entry({ dedup_key: "r4", occurred_at: "2026-07-15T11:00:00Z" }),
      ],
    });
    assert.strictEqual(p.deleted, 2, "r2 and r3 deleted");
    assert.strictEqual(p.updated, 1, "r1 updated (pre-existing)");
    assert.strictEqual(p.upserted, 1, "r4 inserted (new)");
    const rows = db.prepare(
      "SELECT dedup_key FROM nar_entry WHERE date(occurred_at)='2026-07-15' ORDER BY dedup_key",
    ).all() as any[];
    assert.deepStrictEqual(rows.map((r: any) => r.dedup_key), ["r1", "r4"]);
  });
});
