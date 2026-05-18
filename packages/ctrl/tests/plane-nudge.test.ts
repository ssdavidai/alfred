import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocks — must be registered before any import of code that uses them
// ---------------------------------------------------------------------------

// Capture every execFile call so we can assert nudge dispatch happened.
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
const execFileFn = mock.fn((...args: any[]) => {
  const cmd = args[0] as string;
  const cmdArgs = args[1] as string[];
  execFileCalls.push({ cmd, args: cmdArgs });
  const cb = args[args.length - 1] as Function;
  // Temporal CLI returns JSON on success
  cb(null, '{"run_id":"fake-run-id"}', "");
});

mock.module("node:child_process", {
  namedExports: {
    execFile: execFileFn,
    spawn: mock.fn(() => ({
      stderr: { on: mock.fn() },
      stdin: { write: mock.fn(), end: mock.fn() },
      on: mock.fn(),
    })),
  },
});

// Shim fs the same way vault.test.ts does.
const mkdirFn = mock.fn(async () => undefined);
const writeFileFn = mock.fn(async () => undefined);
const readFileSyncFn = mock.fn((_path: string) => "");
const writeFileSyncFn = mock.fn(() => {});
const readdirSyncFn = mock.fn(() => [] as any[]);
const mkdirSyncFn = mock.fn();
const existsSyncFn = mock.fn(() => false);
const statSyncFn = mock.fn(() => ({
  mtimeMs: 0,
  isDirectory: () => false,
  isFile: () => false,
}));
const unlinkSyncFn = mock.fn();
const renameSyncFn = mock.fn();
const appendFileSyncFn = mock.fn();
const openSyncFn = mock.fn(() => 0);
const readSyncFn = mock.fn(() => 0);
const closeSyncFn = mock.fn();
const createReadStreamFn = mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() }));

const fsMock = {
  readFileSync: readFileSyncFn,
  writeFileSync: writeFileSyncFn,
  readdirSync: readdirSyncFn,
  mkdirSync: mkdirSyncFn,
  existsSync: existsSyncFn,
  statSync: statSyncFn,
  unlinkSync: unlinkSyncFn,
  renameSync: renameSyncFn,
  appendFileSync: appendFileSyncFn,
  openSync: openSyncFn,
  readSync: readSyncFn,
  closeSync: closeSyncFn,
  createReadStream: createReadStreamFn,
  Dirent: class Dirent {
    name = "";
    isFile() { return true; }
    isDirectory() { return false; }
  },
  promises: { mkdir: mkdirFn, writeFile: writeFileFn },
};

mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: {
    readFileSync: readFileSyncFn,
    writeFileSync: writeFileSyncFn,
    readdirSync: readdirSyncFn,
    mkdirSync: mkdirSyncFn,
    existsSync: existsSyncFn,
    statSync: statSyncFn,
    unlinkSync: unlinkSyncFn,
    renameSync: renameSyncFn,
    appendFileSync: appendFileSyncFn,
    openSync: openSyncFn,
    readSync: readSyncFn,
    closeSync: closeSyncFn,
    createReadStream: createReadStreamFn,
    Dirent: class Dirent {
      name = "";
      isFile() { return true; }
      isDirectory() { return false; }
    },
  },
});

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;

before(async () => {
  // Enable the feature flag so triggerPlaneSyncNudge doesn't short-circuit.
  process.env.PLANE_SYNC_ENABLED = "true";
  server = createApiServer();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
});

