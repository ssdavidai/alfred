// profiles-mcp-catalog — per-profile MCP catalog routes (#204 Lane I).
//
// Tests the three new routes:
//   GET    /api/v1/admin/profiles/:slug/mcp  — list servers
//   POST   /api/v1/admin/profiles/:slug/mcp  — add server
//   DELETE /api/v1/admin/profiles/:slug/mcp/:name — remove server
//
// Coverage:
//   - GET returns server-list shape from CLI JSON
//   - GET falls back to config.yaml when CLI fails
//   - POST reserved profile → 409
//   - DELETE reserved profile → 409
//   - POST+DELETE round-trip on a non-reserved profile
//   - _parseMcpListJson handles JSON array + object shapes
//   - _readMcpFromConfig handles stdio + http server entries

import { mock, describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set up temp dirs for the DB + hermes state.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-mcp-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.SQLITE_VEC_PATH = "";
// Point HERMES_CONFIG_DIR at our temp dir so _readMcpFromConfig reads our fixtures.
process.env.HERMES_CONFIG_DIR = path.join(tmp, "profiles");

// ── helpers mock ──────────────────────────────────────────────────────────────
//
// We stub dockerExec / dockerExecWithStdin so tests run without a live container.

const dockerExecCalls: { service: string; command: string[]; stdin?: string }[] = [];
let dockerExecHandler: (
  service: string,
  command: string[],
) => string | Promise<string> = async () => "";
let dockerExecWithStdinHandler: (
  service: string,
  command: string[],
  stdin: string,
) => Promise<{ stdout: string; stderr: string }> = async () => ({ stdout: "", stderr: "" });

const realHelpers = await import("../src/api/helpers.js");
mock.module("../src/api/helpers.js", {
  exports: {
    ...realHelpers,
    dockerExec: async (service: string, command: string[]) => {
      dockerExecCalls.push({ service, command: [...command] });
      return await dockerExecHandler(service, command);
    },
    dockerExecWithStdin: async (
      service: string,
      command: string[],
      stdinPayload: string,
    ) => {
      dockerExecCalls.push({ service, command: [...command], stdin: stdinPayload });
      return await dockerExecWithStdinHandler(service, command, stdinPayload);
    },
    dockerComposeCmd: async () => "",
  },
});

// ── supervisor mock ────────────────────────────────────────────────────────────
// Prevent real filesystem writes + SIGUSR1 in test env.
mock.module("../src/hermes/supervisor.js", {
  exports: {
    nudgeHermesSupervisor: () => false,
    writeSupervisorRegistry: () => {},
    restartProfile: () => ({ scope: "noop", attempted: false, warning: null }),
    REGISTRY_PATH: "/dev/null",
  },
});

// Import route registration + server after mocks are in place.
const { matchRoute } = await import("../src/api/server.js");
const {
  registerProfileRoutes,
  _parseMcpListJson,
  _readMcpFromConfig,
} = await import("../src/api/routes/profiles.js");
const { handleError } = await import("../src/api/errors.js");

registerProfileRoutes();

// ── route invocation helpers ─────────────────────────────────────────────────

function invokeGet(
  slug: string,
): Promise<{ status: number; body: any }> {
  return invokeRoute("GET", `/api/v1/admin/profiles/${slug}/mcp`, {}, undefined);
}

function invokePost(
  slug: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  return invokeRoute("POST", `/api/v1/admin/profiles/${slug}/mcp`, {}, body);
}

function invokeDelete(
  slug: string,
  name: string,
): Promise<{ status: number; body: any }> {
  return invokeRoute("DELETE", `/api/v1/admin/profiles/${slug}/mcp/${name}`, {}, undefined);
}

function invokeRoute(
  method: string,
  url: string,
  params: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: any }> {
  // Parse :slug and :name from url since matchRoute does it but we need to
  // supply them as params too for route resolution.
  const matched = matchRoute(method, url);
  if (!matched) {
    return Promise.reject(new Error(`no route matched: ${method} ${url}`));
  }
  return new Promise((resolve, reject) => {
    let bodyChunks: any[] = [];
    let status = 200;
    const res: any = {
      statusCode: 200,
      setHeader() {},
      writeHead(s: number) { status = s; },
      end(chunk?: any) {
        if (chunk !== undefined) bodyChunks.push(chunk);
        try {
          const raw = Buffer.concat(
            bodyChunks.map((c) =>
              Buffer.isBuffer(c) ? c : Buffer.from(String(c)),
            ),
          ).toString();
          resolve({ status, body: raw ? JSON.parse(raw) : {} });
        } catch (e) {
          reject(e);
        }
      },
      write(chunk: any) { bodyChunks.push(chunk); },
    };
    Promise.resolve(
      matched.handler({
        req: {} as any,
        res,
        params: matched.params,
        query: new URLSearchParams(),
        body,
      }),
    ).catch((err) => {
      // Mimic the real server's outer try/catch — convert ApiError to HTTP.
      handleError(res, err);
    });
  });
}

// ── _parseMcpListJson unit tests ─────────────────────────────────────────────

describe("_parseMcpListJson", () => {
  it("parses a JSON array from `hermes mcp list --json`", () => {
    const raw = JSON.stringify([
      { name: "cdsk", transport: "stdio", command: "node /opt/cdsk.js", enabled: true },
      { name: "my-api", type: "http", url: "https://example.com/mcp", enabled: true },
    ]);
    const servers = _parseMcpListJson(raw);
    assert.equal(servers.length, 2);
    assert.equal(servers[0].name, "cdsk");
    assert.equal(servers[0].type, "stdio");
    assert.equal(servers[0].command_or_url, "node /opt/cdsk.js");
    assert.equal(servers[1].name, "my-api");
    assert.equal(servers[1].type, "http");
  });

  it("parses a JSON object (name → def shape)", () => {
    const raw = JSON.stringify({
      sure: { transport: "stdio", command: "node /opt/sure.js" },
      plane: { type: "http", url: "https://plane.example.com/mcp" },
    });
    const servers = _parseMcpListJson(raw);
    assert.equal(servers.length, 2);
    const sure = servers.find((s) => s.name === "sure");
    assert.ok(sure, "sure must be present");
    assert.equal(sure!.type, "stdio");
  });

  it("returns [] for empty string", () => {
    assert.deepEqual(_parseMcpListJson(""), []);
  });

  it("returns [] for non-JSON text", () => {
    assert.deepEqual(_parseMcpListJson("  Listing MCP servers for profile cratchit\n  (none)\n"), []);
  });

  it("marks enabled: true by default, respects enabled: false", () => {
    const raw = JSON.stringify([
      { name: "a", transport: "stdio", command: "x" },
      { name: "b", transport: "stdio", command: "y", enabled: false },
    ]);
    const [a, b] = _parseMcpListJson(raw);
    assert.equal(a.enabled, true);
    assert.equal(b.enabled, false);
  });
});

// ── _readMcpFromConfig unit tests ────────────────────────────────────────────

describe("_readMcpFromConfig", () => {
  before(() => {
    const profileDir = path.join(tmp, "profiles", "test-profile");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "config.yaml"),
      `
mcp_servers:
  sure:
    transport: stdio
    command: node /opt/mcp-stdio/dist/index.js
  alfred-ctrl:
    transport: http
    url: http://ctrl-api:3100/mcp
`,
    );
  });

  it("reads stdio and http servers from config.yaml", () => {
    const servers = _readMcpFromConfig("test-profile");
    assert.equal(servers.length, 2);
    const sure = servers.find((s) => s.name === "sure");
    assert.ok(sure);
    assert.equal(sure!.type, "stdio");
    assert.equal(sure!.command_or_url, "node /opt/mcp-stdio/dist/index.js");
    const ctrl = servers.find((s) => s.name === "alfred-ctrl");
    assert.ok(ctrl);
    assert.equal(ctrl!.type, "http");
    assert.equal(ctrl!.command_or_url, "http://ctrl-api:3100/mcp");
  });

  it("returns [] for a missing profile dir", () => {
    const servers = _readMcpFromConfig("no-such-profile");
    assert.deepEqual(servers, []);
  });
});

