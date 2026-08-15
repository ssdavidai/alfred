// Suppression rate card tests (#563). Fixtures are raw JSON — not derived from loader.
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "suppression-rc-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH   = path.join(tmp, "state.db");
process.env.VAULT_PATH      = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
fs.mkdirSync(process.env.VAULT_PATH!, { recursive: true });

const { loadRateCard, getRateCard, DEFAULT_RATE_MINUTES_PER_ITEM } =
  await import("../src/api/routes/suppressionRateCard.js");
const { getStateDb } = await import("../src/db/state.js");

const OVERRIDE = path.join(tmp, "suppression-rate-card.json");
const STATE    = path.join(tmp, "suppression-rate-card-state.json");
const clear = () => { for (const f of [OVERRIDE, STATE]) { try { fs.unlinkSync(f); } catch { /**/ } } };
const auditCount = () => (getStateDb().prepare("SELECT COUNT(*) AS n FROM audit WHERE action_type='suppression_rate_card_change'").get() as { n: number }).n;

describe("suppression rate card", () => {
  before(() => getStateDb());
  beforeEach(clear);

  // 1. Default loads when no override exists
  it("loads default 0.5 min/item when no override file exists", () => {
    const c = loadRateCard({ dataDir: tmp });
    assert.strictEqual(c.rate_minutes_per_item, 0.5);
    assert.strictEqual(DEFAULT_RATE_MINUTES_PER_ITEM, 0.5);
    assert.strictEqual(c.source, "default");
    assert.strictEqual(c.override_path, null);
  });

  // 2. Override overlays default
  it("override file overlays the default", () => {
    fs.writeFileSync(OVERRIDE, JSON.stringify({ minutes_per_item: 1.5 }), "utf-8");
    const c = loadRateCard({ dataDir: tmp });
    assert.strictEqual(c.rate_minutes_per_item, 1.5);
    assert.strictEqual(c.source, "override");
    assert.strictEqual(c.override_path, OVERRIDE);
  });

  // 3. Malformed / invalid override throws — never silently falls back
  it("malformed JSON in override throws (not silent fallback)", () => {
    fs.writeFileSync(OVERRIDE, "{not valid json", "utf-8");
    assert.throws(() => loadRateCard({ dataDir: tmp }), /not valid JSON/);
  });
  it("override missing minutes_per_item key throws", () => {
    fs.writeFileSync(OVERRIDE, JSON.stringify({ wrong: 1 }), "utf-8");
    assert.throws(() => loadRateCard({ dataDir: tmp }), /minutes_per_item/);
  });

  // 4. Rate-change audit fires on hash change; not on unchanged repeat
  it("audit row written on first getRateCard call (initialise)", () => {
    const before = auditCount();
    getRateCard({ dataDir: tmp });
    assert.strictEqual(auditCount(), before + 1);
  });
  it("no audit row on unchanged repeat call", () => {
    getRateCard({ dataDir: tmp });
    const after1 = auditCount();
    getRateCard({ dataDir: tmp });
    assert.strictEqual(auditCount(), after1);
  });
  it("audit row written when rate changes", () => {
    getRateCard({ dataDir: tmp });
    const mid = auditCount();
    fs.writeFileSync(OVERRIDE, JSON.stringify({ minutes_per_item: 0.75 }), "utf-8");
    getRateCard({ dataDir: tmp });
    assert.strictEqual(auditCount(), mid + 1);
  });
  it("audit payload carries rate, source, hash, previous_hash=null on init", () => {
    getRateCard({ dataDir: tmp });
    const row = getStateDb()
      // The INIT row specifically — id is a ULID, so ASC is insertion order.
      // This used to read `ORDER BY created_at DESC LIMIT 1`, but created_at has
      // one-second resolution: when the whole file runs inside a single second
      // the ordering is a tie and SQLite may return either row. The preceding
      // test deliberately leaves a 0.75 override in place, so the tie resolved
      // to that row and the assertion saw 0.75 instead of 0.5. It passed only by
      // timing luck and broke as soon as an unrelated test file shifted the
      // schedule across a second boundary.
      .prepare("SELECT payload_json FROM audit WHERE action_type='suppression_rate_card_change' ORDER BY id ASC LIMIT 1")
      .get() as { payload_json: string };
    const p = JSON.parse(row.payload_json);
    assert.strictEqual(p.rate_minutes_per_item, 0.5);
    assert.strictEqual(p.source, "default");
    assert.ok(p.hash.length > 0);
    assert.strictEqual(p.previous_hash, null);
  });

  // 5. Invalid rates rejected
  it("negative rate rejected", () => {
    fs.writeFileSync(OVERRIDE, JSON.stringify({ minutes_per_item: -1 }), "utf-8");
    assert.throws(() => loadRateCard({ dataDir: tmp }), /non-negative/);
  });
  it("non-numeric rate rejected", () => {
    fs.writeFileSync(OVERRIDE, JSON.stringify({ minutes_per_item: "fast" }), "utf-8");
    assert.throws(() => loadRateCard({ dataDir: tmp }), /non-negative finite number/);
  });
});
