// F2 (C18) — delegate must NOT flip NA→dispatched optimistically.
//
// The POST /decisions delegate branch wrote status="dispatched" on the
// needs_attention record BEFORE any dispatch was attempted. The real dispatch
// then 400'd on advisory cards (no real signal), but the card was already gone
// from the Desk and the audit said "Dispatched" — failure looked like success.
//
// C18: delegate flips NA→dispatched only AFTER dispatch succeeds, returning the
// dispatch result. An advisory card with no real state.db signal returns a
// clean "nothing to delegate" (not a raw 400, not an optimistic dispatched).
//
// This test POSTs intent=delegate for: (a) a card backed by a real state.db
// signal — must end status=dispatched; (b) an advisory card (source_signal_path
// is a ULID with no signal row) — must NOT be dispatched, must return a clear
// result and leave the NA pending.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dec-delegate-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const VAULT = process.env.VAULT_PATH;
fs.mkdirSync(path.join(VAULT, "needs_attention"), { recursive: true });

const { getStateDb } = await import("../src/db/state.js");
const { registerDecisionRoutes } = await import("../src/api/routes/decisions.js");
const { readNeedsAttention } = await import("../src/api/routes/attention.js");
const { matchRoute } = await import("../src/api/server.js");

registerDecisionRoutes();

const REAL_SIGNAL = "01KS2ZJ3SKBRCMHP97N9DH8PS4";
const ADVISORY_SIGNAL = "01KS2ZJ3SKBRCMHP97N9DH8PS5"; // no signal row

function seedRealSignal(): void {
  getStateDb()
    .prepare(
      `INSERT INTO signal (id, ts, kind, source, headline, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(REAL_SIGNAL, "2026-05-20T15:00:00.000Z", "request", "signal_extract.email", "Renew Plex Pass", "routed_human");
}

function writeNa(id: string, sourceSignalPath: string, reason: string): void {
  fs.writeFileSync(
    path.join(VAULT, "needs_attention", `${id}.md`),
    [
      "---",
      'type: "needs_attention"',
      "status: pending",
      `display_headline: "${id}"`,
      `source_signal_path: "${sourceSignalPath}"`,
      `decision_reason: ${reason}`,
      "---",
      "",
      "body",
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function postDecision(body: unknown): Promise<{ status: number; payload: any }> {
  const m = matchRoute("POST", "/api/v1/decisions");
  assert.ok(m, "POST /api/v1/decisions must be registered");
  let status = 0;
  let payload: any;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(json?: string) { payload = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({
    req: { url: "/api/v1/decisions" } as any,
    res,
    params: {},
    body,
    query: new URLSearchParams(),
  });
  return { status, payload };
}

describe("POST /api/v1/decisions delegate — non-optimistic (F2)", () => {
  before(() => {
    getStateDb();
    seedRealSignal();
  });

  it("flips NA→dispatched only after a real dispatch succeeds", async () => {
    const naId = "real-card";
    writeNa(naId, REAL_SIGNAL, "high_confidence_match");
    const { status, payload } = await postDecision({
      source: "needs_attention",
      source_record: `needs_attention/${naId}.md`,
      intent: "delegate",
      decision_origin: "decision/x.md",
    });
    assert.equal(status, 201, `must 201, got ${status}: ${JSON.stringify(payload)}`);

    const rec = readNeedsAttention(naId);
    assert.equal(rec!.frontmatter.status, "dispatched", "real card must end dispatched");
    // #216: the re-routed signal is stamped 'routed_agent' (TERMINAL) so
    // SignalRouterWorkflow's `unrouted` pickup query does NOT return it.
    // Prior contract was `unrouted`, which caused the dispatch loop today
    // (2026-05-24) — 10 fires per click before the signal escaped.
    const sig = getStateDb()
      .prepare("SELECT status FROM signal WHERE id = ?")
      .get(REAL_SIGNAL) as { status: string };
    assert.equal(sig.status, "routed_agent");
  });

  it("an advisory card (no real signal) is NOT dispatched and returns a clear result", async () => {
    const naId = "advisory-card";
    writeNa(naId, ADVISORY_SIGNAL, "shadow_mode");
    const { status, payload } = await postDecision({
      source: "needs_attention",
      source_record: `needs_attention/${naId}.md`,
      intent: "delegate",
    });
    // Must be a clean 2xx with a "nothing to delegate" outcome — not a raw 400.
    assert.equal(status, 201, `advisory delegate must not 400, got ${status}: ${JSON.stringify(payload)}`);

    const rec = readNeedsAttention(naId);
    assert.notEqual(
      rec!.frontmatter.status,
      "dispatched",
      "advisory card must NOT be optimistically flipped to dispatched",
    );

    // The decision record/result should signal that nothing was delegated.
    const se = payload.frontmatter?.side_effects ?? {};
    assert.ok(
      JSON.stringify(se).includes("nothing_to_delegate") ||
        se.dispatch_ok === false,
      `result must communicate nothing-to-delegate; got ${JSON.stringify(se)}`,
    );
  });
});
