// C-B4 — defer decisions must be resurfaceable.
//
// POST /api/v1/decisions wrote intent="defer" decisions with state="completed"
// (because the source NA flip ran synchronously), but learn's decision_router
// only lists state="open" decisions to parse the note → stamp resurface_at →
// re-open the source NA at that time. A completed defer was never seen by the
// router, so the card vanished and never came back.
//
// C-B4 fix: ctrl ITSELF writes state="open" for a defer (other intents keep
// their normal completed/open state), and the 201 carries
// side_effects: { deferred: true, resurface_at: null } — learn's router fills
// resurface_at async (null is contract-allowed).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dec-defer-resurface-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const VAULT = process.env.VAULT_PATH;
fs.mkdirSync(path.join(VAULT, "needs_attention"), { recursive: true });

const { getStateDb } = await import("../src/db/state.js");
const { registerDecisionRoutes } = await import("../src/api/routes/decisions.js");
const { matchRoute } = await import("../src/api/server.js");

registerDecisionRoutes();

function writeNa(id: string): void {
  fs.writeFileSync(
    path.join(VAULT, "needs_attention", `${id}.md`),
    ["---", 'type: "needs_attention"', "status: pending", `display_headline: "${id}"`, "---", "", "body", ""].join("\n"),
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

describe("C-B4 — defer writes state=open and a resurface contract", () => {
  before(() => {
    getStateDb();
  });

  it("ctrl ITSELF writes state=open for a defer (synchronous NA flip notwithstanding)", async () => {
    writeNa("defer-card");
    const { status, payload } = await postDecision({
      source: "needs_attention",
      source_record: "needs_attention/defer-card.md",
      intent: "defer",
      note: "remind me next month",
    });
    assert.equal(status, 201, `must 201, got ${status}: ${JSON.stringify(payload)}`);
    // The NA flip ran (state used to become "completed") — but the decision
    // must stay "open" so learn's router lists + stamps it.
    assert.equal(
      payload.frontmatter.state,
      "open",
      "a defer must be written state=open, not completed",
    );
    assert.equal(payload.frontmatter.side_effects.deferred, true);
    assert.ok(
      "resurface_at" in payload.frontmatter.side_effects,
      "side_effects must carry a resurface_at key (iso or null)",
    );
  });

  it("a non-defer intent with a synchronous flip writes state=open so the router runs extract_observation_from_decision (loop-close)", async () => {
    // Updated contract (2026-05-24 loop-close): every decision is minted as
    // state=open with synchronous_flip=true. DecisionRouterWorkflow picks it
    // up, runs extract_observation_from_decision (the learning loop), and
    // flips state→completed itself. The router's synchronous_flip guards
    // (decision_router.py:194,307,426,479,486,563,586) cleanly skip the
    // action paths the synchronous flip already performed.
    //
    // Pre-fix: done/noise/take_mine were minted as completed → router skipped
    // them → 0 kind=decision observations ever landed in state.db → instincts
    // could never learn from human decisions on the Desk.
    writeNa("done-card");
    const { status, payload } = await postDecision({
      source: "needs_attention",
      source_record: "needs_attention/done-card.md",
      intent: "done",
    });
    assert.equal(status, 201);
    assert.equal(
      payload.frontmatter.state,
      "open",
      "done must be minted state=open so the router can extract observation",
    );
    assert.ok(
      payload.frontmatter.side_effects?.synchronous_flip,
      "synchronous_flip:true must be set so the router knows to skip action paths",
    );
    assert.ok(
      !payload.frontmatter.side_effects || !("deferred" in payload.frontmatter.side_effects),
      "a non-defer must NOT carry side_effects.deferred",
    );
  });
});