// ── route integration tests ──────────────────────────────────────────────────

describe("GET /api/v1/admin/profiles/:slug/mcp", () => {
  beforeEach(() => {
    dockerExecCalls.length = 0;
    dockerExecHandler = async (_svc, _cmd) => {
      throw new Error("hermes CLI unavailable");
    };
  });

  it("returns server-list shape from CLI JSON when hermes is reachable", async () => {
    dockerExecHandler = async (_svc, _cmd) =>
      JSON.stringify([
        { name: "cdsk", transport: "stdio", command: "node /opt/cdsk.js", enabled: true },
      ]);

    // Create a non-reserved test profile in the DB.
    const { createProfile, getProfile } = await import("../src/db/agentProfiles.js");
    const { getStateDb } = await import("../src/db/state.js");
    // Ensure the profile exists — idempotent slug from prior test run would throw, so try.
    try {
      createProfile(getStateDb(), { slug: "sentinel", label: "Sentinel", model: "x" });
    } catch { /* already exists */ }

    const { status, body } = await invokeGet("sentinel");
    assert.equal(status, 200);
    assert.equal(body.slug, "sentinel");
    assert.equal(body.reserved, false);
    assert.ok(Array.isArray(body.servers));
    assert.equal(body.servers.length, 1);
    assert.equal(body.servers[0].name, "cdsk");
    assert.equal(body.source, "cli");
  });

  it("falls back to config.yaml when CLI throws", async () => {
    dockerExecHandler = async () => { throw new Error("cli not available"); };

    // Write a config.yaml for the sentinel profile.
    const sentinelDir = path.join(tmp, "profiles", "sentinel");
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.writeFileSync(
      path.join(sentinelDir, "config.yaml"),
      `
mcp_servers:
  sure:
    transport: stdio
    command: node /opt/mcp-stdio/dist/index.js
`,
    );

    const { status, body } = await invokeGet("sentinel");
    assert.equal(status, 200);
    assert.equal(body.source, "config");
    assert.ok(Array.isArray(body.servers));
    const sure = body.servers.find((s: any) => s.name === "sure");
    assert.ok(sure, "sure must appear from config.yaml fallback");
  });

  it("returns 404 for an unknown profile slug", async () => {
    const { status, body } = await invokeGet("no-such-slug-xyz");
    assert.equal(status, 404, `expected 404 but got ${status}: ${JSON.stringify(body)}`);
  });

  it("includes reserved=true for the main profile", async () => {
    dockerExecHandler = async () =>
      JSON.stringify([{ name: "alfred", transport: "stdio", command: "node" }]);
    const { status, body } = await invokeGet("main");
    assert.equal(status, 200);
    assert.equal(body.reserved, true);
    // GET is allowed on reserved profiles (read-only is fine)
  });
});