after(async () => {
  delete process.env.PLANE_SYNC_ENABLED;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  execFileCalls.length = 0;
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(payload)),
            }
          : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (c: Buffer) => { raw += c.toString(); });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode!, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode!, data: raw });
          }
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/plane/nudge", () => {
  it("returns 400 when record_type is missing", async () => {
    const { status, data } = await req("POST", "/api/v1/plane/nudge", {
      slug: "foo",
    });
    assert.strictEqual(status, 400);
    assert.ok(
      String(data.error?.message ?? "").includes("record_type"),
      `expected record_type error, got ${JSON.stringify(data)}`,
    );
  });

  it("returns 400 when record_type is unknown", async () => {
    const { status, data } = await req("POST", "/api/v1/plane/nudge", {
      record_type: "project",
      slug: "foo",
    });
    assert.strictEqual(status, 400);
    assert.ok(String(data.error?.message ?? "").includes("record_type"));
  });

  it("returns 400 when slug is missing", async () => {
    const { status, data } = await req("POST", "/api/v1/plane/nudge", {
      record_type: "matter",
    });
    assert.strictEqual(status, 400);
    assert.ok(String(data.error?.message ?? "").includes("slug"));
  });

  it("returns 202 on valid matter payload and dispatches temporal workflow", async () => {
    const { status, data } = await req("POST", "/api/v1/plane/nudge", {
      record_type: "matter",
      slug: "client-x",
    });
    assert.strictEqual(status, 202);
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.scheduled, true);
    assert.ok(
      typeof data.workflow_id === "string" &&
        data.workflow_id.startsWith("plane-nudge-matter-client-x-"),
      `unexpected workflow_id: ${data.workflow_id}`,
    );

    // Verify temporal CLI was invoked with the right shape.
    const dockerCall = execFileCalls.find(
      (c) => c.cmd === "docker" && c.args.includes("temporal"),
    );
    assert.ok(dockerCall, "expected docker exec temporal invocation");
    assert.ok(
      dockerCall.args.includes("PlaneSyncNudgeWorkflow"),
      "expected --type PlaneSyncNudgeWorkflow",
    );
    assert.ok(
      dockerCall.args.includes("alfred-learn"),
      "expected --task-queue alfred-learn",
    );
    const inputIdx = dockerCall.args.lastIndexOf("--input");
    assert.ok(inputIdx >= 0, "expected --input flag");
    const inputJson = JSON.parse(dockerCall.args[inputIdx + 1]);
    assert.deepStrictEqual(inputJson, {
      record_type: "matter",
      slug: "client-x",
    });
  });

  it("returns 202 on valid task payload", async () => {
    const { status, data } = await req("POST", "/api/v1/plane/nudge", {
      record_type: "task",
      slug: "deploy-v2",
    });
    assert.strictEqual(status, 202);
    assert.strictEqual(data.scheduled, true);
  });

  it("returns 202 with scheduled=false when PLANE_SYNC_ENABLED is off", async () => {
    // Flip the flag off for this one test.
    const prev = process.env.PLANE_SYNC_ENABLED;
    process.env.PLANE_SYNC_ENABLED = "false";
    try {
      const { status, data } = await req("POST", "/api/v1/plane/nudge", {
        record_type: "matter",
        slug: "foo",
      });
      assert.strictEqual(status, 202);
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.scheduled, false);
      assert.strictEqual(data.reason, "PLANE_SYNC_ENABLED_off");
      // No temporal dispatch should have happened.
      const dockerCall = execFileCalls.find(
        (c) => c.cmd === "docker" && c.args.includes("temporal"),
      );
      assert.strictEqual(dockerCall, undefined);
    } finally {
      process.env.PLANE_SYNC_ENABLED = prev;
    }
  });
});

describe("automatic nudge on vault writes", () => {
  it("PATCH /api/v1/vault/records/matter/* triggers a nudge", async () => {
    const { status } = await req(
      "PATCH",
      "/api/v1/vault/records/matter/client-x.md",
      { set: { status: "active" } },
    );
    assert.strictEqual(status, 200);
    // Nudge is dispatched via setImmediate — wait a beat for it to run.
    await sleep(20);

    const nudge = execFileCalls.find(
      (c) =>
        c.cmd === "docker" &&
        c.args.includes("temporal") &&
        c.args.includes("PlaneSyncNudgeWorkflow"),
    );
    assert.ok(nudge, "expected a nudge dispatch for matter write");
    const inputIdx = nudge.args.lastIndexOf("--input");
    const inputJson = JSON.parse(nudge.args[inputIdx + 1]);
    assert.deepStrictEqual(inputJson, {
      record_type: "matter",
      slug: "client-x",
    });
  });

  it("PATCH /api/v1/vault/records/task/* triggers a nudge", async () => {
    const { status } = await req(
      "PATCH",
      "/api/v1/vault/records/task/deploy-v2.md",
      { set: { status: "done" } },
    );
    assert.strictEqual(status, 200);
    await sleep(20);

    const nudge = execFileCalls.find(
      (c) =>
        c.cmd === "docker" &&
        c.args.includes("temporal") &&
        c.args.includes("PlaneSyncNudgeWorkflow"),
    );
    assert.ok(nudge, "expected a nudge dispatch for task write");
    const inputIdx = nudge.args.lastIndexOf("--input");
    const inputJson = JSON.parse(nudge.args[inputIdx + 1]);
    assert.deepStrictEqual(inputJson, {
      record_type: "task",
      slug: "deploy-v2",
    });
  });

  it("PATCH /api/v1/vault/records/note/* does NOT trigger a nudge", async () => {
    const { status } = await req(
      "PATCH",
      "/api/v1/vault/records/note/untitled.md",
      { set: { status: "draft" } },
    );
    assert.strictEqual(status, 200);
    await sleep(20);

    const nudge = execFileCalls.find(
      (c) =>
        c.cmd === "docker" &&
        c.args.includes("temporal") &&
        c.args.includes("PlaneSyncNudgeWorkflow"),
    );
    assert.strictEqual(nudge, undefined, "note writes must not nudge Plane");
  });
});
