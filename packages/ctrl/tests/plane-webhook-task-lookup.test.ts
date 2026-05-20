import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Regression for FAILURE-MODES Part 4 (Sure/Plane bug #2):
//
// The Plane → Steward webhook looks up a mirror vault task by scanning the
// vault's task/ dir. On the merged single-VM stack ctrl-api mounts
// vault_data:/vault — the old deploy-template path /mnt/encrypted/vault does
// not exist in the container, so readdirSync throws ENOENT, the catch
// returns null, and EVERY Plane→Steward webhook is silently dropped as
// `no_vault_task`. The lookup must read the real vault path (/vault/task).
// ---------------------------------------------------------------------------

const TASK_FILE = "task/task-x.md";
const PLANE_ISSUE_ID = "issue-abc-123";
const TASK_CONTENT = `---\ntitle: Mirror task\nplane_issue_id: ${PLANE_ISSUE_ID}\n---\nbody\n`;

// Capture the directory the lookup scans so we can assert it's /vault/task.
const readdirCalls: string[] = [];
const readdirSyncFn = mock.fn((p: string) => {
  readdirCalls.push(String(p));
  // Only the correct vault task dir yields the mirror file. The buggy
  // /mnt/encrypted/vault/task dir behaves like the real container would:
  // it does not exist → throw ENOENT.
  if (String(p) === "/vault/task") {
    return ["task-x.md"] as any[];
  }
  const err: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`);
  err.code = "ENOENT";
  throw err;
});

const readFileSyncFn = mock.fn((p: string) => {
  if (String(p) === "/vault/task/task-x.md") return TASK_CONTENT;
  const err: NodeJS.ErrnoException = new Error(`ENOENT: ${p}`);
  err.code = "ENOENT";
  throw err;
});

const appendFileSyncCalls: Array<{ path: string; data: string }> = [];
const appendFileSyncFn = mock.fn((p: string, data: string) => {
  appendFileSyncCalls.push({ path: String(p), data: String(data) });
});

const fsMock = {
  readFileSync: readFileSyncFn,
  writeFileSync: mock.fn(),
  readdirSync: readdirSyncFn,
  mkdirSync: mock.fn(),
  existsSync: mock.fn(() => false),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => true })),
  unlinkSync: mock.fn(),
  renameSync: mock.fn(),
  appendFileSync: appendFileSyncFn,
  openSync: mock.fn(() => 0),
  readSync: mock.fn(() => 0),
  closeSync: mock.fn(),
  createReadStream: mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() })),
  Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: mock.fn(async () => undefined), writeFile: mock.fn(async () => undefined) },
};

mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: {
    readFileSync: readFileSyncFn,
    writeFileSync: fsMock.writeFileSync,
    readdirSync: readdirSyncFn,
    mkdirSync: fsMock.mkdirSync,
    existsSync: fsMock.existsSync,
    statSync: fsMock.statSync,
    unlinkSync: fsMock.unlinkSync,
    renameSync: fsMock.renameSync,
    appendFileSync: appendFileSyncFn,
    openSync: fsMock.openSync,
    readSync: fsMock.readSync,
    closeSync: fsMock.closeSync,
    createReadStream: fsMock.createReadStream,
    Dirent: fsMock.Dirent,
  },
});

const { createApiServer } = await import("../src/api/server.js");

const SECRET = "steward-webhook-secret";
let server: http.Server;

before(async () => {
  process.env.PLANE_WEBHOOK_STEWARD_SECRET = SECRET;
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  delete process.env.PLANE_WEBHOOK_STEWARD_SECRET;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  readdirCalls.length = 0;
  appendFileSyncCalls.length = 0;
});

function sign(raw: string): string {
  return crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
}

async function postRaw(path: string, raw: string, sig: string): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(raw)),
          "X-Plane-Signature": sig,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => { buf += c.toString(); });
        res.on("end", () => {
          try { resolve({ status: res.statusCode!, data: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode!, data: buf }); }
        });
      },
    );
    r.on("error", reject);
    r.write(raw);
    r.end();
  });
}

describe("POST /api/v1/webhooks/plane/steward — task lookup path", () => {
  it("finds the mirror task via /vault/task and records the signal", async () => {
    const raw = JSON.stringify({
      event: "issue_comment",
      action: "created",
      data: { issue: PLANE_ISSUE_ID, comment: "ping" },
    });
    const { status, data } = await postRaw("/api/v1/webhooks/plane/steward", raw, sign(raw));

    assert.strictEqual(status, 200);
    // The lookup must scan the real vault dir, not /mnt/encrypted/vault.
    assert.ok(
      readdirCalls.includes("/vault/task"),
      `lookup scanned ${JSON.stringify(readdirCalls)}, expected /vault/task`,
    );
    assert.ok(
      !readdirCalls.includes("/mnt/encrypted/vault/task"),
      "lookup must not scan the stale /mnt/encrypted/vault path",
    );
    // The signal was recorded against the mirror task — NOT dropped.
    assert.notStrictEqual(data.reason, "no_vault_task");
    assert.strictEqual(data.task_path, TASK_FILE);
    assert.strictEqual(appendFileSyncCalls.length, 1);
  });
});