describe("POST /api/v1/admin/profiles/:slug/mcp — reserved profile → 409", () => {
  beforeEach(() => { dockerExecCalls.length = 0; });

  it("returns 409 for main", async () => {
    const { status, body } = await invokePost("main", {
      name: "cdsk",
      url: "https://cdsk.example.com/mcp",
    });
    assert.equal(status, 409, `expected 409 but got ${status}: ${JSON.stringify(body)}`);
    assert.match(body.error.message, /reserved_profile/);
  });

  it("returns 409 for workers", async () => {
    const { status, body } = await invokePost("workers", {
      name: "cdsk",
      url: "https://cdsk.example.com/mcp",
    });
    assert.equal(status, 409);
  });

  it("returns 409 for heavy", async () => {
    const { status } = await invokePost("heavy", {
      name: "cdsk",
      url: "https://cdsk.example.com/mcp",
    });
    assert.equal(status, 409);
  });

  it("returns 409 for codex-builder", async () => {
    const { status } = await invokePost("codex-builder", {
      name: "cdsk",
      url: "https://cdsk.example.com/mcp",
    });
    assert.equal(status, 409);
  });
});

describe("DELETE /api/v1/admin/profiles/:slug/mcp/:name — reserved profile → 409", () => {
  beforeEach(() => { dockerExecCalls.length = 0; });

  it("returns 409 for main", async () => {
    const { status } = await invokeDelete("main", "some-server");
    assert.equal(status, 409);
  });

  it("returns 409 for workers", async () => {
    const { status } = await invokeDelete("workers", "some-server");
    assert.equal(status, 409);
  });
});

