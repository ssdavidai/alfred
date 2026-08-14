// attention-engaged-allocation.test.ts — engaged_minutes / nar_minutes on items
// and the allocation block on the day statement (#584 / #621 contract).
//
// Covers:
//   1. Inferred entry with engaged_minutes → nar_minutes = displaced − engaged
//   2. Inferred entry with null engaged → nar_minutes is null (not displaced, not zero)
//   3. Chore_run (autonomous) always carries null engaged_minutes and null nar_minutes
//   4. Allocation splits three ways; each nar_hours = displaced − engaged − interruption
//   5. All interruption hours land in unallocated; work and life carry zero
//   6. Entry with no allocation key in notes counts as unallocated
//   7. Reconciliation difference is present and not zero-forced when measures disagree

import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nar-alloc-"));
process.env.ALFRED_DATA_DIR   = tmp;
process.env.STATE_DB_PATH     = path.join(tmp, "state.db");
process.env.VAULT_PATH        = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH   = "";
process.env.HERMES_CONFIG_DIR = path.join(tmp, "hermes-state");
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
function mkEntry(ov: Record<string, unknown> = {}): Record<string, unknown> {
  _seq++;
  return {
    id: `01ALLOC${String(_seq).padStart(8, "0")}XXXXXXXX`, dedup_key: `alloc-dk-${_seq}`,
    occurred_at: "2026-09-01T09:00:00Z", action_class: "conversational", summary: "test session",
    evidence_kind: "session", evidence_ref: `sess-${_seq}`, estimation_method: "standard-time",
    displaced_minutes: 30, acceptance: "accepted", acceptance_path: "inferred",
    ...ov,
  };
}

function buildRes(): { res: ServerResponse; result(): { status: number; p: any } } {
  let status = 0; let p: any = {};
  const res = { writeHead(s: number) { status = s; return res; }, end(j?: string) { if (j) p = JSON.parse(j); } } as unknown as ServerResponse;
  return { res, result: () => ({ status, p }) };
}

async function postEntries(body: unknown): Promise<{ status: number; p: any }> {
  const m = matchRoute("POST", "/api/v1/state/nar-entries");
  assert.ok(m, "route registered");
  const { res, result } = buildRes();
  try { await m.handler({ req: {} as any, res, params: {}, body, query: new URLSearchParams() }); }
  catch (e: any) { if (typeof e?.statusCode === "number") { result().status; } else throw e; }
  return result();
}

async function getStatement(date: string): Promise<any> {
  const m = matchRoute("GET", "/api/v1/attention/statement");
  assert.ok(m, "route registered");
  const { res, result } = buildRes();
  await m.handler({ req: {} as any, res, params: {}, body: null, query: new URLSearchParams(`date=${date}`) });
  return result().p;
}

