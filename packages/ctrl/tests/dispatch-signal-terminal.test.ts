// #216 — delegate-dispatch must mint the re-routed signal in a TERMINAL state
// so SignalRouterWorkflow does not loop.
//
// Today (2026-05-24), Sir clicked Delegate once on a needs_attention card. The
// legacy POST /api/v1/admin/needs-attention/:id/dispatch endpoint correctly
// patched NA→dispatched, minted decision/<ts>.md with intent=delegate, and
// re-armed the source signal so the workers profile could pick it up. But it
// re-armed the signal to status="unrouted" — SignalRouterWorkflow's only
// pickup queue. The signal got dispatched 10 times over 10 minutes (one per
// 2-min router tick) before Sir manually patched it to routed_agent. Each
// dispatch fired a fresh agent invocation, minted a new decision/<ts>.md, and
// polluted the observation pool 10×.
//
// Option A fix: mark the re-routed signal with a terminal status
// (status="routed_agent") at dispatch time. SignalRouter's list_unrouted_signals
// filters on status='unrouted', so the signal is never picked up again. The
// agent dispatch is meant to happen synchronously via the /dispatch call —
// SignalRouter is the cause of the loop, not the agent fire path.
//
// Trade-off (Sir-acknowledged): signal-router can no longer retry a stuck
// re-routed signal. Not a use case right now; the loop is a bigger pain.
//
// This file isolates the SignalRouter-skip assertion. Existing tests
// (dispatch-signal-ulid.test.ts, decisions-delegate-non-optimistic.test.ts)
// are updated in lock-step to assert routed_agent instead of unrouted.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-terminal-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const VAULT = process.env.VAULT_PATH;
fs.mkdirSync(path.join(VAULT, "needs_attention"), { recursive: true });

const { getStateDb } = await import("../src/db/state.js");
const { registerAttentionRoutes } = await import("../src/api/routes/attention.js");
const { registerDecisionRoutes } = await import("../src/api/routes/decisions.js");
const { readNeedsAttention } = await import("../src/api/routes/attention.js");
const { matchRoute } = await import("../src/api/server.js");

registerAttentionRoutes();
registerDecisionRoutes();

const SIGNAL_ULID_LEGACY = "01KSBNBX4VYQDKXFBFCYE9WXPW";
const SIGNAL_ULID_DESK = "01KSBNBX4VYQDKXFBFCYE9WXP1";
const NA_LEGACY = "2026-05-24T15-20-10Z-legacy01";
const NA_DESK = "2026-05-24T15-20-11Z-desk001";

function seedSignal(id: string): void {
  getStateDb()
    .prepare(
      `INSERT INTO signal (id, ts, kind, source, headline, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, "2026-05-24T15:00:00.000Z", "action", "signal_extract.email",
         "A Soft Murmur", "routed_human");
}

function writeNa(id: string, sourceSignalPath: string): void {
  fs.writeFileSync(
    path.join(VAULT, "needs_attention", `${id}.md`),
    [
      "---",
      'type: "needs_attention"',
      "status: pending",
      `display_headline: "${id}"`,
      `source_signal_path: "${sourceSignalPath}"`,
      "decision_reason: high_confidence_match",
      "---",
      "",
      "body",
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function call(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; payload: any }> {
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
    body,
    query: new URLSearchParams(),
  });
  return { status, payload };
}

// Fake equivalent of SignalRouter.list_unrouted_signals — the same query
// list_unrouted_signal_refs in learn issues against ctrl-api:
//   GET /api/v1/state/signals?status=unrouted
// We exercise the raw SQL here so the assertion proves "router would not
// pick this up" without standing up the python worker.
function listUnroutedSignals(): string[] {
  const rows = getStateDb()
    .prepare("SELECT id FROM signal WHERE status = 'unrouted' ORDER BY ts ASC")
    .all() as { id: string }[];
  return rows.map((r) => r.id);
}

describe("delegate-dispatch mints re-routed signal as TERMINAL (#216)", () => {
  before(() => {
    getStateDb();
    seedSignal(SIGNAL_ULID_LEGACY);
    seedSignal(SIGNAL_ULID_DESK);
  });

  it("legacy POST /needs-attention/:id/dispatch leaves the signal in a router-skip state", async () => {
    writeNa(NA_LEGACY, SIGNAL_ULID_LEGACY);
    const { status, payload } = await call(
      "POST",
      `/api/v1/admin/needs-attention/${NA_LEGACY}/dispatch`,
      { decision_origin: "decision/legacy-216.md" },
    );
    assert.equal(status, 200, `dispatch must 200, got ${status}: ${JSON.stringify(payload)}`);
    assert.equal(payload.status, "dispatched");

    // Existing assertions (carry forward — F2 + Gap 4 contract).
    const rec = readNeedsAttention(NA_LEGACY);
    assert.equal(rec!.frontmatter.status, "dispatched", "NA must be flipped to dispatched");
    assert.ok(payload.decision_record_path, "decision mirror must be minted");

    // NEW assertion (#216): the re-routed signal MUST be terminal —
    // status="routed_agent" — so SignalRouterWorkflow's `unrouted`
    // pickup query does NOT return it.
    const sig = getStateDb()
      .prepare("SELECT status, payload_json FROM signal WHERE id = ?")
      .get(SIGNAL_ULID_LEGACY) as { status: string; payload_json: string | null };
    assert.equal(
      sig.status,
      "routed_agent",
      "re-routed signal MUST end in routed_agent (terminal). Setting unrouted causes the SignalRouter loop (#216).",
    );

    // decision_origin must still be stamped — that is how the eventual
    // outcome signal matches back to the principal's intent.
    const pl = sig.payload_json ? JSON.parse(sig.payload_json) : {};
    assert.equal(pl.decision_origin, "decision/legacy-216.md",
                 "decision_origin must be stamped on the signal payload");

    // Prove the loop is severed: the SignalRouter pickup query returns
    // an empty set for this signal id.
    const unrouted = listUnroutedSignals();
    assert.ok(
      !unrouted.includes(SIGNAL_ULID_LEGACY),
      `SignalRouter must NOT see this signal as unrouted. Got: ${JSON.stringify(unrouted)}`,
    );
  });

  it("DeskPage POST /decisions intent=delegate leaves the signal in a router-skip state", async () => {
    writeNa(NA_DESK, SIGNAL_ULID_DESK);
    const { status, payload } = await call(
      "POST",
      "/api/v1/decisions",
      {
        source: "needs_attention",
        source_record: `needs_attention/${NA_DESK}.md`,
        intent: "delegate",
      },
    );
    assert.equal(status, 201, `decision POST must 201, got ${status}: ${JSON.stringify(payload)}`);

    // Existing assertions.
    const rec = readNeedsAttention(NA_DESK);
    assert.equal(
      rec!.frontmatter.status, "dispatched",
      "NA must be flipped to dispatched after a successful dispatch (F2)",
    );

    // NEW assertion (#216): the re-routed signal MUST be terminal.
    const sig = getStateDb()
      .prepare("SELECT status FROM signal WHERE id = ?")
      .get(SIGNAL_ULID_DESK) as { status: string };
    assert.equal(
      sig.status,
      "routed_agent",
      "re-routed signal from DeskPage path MUST end in routed_agent (terminal).",
    );

    const unrouted = listUnroutedSignals();
    assert.ok(
      !unrouted.includes(SIGNAL_ULID_DESK),
      `SignalRouter must NOT see this signal as unrouted. Got: ${JSON.stringify(unrouted)}`,
    );
  });
});
