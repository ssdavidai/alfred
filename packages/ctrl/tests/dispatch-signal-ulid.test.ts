// F3 — dispatchSignalToAgent must resolve a state.db signal ULID.
//
// The needs_attention writer now stamps `source_signal_path` with a state.db
// signal ULID (signals were demoted out of the vault's signal/ directory). But
// the dispatch handler still treated it as a vault-relative path and did
// fs.readFileSync(path.join(VAULT_PATH, ulid)) → ENOENT → "source signal not
// readable" → 400 on every real card (the headline Delegate-fails bug).
//
// This test seeds a state.db signal, writes a needs_attention record whose
// source_signal_path is that ULID, and POSTs /dispatch. Pre-fix it 400s with
// ENOENT; post-fix it 200s and the signal status is stamped 'routed_agent'
// (#216 — terminal so SignalRouterWorkflow does not loop on it).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-ulid-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const VAULT = process.env.VAULT_PATH;
fs.mkdirSync(path.join(VAULT, "needs_attention"), { recursive: true });

const { getStateDb } = await import("../src/db/state.js");
const { registerAttentionRoutes } = await import("../src/api/routes/attention.js");
const { matchRoute } = await import("../src/api/server.js");

registerAttentionRoutes();

const SIGNAL_ULID = "01KS2ZJ3SKBRCMHP97N9DH8PS4";
const NA_ID = "2026-05-20T15-20-10Z-c7587d63";

function seedSignal(): void {
  getStateDb()
    .prepare(
      `INSERT INTO signal (id, ts, kind, source, headline, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(SIGNAL_ULID, "2026-05-20T15:00:00.000Z", "request", "signal_extract.email", "Renew Plex Pass", "routed_human");
}

function writeNa(sourceSignalPath: string): void {
  fs.writeFileSync(
    path.join(VAULT, "needs_attention", `${NA_ID}.md`),
    [
      "---",
      'type: "needs_attention"',
      'status: pending',
      'display_headline: "Renew Plex Pass"',
      `source_signal_path: "${sourceSignalPath}"`,
      'decision_reason: high_confidence_match',
      "---",
      "",
      "body",
      "",
    ].join("\n"),
    "utf-8",
  );
}

async function call(method: string, pathname: string, body?: unknown): Promise<{ status: number; payload: any }> {
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

describe("POST /needs-attention/:id/dispatch — state.db signal ULID (F3)", () => {
  before(() => {
    getStateDb();
    seedSignal();
  });

  it("dispatches a card whose source_signal_path is a state.db ULID", async () => {
    writeNa(SIGNAL_ULID);
    const { status, payload } = await call(
      "POST",
      `/api/v1/admin/needs-attention/${NA_ID}/dispatch`,
      { decision_origin: "decision/abc.md" },
    );
    assert.equal(status, 200, `dispatch must 200, got ${status}: ${JSON.stringify(payload)}`);
    assert.equal(payload.status, "dispatched");

    // #216: the signal is stamped 'routed_agent' (TERMINAL) so SignalRouter
    // does NOT pick it up and loop on the dispatch.
    const sig = getStateDb()
      .prepare("SELECT status, payload_json FROM signal WHERE id = ?")
      .get(SIGNAL_ULID) as { status: string; payload_json: string | null };
    assert.equal(sig.status, "routed_agent", "signal must end in routed_agent (terminal — #216)");
    // decision_origin is stamped so the outcome can be matched to the intent.
    const pl = sig.payload_json ? JSON.parse(sig.payload_json) : {};
    assert.equal(pl.decision_origin, "decision/abc.md");
  });
});