function insertJournal(ts: string, solicited: number): void {
  _seq++;
  db.prepare(`INSERT INTO alfred_journal (id,ts,channel,chat_id,direction,message,solicited) VALUES (?,?,'slack','C-ALLOC','outbound','test',?)`)
    .run(`01JRNL${String(_seq).padStart(9, "0")}`, ts, solicited);
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

describe("attention statement — engaged_minutes / nar_minutes on items", () => {
  before(() => db);
  beforeEach(() => { db.prepare("DELETE FROM nar_entry").run(); db.prepare("DELETE FROM alfred_journal WHERE chat_id='C-ALLOC'").run(); });

  it("inferred entry with engaged_minutes yields nar_minutes = displaced − engaged", async () => {
    await postEntries({ entries: [mkEntry({ occurred_at: "2026-09-01T09:00:00Z", displaced_minutes: 30,
      notes: JSON.stringify({ engaged_minutes: 10, allocation: "work" }) })] });
    const item = (await getStatement("2026-09-01")).displaced.inferred.items[0] as any;
    assert.ok(item, "inferred item must be present");
    assert.strictEqual(item.engaged_minutes, 10, "engaged_minutes must be 10");
    assert.strictEqual(item.nar_minutes, 20, "nar_minutes = displaced(30) − engaged(10)");
  });

  it("inferred entry with null engaged_minutes → nar_minutes is null, not zero, not displaced", async () => {
    await postEntries({ entries: [mkEntry({ occurred_at: "2026-09-02T09:00:00Z", displaced_minutes: 30,
      notes: JSON.stringify({ allocation: "work" }) })] });
    const item = (await getStatement("2026-09-02")).displaced.inferred.items[0] as any;
    assert.ok(item, "inferred item must be present");
    assert.strictEqual(item.engaged_minutes, null, "engaged_minutes must be null when absent from notes");
    assert.strictEqual(item.nar_minutes, null, "nar_minutes must be null — unknown engagement is not zero");
  });

  it("autonomous (chore_run) always carries null engaged_minutes and null nar_minutes", async () => {
    await postEntries({ entries: [mkEntry({ occurred_at: "2026-09-03T09:00:00Z", action_class: "chore_run",
      evidence_kind: "chore_run", acceptance_path: "explicit", displaced_minutes: 20,
      notes: JSON.stringify({ allocation: "work" }) })] });
    const item = (await getStatement("2026-09-03")).displaced.autonomous.items[0] as any;
    assert.ok(item, "autonomous item must be present");
    assert.strictEqual(item.engaged_minutes, null, "chore_run never has engagement");
    assert.strictEqual(item.nar_minutes, null, "chore_run nar_minutes is null");
  });
});

describe("attention statement — allocation block", () => {
  before(() => db);
  beforeEach(() => { db.prepare("DELETE FROM nar_entry").run(); db.prepare("DELETE FROM alfred_journal WHERE chat_id='C-ALLOC'").run(); });

  it("allocation splits three ways; each nar_hours = displaced − engaged − interruption", async () => {
    await postEntries({ entries: [
      mkEntry({ dedup_key: "work-a", occurred_at: "2026-09-04T08:00:00Z",
        displaced_minutes: 60, notes: JSON.stringify({ engaged_minutes: 20, allocation: "work" }) }),
      mkEntry({ dedup_key: "life-a", occurred_at: "2026-09-04T09:00:00Z",
        displaced_minutes: 30, notes: JSON.stringify({ engaged_minutes: 10, allocation: "life" }) }),
      mkEntry({ dedup_key: "unalloc-a", occurred_at: "2026-09-04T10:00:00Z",
        displaced_minutes: 10, notes: JSON.stringify({}) }),
    ] });
    insertJournal("2026-09-04T11:00:00Z", 0); // 1 × 2 min = 2 min interruption
    const { work, life, unallocated } = (await getStatement("2026-09-04")).allocation;
    assert.strictEqual(work.displaced_hours,    r3(60/60), "work displaced");
    assert.strictEqual(work.engaged_hours,      r3(20/60), "work engaged");
    assert.strictEqual(work.interruption_hours, 0,         "work interruption must be 0");
    assert.strictEqual(work.nar_hours,          r3((60-20)/60), "work nar");
    assert.strictEqual(life.displaced_hours,    r3(30/60), "life displaced");
    assert.strictEqual(life.engaged_hours,      r3(10/60), "life engaged");
    assert.strictEqual(life.interruption_hours, 0, "life interruption must be 0");
    assert.strictEqual(life.nar_hours,          r3((30-10)/60), "life nar");
    assert.strictEqual(unallocated.displaced_hours,    r3(10/60), "unallocated displaced");
    assert.strictEqual(unallocated.engaged_hours,      0,         "unallocated engaged");
    assert.strictEqual(unallocated.interruption_hours, r3(2/60),  "unallocated interruption = 2 min");
    assert.strictEqual(unallocated.nar_hours,  r3((10-0)/60 - 2/60), "unallocated nar");
  });

  it("all interruption hours land in unallocated; work and life carry zero", async () => {
    await postEntries({ entries: [
      mkEntry({ dedup_key: "int-work", occurred_at: "2026-09-05T08:00:00Z",
        notes: JSON.stringify({ engaged_minutes: 5, allocation: "work" }) }),
      mkEntry({ dedup_key: "int-life", occurred_at: "2026-09-05T09:00:00Z",
        notes: JSON.stringify({ engaged_minutes: 5, allocation: "life" }) }),
    ] });
    insertJournal("2026-09-05T10:00:00Z", 0);
    insertJournal("2026-09-05T10:01:00Z", 0);
    insertJournal("2026-09-05T10:02:00Z", 0);
    const { work, life, unallocated } = (await getStatement("2026-09-05")).allocation;
    assert.strictEqual(work.interruption_hours, 0, "work must carry zero interruption");
    assert.strictEqual(life.interruption_hours, 0, "life must carry zero interruption");
    assert.ok(unallocated.interruption_hours > 0, "unallocated must carry all interruption");
    assert.strictEqual(unallocated.interruption_hours, r3(6/60), "3 × 2 min = 6 min");
  });

  it("entry with no allocation key in notes counts as unallocated", async () => {
    await postEntries({ entries: [
      mkEntry({ dedup_key: "no-alloc", occurred_at: "2026-09-06T09:00:00Z",
        displaced_minutes: 45, notes: JSON.stringify({ engaged_minutes: 15 }) }),
    ] });
    const { work, life, unallocated } = (await getStatement("2026-09-06")).allocation;
    assert.strictEqual(work.displaced_hours, 0, "work must get nothing");
    assert.strictEqual(life.displaced_hours, 0, "life must get nothing");
    assert.ok(unallocated.displaced_hours > 0, "unallocated must absorb the entry");
    assert.strictEqual(unallocated.displaced_hours, r3(45/60));
    assert.strictEqual(unallocated.engaged_hours,   r3(15/60));
  });

  it("reconciliation difference is present and not zero-forced when measures disagree", async () => {
    // No Hermes sessions → day_engaged_hours = 0.
    // Notes carry engaged_minutes = 15 → attributed_engaged_hours > 0.
    // difference_hours must be non-zero (and negative: day − attributed < 0).
    await postEntries({ entries: [
      mkEntry({ dedup_key: "recon-a", occurred_at: "2026-09-07T09:00:00Z",
        displaced_minutes: 60, notes: JSON.stringify({ engaged_minutes: 15, allocation: "work" }) }),
    ] });
    const p = await getStatement("2026-09-07");
    assert.ok("allocation_reconciliation" in p, "allocation_reconciliation must be present");
    const rec = p.allocation_reconciliation;
    assert.ok("attributed_engaged_hours" in rec && "day_engaged_hours" in rec && "difference_hours" in rec);
    assert.strictEqual(rec.day_engaged_hours, 0, "no Hermes sessions → day engaged = 0");
    assert.ok(rec.attributed_engaged_hours > 0, "per-session notes yield attributed > 0");
    assert.ok(rec.difference_hours !== 0,        "difference must not be zero-forced");
    assert.ok(rec.difference_hours < 0,          "difference = day − attributed < 0 here");
  });
});
