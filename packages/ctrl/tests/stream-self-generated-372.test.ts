// #372 — the alfred-channel-delivery skill mandates that the agent POST an
// audit record to /api/v1/streams/ingest after every outbound Slack /
// Telegram / email / voice delivery, so a fresh session can answer "what did
// you just send me?" (the fix for the real amnesia incident where Alfred
// sent a Slack DM and denied it eight minutes later).
//
// Those records were ALSO mirrored into ingest.db — the feed
// SignalExtractWorkflow consumes. The extractor has no `source_type` for
// Alfred's own outbound traffic, so every one burned 5 retries and
// dead-lettered: live on home, 100% (3/3) of `outbound-deliveries` events
// were dead-lettered vs 100% success on every real inbound stream.
//
// The fix is at the mirror, not the skill: the JSONL side (which backs the
// memory read at /api/v1/streams/:id/events) must still receive the event,
// while Store 4 must not.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "streams-selfgen-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

const { matchRoute } = await import("../src/api/server.js");
const { registerStreamRoutes, isSelfGeneratedStreamEvent } = await import(
  "../src/api/routes/streams.js"
);
const { getIngestDb } = await import("../src/db/ingest.js");

registerStreamRoutes();

function mockRes(): { res: ServerResponse; captured: { status: number; body: any } } {
  const captured = { status: 0, body: undefined as any };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(payload?: string) {
      if (payload) {
        try {
          captured.body = JSON.parse(payload);
        } catch {
          captured.body = payload;
        }
      }
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function ingest(body: Record<string, unknown>): Promise<number> {
  const matched = matchRoute("POST", "/api/v1/streams/ingest");
  assert.ok(matched, "POST /api/v1/streams/ingest must be registered");
  const { res, captured } = mockRes();
  await matched!.handler({
    req: {} as any,
    res,
    params: {},
    body,
    query: new URLSearchParams(),
  });
  return captured.status;
}

function ingestRowCount(stream: string): number {
  const row = getIngestDb()
    .prepare("SELECT COUNT(*) AS n FROM stream_event WHERE stream = ?")
    .get(stream) as { n: number };
  return row?.n ?? 0;
}

describe("self-generated outbound deliveries stay out of the signal feed (#372)", () => {
  it("does NOT mirror an outbound-delivery into ingest.db", async () => {
    await ingest({
      stream_id: "outbound-deliveries",
      stream_type: "outbound-delivery",
      source_ref: "slack:D0123:1754000000000",
      summary: "slack to Sir: the weekly report is ready",
      raw: { channel: "slack", to: "D0123", direction: "outbound" },
    });
    assert.equal(
      ingestRowCount("outbound-deliveries"),
      0,
      "outbound-delivery must not reach Store 4 (it dead-letters there)",
    );
  });

  it("still appends the event to the JSONL memory read path", () => {
    // The whole reason the skill writes these: a fresh session reads them
    // back through /api/v1/streams/:id/events, which is JSONL-backed.
    const jsonl = path.join(tmp, "streams", "outbound-deliveries.jsonl");
    const found = fs.existsSync(jsonl)
      ? fs.readFileSync(jsonl, "utf8")
      : fs
          .readdirSync(tmp, { recursive: true } as any)
          .filter((f: any) => String(f).includes("outbound-deliveries"))
          .map((f: any) => fs.readFileSync(path.join(tmp, String(f)), "utf8"))
          .join("");
    assert.match(found, /the weekly report is ready/);
  });

  it("DOES mirror a real inbound stream event", async () => {
    await ingest({
      stream_id: "email",
      stream_type: "email",
      source_ref: "msg-inbound-1",
      raw: { body: "an actual inbound email" },
    });
    assert.equal(ingestRowCount("email"), 1, "inbound email must still mirror");
  });
});

describe("isSelfGeneratedStreamEvent classification (#372)", () => {
  it("treats outbound-delivery and any outbound-* as self-generated", () => {
    assert.equal(isSelfGeneratedStreamEvent("outbound-delivery"), true);
    assert.equal(isSelfGeneratedStreamEvent("outbound-sms"), true);
    assert.equal(isSelfGeneratedStreamEvent("  Outbound-Delivery "), true);
  });

  it("leaves every real inbound stream type alone", () => {
    for (const t of ["email", "gmail", "slack", "webhook", "media", "system"]) {
      assert.equal(isSelfGeneratedStreamEvent(t), false, t);
    }
    assert.equal(isSelfGeneratedStreamEvent(undefined), false);
  });
});
