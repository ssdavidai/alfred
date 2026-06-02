// channels_recall_dispatch — POST /bots + POST /bots/:id/leave + webhook
// state flip + GET /bots/active (#113 PR4).
//
// This file ships the ctrl-api half of the PR4 task spec. The Recall.ai
// API is stubbed at the global fetch boundary the same way as
// channels_recall.test.ts — we never reach out to recall.ai. The
// state.db migration 0007_recall has already created the recall_*
// tables by the time `getStateDb()` returns.
//
// Cases (per PR4 spec):
//   1. POST /bots with valid Zoom URL → 200 + bot_id + recall_bot row inserted
//   2. POST /bots with valid Meet URL → 200 + row inserted
//   3. POST /bots with valid Teams URL → 200 + row inserted
//   4. POST /bots with invalid URL → 400 VALIDATION_ERROR
//   5. POST /bots without RECALL_API_KEY → 503 NOT_CONFIGURED
//   6. POST /bots Recall returns 401 → 503 (NOT_CONFIGURED on auth failures)
//   7. POST /bots Recall returns 422 → 502 RECALL_REJECTED
//   8. POST /bots is idempotent on calendar_event_id (no second Recall call)
//   9. POST /bots respects bot_name override (sent to Recall in body)
//  10. POST /bots/:id/leave flips local row to "leaving"
//  11. POST /bots/:id/leave with 404 from Recall marks row "done"
//  12. POST /bots/:id/leave without API key → 503
//  13. Webhook bot.in_call_recording flips status to in_meeting
//  14. Webhook bot.done flips status to done + stamps left_at
//  15. GET /bots/active returns inserted bot

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

// ── fixture dir ───────────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-recall-dispatch-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.DOMAIN = "test.alfred.black";
process.env.AAS_HOST = "127.0.0.1";
process.env.AAS_PORT = "3100";
delete process.env.RECALL_API_KEY;
delete process.env.RECALL_WEBHOOK_SECRET;

// ── Recall stub ───────────────────────────────────────────────────────────

interface RecallStub {
  createBotStatus: number;
  createBotBody: unknown;
  // capture the last create-bot request so tests can assert the body
  lastCreateBody: unknown | null;
  // for the leave/delete path
  deleteBotStatus: number;
}

const originalFetch = globalThis.fetch;

const recallStub: RecallStub = {
  createBotStatus: 200,
  createBotBody: { id: "bot-default", recording_url: "https://recall.example/bot-default" },
  lastCreateBody: null,
  deleteBotStatus: 200,
};

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();

  // Recall POST /api/v2/bot — create-bot
  if (
    method === "POST" &&
    /\/api\/v2\/bot$/.test(url) &&
    /recall\.ai/.test(url)
  ) {
    try {
      recallStub.lastCreateBody = init?.body
        ? JSON.parse(String(init.body))
        : null;
    } catch {
      recallStub.lastCreateBody = init?.body;
    }
    return makeJsonResponse(recallStub.createBotBody, recallStub.createBotStatus);
  }
  // Recall DELETE /api/v1/bot/:id/ — leave path
  if (
    method === "DELETE" &&
    /\/api\/v1\/bot\/[^/]+\/?$/.test(url) &&
    /recall\.ai/.test(url)
  ) {
    const status = recallStub.deleteBotStatus;
    if (status === 204) return new Response(null, { status });
    return makeJsonResponse({}, status);
  }
  throw new Error(`unexpected fetch in dispatch test: ${method} ${url}`);
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

async function invokeRoute(
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {},
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
}

// ── DB helpers ─────────────────────────────────────────────────────────────

function clearDb() {
  const db = getStateDb();
  db.exec("DELETE FROM recall_event");
  db.exec("DELETE FROM recall_bot");
  db.exec("DELETE FROM recall_config");
}

function getBotRow(id: string) {
  const db = getStateDb();
  return db.prepare(`SELECT * FROM recall_bot WHERE id = ?`).get(id) as
    | Record<string, any>
    | undefined;
}

// ── webhook signing ───────────────────────────────────────────────────────

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

// ── tests ─────────────────────────────────────────────────────────────────

