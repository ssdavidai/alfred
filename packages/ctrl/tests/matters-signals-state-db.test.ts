// F9 — matters route reads the signal timeline from state.db.
//
// Signals were demoted out of vault/signal/ into the state.db `signal` table
// (storage cutover #27). The NightlyNarrativeWorkflow composer reads them from
// state.db (sc.list_signals(matter=...)), but the matters route still walked
// vault/signal/*.md — a directory that does not exist on the box (0 files). So
// the matter timeline was always empty even when signals had been routed to the
// matter, and the composer and the route disagreed on the signal store.
//
// This test seeds a matter file plus a state.db signal row whose matter_ref is
// that matter, and asserts the matter detail timeline includes a signal entry
// sourced from state.db. Pairs with learn F38 (composer aligned on state.db).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "matters-signals-"));
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";

const VAULT = process.env.VAULT_PATH;
fs.mkdirSync(path.join(VAULT, "matter"), { recursive: true });

const { getStateDb } = await import("../src/db/state.js");
const { matchRoute } = await import("../src/api/server.js");
const { registerMatterRoutes } = await import("../src/api/routes/matters.js");
registerMatterRoutes();

const MATTER_PATH = "matter/acme-deal.md";
const SIGNAL_ULID = "01KS3SIGNALMATTERTIMELINE01";

function seedMatter(): void {
  fs.writeFileSync(
    path.join(VAULT, MATTER_PATH),
    ["---", "type: matter", "name: Acme Deal", "status: active", "---", "", "Body.", ""].join("\n"),
    "utf-8",
  );
}

function seedSignal(): void {
  getStateDb()
    .prepare(
      `INSERT INTO signal (id, ts, kind, source, matter_ref, headline, body, salience, status, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      SIGNAL_ULID,
      "2026-05-22T10:00:00.000Z",
      "request",
      "signal_extract.email",
      MATTER_PATH,
      "Acme wants a revised quote",
      "Reasoning detail.",
      0.8,
      "routed_human",
      JSON.stringify({ created: "2026-05-22T10:00:00.000Z" }),
    );
}

async function call(method: string, pathname: string): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, pathname);
  assert.ok(m, `${method} ${pathname} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(json?: string) { payload = json ? JSON.parse(json) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({ req: { url: pathname } as any, res, params: m!.params, body: undefined, query: new URLSearchParams() });
  return { status, payload };
}

describe("matters route — signal timeline from state.db (F9)", () => {
  before(() => {
    getStateDb();
    seedMatter();
    seedSignal();
  });

  it("includes the state.db signal in the matter timeline", async () => {
    const { status, payload } = await call("GET", "/api/v1/matters/acme-deal");
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(payload)}`);
    const timeline = payload.matter.timeline as any[];
    const sig = timeline.find((e) => e.kind === "signal");
    assert.ok(sig, `matter timeline must include the state.db signal; got ${JSON.stringify(timeline)}`);
    assert.equal(sig.headline, "Acme wants a revised quote");
  });
});