describe("POST+DELETE round-trip on a non-reserved profile", () => {
  beforeEach(() => { dockerExecCalls.length = 0; });

  it("POST calls hermes mcp add with y\\ny\\n stdin and returns 201", async () => {
    dockerExecWithStdinHandler = async (_svc, _cmd, _stdin) => ({
      stdout: "Added server 'cdsk' to profile 'sentinel'",
      stderr: "",
    });

    const { status, body } = await invokePost("sentinel", {
      name: "cdsk",
      url: "https://cdsk.example.com/mcp",
    });
    assert.equal(status, 201, `expected 201 but got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    assert.equal(body.name, "cdsk");

    // Verify the dockerExecWithStdin call shape.
    const addCall = dockerExecCalls.find((c) =>
      c.command.includes("add") && c.command.includes("cdsk"),
    );
    assert.ok(addCall, "hermes mcp add must have been called");
    assert.equal(addCall!.service, "hermes");
    assert.ok(addCall!.command.includes("mcp"), "command must include 'mcp'");
    assert.ok(addCall!.command.includes("-p"), "command must include '-p' flag");
    assert.ok(addCall!.command.includes("sentinel"), "command must reference the slug");
    assert.equal(addCall!.stdin, "y\ny\n", "stdin must pipe 'y\\ny\\n' for interactive prompts");
  });

  it("DELETE calls hermes mcp remove and returns 200 { ok: true }", async () => {
    dockerExecHandler = async (_svc, _cmd) => "";

    const { status, body } = await invokeDelete("sentinel", "cdsk");
    assert.equal(status, 200, `expected 200 but got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);

    const removeCall = dockerExecCalls.find((c) =>
      c.command.includes("remove") && c.command.includes("cdsk"),
    );
    assert.ok(removeCall, "hermes mcp remove must have been called");
    assert.equal(removeCall!.service, "hermes");
    assert.ok(removeCall!.command.includes("-p"));
    assert.ok(removeCall!.command.includes("sentinel"));
  });

  it("POST with stdio command sends --transport stdio", async () => {
    dockerExecWithStdinHandler = async () => ({ stdout: "", stderr: "" });

    const { status, body } = await invokePost("sentinel", {
      name: "my-stdio-server",
      command: "node /opt/my-server/dist/index.js",
    });
    assert.equal(status, 201, `expected 201 but got ${status}: ${JSON.stringify(body)}`);

    const addCall = dockerExecCalls.find((c) =>
      c.command.includes("my-stdio-server"),
    );
    assert.ok(addCall);
    assert.ok(
      addCall!.command.includes("stdio"),
      "stdio transport flag must be present",
    );
  });

  it("POST returns 400 when neither url nor command is supplied", async () => {
    const { status } = await invokePost("sentinel", { name: "cdsk" });
    assert.equal(status, 400);
  });

  it("POST returns 400 for invalid name characters", async () => {
    const { status } = await invokePost("sentinel", {
      name: "bad name!",
      url: "https://example.com",
    });
    assert.equal(status, 400);
  });

  it("POST returns 404 for unknown profile slug", async () => {
    const { status } = await invokePost("no-such-slug-xyz", {
      name: "cdsk",
      url: "https://cdsk.example.com/mcp",
    });
    assert.equal(status, 404);
  });
});