describe("/api/v1/channels/recall — dispatcher routes (#113 PR4)", () => {
  before(() => {
    getStateDb();
  });

  beforeEach(() => {
    clearDb();
    recallStub.createBotStatus = 200;
    recallStub.createBotBody = {
      id: "bot-default",
      recording_url: "https://recall.example/bot-default",
    };
    recallStub.lastCreateBody = null;
    recallStub.deleteBotStatus = 200;
    delete process.env.RECALL_API_KEY;
    delete process.env.RECALL_WEBHOOK_SECRET;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  describe("classifyMeetingUrl (pure)", () => {
    it("recognises a zoom.us URL", () => {
      const r = _recallInternals.classifyMeetingUrl("https://zoom.us/j/123");
      assert.equal(r?.platform, "zoom");
    });
    it("recognises a subdomain zoom URL", () => {
      const r = _recallInternals.classifyMeetingUrl(
        "https://acme.zoom.us/j/123?pwd=x",
      );
      assert.equal(r?.platform, "zoom");
    });
    it("recognises a meet.google.com URL", () => {
      const r = _recallInternals.classifyMeetingUrl("https://meet.google.com/abc-defg-hij");
      assert.equal(r?.platform, "meet");
    });
    it("recognises a teams.microsoft.com URL", () => {
      const r = _recallInternals.classifyMeetingUrl(
        "https://teams.microsoft.com/l/meetup-join/abc",
      );
      assert.equal(r?.platform, "teams");
    });
    it("rejects a random URL", () => {
      assert.equal(
        _recallInternals.classifyMeetingUrl("https://example.com/foo"),
        null,
      );
    });
    it("rejects a non-URL", () => {
      assert.equal(_recallInternals.classifyMeetingUrl("not a url"), null);
    });
  });

  describe("POST /api/v1/channels/recall/bots", () => {
    it("creates a bot with a valid Zoom URL → 200 + recall_bot row", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      recallStub.createBotBody = {
        id: "bot-abc-001",
        recording_url: "https://recall.example/bot-abc-001",
      };
      const r = await invokeRoute("POST", "/api/v1/channels/recall/bots", {
        meeting_url: "https://zoom.us/j/123456",
      });
      assert.equal(r.status, 200);
      assert.equal(r.payload.bot_id, "bot-abc-001");
      assert.equal(r.payload.status, "requested");
      assert.equal(r.payload.recall_url, "https://recall.example/bot-abc-001");
      const row = getBotRow("bot-abc-001");
      assert.ok(row, "recall_bot row must be inserted");
      assert.equal(row!.status, "requested");
      assert.equal(row!.meeting_url, "https://zoom.us/j/123456");
    });

    it("accepts a Meet URL", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      recallStub.createBotBody = { id: "bot-meet-1" };
      const r = await invokeRoute("POST", "/api/v1/channels/recall/bots", {
        meeting_url: "https://meet.google.com/abc-defg-hij",
      });
      assert.equal(r.status, 200);
      assert.equal(r.payload.bot_id, "bot-meet-1");
    });

    it("accepts a Teams URL", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      recallStub.createBotBody = { id: "bot-teams-1" };
      const r = await invokeRoute("POST", "/api/v1/channels/recall/bots", {
        meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
      });
      assert.equal(r.status, 200);
      assert.equal(r.payload.bot_id, "bot-teams-1");
    });

    it("400 VALIDATION_ERROR on an unknown meeting URL", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      const r = await invokeRoute("POST", "/api/v1/channels/recall/bots", {
        meeting_url: "https://example.com/foo",
      });
      assert.equal(r.status, 400);
      assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    });

    it("400 VALIDATION_ERROR when meeting_url is missing", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      const r = await invokeRoute("POST", "/api/v1/channels/recall/bots", {});
      assert.equal(r.status, 400);
      assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    });

    it("503 NOT_CONFIGURED when RECALL_API_KEY is absent", async () => {
      const r = await invokeRoute("POST", "/api/v1/channels/recall/bots", {
        meeting_url: "https://zoom.us/j/1",
      });
      assert.equal(r.status, 503);
      assert.equal(r.payload.error.code, "NOT_CONFIGURED");
    });

    it("Recall 401 surfaces as 503 NOT_CONFIGURED", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      recallStub.createBotStatus = 401;
      recallStub.createBotBody = { detail: "Invalid token." };
      const r = await invokeRoute("POST", "/api/v1/channels/recall/bots", {
        meeting_url: "https://zoom.us/j/1",
      });
      assert.equal(r.status, 503);
      assert.equal(r.payload.error.code, "NOT_CONFIGURED");
    });

    it("Recall 422 surfaces as 502 RECALL_REJECTED", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      recallStub.createBotStatus = 422;
      recallStub.createBotBody = { detail: "Unsupported meeting URL" };
      const r = await invokeRoute("POST", "/api/v1/channels/recall/bots", {
        meeting_url: "https://zoom.us/j/1",
      });
      assert.equal(r.status, 502);
      assert.equal(r.payload.error.code, "RECALL_REJECTED");
    });

    it("idempotent on calendar_event_id — second POST returns existing row", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      recallStub.createBotBody = { id: "bot-cal-1" };
      const a = await invokeRoute("POST", "/api/v1/channels/recall/bots", {
        meeting_url: "https://zoom.us/j/1",
        calendar_event_id: "gcal-evt-42",
      });
      assert.equal(a.status, 200);
      assert.equal(a.payload.bot_id, "bot-cal-1");

      // Second call would *try* to create bot-cal-2 if not for dedupe.
      recallStub.createBotBody = { id: "bot-cal-2" };
      recallStub.lastCreateBody = null;
      const b = await invokeRoute("POST", "/api/v1/channels/recall/bots", {
        meeting_url: "https://zoom.us/j/1",
        calendar_event_id: "gcal-evt-42",
      });
      assert.equal(b.status, 200);
      assert.equal(b.payload.bot_id, "bot-cal-1", "must return existing bot");
      assert.equal(
        recallStub.lastCreateBody,
        null,
        "must NOT have re-called Recall create-bot",
      );
    });

    it("respects bot_name override (sent verbatim to Recall)", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      recallStub.createBotBody = { id: "bot-name-1" };
      await invokeRoute("POST", "/api/v1/channels/recall/bots", {
        meeting_url: "https://zoom.us/j/2",
        bot_name: "Cratchit",
      });
      const body = recallStub.lastCreateBody as Record<string, any>;
      assert.equal(body?.bot_name, "Cratchit");
      assert.equal(body?.meeting_url, "https://zoom.us/j/2");
    });

    it("400 VALIDATION_ERROR on a malformed scheduled_join_time", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      const r = await invokeRoute("POST", "/api/v1/channels/recall/bots", {
        meeting_url: "https://zoom.us/j/1",
        scheduled_join_time: "not a date",
      });
      assert.equal(r.status, 400);
      assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    });
  });

  describe("POST /api/v1/channels/recall/bots/:bot_id/leave", () => {
    it("flips an in-flight row to 'leaving'", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      const db = getStateDb();
      db.prepare(
        `INSERT INTO recall_bot (id, status, created_at, json) VALUES (?, 'in_meeting', ?, '{}')`,
      ).run("bot-leave-1", Date.now());
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/recall/bots/bot-leave-1/leave",
      );
      assert.equal(r.status, 200);
      assert.equal(r.payload.status, "leaving");
      const row = getBotRow("bot-leave-1");
      assert.equal(row!.status, "leaving");
      assert.ok(row!.left_at);
    });

    it("404 from Recall marks the local row 'done'", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      const db = getStateDb();
      db.prepare(
        `INSERT INTO recall_bot (id, status, created_at, json) VALUES (?, 'in_meeting', ?, '{}')`,
      ).run("bot-leave-404", Date.now());
      recallStub.deleteBotStatus = 404;
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/recall/bots/bot-leave-404/leave",
      );
      assert.equal(r.status, 200);
      assert.equal(r.payload.status, "done");
      const row = getBotRow("bot-leave-404");
      assert.equal(row!.status, "done");
    });

    it("503 NOT_CONFIGURED without RECALL_API_KEY", async () => {
      const r = await invokeRoute(
        "POST",
        "/api/v1/channels/recall/bots/anything/leave",
      );
      assert.equal(r.status, 503);
      assert.equal(r.payload.error.code, "NOT_CONFIGURED");
    });
  });

  describe("webhook event flips status", () => {
    it("bot.in_call_recording → in_meeting + stamps joined_at", async () => {
      process.env.RECALL_WEBHOOK_SECRET = WEBHOOK_SECRET;
      const db = getStateDb();
      db.prepare(
        `INSERT INTO recall_bot (id, status, created_at, json) VALUES (?, 'requested', ?, '{}')`,
      ).run("bot-wh-1", Date.now());

      const payload = { event: "bot.in_call_recording", data: { bot_id: "bot-wh-1" } };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const headers = signSvix(rawBody);
      const r = await invokeRoute(
        "POST",
        "/api/v1/webhooks/recall",
        rawBody,
        headers,
      );
      assert.equal(r.status, 200);
      assert.equal(r.payload.ok, true);
      assert.equal(r.payload.new_status, "in_meeting");
      const row = getBotRow("bot-wh-1");
      assert.equal(row!.status, "in_meeting");
      assert.ok(row!.joined_at);
    });

    it("bot.done → done + stamps left_at", async () => {
      process.env.RECALL_WEBHOOK_SECRET = WEBHOOK_SECRET;
      const db = getStateDb();
      const t0 = Date.now() - 1000;
      db.prepare(
        `INSERT INTO recall_bot (id, status, created_at, joined_at, json) VALUES (?, 'in_meeting', ?, ?, '{}')`,
      ).run("bot-wh-2", t0, t0);

      const payload = { event: "bot.done", data: { bot: { id: "bot-wh-2" } } };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const headers = signSvix(rawBody);
      const r = await invokeRoute(
        "POST",
        "/api/v1/webhooks/recall",
        rawBody,
        headers,
      );
      assert.equal(r.status, 200);
      assert.equal(r.payload.new_status, "done");
      const row = getBotRow("bot-wh-2");
      assert.equal(row!.status, "done");
      assert.ok(row!.left_at);
    });
  });

  describe("GET /api/v1/channels/recall/bots/active", () => {
    it("returns the inserted bot when status is non-terminal", async () => {
      process.env.RECALL_API_KEY = "rec_test_key";
      recallStub.createBotBody = { id: "bot-active-1" };
      await invokeRoute("POST", "/api/v1/channels/recall/bots", {
        meeting_url: "https://zoom.us/j/777",
        calendar_event_id: "gcal-active",
      });
      const r = await invokeRoute(
        "GET",
        "/api/v1/channels/recall/bots/active",
      );
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.payload.bots));
      assert.equal(r.payload.bots.length, 1);
      assert.equal(r.payload.bots[0].id, "bot-active-1");
      assert.equal(r.payload.bots[0].calendar_event_id, "gcal-active");
    });
  });
});
