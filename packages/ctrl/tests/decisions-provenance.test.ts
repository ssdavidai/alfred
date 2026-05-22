// C-B5 — decision / needs-attention provenance.
//
// The provenance data (source signal, matched instinct, matter/task linkage)
// already lives on the needs_attention frontmatter and on the decision schema,
// but it was dropped at two API points:
//
//   1. GET /api/v1/admin/needs-attention dropped `source_signal_path`,
//      `matched_instinct`, `matter_ref`, `task_ref` (only `target_path` /
//      `target_kind` survived). The Desk card could never show the source
//      signal or the matter/task a card belongs to.
//   2. POST /api/v1/decisions never carried `task_ref` from the source NA
//      record (only `matter_ref` survived, and only for target_kind=matter).
//
// This proves the GET now surfaces all four provenance fields, and that a
// POST defaulting its task linkage off the NA `target_path` (target_kind=task)
// persists `task_ref` onto the decision record.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dec-prov-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const VAULT = process.env.VAULT_PATH;
fs.mkdirSync(path.join(VAULT, "needs_attention"), { recursive: true });

const { getStateDb } = await import("../src/db/state.js");
const { registerDecisionRoutes } = await import("../src/api/routes/decisions.js");
const { registerAttentionRoutes } = await import("../src/api/routes/attention.js");
const { attentionCache } = await import("../src/api/vaultCache.js");
const { matchRoute } = await import("../src/api/server.js");

registerDecisionRoutes();
registerAttentionRoutes();

function writeNa(id: string, fm: Record<string, string>): void {
  const lines = ["---", 'type: "needs_attention"', "status: pending"];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: "${v}"`);
  lines.push("---", "", "body", "");
  fs.writeFileSync(path.join(VAULT, "needs_attention", `${id}.md`), lines.join("\n"), "utf-8");
  // The list endpoint has a 2s TTL cache keyed by include:limit; bust it so a
  // GET right after the write reflects the freshly-written record.
  attentionCache.invalidate();
}

async function call(
  method: string,
  pathname: string,
  body?: unknown,
  qs = "",
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
    req: { url: `${pathname}${qs}` } as any,
    res,
    params: m!.params,
    body,
    query: new URLSearchParams(qs.replace(/^\?/, "")),
  });
  return { status, payload };
}

describe("C-B5 — provenance exposed on the needs-attention list", () => {
  before(() => {
    getStateDb();
  });

  it("surfaces source_signal_path / matched_instinct / matter_ref / task_ref", async () => {
    writeNa("prov-card", {
      display_headline: "Renew Plex Pass",
      source_signal_path: "01KS2ZJ3SKBRCMHP97N9DH8PS4",
      matched_instinct: "instinct/renew-subscriptions.md",
      target_path: "task/renew-plex.md",
      target_kind: "task",
      matter_ref: "matter/household.md",
      task_ref: "task/renew-plex.md",
    });
    const { status, payload } = await call("GET", "/api/v1/admin/needs-attention");
    assert.equal(status, 200);
    const card = payload.records.find((r: any) => r.id === "prov-card");
    assert.ok(card, "the NA record must be listed");
    assert.equal(card.source_signal_path, "01KS2ZJ3SKBRCMHP97N9DH8PS4");
    assert.equal(card.matched_instinct, "instinct/renew-subscriptions.md");
    assert.equal(card.matter_ref, "matter/household.md");
    assert.equal(card.task_ref, "task/renew-plex.md");
    // Pre-existing fields must still be present.
    assert.equal(card.target_path, "task/renew-plex.md");
    assert.equal(card.target_kind, "task");
  });

  it("degrades to null for cards with no provenance", async () => {
    writeNa("bare-card", { display_headline: "Open-ended nudge" });
    const { payload } = await call("GET", "/api/v1/admin/needs-attention");
    const card = payload.records.find((r: any) => r.id === "bare-card");
    assert.ok(card);
    assert.equal(card.source_signal_path, null);
    assert.equal(card.matched_instinct, null);
    assert.equal(card.matter_ref, null);
    assert.equal(card.task_ref, null);
  });
});

describe("C-B5 — POST /api/v1/decisions persists task_ref", () => {
  before(() => {
    getStateDb();
  });

  it("persists an explicit task_ref onto the decision record", async () => {
    const { status, payload } = await call("POST", "/api/v1/decisions", {
      source: "judgment",
      source_record: "judgment/x.md",
      intent: "done",
      task_ref: "task/explicit.md",
      matter_ref: "matter/explicit.md",
    });
    assert.equal(status, 201, `must 201, got ${status}: ${JSON.stringify(payload)}`);
    assert.equal(payload.frontmatter.task_ref, "task/explicit.md");
    assert.equal(payload.frontmatter.matter_ref, "matter/explicit.md");
  });

  it("backfills task_ref from the source NA target_path when target_kind=task", async () => {
    writeNa("task-card", {
      display_headline: "Do the task",
      target_path: "task/from-na.md",
      target_kind: "task",
    });
    const { status, payload } = await call("POST", "/api/v1/decisions", {
      source: "needs_attention",
      source_record: "needs_attention/task-card.md",
      intent: "done",
    });
    assert.equal(status, 201, `must 201, got ${status}: ${JSON.stringify(payload)}`);
    assert.equal(
      payload.frontmatter.task_ref,
      "task/from-na.md",
      "task linkage must be copied from the NA target_path",
    );
  });
});
