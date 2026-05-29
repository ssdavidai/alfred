// channels_recall — /api/v1/channels/recall/* + /api/v1/webhooks/recall.
//
// What's under test
// -----------------
// The 7 outbound routes + 1 inbound webhook that ship in #113 PR2. The
// route handlers depend on:
//   * a real state.db (so the recall_config / recall_bot / recall_event
//     tables exist post-migration);
//   * a stubbed Recall.ai API (we don't reach out to recall.ai);
//   * RECALL_API_KEY / RECALL_WEBHOOK_SECRET env vars.
//
// We drive routes through matchRoute + a handleError shim — the same
// pattern as channels_paperclip.test.ts — so thrown ApiErrors come back
// as JSON envelopes rather than crashing the test runner.
//
// Coverage (≥8 cases, per PR2 task spec):
//   1. validate-key — Recall returns 200 → {ok:true}.
//   2. validate-key — Recall returns 401 → {ok:false, reason:...}.
//   3. validate-key — missing api_key body field → 400 VALIDATION_ERROR.
//   4. validate-key — invalid region → 400 VALIDATION_ERROR.
//   5. config — GET returns the seeded singleton row with defaults.
//   6. config — PATCH updates fields and persists.
//   7. config — PATCH rejects invalid enum.
//   8. config — PATCH rejects out-of-range numeric.
//   9. usage — empty DB returns 0 hours, 0 active bots.
//  10. usage — joined+left rows in this month contribute hours.
//  11. bots/active — only non-terminal bots are listed.
//  12. bots/:id DELETE — calls Recall, flips local row to leaving.
//  13. bots/:id DELETE — no RECALL_API_KEY → 503.
//  14. webhook — valid signature persists event + updates bot status.
//  15. webhook — bad signature → 401.
//  16. webhook — stale timestamp → 401 (replay window).
//  17. webhook — no RECALL_WEBHOOK_SECRET → 503.
//
// Privacy: this is a public OSS repo. No real secrets in this file.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

// ── per-suite fixture dir ────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-recall-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.DOMAIN = "test.alfred.black";
process.env.AAS_HOST = "127.0.0.1";
process.env.AAS_PORT = "3100";
delete process.env.RECALL_API_KEY;
delete process.env.RECALL_WEBHOOK_SECRET;

// ── Recall + self-loop fetch mock ────────────────────────────────────────

const originalFetch = globalThis.fetch;

interface RecallStub {
  // GET /api/v1/bot/?limit=1 (validate-key path)
  listBotsStatus: number;
  listBotsBody: unknown;
  // DELETE /api/v1/bot/:id/
  deleteBotStatus: number;
}

const recallStub: RecallStub = {
  listBotsStatus: 200,
  listBotsBody: { count: 0, results: [] },
  deleteBotStatus: 200,
};

let recallShouldThrow = false;

let invokeRoute: (
  method: string,
  p: string,
  body?: unknown,
  headers?: Record<string, string>,
  rawBodyBuf?: Buffer,
) => Promise<{ status: number; payload: any }>;

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();

  // Recall list-bots — validate-key
  if (
    method === "GET" &&
    /\/api\/v1\/bot\/\?limit=1$/.test(url) &&
    /recall\.ai/.test(url)
  ) {
    if (recallShouldThrow) throw new Error("recall unreachable");
    return makeJsonResponse(recallStub.listBotsBody, recallStub.listBotsStatus);
  }
  // Recall delete-bot — DELETE /api/v1/bot/<id>/
  if (
    method === "DELETE" &&
    /\/api\/v1\/bot\/[^/]+\/?$/.test(url) &&
    /recall\.ai/.test(url)
  ) {
    if (recallShouldThrow) throw new Error("recall unreachable");
    const status = recallStub.deleteBotStatus;
    // 204 No Content cannot carry a body per the Fetch spec.
    if (status === 204 || status === 205 || status === 304) {
      return new Response(null, { status });
    }
    return makeJsonResponse({}, status);
  }
  // Self-loop from /webhook-test → /webhooks/recall
  if (
    method === "POST" &&
    url.includes("/api/v1/webhooks/recall")
  ) {
    const headersIn = init?.headers ?? {};
    const hdrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(headersIn)) {
      hdrs[k.toLowerCase()] = String(v);
    }
    const raw =
      init?.body instanceof Buffer
        ? init.body
        : Buffer.from(String(init?.body ?? ""));
    // The webhook handler expects Buffer in body (server.ts isRawBody path).
    const result = await invokeRoute(
      "POST",
      "/api/v1/webhooks/recall",
      raw,
      hdrs,
    );
    return makeJsonResponse(result.payload, result.status);
  }
  throw new Error(`unexpected fetch in channels_recall test: ${method} ${url}`);
}) as typeof fetch;

