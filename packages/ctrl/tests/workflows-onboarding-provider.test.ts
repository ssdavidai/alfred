// #758 — POST /api/v1/workflows/onboarding/start carries the email provider.
//
// The workflow-start route stamps `email_provider` and the chosen
// `connection_id` into OnboardingInput. Absent means gmail (every legacy
// caller); an unsupported explicit value is rejected, never treated as gmail.

import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Capture the temporal CLI invocations so we can read back the --input JSON.
const temporalCalls: string[][] = [];

mock.module("../src/api/helpers.js", {
  namedExports: {
    HERMES_CONTAINER: "hermes",
    HERMES_CMD: ["hermes"],
    ALFRED_CMD: ["alfred"],
    OPENCLAW_CMD: ["hermes"],
    OPENCLAW_CONTAINER: "hermes",
    COMPOSE_DIR: "/srv/alfred-black",
    execAsync: async () => ({ stdout: "", stderr: "" }),
    hostExec: async () => "",
    sudoExec: async () => "",
    parseJsonLines: (_raw: string) => [],
    getQuery: (url: string) => new URLSearchParams(url.split("?")[1] || ""),
    validateServiceName: (_name: string) => {},
    dockerComposeCmd: async (_args: string[]) => "",
    dockerExec: async (_container: string, command: string[]) => {
      temporalCalls.push(command);
      return JSON.stringify({ runId: "r1" });
    },
    dockerExecWithStdin: async () => "",
  },
});

const fsMock = {
  existsSync: mock.fn(() => false),
  readFileSync: mock.fn(() => { const e = new Error("ENOENT") as any; e.code = "ENOENT"; throw e; }),
  writeFileSync: mock.fn(), mkdirSync: mock.fn(), readdirSync: mock.fn(() => []),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false })),
  unlinkSync: mock.fn(), renameSync: mock.fn(), appendFileSync: mock.fn(), rmSync: mock.fn(),
  chownSync: mock.fn(), openSync: mock.fn(() => 0), readSync: mock.fn(() => 0), closeSync: mock.fn(),
  createReadStream: mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() })),
  Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: mock.fn(async () => undefined), writeFile: mock.fn(async () => undefined) },
};
mock.module("node:fs", { defaultExport: fsMock, namedExports: { ...fsMock } });

await import("../src/api/routes/workflows.js");
const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;
before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => { temporalCalls.length = 0; });

async function req(method: string, pathname: string, body?: unknown): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port: addr.port, path: pathname, method,
        headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) } },
      (resp) => {
        let raw = "";
        resp.on("data", (c) => (raw += c));
        resp.on("end", () => { let d: any; try { d = JSON.parse(raw); } catch { d = raw; } resolve({ status: resp.statusCode ?? 0, data: d }); });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function lastOnboardingInput(): any {
  const start = temporalCalls.find((c) => c.includes("start") && c.includes("--input"));
  assert.ok(start, "expected a temporal workflow start call");
  const i = start!.indexOf("--input");
  return JSON.parse(start![i + 1]);
}

describe("#758 onboarding/start provider", () => {
  it("stamps email_provider=outlook and the chosen connection_id", async () => {
    const { status } = await req("POST", "/api/v1/workflows/onboarding/start", {
      user_id: "u1", stream_id: "s1", email_provider: "outlook", connection_id: "ca_out456",
    });
    assert.equal(status, 201);
    const input = lastOnboardingInput();
    assert.equal(input.email_provider, "outlook");
    assert.equal(input.connection_id, "ca_out456");
  });

  it("defaults to gmail when no provider is given (legacy callers)", async () => {
    const { status } = await req("POST", "/api/v1/workflows/onboarding/start", {
      user_id: "u1", stream_id: "s1",
    });
    assert.equal(status, 201);
    assert.equal(lastOnboardingInput().email_provider, "gmail");
  });

  it("rejects an unsupported provider rather than falling back to gmail", async () => {
    const { status } = await req("POST", "/api/v1/workflows/onboarding/start", {
      user_id: "u1", email_provider: "yahoo",
    });
    assert.equal(status, 400);
    assert.equal(temporalCalls.length, 0, "no workflow should be started for a bad provider");
  });
});
