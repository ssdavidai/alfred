import { mock, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocks — execFile feeds the dockerExec helper; fs feeds the temp-file
// payload writer in runRailsRunnerMutate.
// ---------------------------------------------------------------------------

let execFileStdout = "{}";
let execFileError: Error | null = null;
const execFileFn = mock.fn((...args: any[]) => {
  const cb = args[args.length - 1] as Function;
  if (execFileError) {
    cb(execFileError, "", "exec failed");
    return;
  }
  cb(null, execFileStdout, "");
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

const writeFileSyncFn = mock.fn(() => {});
const fsMock = {
  readFileSync: mock.fn(() => ""),
  writeFileSync: writeFileSyncFn,
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
    writeFileSync: writeFileSyncFn,
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
          ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) }
          : {},
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

function setEnvelope(env: object) {
  execFileStdout = JSON.stringify(env);
  execFileError = null;
}

function setExecError(err: Error) {
  execFileStdout = "";
  execFileError = err;
}

// ---------------------------------------------------------------------------
// Generic envelope → HTTP status mapping (the contract every mutate route
// inherits via runRailsRunnerMutate / forwardMutateResult / statusFromMutateResult).
// ---------------------------------------------------------------------------

describe("Rails-runner envelope → HTTP status mapping", () => {
  it("maps {ok: true} on create → 201", async () => {
    setEnvelope({ ok: true, transfer: { id: "t-1" } });
    const { status, data } = await req("POST", "/api/v1/sure/transfers", {
      source_account_id: "a", destination_account_id: "b", amount: "100", date: "2026-04-30",
    });
    assert.strictEqual(status, 201);
    assert.deepStrictEqual(data.transfer, { id: "t-1" });
  });

  it("maps {ok: false, status: validation_error} → 422", async () => {
    setEnvelope({ ok: false, error: "amount must be positive", status: "validation_error" });
    const { status, data } = await req("POST", "/api/v1/sure/transfers", {
      source_account_id: "a", destination_account_id: "b", amount: "-1", date: "2026-04-30",
    });
    assert.strictEqual(status, 422);
    assert.strictEqual(data.error.code, "SURE_TRANSFER_MUTATE_ERROR");
    assert.match(data.error.message, /amount must be positive/);
  });

  it("maps {ok: false, status: not_found} → 404", async () => {
    setEnvelope({ ok: false, error: "transfer not found: t-x", status: "not_found" });
    const { status, data } = await req("DELETE", "/api/v1/sure/transfers/t-x");
    assert.strictEqual(status, 404);
    assert.strictEqual(data.error.code, "SURE_TRANSFER_MUTATE_ERROR");
  });

  it("maps execFile failure → 502 with EXEC_FAILED code", async () => {
    setExecError(new Error("docker compose exited 137"));
    const { status, data } = await req("POST", "/api/v1/sure/transfers", {
      source_account_id: "a", destination_account_id: "b", amount: "100", date: "2026-04-30",
    });
    assert.strictEqual(status, 502);
    assert.strictEqual(data.error.code, "SURE_TRANSFER_MUTATE_EXEC_FAILED");
  });

  it("maps unparseable runner output → 502 SURE_MUTATE_PARSE_FAILED", async () => {
    execFileStdout = "Rails booted but the script crashed before printing JSON\n";
    execFileError = null;
    const { status, data } = await req("POST", "/api/v1/sure/transfers", {
      source_account_id: "a", destination_account_id: "b", amount: "100", date: "2026-04-30",
    });
    assert.strictEqual(status, 502);
    assert.strictEqual(data.error.code, "SURE_MUTATE_PARSE_FAILED");
  });

  it("scans from the bottom for the envelope, ignoring Rails warnings above", async () => {
    execFileStdout = [
      "I, [2026-04-30T10:00:00 #1]  INFO -- : [SKYLIGHT] Unable to start",
      "W, [2026-04-30T10:00:01 #1]  WARN  -- : [OmniAuth] Skipping OIDC provider",
      JSON.stringify({ ok: true, transfer: { id: "t-2" } }),
    ].join("\n");
    execFileError = null;
    const { status, data } = await req("POST", "/api/v1/sure/transfers", {
      source_account_id: "a", destination_account_id: "b", amount: "100", date: "2026-04-30",
    });
    assert.strictEqual(status, 201);
    assert.deepStrictEqual(data.transfer, { id: "t-2" });
  });
});

// ---------------------------------------------------------------------------
// Transfer routes
// ---------------------------------------------------------------------------

describe("POST /api/v1/sure/transfers/match", () => {
  it("maps a successful match envelope → 201", async () => {
    setEnvelope({ ok: true, transfer: { id: "t-3", status: "confirmed" } });
    const { status, data } = await req("POST", "/api/v1/sure/transfers/match", {
      inflow_transaction_id: "in", outflow_transaction_id: "out",
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(data.transfer.id, "t-3");
  });
});

describe("POST /api/v1/sure/transfers/:id/confirm", () => {
  it("returns 200 with the updated transfer", async () => {
    setEnvelope({ ok: true, transfer: { id: "t-1", status: "confirmed" } });
    const { status, data } = await req("POST", "/api/v1/sure/transfers/t-1/confirm");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.transfer.status, "confirmed");
  });
});

describe("POST /api/v1/sure/transfers/:id/reject", () => {
  it("returns 200 with rejected id when rejection succeeds", async () => {
    setEnvelope({ ok: true, rejected: "t-1" });
    const { status, data } = await req("POST", "/api/v1/sure/transfers/t-1/reject");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.rejected, "t-1");
  });
});

describe("DELETE /api/v1/sure/transfers/:id", () => {
  it("returns 200 with deleted id", async () => {
    setEnvelope({ ok: true, deleted: "t-1" });
    const { status, data } = await req("DELETE", "/api/v1/sure/transfers/t-1");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.deleted, "t-1");
  });
});

// ---------------------------------------------------------------------------
// Entry routes (split / unsplit / bulk)
// ---------------------------------------------------------------------------

describe("POST /api/v1/sure/transactions/:id/split", () => {
  it("returns 200 with parent + children", async () => {
    setEnvelope({
      ok: true,
      parent: { transaction_id: "p", excluded: true },
      children: [{ transaction_id: "c1" }, { transaction_id: "c2" }],
    });
    const { status, data } = await req("POST", "/api/v1/sure/transactions/p/split", {
      splits: [{ amount: 50, name: "half" }, { amount: 50, name: "other half" }],
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.children.length, 2);
  });
});

describe("POST /api/v1/sure/transactions/:id/unsplit", () => {
  it("returns 200 with restored parent", async () => {
    setEnvelope({ ok: true, entry: { transaction_id: "p", excluded: false } });
    const { status, data } = await req("POST", "/api/v1/sure/transactions/p/unsplit");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.entry.transaction_id, "p");
  });
});

describe("POST /api/v1/sure/transactions/bulk_update", () => {
  it("returns 200 with updated count", async () => {
    setEnvelope({ ok: true, updated_count: 3, transaction_ids: ["a", "b", "c"] });
    const { status, data } = await req("POST", "/api/v1/sure/transactions/bulk_update", {
      transaction_ids: ["a", "b", "c"],
      attributes: { category_id: "cat-1" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.updated_count, 3);
  });
});

describe("POST /api/v1/sure/transactions/bulk_delete", () => {
  it("returns 200 with deleted count", async () => {
    setEnvelope({ ok: true, deleted_count: 2, transaction_ids: ["a", "b"] });
    const { status, data } = await req("POST", "/api/v1/sure/transactions/bulk_delete", {
      transaction_ids: ["a", "b"],
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.deleted_count, 2);
  });

  it("returns 422 when split-child transactions are in the set", async () => {
    setEnvelope({
      ok: false,
      error: "split-child transactions cannot be deleted individually; delete the parent",
      status: "validation_error",
    });
    const { status, data } = await req("POST", "/api/v1/sure/transactions/bulk_delete", {
      transaction_ids: ["c1"],
    });
    assert.strictEqual(status, 422);
    assert.match(data.error.message, /split-child/);
  });
});

// ---------------------------------------------------------------------------
// Smoke check that account + rule routes still hit the runner with the new
// shared helper code path (no regressions from the helper extraction).
// ---------------------------------------------------------------------------

describe("regression — account + rule routes still mapped", () => {
  it("POST /api/v1/sure/accounts forwards to its own runner", async () => {
    setEnvelope({ ok: true, account: { id: "acc-1" } });
    const { status } = await req("POST", "/api/v1/sure/accounts", {
      name: "x", balance: 1, currency: "HUF", accountable_type: "Loan",
    });
    assert.strictEqual(status, 201);
  });

  it("POST /api/v1/sure/rules/preview forwards", async () => {
    setEnvelope({ ok: true, affected_resource_count: 5, sample: [] });
    const { status, data } = await req("POST", "/api/v1/sure/rules/preview", {
      name: "x",
      conditions: [{ condition_type: "transaction_amount", operator: "=", value: "1" }],
      actions: [{ action_type: "exclude_transaction" }],
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.affected_resource_count, 5);
  });
});