// ── module imports (after env + fetch are set) ─────────────────────────────

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const {
  registerChannelsRecallRoutes,
  registerRecallWebhookRoute,
  _recallInternals,
} = await import("../src/api/routes/channels_recall.js");
const { getStateDb } = await import("../src/db/state.js");
registerChannelsRecallRoutes();
registerRecallWebhookRoute();

invokeRoute = async function (
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {},
  _rawBodyBuf?: Buffer,
): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(c: number) {
      status = c;
      return res;
    },
    end(j?: string) {
      payload = j ? JSON.parse(j) : undefined;
    },
  } as unknown as ServerResponse;
  try {
    await m!.handler({
      req: { method, url: p, headers } as any,
      res,
      params: m!.params,
      body,
      query: new URLSearchParams(),
    });
  } catch (err) {
    handleError(res, err);
  }
  return { status, payload };
};

// ── signing helpers ────────────────────────────────────────────────────────

const WEBHOOK_SECRET = "test-recall-secret";

function signSvix(
  rawBody: Buffer,
  opts: { secret?: string; ts?: number; id?: string } = {},
): Record<string, string> {
  const secret = opts.secret ?? WEBHOOK_SECRET;
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const id = opts.id ?? `evt-${ts}`;
  const secretBytes = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf-8");
  const signed = Buffer.concat([
    Buffer.from(`${id}.${ts}.`, "utf-8"),
    rawBody,
  ]);
  const v1 = crypto
    .createHmac("sha256", secretBytes)
    .update(signed)
    .digest("base64");
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": String(ts),
    "svix-signature": `v1,${v1}`,
  };
}

// ── DB cleanup helpers ─────────────────────────────────────────────────────

function clearDb() {
  const db = getStateDb();
  db.exec("DELETE FROM recall_event");
  db.exec("DELETE FROM recall_bot");
  db.exec("DELETE FROM recall_config");
}

