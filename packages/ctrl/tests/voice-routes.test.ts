// Lane I — /api/v1/channels/voice/status (voice-bridge deploy-readiness).
//
// Mirrors the test shape of sms-routes (and the agents.test.ts mock-module
// pattern that ships in this worktree). The route is a read-only status
// probe — there is no PUT/DELETE/test, so the suite stays small.
//
// We mock `../src/api/helpers.js` so the route's `dockerExec` /
// `dockerComposeCmd` calls hit fakes that simulate the four resolution
// paths the route must distinguish:
//
//   1. `compose_service_exists=false` (compose has no `voice-bridge` service
//      because Phase-2 orchestrator hasn't merged onto this VM yet) →
//      state="unconfigured", error=null.
//   2. service present + no TWILIO_PHONE_NUMBER in the hermes-main .env →
//      state="unconfigured", calling_number=null (deployed but unconfigured).
//   3. service present + TWILIO_PHONE_NUMBER set + container healthy →
//      state="configured_running", calling_number set.
//   4. service present + TWILIO_PHONE_NUMBER set + container unhealthy →
//      state="error" with a non-null error string sourced from container
//      logs tail.
//
// `+15550100` is a NANPA reserved-for-fiction E.164 — never a real number.

import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import realFs from "node:fs";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
//
// We import the full `server.js` to get addRoute + matchRoute, which
// transitively imports every route module — including `streams.ts`, which
// calls `fs.mkdirSync('/mnt/encrypted/alfred/streams', ...)` at module
// load. Sandbox-friendly: shim node:fs so the top-level side effects
// no-op, but defer to the real fs for anything else (tsx loader still
// needs it to read source files).

const fsMock = {
  ...realFs,
  mkdirSync: mock.fn(() => undefined),
  writeFileSync: mock.fn(() => undefined),
  appendFileSync: mock.fn(() => undefined),
};

mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: {
    // Spread `realFs` so anything we don't override still works (tsx
    // loader, route modules reading vault files in other suites).
    ...(realFs as unknown as Record<string, unknown>),
    mkdirSync: fsMock.mkdirSync,
    writeFileSync: fsMock.writeFileSync,
    appendFileSync: fsMock.appendFileSync,
  },
});

// State the fakes read from on each call, mutated per-test in `beforeEach`.
interface FakeState {
  composeService: "missing" | "running" | "starting" | "unhealthy";
  envText: string; // contents of the hermes-main /.env
  logsTail: string; // tail of voice-bridge container logs (used in error state)
}

const fake: FakeState = {
  composeService: "missing",
  envText: "",
  logsTail: "",
};

// dockerComposeCmd(["ps","voice-bridge","--format","json"]) is the
// compose_service_exists probe. When the service is absent, `docker
// compose ps <name>` returns either an empty stdout (newer compose) OR
// throws with "no such service" (older compose); the route must handle
// both. We simulate the empty-stdout branch here and the throw-branch in
// the dedicated test.
const dockerComposeCmdFn = mock.fn(async (args: string[]) => {
  // 0: "ps", 1: "voice-bridge", 2: "--format", 3: "json"
  if (args[0] === "ps" && args[1] === "voice-bridge") {
    if (fake.composeService === "missing") {
      // Newer compose returns an empty string when the service is
      // unknown but does not throw — mirror that here.
      return "";
    }
    const stateMap = {
      running: "running",
      starting: "starting",
      unhealthy: "exited",
    } as const;
    const healthMap = {
      running: "healthy",
      starting: "starting",
      unhealthy: "unhealthy",
    } as const;
    // `docker compose ps --format json` emits one JSON line per service
    // (compose ≥ v2.21) — a JSONL-ish shape, not a JSON array.
    return (
      JSON.stringify({
        Name: "alfred-voice-bridge-1",
        Service: "voice-bridge",
        State: stateMap[fake.composeService],
        Health: healthMap[fake.composeService],
      }) + "\n"
    );
  }
  if (args[0] === "logs") {
    // `dockerComposeCmd(["logs","--tail","20","voice-bridge"])` for the
    // unhealthy branch.
    return fake.logsTail;
  }
  return "";
});

// dockerExec(service, ["sh","-c","cat <env-path> 2>/dev/null || true"]) is
// the hermes per-profile .env read. Reuses the SMS profile env layout
// (TWILIO_PHONE_NUMBER lives there).
const dockerExecFn = mock.fn(async (_service: string, command: string[]) => {
  const inner = command[command.length - 1];
  if (typeof inner === "string" && inner.includes("/.env")) {
    return fake.envText;
  }
  return "";
});

mock.module("../src/api/helpers.js", {
  namedExports: {
    dockerExec: dockerExecFn,
    dockerComposeCmd: dockerComposeCmdFn,
    // Re-export anything the route file might import even if unused — keeps
    // the mock compatible if the real helpers.ts grows new exports.
    execAsync: mock.fn(async () => ({ stdout: "", stderr: "" })),
    dockerExecWithStdin: mock.fn(async () => ({ stdout: "", stderr: "" })),
    hostExec: mock.fn(async () => ""),
    sudoExec: mock.fn(async () => ""),
    parseJsonLines: (raw: string) => {
      if (!raw.trim()) return [];
      return raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    },
    getQuery: (url: string) => new URLSearchParams(url.split("?")[1] ?? ""),
    validateServiceName: () => undefined,
    ALFRED_CMD: ["alfred"],
    OPENCLAW_CMD: ["node", "openclaw.mjs"],
    COMPOSE_DIR: "/opt/alfred/compose",
  },
});

