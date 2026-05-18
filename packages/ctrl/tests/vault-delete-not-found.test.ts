import { mock, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Configurable execFile mock — drives DELETE handler down success / not-found
// / generic-failure paths to verify the correct status mapping.
//
// The alfred CLI's `vault delete` exits 1 and prints
//   {"error": "File not found: <path>"}
// to stdout and/or stderr when the target is already absent. The route
// must downgrade that case to HTTP 404 so idempotent consumers (the
// rematerializer, fleet cleanup scripts, etc.) don't log every
// already-deleted record as a false-positive failure. All OTHER non-zero
// exits must keep returning 500 EXEC_ERROR so genuine breakage stays loud.
// ---------------------------------------------------------------------------

type ExecMode = "ok" | "not-found" | "permission-denied";
let execMode: ExecMode = "ok";
let execStdoutOnSuccess = '{"deleted":true}';

const execFileFn = mock.fn((...args: any[]) => {
  const cb = args[args.length - 1] as (
    err: (Error & { status?: number; code?: number | string }) | null,
    stdout: string,
    stderr: string,
  ) => void;

  if (execMode === "ok") {
    cb(null, execStdoutOnSuccess, "");
    return;
  }

  // Synthesise the shape execFile produces for a non-zero exit.
  const err = new Error("Command failed: alfred vault delete ...") as Error & {
    status?: number;
  };
  err.status = 1;

  if (execMode === "not-found") {
    // The CLI emits the JSON payload to stdout (sometimes also stderr).
    // The route must inspect both streams and match case-insensitively.
    const stdout = '{"error": "File not found: note/already-gone.md"}\n';
    cb(err, stdout, "");
    return;
  }

  if (execMode === "permission-denied") {
    cb(err, "", "permission denied: cannot write /vault/note/foo.md\n");
    return;
  }
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

// fs is touched by some peripheral routes during route registration / nudge
// scheduling — provide a minimal no-op surface so the server boots cleanly.
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
mock.module("node:fs", { defaultExport: fsMock, namedExports: fsMock });

const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;
before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function req(method: string, path: string): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method },
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
    r.end();
  });
}

describe("DELETE /api/v1/vault/records/* — error mapping", () => {
  it("returns 200 on successful delete (existing behaviour)", async () => {
    execMode = "ok";
    execStdoutOnSuccess = '{"deleted":true}';
    const { status, data } = await req("DELETE", "/api/v1/vault/records/note/exists.md");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data, { deleted: true });
  });

  it("maps alfred CLI 'File not found' (exit 1) to HTTP 404 with NOT_FOUND code", async () => {
    execMode = "not-found";
    const { status, data } = await req(
      "DELETE",
      "/api/v1/vault/records/note/already-gone.md",
    );
    assert.strictEqual(status, 404, "should downgrade File-not-found to 404");
    assert.strictEqual(data.error.code, "NOT_FOUND");
    assert.ok(
      String(data.error.message).includes("note/already-gone.md"),
      `error message should include the requested path; got: ${data.error.message}`,
    );
  });

  it("preserves 500 EXEC_ERROR for other CLI failures (e.g. permission denied)", async () => {
    execMode = "permission-denied";
    const { status, data } = await req(
      "DELETE",
      "/api/v1/vault/records/note/locked.md",
    );
    assert.strictEqual(status, 500, "non-not-found errors must remain 500");
    assert.strictEqual(data.error.code, "EXEC_ERROR");
    assert.ok(
      String(data.error.message).toLowerCase().includes("permission denied")
        || String(data.error.message).toLowerCase().includes("alfred failed")
        || String(data.error.message).toLowerCase().includes("docker failed"),
      `expected exec error to surface, got: ${data.error.message}`,
    );
  });
});
