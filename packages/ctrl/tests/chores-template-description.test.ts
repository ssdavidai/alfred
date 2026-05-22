// B7-ctrl — template chores show a description.
//
// Template/standard chores (e.g. money-day / WeeklyMoneyDayBriefWorkflow) are
// written with an EMPTY user_facing_description, so the web renders "No
// description yet." The READ path now falls back to the matching standard-
// library template's description (by template, then workflow_class_name) on
// both GET /api/v1/chores (list) and GET /api/v1/chores/:slug (detail). A
// record with its OWN non-empty description keeps it.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chores-desc-"));
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";

const CHORE_DIR = path.join(process.env.VAULT_PATH, "chore");
fs.mkdirSync(CHORE_DIR, { recursive: true });

const { matchRoute } = await import("../src/api/server.js");
const { registerChoreRoutes } = await import("../src/api/routes/chores.js");
registerChoreRoutes();

const write = (slug: string, lines: string[]) =>
  fs.writeFileSync(path.join(CHORE_DIR, `${slug}.md`), lines.join("\n") + "\n", "utf-8");

function seed(): void {
  // Template chore with EMPTY user_facing_description — matches a standard
  // template by `template` AND workflow_class_name.
  write("weekly-money-day", [
    "---",
    "type: chore",
    "name: Money Day",
    "status: active",
    "template: weekly_money_day",
    "workflow_class_name: WeeklyMoneyDayBriefWorkflow",
    "schedule: 0 6 * * 2",
    "user_facing_description: ''",
    "---",
    "Body.",
  ]);
  // Match only by workflow_class_name (no template field, absent description).
  write("subscription-watch", [
    "---",
    "type: chore",
    "name: Subs",
    "status: active",
    "workflow_class_name: SubscriptionWatcherWorkflow",
    "schedule: 0 7 * * 5",
    "---",
    "Body.",
  ]);
  // A chore with its OWN non-empty description — must be preserved.
  write("custom-thing", [
    "---",
    "type: chore",
    "name: Custom",
    "status: active",
    "template: weekly_money_day",
    "user_facing_description: A bespoke note the principal wrote.",
    "schedule: 0 6 * * 2",
    "---",
    "Body.",
  ]);
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

describe("chores — template description fallback (B7-ctrl)", () => {
  before(() => seed());

  it("list: empty description falls back to the template; own description is kept", async () => {
    const { status, payload } = await call("GET", "/api/v1/chores");
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(payload)}`);
    const bySlug = (s: string) => (payload.chores as any[]).find((c) => c.slug === s);

    const money = bySlug("weekly-money-day");
    assert.ok(money, "money-day must be listed");
    assert.ok(/Money Day|Tuesday|net worth/i.test(money.user_facing_description),
      `money-day must show template description, got: ${JSON.stringify(money.user_facing_description)}`);

    const subs = bySlug("subscription-watch");
    assert.ok(/recurring charges|Subscription/i.test(subs.user_facing_description),
      `match by workflow_class_name; got: ${JSON.stringify(subs.user_facing_description)}`);

    const custom = bySlug("custom-thing");
    assert.equal(custom.user_facing_description, "A bespoke note the principal wrote.",
      "a record's own description must not be overridden");
  });

  it("detail: empty description falls back to the template", async () => {
    const { status, payload } = await call("GET", "/api/v1/chores/weekly-money-day");
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(payload)}`);
    const desc = String(payload.frontmatter.user_facing_description ?? "");
    assert.ok(desc.trim().length > 0 && /Money Day|Tuesday|net worth/i.test(desc),
      `detail must backfill description; got: ${JSON.stringify(desc)}`);
  });

  it("detail: a record's own description is preserved", async () => {
    const { payload } = await call("GET", "/api/v1/chores/custom-thing");
    assert.equal(payload.frontmatter.user_facing_description, "A bespoke note the principal wrote.",
      "own description must survive on detail");
  });
});