// ---------------------------------------------------------------------------
// Wire the route into a tiny test server
// ---------------------------------------------------------------------------

const { addRoute, matchRoute } = await import("../src/api/server.js");
const { sendJson, handleError } = await import("../src/api/errors.js");
const { registerVoiceRoutes } = await import(
  "../src/api/routes/voice.js"
);

// Register exactly once. The shared `addRoute` table persists across tests
// in the same process, so duplicate registration would 404 the second
// route the matcher hits. node:test runs files sequentially by default
// and this file is the only consumer of /api/v1/channels/voice/* — safe.
registerVoiceRoutes();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = matchRoute(req.method ?? "GET", url.pathname);
  if (!match) {
    sendJson(res, 404, { error: { code: "NOT_FOUND", message: "no route" } });
    return;
  }
  match
    .handler({
      req,
      res,
      params: match.params,
      body: undefined,
      query: url.searchParams,
    })
    .catch((err: unknown) => handleError(res, err));
});

before(async () => {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  fake.composeService = "missing";
  fake.envText = "";
  fake.logsTail = "";
  dockerComposeCmdFn.mock.resetCalls();
  dockerExecFn.mock.resetCalls();
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function get(
  path: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const addr = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method: "GET",
      },
      (res) => {
        let raw = "";
        res.on("data", (c: Buffer) => {
          raw += c.toString();
        });
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              data: JSON.parse(raw) as Record<string, unknown>,
            });
          } catch {
            resolve({
              status: res.statusCode ?? 0,
              data: { raw } as unknown as Record<string, unknown>,
            });
          }
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Tests — the four contract states
// ---------------------------------------------------------------------------

describe("GET /api/v1/channels/voice/status", () => {
  it("reports state=unconfigured + compose_service_exists=false when the voice-bridge service is absent from compose", async () => {
    fake.composeService = "missing";
    fake.envText = ""; // no creds either
    const { status, data } = await get("/api/v1/channels/voice/status");
    assert.equal(status, 200);
    assert.equal(data.compose_service_exists, false);
    assert.equal(data.configured, false);
    assert.equal(data.state, "unconfigured");
    assert.equal(data.error, null);
    assert.equal(data.calling_number, null);
  });

  it("reports state=unconfigured when the service exists but TWILIO_PHONE_NUMBER isn't set in the hermes profile", async () => {
    fake.composeService = "running";
    fake.envText = "# no twilio number yet\n";
    const { status, data } = await get("/api/v1/channels/voice/status");
    assert.equal(status, 200);
    assert.equal(data.compose_service_exists, true);
    assert.equal(data.configured, false);
    assert.equal(data.state, "unconfigured");
    assert.equal(data.calling_number, null);
    assert.equal(data.error, null);
  });

  it("reports state=configured_running with the SMS phone number echoed when the service is healthy and a number is configured", async () => {
    fake.composeService = "running";
    // SMS reuses the same .env key — voice surfaces the same number.
    // +15550100 is a NANPA reserved-for-fiction E.164.
    fake.envText =
      "TWILIO_ACCOUNT_SID=AC00000000000000000000000000000000\n" +
      "TWILIO_AUTH_TOKEN=00000000000000000000000000000000\n" +
      "TWILIO_PHONE_NUMBER=+15550100\n";
    const { status, data } = await get("/api/v1/channels/voice/status");
    assert.equal(status, 200);
    assert.equal(data.compose_service_exists, true);
    assert.equal(data.configured, true);
    assert.equal(data.state, "configured_running");
    assert.equal(data.calling_number, "+15550100");
    assert.equal(data.error, null);
  });

  it("reports state=error with a non-null error string when the service is unhealthy", async () => {
    fake.composeService = "unhealthy";
    fake.envText = "TWILIO_PHONE_NUMBER=+15550100\n";
    fake.logsTail =
      "voice-bridge | ERROR: media stream websocket connection refused\n";
    const { status, data } = await get("/api/v1/channels/voice/status");
    assert.equal(status, 200);
    assert.equal(data.compose_service_exists, true);
    assert.equal(data.configured, true);
    assert.equal(data.state, "error");
    assert.equal(data.calling_number, "+15550100");
    assert.equal(typeof data.error, "string");
    assert.ok(
      (data.error as string).length > 0,
      "expected non-empty error string",
    );
  });
});

// ---------------------------------------------------------------------------
// Defensive case (NOT one of the 4 contract cases — but the task spec calls
// it out explicitly): older compose throws on `ps <missing-service>` instead
// of returning empty stdout. The route MUST treat that as
// compose_service_exists=false / state="unconfigured" (NOT state="error").
// ---------------------------------------------------------------------------

describe("GET /api/v1/channels/voice/status — defensive cases", () => {
  it("handles `docker compose ps` throwing 'no such service' gracefully", async () => {
    // Simulate the older compose CLI behaviour: it exits non-zero with a
    // 'no such service' message instead of returning empty stdout.
    dockerComposeCmdFn.mock.mockImplementationOnce(async () => {
      throw new Error("no such service: voice-bridge");
    });
    fake.envText = "";
    const { status, data } = await get("/api/v1/channels/voice/status");
    assert.equal(status, 200);
    assert.equal(data.compose_service_exists, false);
    assert.equal(data.state, "unconfigured");
    assert.equal(data.error, null);
  });
});
