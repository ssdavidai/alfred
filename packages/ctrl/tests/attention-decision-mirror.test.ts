// Gap 4 — the legacy needs-attention POST endpoints (/done, /dispatch,
// /skip) historically only patched the card's frontmatter and emitted a
// `needs_attention_action` audit. The new contract: they ALSO mint a
// `decision/<ts>.md` so DecisionRouterWorkflow picks the click up and
// downstream learning (observation extraction, matter timeline, etc.)
// fires for clicks that originate from the legacy buttons too.
//
// Mapping:
//   done     → decision.intent = "done"
//   dispatch → decision.intent = "delegate"
//   skip     → decision.intent = "defer"   (the canonical "Sir doesn't
//                                            want to do it now" intent;
//                                            see decisions.ts where
//                                            intent=defer → NA status=skipped)
//
// The mirror is *additive*: the frontmatter patch + audit emission MUST
// continue exactly as before. If the decision write throws (e.g. vault
// disk full), the request must still return 200 because the audit row
// is the existing contract.
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "attention-mirror-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";
const VAULT = process.env.VAULT_PATH!;
fs.mkdirSync(path.join(VAULT, "needs_attention"), { recursive: true });
fs.mkdirSync(path.join(VAULT, "event"), { recursive: true });
fs.mkdirSync(path.join(VAULT, "decision"), { recursive: true });

const { getStateDb } = await import("../src/db/state.js");
const { registerAttentionRoutes } = await import("../src/api/routes/attention.js");
const { matchRoute } = await import("../src/api/server.js");

registerAttentionRoutes();
getStateDb();

function writeCard(id: string) {
  const p = path.join(VAULT, "needs_attention", `${id}.md`);
  const yaml = [
    "---",
    'type: "needs_attention"',
    'status: "pending"',
    'created: "2026-05-24T00:00:00Z"',
    'action_what: "Reply to Jane"',
    'reasoning: "Jane is waiting"',
    'source_signal_path: "signal/abc.md"',
    'decision_reason: "high_confidence_match"',
    "---",
    "",
    "# Body",
    "",
  ].join("\n");
  fs.writeFileSync(p, yaml, "utf-8");
}

async function post(routeTpl: string, id: string, body: any = {}): Promise<{ status: number; payload: any }> {
  const url = routeTpl.replace(":id", id);
  const m = matchRoute("POST", url);
  assert.ok(m, `${url} must be registered`);
  let status = 200;
  let payload: any;
  const res = {
    writeHead(s: number) { status = s; return res; },
    end(json?: string) { payload = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  try {
    await m!.handler({
      req: { url, method: "POST" } as any,
      res, params: { id }, body, query: new URLSearchParams(),
    });
  } catch (err: any) {
    if (err && typeof err.statusCode === "number") {
      status = err.statusCode;
      payload = { error: { code: err.code, message: err.message } };
    } else { throw err; }
  }
  return { status, payload };
}

function listDecisions(): { id: string; fm: any }[] {
  const dir = path.join(VAULT, "decision");
  const out: { id: string; fm: any }[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const raw = fs.readFileSync(path.join(dir, f), "utf-8");
    const m = /^---\n([\s\S]*?)\n---/.exec(raw);
    if (!m) continue;
    // Lightweight YAML scan — we only need `intent`, `source`, `source_record`.
    const fm: any = {};
    for (const line of m[1].split("\n")) {
      const km = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
      if (!km) continue;
      let v: any = km[2];
      if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v);
      fm[km[1]] = v;
    }
    out.push({ id: f.replace(/\.md$/, ""), fm });
  }
  return out;
}

function listAttentionAudits(naId: string): string[] {
  const dir = path.join(VAULT, "event");
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("needs_attention_action-") && f.endsWith(`-${naId}.md`));
}

describe("Gap 4 — legacy needs-attention actions ALSO mint decision/<ts>.md", () => {
  beforeEach(() => {
    // Clean decision/ and event/ between tests so we count fresh records.
    for (const f of fs.readdirSync(path.join(VAULT, "decision"))) {
      fs.unlinkSync(path.join(VAULT, "decision", f));
    }
    for (const f of fs.readdirSync(path.join(VAULT, "event"))) {
      fs.unlinkSync(path.join(VAULT, "event", f));
    }
    for (const f of fs.readdirSync(path.join(VAULT, "needs_attention"))) {
      fs.unlinkSync(path.join(VAULT, "needs_attention", f));
    }
  });

  it("POST /skip → frontmatter patched, audit emitted, decision/<ts>.md minted with intent=defer", async () => {
    writeCard("ABC123");
    const { status, payload } = await post(
      "/api/v1/admin/needs-attention/:id/skip",
      "ABC123",
      { note: "not now" },
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(payload.status, "skipped");

    // (a) Frontmatter patched to status=skipped.
    const card = fs.readFileSync(
      path.join(VAULT, "needs_attention", "ABC123.md"),
      "utf-8",
    );
    assert.match(card, /^status: skipped$/m);

    // (b) Legacy needs_attention_action audit emitted (existing contract).
    const audits = listAttentionAudits("ABC123");
    assert.strictEqual(audits.length, 1, "legacy audit must still be emitted");

    // (c) NEW: decision/<ts>.md minted with intent=defer (Sir doesn't
    // want to do it now), source=needs_attention, source_record points
    // at the NA card.
    const decisions = listDecisions();
    assert.strictEqual(decisions.length, 1, "exactly one decision must be minted");
    assert.strictEqual(decisions[0].fm.intent, "defer");
    assert.strictEqual(decisions[0].fm.source, "needs_attention");
    assert.strictEqual(decisions[0].fm.source_record, "needs_attention/ABC123.md");
    assert.strictEqual(decisions[0].fm.type, "decision");
  });

  it("POST /done → mints decision with intent=done", async () => {
    writeCard("DEF456");
    const { status } = await post(
      "/api/v1/admin/needs-attention/:id/done",
      "DEF456",
      { note: "handled it" },
    );
    assert.strictEqual(status, 200);

    const decisions = listDecisions();
    assert.strictEqual(decisions.length, 1);
    assert.strictEqual(decisions[0].fm.intent, "done");
    assert.strictEqual(decisions[0].fm.source_record, "needs_attention/DEF456.md");

    // Legacy audit still emitted.
    assert.strictEqual(listAttentionAudits("DEF456").length, 1);
  });

  it("POST /dispatch → mints decision with intent=delegate", async () => {
    writeCard("GHI789");
    // dispatch needs a re-armable signal — fake one in state.db. The
    // source_signal_path on the NA card is "signal/abc.md" (vault path),
    // so the dispatcher walks the legacy filesystem path. Create it.
    const sigDir = path.join(VAULT, "signal");
    fs.mkdirSync(sigDir, { recursive: true });
    fs.writeFileSync(
      path.join(sigDir, "abc.md"),
      "---\nstatus: dispatched\n---\nbody\n",
      "utf-8",
    );

    const { status } = await post(
      "/api/v1/admin/needs-attention/:id/dispatch",
      "GHI789",
      { note: "send it" },
    );
    assert.strictEqual(status, 200);

    const decisions = listDecisions();
    assert.strictEqual(decisions.length, 1);
    assert.strictEqual(decisions[0].fm.intent, "delegate");
    assert.strictEqual(decisions[0].fm.source_record, "needs_attention/GHI789.md");

    // Legacy audit still emitted.
    assert.strictEqual(listAttentionAudits("GHI789").length, 1);
  });
});
