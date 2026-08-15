// nar-entries.test.ts — NAR entry persistence + statement endpoints (#584).
// Covers: (1) upsert idempotency; (2) CHECK violation → 4xx not 500;
//         (3) empty day → 200 zeros not 404; (4) unrated populated;
//         (5) rates echoes the arithmetic table used.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nar-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH   = path.join(tmp, "state.db");
process.env.VAULT_PATH      = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
// Point HERMES_CONFIG_DIR at the tmp tree so the parentage-filter tests can
// create a real main/state.db that the route handler finds. Must be set BEFORE
// registerAttentionRoutes() captures it.
process.env.HERMES_CONFIG_DIR = path.join(tmp, "hermes-state");
["needs_attention", "decision", "event"].forEach((d) =>
  fs.mkdirSync(path.join(tmp, "vault", d), { recursive: true }),
);

const { getStateDb } = await import("../src/db/state.js");
const { registerStateRoutes } = await import("../src/api/routes/state.js");
const { registerAttentionRoutes, HUMAN_SESSION_SOURCES } = await import("../src/api/routes/attention.js");
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

  // ── #584 explicit-group fix ─────────────────────────────────────────────
  // Non-suppression rows with displaced_minutes must credit explicit, not unrated.

  it("rated desk_decision rows credit explicit; unrated ones appear in unrated — never dropped", async () => {
    // 3 noise decisions × 0.5 min = 1.5 min; 2 done decisions with no rate.
    await postEntries({ entries: [
      entry({ dedup_key: "dd-r1", action_class: "desk_decision", evidence_kind: "decision",
              displaced_minutes: 0.5, estimation_method: "standard-time",
              acceptance: "accepted", acceptance_path: "explicit" }),
      entry({ dedup_key: "dd-r2", action_class: "desk_decision", evidence_kind: "decision",
              displaced_minutes: 0.5, estimation_method: "standard-time",
              acceptance: "accepted", acceptance_path: "explicit" }),
      entry({ dedup_key: "dd-r3", action_class: "desk_decision", evidence_kind: "decision",
              displaced_minutes: 0.5, estimation_method: "standard-time",
              acceptance: "accepted", acceptance_path: "explicit" }),
      entry({ dedup_key: "dd-u1", action_class: "desk_decision", evidence_kind: "decision",
              displaced_minutes: null, estimation_method: null,
              acceptance: "accepted", acceptance_path: "explicit" }),
      entry({ dedup_key: "dd-u2", action_class: "desk_decision", evidence_kind: "decision",
              displaced_minutes: null, estimation_method: null,
              acceptance: "accepted", acceptance_path: "explicit" }),
    ]});
    const { p } = await getStatement("date=2026-08-14");
    // Rated entries land in explicit.
    const ddItem = p.displaced.explicit.items.find((i: any) => i.label === "desk_decision");
    assert.ok(ddItem, `desk_decision must appear in explicit.items; got ${JSON.stringify(p.displaced.explicit.items)}`);
    assert.strictEqual(ddItem.count, 3, "3 rated desk_decision rows");
    assert.strictEqual(ddItem.minutes, 1.5, "3 × 0.5 = 1.5 min");
    // Unrated entries land in unrated, not silently dropped.
    const unratedEntry = p.unrated.find((u: any) => u.action_class === "desk_decision");
    assert.ok(unratedEntry, `desk_decision must appear in unrated; got ${JSON.stringify(p.unrated)}`);
    assert.strictEqual(unratedEntry.count, 2, "2 unrated desk_decision rows");
  });

  it("explicit + inferred + autonomous hours sum exactly to displaced.total_hours", async () => {
    // A mix of all three classification paths ensures no group is silently dropped.
    // estimation_method must be one of the CHECK-list values.
    await postEntries({ entries: [
      entry({ dedup_key: "sup-sum", action_class: "suppression", evidence_kind: "audit",
              displaced_minutes: 0.5, estimation_method: "standard-time",
              acceptance: "accepted", acceptance_path: "explicit" }),
      entry({ dedup_key: "inf-sum", action_class: "conversational", evidence_kind: "session",
              displaced_minutes: 30, estimation_method: "standard-time",
              acceptance: "accepted", acceptance_path: "inferred" }),
      entry({ dedup_key: "aut-sum", action_class: "chore_run", evidence_kind: "chore_run",
              displaced_minutes: 20, estimation_method: "standard-time",
              acceptance: "accepted", acceptance_path: "explicit" }),
    ]});
    const { p } = await getStatement("date=2026-08-14");
    const sum = p.displaced.explicit.hours + p.displaced.inferred.hours + p.displaced.autonomous.hours;
    // Each group is independently rounded to 3 dp before summing; total_hours rounds the
    // unrounded sum. A 1-unit-last-place (≤0.002 h) discrepancy is normal floating-point
    // behaviour. The test is that no group is silently dropped — if it were, sum would be
    // far smaller than total_hours.
    assert.ok(Math.abs(sum - p.displaced.total_hours) <= 0.002,
      `explicit+inferred+autonomous must approximate total_hours within 0.002 (got ${sum} vs ${p.displaced.total_hours})`);
    assert.ok(p.displaced.total_hours > 0, "total must be positive with these entries");
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

// ─── parent_session_id filter (#584) ───────────────────────────────────────
// The human-turn query in buildDayStatement must exclude agent-spawned
// sessions (parent_session_id IS NOT NULL) so engaged time matches the recap.
// HERMES_CONFIG_DIR was pointed at tmp/hermes-state at module level (above)
// so registerAttentionRoutes() captured it; we just manage the file here.
describe("GET /api/v1/attention/statement — parent_session_id filter", () => {
  const hsDir = path.join(tmp, "hermes-state");
  const hsDbPath = path.join(hsDir, "main", "state.db");

  before(() => {
    fs.mkdirSync(path.join(hsDir, "main"), { recursive: true });
    const hdb = new DatabaseSync(hsDbPath);
    hdb.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, parent_session_id TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, timestamp REAL NOT NULL);
    `);
    hdb.close();
  });

  after(() => { fs.rmSync(hsDir, { recursive: true, force: true }); });

  beforeEach(() => {
    db.prepare("DELETE FROM nar_entry").run();
    const hdb = new DatabaseSync(hsDbPath);
    hdb.exec("DELETE FROM messages; DELETE FROM sessions;");
    hdb.close();
  });

  it("spawned session (parent IS NOT NULL) contributes no turns to engaged time", async () => {
    const hdb = new DatabaseSync(hsDbPath);
    hdb.prepare("INSERT INTO sessions VALUES (?,?,?)").run("s-agent", "slack", "parent-1");
    hdb.prepare("INSERT INTO messages VALUES (?,?,'user',?)").run(
      "m-1", "s-agent", new Date("2026-07-15T10:00:00Z").getTime() / 1000,
    );
    hdb.close();
    const { p } = await getStatement("date=2026-07-15");
    assert.strictEqual(p.engaged.hours, 0, "agent-spawned session must be excluded");
  });

  it("human session (parent IS NULL) contributes turns to engaged time", async () => {
    const hdb = new DatabaseSync(hsDbPath);
    hdb.prepare("INSERT INTO sessions VALUES (?,?,?)").run("s-human", "slack", null);
    hdb.prepare("INSERT INTO messages VALUES (?,?,'user',?)").run(
      "m-2", "s-human", new Date("2026-07-15T10:00:00Z").getTime() / 1000,
    );
    hdb.close();
    const { p } = await getStatement("date=2026-07-15");
    assert.ok(p.engaged.hours > 0, "human session with null parent must contribute");
  });

  it("unknown-source session excluded even with null parent", async () => {
    const hdb = new DatabaseSync(hsDbPath);
    hdb.prepare("INSERT INTO sessions VALUES (?,?,?)").run("s-omi", "omi", null);
    hdb.prepare("INSERT INTO messages VALUES (?,?,'user',?)").run(
      "m-3", "s-omi", new Date("2026-07-15T10:00:00Z").getTime() / 1000,
    );
    hdb.close();
    const { p } = await getStatement("date=2026-07-15");
    assert.strictEqual(p.engaged.hours, 0, "source not in allowlist excluded regardless of parentage");
  });
});

// ─── interruption fallback (#580) ────────────────────────────────────────────
// The interruption count has two sub-terms:
//   from_flag:        solicited = 0  (authoritative)
//   from_source_kind: solicited IS NULL + source_kind IN ('cron','system')
//                     (historical fallback — machine-initiated by definition)
// These tests prove each inclusion and exclusion rule, and that the totals
// add up (disclosure integrity).
describe("GET /api/v1/attention/statement — interruption fallback (#580)", () => {
  let jSeq = 0;
  function insertJournal(params: {
    ts: string; direction: string; source_kind?: string | null; solicited?: number | null;
  }): void {
    jSeq++;
    db.prepare(
      `INSERT INTO alfred_journal
         (id, ts, channel, chat_id, direction, message, source_kind, solicited)
       VALUES (?, ?, 'slack', 'C-INT-580', ?, 'test', ?, ?)`,
    ).run(`01INT${String(jSeq).padStart(10, "0")}`, params.ts, params.direction,
          params.source_kind ?? null, params.solicited ?? null);
  }

  beforeEach(() => {
    db.prepare("DELETE FROM alfred_journal WHERE chat_id = 'C-INT-580'").run();
  });

  it("solicited=0 → counted in from_flag", async () => {
    insertJournal({ ts: "2026-06-01T10:00:00Z", direction: "outbound", source_kind: "slack", solicited: 0 });
    const { p } = await getStatement("date=2026-06-01");
    assert.strictEqual(p.interruption.count, 1);
    assert.strictEqual(p.interruption.from_flag, 1);
    assert.strictEqual(p.interruption.from_source_kind, 0);
  });

  it("solicited=1 → never counted regardless of source_kind", async () => {
    insertJournal({ ts: "2026-06-02T10:00:00Z", direction: "outbound", source_kind: "cron", solicited: 1 });
    const { p } = await getStatement("date=2026-06-02");
    assert.strictEqual(p.interruption.count, 0);
    assert.strictEqual(p.interruption.from_flag, 0);
    assert.strictEqual(p.interruption.from_source_kind, 0);
  });

  it("solicited IS NULL + source_kind='cron' → counted in from_source_kind", async () => {
    insertJournal({ ts: "2026-06-03T10:00:00Z", direction: "outbound", source_kind: "cron", solicited: null });
    const { p } = await getStatement("date=2026-06-03");
    assert.strictEqual(p.interruption.count, 1);
    assert.strictEqual(p.interruption.from_flag, 0);
    assert.strictEqual(p.interruption.from_source_kind, 1);
  });

  it("solicited IS NULL + source_kind='system' → counted in from_source_kind", async () => {
    insertJournal({ ts: "2026-06-04T10:00:00Z", direction: "outbound", source_kind: "system", solicited: null });
    const { p } = await getStatement("date=2026-06-04");
    assert.strictEqual(p.interruption.count, 1);
    assert.strictEqual(p.interruption.from_flag, 0);
    assert.strictEqual(p.interruption.from_source_kind, 1);
  });

  it("solicited IS NULL + source_kind='ha-conversation-reply' → NOT counted", async () => {
    insertJournal({ ts: "2026-06-05T10:00:00Z", direction: "outbound", source_kind: "ha-conversation-reply", solicited: null });
    const { p } = await getStatement("date=2026-06-05");
    assert.strictEqual(p.interruption.count, 0, "ha-conversation-reply is solicited; must not count even when flag absent");
    assert.strictEqual(p.interruption.from_source_kind, 0);
  });

  it("solicited IS NULL + source_kind IS NULL → NOT counted", async () => {
    insertJournal({ ts: "2026-06-06T10:00:00Z", direction: "outbound", source_kind: null, solicited: null });
    const { p } = await getStatement("date=2026-06-06");
    assert.strictEqual(p.interruption.count, 0, "genuinely unknown provenance must not be counted");
    assert.strictEqual(p.interruption.from_source_kind, 0);
  });

  it("from_flag + from_source_kind === count (disclosure adds up to total)", async () => {
    // 2 via flag + 3 via source_kind, plus 2 that must be excluded.
    insertJournal({ ts: "2026-06-07T08:00:00Z", direction: "outbound", source_kind: "slack",  solicited: 0 });
    insertJournal({ ts: "2026-06-07T08:01:00Z", direction: "outbound", source_kind: "slack",  solicited: 0 });
    insertJournal({ ts: "2026-06-07T09:00:00Z", direction: "outbound", source_kind: "cron",   solicited: null });
    insertJournal({ ts: "2026-06-07T09:01:00Z", direction: "outbound", source_kind: "cron",   solicited: null });
    insertJournal({ ts: "2026-06-07T09:02:00Z", direction: "outbound", source_kind: "system", solicited: null });
    // Must NOT count: solicited=1 overrides cron classification, and NULL source.
    insertJournal({ ts: "2026-06-07T10:00:00Z", direction: "outbound", source_kind: "cron",   solicited: 1 });
    insertJournal({ ts: "2026-06-07T10:01:00Z", direction: "outbound", source_kind: null,     solicited: null });
    const { p } = await getStatement("date=2026-06-07");
    assert.strictEqual(p.interruption.from_flag, 2,       "two solicited=0 rows");
    assert.strictEqual(p.interruption.from_source_kind, 3,"three NULL+cron/system rows");
    assert.strictEqual(p.interruption.count, 5,           "total = 2 + 3");
    assert.strictEqual(p.interruption.from_flag + p.interruption.from_source_kind,
                       p.interruption.count, "disclosure sub-counts must sum to total");
  });
});

// ─── HUMAN_SESSION_SOURCES allowlist — cli removed (#584) ───────────────────
// cli sessions are agent-driven one-shots, not principal attention.
// These tests cover: (a) the constant shape; (b) cli-only day = zero engaged;
// (c) mixed slack+cli day = only slack turns count.
// The Hermes state.db fixture reuses the tmp dir from the parent_session_id
// describe block above but in a fresh before() that re-creates the directory
// (which that block's after() deletes).
describe("HUMAN_SESSION_SOURCES allowlist — cli excluded (#584)", () => {
  // Re-create the same hermes-state path that the parent_session_id block's
  // after() cleaned up, so the route handler's fs.existsSync check passes.
  const hsDir2 = path.join(tmp, "hermes-state");
  const hsDbPath2 = path.join(hsDir2, "main", "state.db");

  before(() => {
    fs.mkdirSync(path.join(hsDir2, "main"), { recursive: true });
    const hdb = new DatabaseSync(hsDbPath2);
    hdb.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, parent_session_id TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, timestamp REAL NOT NULL);
    `);
    hdb.close();
  });

  after(() => { fs.rmSync(hsDir2, { recursive: true, force: true }); });

  beforeEach(() => {
    db.prepare("DELETE FROM nar_entry").run();
    const hdb = new DatabaseSync(hsDbPath2);
    hdb.exec("DELETE FROM messages; DELETE FROM sessions;");
    hdb.close();
  });

  // Parity guard. ctrl decides which turns become ENGAGED; learn decides which
  // sessions become DISPLACED. They read separate copies of the same allowlist,
  // so a source present in one and absent from the other credits work with no
  // attention cost against it (or the reverse) — and nothing on the statement
  // shows the divergence. This test failed to exist when ctrl carried
  // [slack, telegram] against learn's [web, slack, telegram].
  it("allowlist matches learn's HUMAN_SOURCES exactly", () => {
    const pyPath = path.join(
      import.meta.dirname, "..", "..", "learn", "src", "activities", "nar_data.py",
    );
    const py = fs.readFileSync(pyPath, "utf8");
    const m = py.match(/HUMAN_SOURCES:\s*frozenset\[str\]\s*=\s*frozenset\(\{([^}]*)\}\)/);
    assert.ok(m, "could not find HUMAN_SOURCES in nar_data.py — has it moved?");
    const learnSources = [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
    const ctrlSources = [...HUMAN_SESSION_SOURCES].sort();
    assert.deepEqual(
      ctrlSources, learnSources,
      `ctrl [${ctrlSources}] and learn [${learnSources}] must list the same human sources`,
    );
  });

  it("constant contains slack and telegram and does NOT contain cli", () => {
    assert.ok(
      (HUMAN_SESSION_SOURCES as readonly string[]).includes("slack"),
      "slack must be in HUMAN_SESSION_SOURCES",
    );
    assert.ok(
      (HUMAN_SESSION_SOURCES as readonly string[]).includes("telegram"),
      "telegram must be in HUMAN_SESSION_SOURCES",
    );
    assert.ok(
      !(HUMAN_SESSION_SOURCES as readonly string[]).includes("cli"),
      "cli must NOT be in HUMAN_SESSION_SOURCES — it is machine traffic",
    );
  });

  it("cli-only sessions (parent IS NULL) yield zero engaged time", async () => {
    const hdb = new DatabaseSync(hsDbPath2);
    hdb.prepare("INSERT INTO sessions VALUES (?,?,?)").run("s-cli-1", "cli", null);
    hdb.prepare("INSERT INTO messages VALUES (?,?,'user',?)").run(
      "m-cli-1", "s-cli-1", new Date("2026-08-10T09:00:00Z").getTime() / 1000,
    );
    hdb.prepare("INSERT INTO sessions VALUES (?,?,?)").run("s-cli-2", "cli", null);
    hdb.prepare("INSERT INTO messages VALUES (?,?,'user',?)").run(
      "m-cli-2", "s-cli-2", new Date("2026-08-10T09:01:00Z").getTime() / 1000,
    );
    hdb.close();
    const { p } = await getStatement("date=2026-08-10");
    assert.strictEqual(p.engaged.hours, 0,
      "cli sessions must not contribute to engaged — they are machine traffic");
  });

  it("mixed slack+cli day counts only the slack turns", async () => {
    const hdb = new DatabaseSync(hsDbPath2);
    // One human slack session.
    hdb.prepare("INSERT INTO sessions VALUES (?,?,?)").run("s-slack-1", "slack", null);
    hdb.prepare("INSERT INTO messages VALUES (?,?,'user',?)").run(
      "m-slack-1", "s-slack-1", new Date("2026-08-11T10:00:00Z").getTime() / 1000,
    );
    // One agent cli session — same day.
    hdb.prepare("INSERT INTO sessions VALUES (?,?,?)").run("s-cli-3", "cli", null);
    hdb.prepare("INSERT INTO messages VALUES (?,?,'user',?)").run(
      "m-cli-3", "s-cli-3", new Date("2026-08-11T10:30:00Z").getTime() / 1000,
    );
    hdb.close();
    // The slack session contributes ≥ the 2-min floor; cli contributes 0.
    // If cli were included the burst would be ~32 min; slack-only = 2 min floor.
    const { p } = await getStatement("date=2026-08-11");
    // The two timestamps are 30 min apart — two separate bursts if both counted.
    // With cli excluded, only the slack turn remains → single burst at the floor.
    assert.ok(p.engaged.hours > 0, "slack turn must be counted");
    // 30-min gap > GAP_MS (10 min) → two bursts if both sources counted.
    // Verify the cli turn did NOT add a second burst by checking hours < 2 × floor.
    // floor = 2 min, so two bursts would yield ≥ 4 min = 0.0667 h.
    // One burst (slack only) = 2 min = 0.0333 h.
    assert.ok(
      p.engaged.hours < 0.05,
      `only the slack turn must be counted; expected < 0.05h but got ${p.engaged.hours}`,
    );
  });
});
