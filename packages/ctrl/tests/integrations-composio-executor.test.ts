import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Tests for executeComposioAction in integrations.ts (Phase A: HTTP sidecar).
//
// The route POST /api/v1/integrations/execute used to shell out to
//
//     docker exec alfred-learn python3 -c "<inline script>"
//
// …paying ~4s per call to spin Python + import the Composio SDK. Phase A
// replaces it with a long-running FastAPI sidecar inside alfred-learn at
// port 8788. This test pins the path-selection contract:
//
//   • Default (no env) → http path (POST http://alfred-learn:8788/...)
//   • Body shape matches what the sidecar expects
//   • An AbortSignal timeout is attached
//   • Non-2xx response from the sidecar surfaces as ApiError(502)
//   • Network failure also surfaces as ApiError(502)
//   • Composio-side error envelope is passed through verbatim (200 body)
// ---------------------------------------------------------------------------

// Mock node:fs so the integrations module-load doesn't fail (streams.ts /
// other transitive callsites call mkdirSync of /alfred-data/...).
const fsMockFns = {
  mkdirSync: mock.fn(() => undefined),
  writeFileSync: mock.fn(() => undefined),
  readFileSync: mock.fn(() => "{}"),
  readdirSync: mock.fn(() => [] as any[]),
  existsSync: mock.fn(() => false),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false })),
  unlinkSync: mock.fn(),
  renameSync: mock.fn(),
  appendFileSync: mock.fn(),
  openSync: mock.fn(() => 0),
  readSync: mock.fn(() => 0),
  closeSync: mock.fn(),
  createReadStream: mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() })),
  chownSync: mock.fn(),
};
const fsMock = {
  ...fsMockFns,
  promises: { mkdir: mock.fn(async () => undefined), writeFile: mock.fn(async () => undefined) },
};
mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: fsMockFns,
});

// Make sure the executor defaults to http.
process.env.COMPOSIO_EXECUTOR = "http";
process.env.COMPOSIO_SIDECAR_URL = "http://alfred-learn:8788";

const { executeComposioAction } = await import("../src/api/routes/integrations.js");
const { ApiError } = await import("../src/api/errors.js");

// Track captured fetch requests across tests.
let lastFetch: { url: string; init: any } | null = null;
let fetchResponse: { status: number; json: () => Promise<any> } = {
  status: 200,
  json: async () => ({ data: "from-http", successful: true }),
};
const fetchFn = async (url: string, init?: any) => {
  lastFetch = { url, init };
  return {
    ok: fetchResponse.status >= 200 && fetchResponse.status < 300,
    status: fetchResponse.status,
    json: fetchResponse.json,
  };
};

const originalFetch = globalThis.fetch;

before(() => {
  (globalThis as any).fetch = fetchFn;
});

after(() => {
  (globalThis as any).fetch = originalFetch;
});

beforeEach(() => {
  lastFetch = null;
  (globalThis as any).fetch = fetchFn;
  fetchResponse = {
    status: 200,
    json: async () => ({ data: "from-http", successful: true }),
  };
});

const standardArgs = {
  apiKey: "ak_test",
  userId: "alfred-test-1",
  actionSlug: "GMAIL_FETCH_EMAILS",
  arguments: { userId: "me", maxResults: 5 },
  connectedAccountId: "ca_abc",
};

describe("executeComposioAction — HTTP sidecar path (default)", () => {
  it("POSTs to the sidecar URL with the documented contract body", async () => {
    const result = await executeComposioAction(standardArgs);

    assert.ok(lastFetch, "must POST to the sidecar");
    assert.equal(lastFetch!.url, "http://alfred-learn:8788/composio/execute");
    assert.equal(lastFetch!.init.method, "POST");
    assert.equal(
      lastFetch!.init.headers["Content-Type"],
      "application/json",
      "JSON content-type sent",
    );

    const body = JSON.parse(lastFetch!.init.body);
    assert.equal(body.action, "GMAIL_FETCH_EMAILS");
    assert.deepEqual(body.arguments, { userId: "me", maxResults: 5 });
    assert.equal(body.user_id, "alfred-test-1");
    assert.equal(body.connected_account_id, "ca_abc");

    assert.deepEqual(result, { data: "from-http", successful: true });
  });

  it("attaches an AbortSignal timeout so a wedged sidecar doesn't hang ctrl-api", async () => {
    await executeComposioAction(standardArgs);
    assert.ok(lastFetch!.init.signal, "AbortSignal attached for timeout");
  });

  it("passes through a Composio-side error envelope verbatim (HTTP 200)", async () => {
    fetchResponse = {
      status: 200,
      json: async () => ({ error: "No active gmail connection", action: "GMAIL_FETCH_EMAILS" }),
    };
    const result = await executeComposioAction(standardArgs);
    assert.equal((result as any).error, "No active gmail connection");
    assert.equal((result as any).action, "GMAIL_FETCH_EMAILS");
  });
});

describe("executeComposioAction — failure surface", () => {
  it("raises ApiError(502) carrying the sidecar's structured error code", async () => {
    fetchResponse = {
      status: 503,
      json: async () => ({ error: { code: "SERVICE_BUSY", message: "queue full" } }),
    };
    await assert.rejects(
      executeComposioAction(standardArgs),
      (err: any) => {
        assert.ok(err instanceof ApiError, "must be an ApiError");
        assert.equal(err.statusCode, 502);
        assert.equal(err.code, "SERVICE_BUSY");
        assert.match(err.message, /queue full/);
        return true;
      },
    );
  });

  it("raises ApiError(502) when fetch itself rejects (network failure)", async () => {
    (globalThis as any).fetch = async () => {
      throw new Error("ENOTFOUND alfred-learn");
    };
    await assert.rejects(
      executeComposioAction(standardArgs),
      (err: any) => {
        assert.ok(err instanceof ApiError, "must be an ApiError");
        assert.equal(err.statusCode, 502);
        assert.equal(err.code, "COMPOSIO_SIDECAR_UNREACHABLE");
        assert.match(err.message, /ENOTFOUND/);
        return true;
      },
    );
  });

  it("defaults to a generic code when the sidecar's error body is malformed", async () => {
    fetchResponse = {
      status: 500,
      // No `error` envelope at all — Composio sidecar misbehaving.
      json: async () => ({ random: "junk" }),
    };
    await assert.rejects(
      executeComposioAction(standardArgs),
      (err: any) => {
        assert.equal(err.statusCode, 502);
        assert.equal(err.code, "COMPOSIO_SIDECAR_HTTP_ERROR");
        assert.match(err.message, /500/);
        return true;
      },
    );
  });
});
