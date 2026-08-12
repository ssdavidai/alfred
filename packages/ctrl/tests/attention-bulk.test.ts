// Tests for POST /api/v1/admin/needs-attention/bulk.
// Covers: preview mutates nothing; apply writes ONE audit row + ONE decision;
// unknown/already-resolved ids skipped; delegate rejected; noise_warning present.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "attn-bulk-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
const VAULT = process.env.VAULT_PATH!;
fs.mkdirSync(path.join(VAULT, "needs_attention"), { recursive: true });
fs.mkdirSync(path.join(VAULT, "decision"), { recursive: true });

const { getStateDb } = await import("../src/db/state.js");
const { registerAttentionRoutes } = await import("../src/api/routes/attention.js");
const { matchRoute } = await import("../src/api/server.js");
registerAttentionRoutes();
const db = getStateDb();
const NA = path.join(VAULT, "needs_attention");
const DEC = path.join(VAULT, "decision");

function card(id: string, status = "pending"): void {
  fs.writeFileSync(path.join(NA, `${id}.md`),
    `---\ntype: "needs_attention"\nstatus: "${status}"\ncreated: "2026-08-12T00:00:00Z"\n---\nbody\n`, "utf-8");
}
function cardSt(id: string): string {
  const m = /^status: "?([^"\n]+)"?/m.exec(fs.readFileSync(path.join(NA, `${id}.md`), "utf-8"));
  return m ? m[1] : "?";
}
function decCount(): number { return fs.readdirSync(DEC).filter((f) => f.endsWith(".md")).length; }
function auditCount(): number { return (db.prepare("SELECT COUNT(*) as n FROM audit").get() as { n: number }).n; }

async function post(body: unknown): Promise<{ status: number; p: any }> {
  const m = matchRoute("POST", "/api/v1/admin/needs-attention/bulk");
  assert.ok(m, "route must be registered");
  let status = 0; let p: any;
  const res = {
    writeHead(s: number) { status = s; return res; },
    end(json?: string) { p = json ? JSON.parse(json) : {}; },
  } as unknown as ServerResponse;
  try {
    await m!.handler({ req: { url: "/api/v1/admin/needs-attention/bulk", method: "POST" } as any,
      res, params: {}, body, query: new URLSearchParams() });
  } catch (e: any) {
    if (typeof e?.statusCode === "number") { status = e.statusCode; p = { error: e }; }
    else throw e;
  }
  return { status, p };
}

describe("bulk needs-attention", () => {
  beforeEach(() => {
    [NA, DEC].forEach((d) => fs.readdirSync(d).forEach((f) => fs.unlinkSync(path.join(d, f))));
    db.prepare("DELETE FROM audit").run();
  });

  it("preview (dry_run) mutates nothing and counts accurately", async () => {
    card("P1"); card("P2"); card("D1", "done");
    const pre = auditCount();
    const { status, p } = await post({ ids: ["P1", "P2", "D1", "GHOST"], intent: "done", dry_run: true });
    assert.strictEqual(status, 200);
    assert.strictEqual(p.dry_run, true);
    assert.strictEqual(p.would_apply, 2);  // P1 + P2 pending
    assert.strictEqual(p.would_skip, 2);   // D1 already_resolved + GHOST not_found
    assert.strictEqual(cardSt("P1"), "pending");  // untouched
    assert.strictEqual(auditCount(), pre);         // no audit rows
    assert.strictEqual(decCount(), 0);             // no decisions
  });

  it("apply flips correct cards, writes exactly ONE audit row and ONE decision", async () => {
    card("A"); card("B"); card("C");
    const { status, p } = await post({ ids: ["A", "B", "C"], intent: "done" });
    assert.strictEqual(status, 200);
    assert.strictEqual(p.applied, 3);
    assert.strictEqual(p.skipped.length, 0);
    assert.strictEqual(cardSt("A"), "done");
    assert.strictEqual(cardSt("B"), "done");
    assert.strictEqual(cardSt("C"), "done");
    assert.strictEqual(auditCount(), 1, "exactly one audit row for the batch");
    assert.strictEqual(decCount(), 1, "exactly one decision record");
    assert.ok(p.decision_path?.startsWith("decision/"));
    assert.ok(typeof p.audit_id === "string" && p.audit_id.length > 0);
  });

  it("skips unknown ids and already-resolved ids; batch still completes over valid subset", async () => {
    card("GOOD"); card("ALREADY", "done");
    const { status, p } = await post({ ids: ["GOOD", "ALREADY", "MISSING"], intent: "defer" });
    assert.strictEqual(status, 200);
    assert.strictEqual(p.applied, 1);
    assert.strictEqual(p.skipped.length, 2);
    assert.strictEqual(cardSt("GOOD"), "skipped"); // defer → skipped on card
    const reasons: string[] = p.skipped.map((s: any) => s.reason);
    assert.ok(reasons.some((r) => r.startsWith("already_resolved")));
    assert.ok(reasons.some((r) => r === "not_found"));
  });

  it("rejects delegate with 400 and leaves cards untouched", async () => {
    card("X");
    const { status, p } = await post({ ids: ["X"], intent: "delegate" });
    assert.strictEqual(status, 400);
    assert.ok(p.error.message?.includes("delegate"));
    assert.strictEqual(cardSt("X"), "pending");
    assert.strictEqual(decCount(), 0);
  });

  it("noise preview includes noise_warning; apply marks cards noise", async () => {
    card("N1"); card("N2");
    const prev = await post({ ids: ["N1", "N2"], intent: "noise", dry_run: true });
    assert.ok(typeof prev.p.noise_warning === "string" && prev.p.noise_warning.length > 0);
    assert.strictEqual(decCount(), 0); // preview: no writes
    const apply = await post({ ids: ["N1", "N2"], intent: "noise" });
    assert.strictEqual(apply.p.applied, 2);
    assert.strictEqual(cardSt("N1"), "noise");
    assert.strictEqual(cardSt("N2"), "noise");
  });
});
