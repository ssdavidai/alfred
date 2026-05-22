// B11 — the "What Alfred is doing now" Desk strip (GET
// /api/v1/decisions/in-flight) was surfacing stale/stranded items: a
// decision left in dispatching/executing/open for hours (e.g. an 8am
// "delegating celebration" still showing at noon) never left the strip
// because the route deliberately kept stuck `open` items "to make the
// stuck state observable". A stranded corpse is not active work.
//
// Fix: age out items whose last activity (max of created /
// executing_at / scheduled_at / execute_at) is older than
// INFLIGHT_STRANDED_MINUTES (default 120). Recent active items still
// show; the malformed/legacy intent+source_record filter is preserved.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inflight-strand-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
// Default threshold (120 min) under test — leave INFLIGHT_STRANDED_MINUTES unset.

const DECISIONS_DIR = path.join(process.env.VAULT_PATH, "decision");
fs.mkdirSync(DECISIONS_DIR, { recursive: true });

function iso(minsAgo: number): string {
  return new Date(Date.now() - minsAgo * 60_000).toISOString();
}

function writeDecision(id: string, fm: Record<string, unknown>): void {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    lines.push(`${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`);
  }
  lines.push("---", "", `body for ${id}`, "");
  fs.writeFileSync(path.join(DECISIONS_DIR, `${id}.md`), lines.join("\n"), "utf-8");
}

// Fresh, genuinely-active executing item — must show.
writeDecision("fresh-executing", {
  type: "decision",
  created: iso(5),
  intent: "delegate",
  source_record: "matter/abc",
  source_headline: "fresh work",
  state: "executing",
  executing_at: iso(4),
});
// 3h-old dispatching corpse — stranded, must be excluded.
writeDecision("stale-dispatching", {
  type: "decision",
  created: iso(180),
  intent: "delegate",
  source_record: "matter/def",
  source_headline: "delegating celebration",
  state: "dispatching",
});
// Recently-transitioned executing whose created is old but executing_at is
// fresh — last activity is recent, so it must STILL show.
writeDecision("old-created-recent-executing", {
  type: "decision",
  created: iso(300),
  intent: "delegate",
  source_record: "matter/ghi",
  source_headline: "long-running but live",
  state: "executing",
  executing_at: iso(3),
});
// 3h-old open item — stranded, excluded.
writeDecision("stale-open", {
  type: "decision",
  created: iso(200),
  intent: "take_mine",
  source_record: "matter/jkl",
  source_headline: "stuck open",
  state: "open",
});

const { matchRoute } = await import("../src/api/server.js");
const { registerDecisionRoutes } = await import("../src/api/routes/decisions.js");
registerDecisionRoutes();

async function call(method: string, p: string): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(c: number) { status = c; return res; },
    end(j?: string) { payload = j ? JSON.parse(j) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({ req: { url: p } as any, res, params: m!.params, body: undefined, query: new URLSearchParams() });
  return { status, payload };
}

describe("GET /api/v1/decisions/in-flight — age out stranded items (B11)", () => {
  let ids: Set<string>;

  before(async () => {
    const { status, payload } = await call("GET", "/api/v1/decisions/in-flight");
    assert.equal(status, 200, `expected 200, got ${status}`);
    ids = new Set(payload.decisions.map((d: any) => d.id));
  });

  it("shows a fresh executing decision", () => {
    assert.ok(ids.has("fresh-executing"), "fresh executing must show");
  });

  it("excludes a 3h-old dispatching corpse", () => {
    assert.ok(!ids.has("stale-dispatching"), "stranded dispatching item must be dropped");
  });

  it("excludes a 3h-old open item", () => {
    assert.ok(!ids.has("stale-open"), "stranded open item must be dropped");
  });

  it("keeps an item whose created is old but last activity (executing_at) is recent", () => {
    assert.ok(
      ids.has("old-created-recent-executing"),
      "recent activity (executing_at) must keep the item in the strip",
    );
  });
});