function seedBot(id: string, overrides: Partial<{
  status: string;
  created_at: number;
  joined_at: number | null;
  left_at: number | null;
}> = {}) {
  const db = getStateDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO recall_bot (id, calendar_event_id, meeting_url, status, created_at, joined_at, left_at, json)
       VALUES (?, NULL, 'https://meet.example/abc', ?, ?, ?, ?, '{}')`,
  ).run(
    id,
    overrides.status ?? "requested",
    overrides.created_at ?? now,
    overrides.joined_at ?? null,
    overrides.left_at ?? null,
  );
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("/api/v1/channels/recall/* + webhook — #113 PR2", () => {
  before(() => {
    // Initialise the DB once — applies migrations including 0007_recall.
    getStateDb();
  });

  beforeEach(() => {
    clearDb();
    recallStub.listBotsStatus = 200;
    recallStub.listBotsBody = { count: 0, results: [] };
    recallStub.deleteBotStatus = 200;
    recallShouldThrow = false;
    delete process.env.RECALL_API_KEY;
    delete process.env.RECALL_WEBHOOK_SECRET;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  describe("POST /validate-key", () => {
    it("returns {ok:true} when Recall accepts the key", async () => {
      recallStub.listBotsStatus = 200;
      recallStub.listBotsBody = { count: 3, results: [] };
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/recall/validate-key",
        { api_key: "rec_test_key", region: "us-east-1" },
      );
      assert.equal(r.status, 200);
      assert.equal(r.payload.ok, true);
      assert.equal(r.payload.account.region, "us-east-1");
      assert.equal(r.payload.account.bots_known, 3);
    });

    it("returns {ok:false} with a reason when Recall returns 401", async () => {
      recallStub.listBotsStatus = 401;
      recallStub.listBotsBody = { detail: "Invalid token." };
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/recall/validate-key",
        { api_key: "wrong" },
      );
      assert.equal(r.status, 200);
      assert.equal(r.payload.ok, false);
      assert.match(String(r.payload.reason), /rejected/);
    });

    it("400 VALIDATION_ERROR when api_key is missing", async () => {
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/recall/validate-key",
        {},
      );
      assert.equal(r.status, 400);
      assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    });

    it("400 VALIDATION_ERROR when region is not in the allowlist", async () => {
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/recall/validate-key",
        { api_key: "rec_test", region: "moon-base-1" },
      );
      assert.equal(r.status, 400);
      assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    });
  });

  describe("config", () => {
    it("GET seeds the singleton row with the migration defaults", async () => {
      const r = await invokeRoute("GET", "/api/v1/channels/recall/config");
      assert.equal(r.status, 200);
      assert.equal(r.payload.region, "us-east-1");
      assert.equal(r.payload.bot_name, "Alfred's note-taker");
      assert.equal(r.payload.announces_on_join, true);
      assert.equal(r.payload.auto_join_policy, "principal_attendee");
      assert.equal(r.payload.calendar_source, "composio");
      assert.equal(r.payload.monthly_hours_cap, 60);
      assert.equal(r.payload.leave_after_minutes, 90);
      assert.equal(r.payload.respond_mode, "on_mention");
      assert.equal(r.payload.wake_word, "Alfred");
      assert.deepEqual(r.payload.cost_alert_thresholds, [80, 100]);
      assert.equal(typeof r.payload.updated_at, "number");
    });

    it("PATCH updates fields and the next GET reflects them", async () => {
      const patch = {
        bot_name: "Recall Bot",
        announces_on_join: false,
        monthly_hours_cap: 120,
        wake_word: "Jeeves",
        cost_alert_thresholds: [50, 80, 100],
      };
      const r = await invokeRoute(
        "PATCH",
        "/api/v1/channels/recall/config",
        patch,
      );
      assert.equal(r.status, 200);
      assert.equal(r.payload.bot_name, "Recall Bot");
      assert.equal(r.payload.announces_on_join, false);
      assert.equal(r.payload.monthly_hours_cap, 120);
      assert.equal(r.payload.wake_word, "Jeeves");
      assert.deepEqual(r.payload.cost_alert_thresholds, [50, 80, 100]);

      const g = await invokeRoute("GET", "/api/v1/channels/recall/config");
      assert.equal(g.payload.bot_name, "Recall Bot");
      assert.equal(g.payload.monthly_hours_cap, 120);
    });

    it("PATCH rejects an unknown auto_join_policy with 400", async () => {
      const r = await invokeRoute(
        "PATCH",
        "/api/v1/channels/recall/config",
        { auto_join_policy: "never-ever" },
      );
      assert.equal(r.status, 400);
      assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    });

    it("PATCH rejects negative monthly_hours_cap with 400", async () => {
      const r = await invokeRoute(
        "PATCH",
        "/api/v1/channels/recall/config",
        { monthly_hours_cap: -5 },
      );
      assert.equal(r.status, 400);
      assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    });

    it("PATCH with no recognised fields → 400", async () => {
      const r = await invokeRoute(
        "PATCH",
        "/api/v1/channels/recall/config",
        { junk: "yes" },
      );
      assert.equal(r.status, 400);
    });
  });

  describe("GET /usage", () => {
    it("returns zeros when no bots exist", async () => {
      const r = await invokeRoute("GET", "/api/v1/channels/recall/usage");
      assert.equal(r.status, 200);
      assert.equal(r.payload.this_month_hours, 0);
      assert.equal(r.payload.bot_count_active, 0);
      assert.equal(r.payload.monthly_hours_cap, 60);
    });

    it("sums completed bot durations from the current month", async () => {
      const now = Date.now();
      const oneHourMs = 60 * 60 * 1000;
      // A bot that ran for exactly one hour starting "now - 2h".
      seedBot("bot-completed", {
        status: "done",
        joined_at: now - 2 * oneHourMs,
        left_at: now - oneHourMs,
      });
      // An in-flight bot that joined 30 minutes ago.
      seedBot("bot-inflight", {
        status: "in_meeting",
        joined_at: now - 30 * 60 * 1000,
        left_at: null,
      });
      const r = await invokeRoute("GET", "/api/v1/channels/recall/usage");
      // Completed = 1h, in-flight = ~0.5h. Allow a small rounding window.
      assert.ok(r.payload.this_month_hours >= 1.4 && r.payload.this_month_hours <= 1.6);
      assert.equal(r.payload.bot_count_active, 1);
    });
  });

  describe("GET /bots/active", () => {
    it("lists only non-terminal bots, newest first", async () => {
      seedBot("bot-1", { status: "in_meeting", created_at: 1000 });
      seedBot("bot-2", { status: "done", created_at: 2000 });
      seedBot("bot-3", { status: "requested", created_at: 3000 });
      seedBot("bot-4", { status: "fail", created_at: 4000 });
      const r = await invokeRoute(
        "GET",
        "/api/v1/channels/recall/bots/active",
      );
      assert.equal(r.status, 200);
      const ids = r.payload.bots.map((b: any) => b.id);
      assert.deepEqual(ids, ["bot-3", "bot-1"]);
    });
  });

  describe("DELETE /bots/:bot_id", () => {
    it("503 NOT_CONFIGURED when RECALL_API_KEY is unset", async () => {
      seedBot("bot-x", { status: "in_meeting" });
      const r = await invokeRoute(
        "DELETE",
        "/api/v1/channels/recall/bots/bot-x",
      );
      assert.equal(r.status, 503);
      assert.equal(r.payload.error.code, "NOT_CONFIGURED");
    });

    it("calls Recall and flips the local row to leaving on 2xx", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      seedBot("bot-x", { status: "in_meeting" });
      recallStub.deleteBotStatus = 204;
      const r = await invokeRoute(
        "DELETE",
        "/api/v1/channels/recall/bots/bot-x",
      );
      assert.equal(r.status, 200);
      assert.equal(r.payload.status, "leaving");
      // Local row updated to leaving + left_at populated.
      const db = getStateDb();
      const row = db
        .prepare("SELECT status, left_at FROM recall_bot WHERE id = ?")
        .get("bot-x") as { status: string; left_at: number | null };
      assert.equal(row.status, "leaving");
      assert.ok(row.left_at && row.left_at > 0);
    });

    it("on Recall 404 marks the local row done (it's already gone upstream)", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      seedBot("bot-gone", { status: "in_meeting" });
      recallStub.deleteBotStatus = 404;
      const r = await invokeRoute(
        "DELETE",
        "/api/v1/channels/recall/bots/bot-gone",
      );
      assert.equal(r.status, 200);
      assert.equal(r.payload.status, "done");
    });
  });

  describe("POST /api/v1/webhooks/recall — Svix signed", () => {
    it("503 NOT_CONFIGURED when RECALL_WEBHOOK_SECRET is unset", async () => {
      const raw = Buffer.from(JSON.stringify({ event: "bot.joined" }));
      const r = await invokeRoute(
        "POST",
        "/api/v1/webhooks/recall",
        raw,
        { "content-type": "application/json" },
      );
      assert.equal(r.status, 503);
      assert.equal(r.payload.error.code, "NOT_CONFIGURED");
    });

    it("401 AUTH_FAILED when no svix headers are present", async () => {
      process.env.RECALL_WEBHOOK_SECRET = WEBHOOK_SECRET;
      const raw = Buffer.from(JSON.stringify({ event: "bot.joined" }));
      const r = await invokeRoute(
        "POST",
        "/api/v1/webhooks/recall",
        raw,
        { "content-type": "application/json" },
      );
      assert.equal(r.status, 401);
      assert.equal(r.payload.error.code, "AUTH_FAILED");
    });

    it("401 AUTH_FAILED when the HMAC does not validate", async () => {
      process.env.RECALL_WEBHOOK_SECRET = WEBHOOK_SECRET;
      const raw = Buffer.from(JSON.stringify({ event: "bot.joined" }));
      const headers = signSvix(raw, { secret: "wrong-secret" });
      const r = await invokeRoute(
        "POST",
        "/api/v1/webhooks/recall",
        raw,
        headers,
      );
      assert.equal(r.status, 401);
    });

    it("401 AUTH_FAILED when svix-timestamp is outside the ±5min window", async () => {
      process.env.RECALL_WEBHOOK_SECRET = WEBHOOK_SECRET;
      const raw = Buffer.from(JSON.stringify({ event: "bot.joined" }));
      const stale = Math.floor(Date.now() / 1000) - 3600; // 1h old
      const headers = signSvix(raw, { ts: stale });
      const r = await invokeRoute(
        "POST",
        "/api/v1/webhooks/recall",
        raw,
        headers,
      );
      assert.equal(r.status, 401);
      assert.match(String(r.payload.error.message), /replay/);
    });

    it("on valid signature, persists the event and updates the bot status", async () => {
      process.env.RECALL_WEBHOOK_SECRET = WEBHOOK_SECRET;
      seedBot("bot-live", { status: "joining" });

      const payload = {
        event: "bot.in_call_recording",
        data: { bot: { id: "bot-live" } },
      };
      const raw = Buffer.from(JSON.stringify(payload));
      const headers = signSvix(raw);
      const r = await invokeRoute(
        "POST",
        "/api/v1/webhooks/recall",
        raw,
        headers,
      );
      assert.equal(r.status, 200);
      assert.equal(r.payload.ok, true);
      assert.equal(r.payload.new_status, "in_meeting");
      // Event row + bot row reflect the update.
      const db = getStateDb();
      const eventCount = db
        .prepare("SELECT COUNT(*) AS n FROM recall_event WHERE bot_id = ?")
        .get("bot-live") as { n: number };
      assert.equal(eventCount.n, 1);
      const botRow = db
        .prepare("SELECT status, joined_at FROM recall_bot WHERE id = ?")
        .get("bot-live") as { status: string; joined_at: number | null };
      assert.equal(botRow.status, "in_meeting");
      assert.ok(botRow.joined_at && botRow.joined_at > 0);
    });

    it("verifySvixSignature internals — round-trip golden vector", () => {
      const raw = Buffer.from('{"event":"bot.joined"}', "utf-8");
      const ts = Math.floor(Date.now() / 1000);
      const id = "evt-golden";
      const headers = signSvix(raw, { ts, id });
      const result = _recallInternals.verifySvixSignature(
        raw,
        headers,
        WEBHOOK_SECRET,
      );
      assert.equal(result.ok, true);
    });

    it("does not regress a bot already in a terminal state", async () => {
      process.env.RECALL_WEBHOOK_SECRET = WEBHOOK_SECRET;
      seedBot("bot-done", { status: "done", joined_at: 1000, left_at: 2000 });
      const payload = {
        event: "bot.joining_call",
        data: { bot: { id: "bot-done" } },
      };
      const raw = Buffer.from(JSON.stringify(payload));
      const headers = signSvix(raw);
      await invokeRoute(
        "POST",
        "/api/v1/webhooks/recall",
        raw,
        headers,
      );
      const db = getStateDb();
      const row = db
        .prepare("SELECT status FROM recall_bot WHERE id = ?")
        .get("bot-done") as { status: string };
      // Still done — terminal states are sticky.
      assert.equal(row.status, "done");
    });
  });
});
