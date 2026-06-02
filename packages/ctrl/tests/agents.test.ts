import { mock, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// execFile controls all docker exec and execAsync calls
let execFileStdout = "{}";
const execFileFn = mock.fn((...args: any[]) => {
  const cb = args[args.length - 1] as Function;
  cb(null, execFileStdout, "");
});

// spawn is used by writeConfig (python3 writes config.yaml for surveyor)
const spawnFn = mock.fn(() => {
  const closeListeners: ((code: number) => void)[] = [];
  const errorListeners: ((err: Error) => void)[] = [];
  return {
    stderr: { on: mock.fn() },
    stdin: {
      write: mock.fn(),
      end: mock.fn(() => {
        // Simulate successful process exit after stdin closes
        setTimeout(() => closeListeners.forEach((cb) => cb(0)), 0);
      }),
    },
    on: mock.fn((event: string, cb: any) => {
      if (event === "close") closeListeners.push(cb);
      if (event === "error") errorListeners.push(cb);
    }),
  };
});

mock.module("node:child_process", {
  // execFileSync is imported by src/api/routes/system.ts; must be listed
  // even though these tests don't exercise the ssh-keygen surface.
  namedExports: { execFile: execFileFn, execFileSync: mock.fn(() => ""), spawn: spawnFn },
});

// node:fs mock (readConfig uses python3/execFile, but admin routes may need fs)
const fsMock = {
  readFileSync: mock.fn(() => ""),
  writeFileSync: mock.fn(() => {}),
  readdirSync: mock.fn(() => [] as any[]),
  mkdirSync: mock.fn(),
  existsSync: mock.fn(() => false),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false })),
  unlinkSync: mock.fn(),
  renameSync: mock.fn(),
  appendFileSync: mock.fn(),
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
    readFileSync: fsMock.readFileSync,
    writeFileSync: fsMock.writeFileSync,
    readdirSync: fsMock.readdirSync,
    mkdirSync: fsMock.mkdirSync,
    existsSync: fsMock.existsSync,
    statSync: fsMock.statSync,
    unlinkSync: fsMock.unlinkSync,
    renameSync: fsMock.renameSync,
    appendFileSync: fsMock.appendFileSync,
    openSync: fsMock.openSync,
    readSync: fsMock.readSync,
    closeSync: fsMock.closeSync,
    createReadStream: fsMock.createReadStream,
    Dirent: fsMock.Dirent,
  },
});

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function req(
  method: string,
  path: string,
  body?: unknown
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
          try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode!, data: raw }); }
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/agents", () => {
  it("returns the agent list", async () => {
    // readConfig uses python3 via execFile — return empty config
    execFileStdout = "{}";
    const { status, data } = await req("GET", "/api/v1/admin/agents");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.agents), "agents should be an array");
    assert.ok(data.agents.length > 0, "should have at least one agent");
    assert.ok(
      data.agents.every((a: any) => a.id && a.label && a.description),
      "each agent should have id, label, description"
    );
  });

  it("includes surveyor config", async () => {
    execFileStdout = "{}";
    const { status, data } = await req("GET", "/api/v1/admin/agents");
    assert.strictEqual(status, 200);
    assert.ok(data.surveyor, "should include surveyor");
    assert.ok(typeof data.surveyor.labeler_model === "string");
  });
});

describe("GET /api/v1/admin/agents/:agentId", () => {
  it("returns 400 for an unknown agent", async () => {
    const { status, data } = await req("GET", "/api/v1/admin/agents/nonexistent-agent");
    assert.strictEqual(status, 400);
    assert.ok(data.error.message.includes("Unknown agent"));
  });

  it("returns surveyor config for the surveyor agent", async () => {
    execFileStdout = "{}";
    const { status, data } = await req("GET", "/api/v1/admin/agents/surveyor");
    assert.strictEqual(status, 200);
    assert.ok(typeof data.labeler_model === "string");
    assert.ok(typeof data.embedder_model === "string");
  });
});

describe("PATCH /api/v1/admin/agents/:agentId/model", () => {
  it("returns 400 when model field is missing", async () => {
    const { status, data } = await req(
      "PATCH",
      "/api/v1/admin/agents/main/model",
      { other: "field" }
    );
    assert.strictEqual(status, 400);
    assert.ok(data.error.message.includes("model"));
  });

  it("returns 400 when model is an empty string", async () => {
    const { status, data } = await req(
      "PATCH",
      "/api/v1/admin/agents/main/model",
      { model: "   " }
    );
    assert.strictEqual(status, 400);
  });

  it("returns 400 for unknown agent", async () => {
    const { status, data } = await req(
      "PATCH",
      "/api/v1/admin/agents/ghost-agent/model",
      { model: "anthropic/claude-opus-4" }
    );
    assert.strictEqual(status, 400);
    assert.ok(data.error.message.includes("Unknown agent"));
  });

  it("returns 200 when updating a valid agent model", async () => {
    // patchScript returns success, restart also succeeds
    execFileStdout = JSON.stringify({ ok: true, agent: "main", model: "anthropic/claude-opus-4" });
    execFileFn.mock.resetCalls();
    const { status, data } = await req(
      "PATCH",
      "/api/v1/admin/agents/main/model",
      { model: "anthropic/claude-opus-4" }
    );
    assert.strictEqual(status, 200);
    assert.ok(data.message.includes("anthropic/claude-opus-4"));
    assert.ok(data.agent?.id === "main");
  });
});
