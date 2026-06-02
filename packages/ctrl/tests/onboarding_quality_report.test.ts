import { mock, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Same fs/child_process mock prelude as tests/onboarding_quality_gate.test.ts
// (the report endpoint pulls in the full ctrl-api route surface).

let execFileStdout = '{"ok":true}';
const execFileFn = mock.fn((...args: any[]) => {
  const cb = args[args.length - 1] as Function;
  cb(null, execFileStdout, "");
});

mock.module("node:child_process", {
  namedExports: {
    execFile: execFileFn,
    // execFileSync needed by src/api/routes/system.ts (ssh-keygen, unused here).
    execFileSync: mock.fn(() => ""),
    spawn: mock.fn(() => ({ stderr: { on: mock.fn() }, stdin: { write: mock.fn(), end: mock.fn() }, on: mock.fn() })),
  },
});

const mkdirFn = mock.fn(async () => undefined);
const writeFileFn = mock.fn(async () => undefined);
const readFileSyncFn = mock.fn((_p: string) => "");
const writeFileSyncFn = mock.fn(() => {});
const readdirSyncFn = mock.fn(() => [] as any[]);
const mkdirSyncFn = mock.fn();
const existsSyncFn = mock.fn(() => false);
const statSyncFn = mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false }));
const unlinkSyncFn = mock.fn();
const renameSyncFn = mock.fn();
const appendFileSyncFn = mock.fn();
const openSyncFn = mock.fn(() => 0);
const readSyncFn = mock.fn(() => 0);
const closeSyncFn = mock.fn();
const createReadStreamFn = mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() }));

const fsMock = {
  readFileSync: readFileSyncFn, writeFileSync: writeFileSyncFn,
  readdirSync: readdirSyncFn, mkdirSync: mkdirSyncFn, existsSync: existsSyncFn,
  statSync: statSyncFn, unlinkSync: unlinkSyncFn, renameSync: renameSyncFn,
  appendFileSync: appendFileSyncFn, openSync: openSyncFn, readSync: readSyncFn,
  closeSync: closeSyncFn, createReadStream: createReadStreamFn,
  Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: mkdirFn, writeFile: writeFileFn },
};

mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: {
    readFileSync: readFileSyncFn, writeFileSync: writeFileSyncFn,
    readdirSync: readdirSyncFn, mkdirSync: mkdirSyncFn, existsSync: existsSyncFn,
    statSync: statSyncFn, unlinkSync: unlinkSyncFn, renameSync: renameSyncFn,
    appendFileSync: appendFileSyncFn, openSync: openSyncFn, readSync: readSyncFn,
    closeSync: closeSyncFn, createReadStream: createReadStreamFn,
    Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  },
});

const { createApiServer } = await import("../src/api/server.js");
const { _resetQualityGateCacheForTest } = await import(
  "../src/api/middleware/onboarding_quality_gate.js"
);

let server: http.Server;
before(async () => {
  server = createApiServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function req(
  method: string, path: string, body?: unknown, headers: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1", port: addr.port, path, method,
        headers: {
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c: Buffer) => { raw += c.toString(); });
        res.on("end", () => {
          try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode!, data: raw }); }
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Contract C-OB1: GET /api/v1/onboarding/quality-report — summarises the
// last 24h of onboarding-pipeline vault writes. accepted = running total;
// rejected_by_kind + rejections come from the in-memory ring buffer the
// promotion gate (commit 1) populates on every 422 QUALITY_REJECTED.
// ---------------------------------------------------------------------------

describe("GET /api/v1/onboarding/quality-report", () => {
  it("returns the rolling accepted/rejected counts after 3 accepts + 2 rejects", async () => {
    _resetQualityGateCacheForTest();
    readFileSyncFn.mock.mockImplementation((_p: string) => "");

    // 3 accepts — substantive matter / well-named person / valid org in USER.md
    const longBody = "Real principal matter with enough body. ".repeat(20);
    const acceptA = await req("POST", "/api/v1/vault/records", {
      type: "matter", name: "Kondorosi Renovation",
      content: `---\ntype: matter\ncreated_by: onboarding_pipeline\n---\n${longBody}`,
    });
    assert.strictEqual(acceptA.status, 201);
    const acceptB = await req("POST", "/api/v1/vault/records", {
      type: "person", name: "Jane Doe",
      content: "---\ntype: person\ncreated_by: onboarding_pipeline\n---\nReal contact",
    });
    assert.strictEqual(acceptB.status, 201);
    const acceptC = await req("POST", "/api/v1/vault/records", {
      type: "note", name: "Trip notes 2026-05",
      content: "---\ntype: note\ncreated_by: onboarding_pipeline\n---\nTrip notes",
    });
    assert.strictEqual(acceptC.status, 201);

    // 2 rejects — non-human person + per-service note
    const rejA = await req("POST", "/api/v1/vault/records", {
      type: "person", name: "Github Notifications",
      content: "---\ntype: person\ncreated_by: onboarding_pipeline\n---\nAuto",
    });
    assert.strictEqual(rejA.status, 422);
    const rejB = await req("POST", "/api/v1/vault/records", {
      type: "note", name: "GitHub Service & Notification Summary",
      content: "---\ntype: note\ncreated_by: alfred_vault_curator\n---\n",
    });
    assert.strictEqual(rejB.status, 422);

    const { status, data } = await req("GET", "/api/v1/onboarding/quality-report");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.accepted, 3, "accepted should be 3");
    assert.strictEqual(data.rejected_by_kind.person, 1, "1 person rejection");
    assert.strictEqual(data.rejected_by_kind.note, 1, "1 note rejection");
    assert.strictEqual(data.rejections.length, 2, "2 rejection rows");
    for (const r of data.rejections) {
      assert.ok(typeof r.record_kind === "string");
      assert.ok(typeof r.name === "string");
      assert.ok(typeof r.reason === "string");
      assert.ok(typeof r.suggestion === "string");
      assert.ok(typeof r.timestamp === "string");
    }
    assert.ok(typeof data.since === "string");
  });
});
