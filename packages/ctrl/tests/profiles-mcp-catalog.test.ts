// profiles-mcp-catalog — unit tests for #204 Lane I per-profile MCP routes.
//
// Routes under test:
//   GET    /api/v1/admin/profiles/:slug/mcp
//   POST   /api/v1/admin/profiles/:slug/mcp
//   DELETE /api/v1/admin/profiles/:slug/mcp/:name
//
// All filesystem I/O goes to a per-test tmp dir (HERMES_CONFIG_DIR).
// nudgeHermesSupervisor is mocked so no docker calls are made.

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── isolate state.db + hermes-state ──────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-mcp-test-"));
process.env.STATE_DB_PATH = path.join(TMP, "state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_PATH = path.join(TMP, "vault");
process.env.ALFRED_DATA_DIR = TMP;
process.env.HERMES_CONFIG_DIR = path.join(TMP, "profiles");
process.env.HERMES_STATE_DIR_CTRL_VIEW = path.join(TMP, "hermes-state");
process.env.INGEST_DB_PATH = path.join(TMP, "ingest.db");
fs.mkdirSync(process.env.HERMES_CONFIG_DIR, { recursive: true });

// ── mock nudgeHermesSupervisor (no docker calls) ──────────────────────────────
const nudgeCalls: string[] = [];

mock.module("../src/hermes/supervisor.js", {
  namedExports: {
    writeSupervisorRegistry: () => {},
    nudgeHermesSupervisor: () => {
      nudgeCalls.push("nudged");
      return true;
    },
    restartProfile: () => ({
      scope: "per-profile",
      attempted: true,
      warning: null,
    }),
    REGISTRY_PATH: path.join(TMP, "hermes-state", "profiles", "_registry.json"),
  },
});

// ── import route layer ─────────────────────────────────────────────────────
const { matchRoute } = await import("../src/api/server.js");
const { registerProfileRoutes } = await import("../src/api/routes/profiles.js");
const { handleError } = await import("../src/api/errors.js");
const { getStateDb } = await import("../src/db/state.js");
const { createProfile } = await import("../src/db/agentProfiles.js");

registerProfileRoutes();

// ── http test helper ───────────────────────────────────────────────────────
// Mirrors the server.ts dispatch loop: wraps the handler in try/catch and
// calls handleError() on thrown ApiErrors so the test sees the HTTP status
// rather than an unhandled rejection.
function invokeRoute(
  method: string,
  url: string,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const matched = matchRoute(method, url);
  assert.ok(matched, `${method} ${url} must be registered`);
  return new Promise((resolve, reject) => {
    const bodyChunks: any[] = [];
    let status = 200;
    const res: any = {
      statusCode: 200,
      setHeader() {},
      writeHead(s: number) {
        status = s;
      },
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
      write(chunk: any) {
        bodyChunks.push(chunk);
      },
    };
    const resolvedParams = matched!.params ?? {};
    // Merge explicit params over matched wildcard params.
    const mergedParams = { ...resolvedParams, ...params };
    Promise.resolve(
      matched!.handler({
        req: {} as any,
        res,
        params: mergedParams,
        query: new URLSearchParams(),
        body: body ?? undefined,
      }),
    ).catch((err) => {
      // Mirror server.ts: ApiErrors become structured HTTP responses.
      try {
        handleError(res, err);
      } catch (e2) {
        reject(e2);
      }
    });
  });
}

// ── helpers ────────────────────────────────────────────────────────────────
function writeConfig(slug: string, content: string): void {
  const dir = path.join(process.env.HERMES_CONFIG_DIR!, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), content, "utf-8");
}

function readConfig(slug: string): string {
  return fs.readFileSync(
    path.join(process.env.HERMES_CONFIG_DIR!, slug, "config.yaml"),
    "utf-8",
  );
}

// ── setup ─────────────────────────────────────────────────────────────────
const SENTINEL_SLUG = "mcp-test-sentinel";

before(() => {
  // Seed a non-reserved user profile in state.db for the tests.
  const db = getStateDb();
  createProfile(db, {
    slug: SENTINEL_SLUG,
    label: "MCP Test Sentinel",
    model: "gpt-4.1",
  });
  nudgeCalls.length = 0;
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── GET tests ─────────────────────────────────────────────────────────────

describe("GET /api/v1/admin/profiles/:slug/mcp", () => {
  it("returns 404 for an unknown slug", async () => {
    const { status, body } = await invokeRoute(
      "GET",
      "/api/v1/admin/profiles/:slug/mcp",
      { slug: "no-such-profile" },
    );
    assert.equal(status, 404);
    assert.match(body.error.message ?? body.error, /not found/i);
  });

  it("returns 200 with empty servers when config.yaml absent", async () => {
    const { status, body } = await invokeRoute(
      "GET",
      "/api/v1/admin/profiles/:slug/mcp",
      { slug: SENTINEL_SLUG },
    );
    assert.equal(status, 200);
    assert.equal(body.slug, SENTINEL_SLUG);
    assert.equal(body.reserved, false);
    assert.deepEqual(body.servers, []);
  });

  it("returns 200 with server list parsed from config.yaml", async () => {
    writeConfig(
      SENTINEL_SLUG,
      `mcp_servers:\n  my-http-server:\n    url: "http://example.invalid"\n  my-stdio:\n    command: node\n    args:\n    - /opt/mcp/stdio.js\n`,
    );
    const { status, body } = await invokeRoute(
      "GET",
      "/api/v1/admin/profiles/:slug/mcp",
      { slug: SENTINEL_SLUG },
    );
    assert.equal(status, 200);
    assert.equal(body.servers.length, 2);
    const httpSrv = body.servers.find((s: any) => s.name === "my-http-server");
    assert.ok(httpSrv, "my-http-server must appear");
    assert.equal(httpSrv.type, "http");
    assert.equal(httpSrv.command_or_url, "http://example.invalid");
    assert.equal(httpSrv.enabled, true);
    const stdioSrv = body.servers.find((s: any) => s.name === "my-stdio");
    assert.ok(stdioSrv, "my-stdio must appear");
    assert.equal(stdioSrv.type, "stdio");
    assert.match(stdioSrv.command_or_url, /node/);
  });

  it("returns reserved=true for 'main'", async () => {
    const { status, body } = await invokeRoute(
      "GET",
      "/api/v1/admin/profiles/:slug/mcp",
      { slug: "main" },
    );
    assert.equal(status, 200);
    assert.equal(body.reserved, true);
  });
});

// ── POST tests ────────────────────────────────────────────────────────────

describe("POST /api/v1/admin/profiles/:slug/mcp", () => {
  it("returns 409 for a reserved profile (main)", async () => {
    const { status, body } = await invokeRoute(
      "POST",
      "/api/v1/admin/profiles/:slug/mcp",
      { slug: "main" },
      { name: "cdsk-test", url: "http://example.invalid" },
    );
    assert.equal(status, 409);
    assert.match(body.error.message ?? body.error, /reserved_profile/);
  });

  it("returns 404 for an unknown slug", async () => {
    const { status, body } = await invokeRoute(
      "POST",
      "/api/v1/admin/profiles/:slug/mcp",
      { slug: "no-such-profile" },
      { name: "cdsk-test", url: "http://example.invalid" },
    );
    assert.equal(status, 404);
    assert.match(body.error.message ?? body.error, /not found/i);
  });

  it("returns 400 when name is missing", async () => {
    const { status } = await invokeRoute(
      "POST",
      "/api/v1/admin/profiles/:slug/mcp",
      { slug: SENTINEL_SLUG },
      { url: "http://example.invalid" },
    );
    assert.equal(status, 400);
  });

  it("returns 400 when name is malformed (uppercase)", async () => {
    const { status, body } = await invokeRoute(
      "POST",
      "/api/v1/admin/profiles/:slug/mcp",
      { slug: SENTINEL_SLUG },
      { name: "BadName", url: "http://example.invalid" },
    );
    assert.equal(status, 400);
    assert.match(body.error.message ?? body.error, /name must match/i);
  });

  it("returns 400 when both url and command are provided", async () => {
    const { status } = await invokeRoute(
      "POST",
      "/api/v1/admin/profiles/:slug/mcp",
      { slug: SENTINEL_SLUG },
      { name: "cdsk-test", url: "http://example.invalid", command: "node /opt/x.js" },
    );
    assert.equal(status, 400);
  });

  it("returns 400 when neither url nor command is provided", async () => {
    const { status } = await invokeRoute(
      "POST",
      "/api/v1/admin/profiles/:slug/mcp",
      { slug: SENTINEL_SLUG },
      { name: "cdsk-test" },
    );
    assert.equal(status, 400);
  });

  it("adds an HTTP MCP server and returns 201; nudges supervisor", async () => {
    nudgeCalls.length = 0;
    const { status, body } = await invokeRoute(
      "POST",
      "/api/v1/admin/profiles/:slug/mcp",
      { slug: SENTINEL_SLUG },
      { name: "cdsk-added", url: "http://example.invalid" },
    );
    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.equal(body.name, "cdsk-added");
    assert.ok(nudgeCalls.length > 0, "supervisor was nudged");
    // Verify config.yaml contains the new server.
    const yaml = readConfig(SENTINEL_SLUG);
    assert.match(yaml, /cdsk-added/);
    assert.match(yaml, /http:\/\/example\.invalid/);
  });

  it("adds a stdio MCP server with command split into args", async () => {
    const { status, body } = await invokeRoute(
      "POST",
      "/api/v1/admin/profiles/:slug/mcp",
      { slug: SENTINEL_SLUG },
      { name: "cdsk-stdio", command: "node /opt/mcp/server.js --port 9999" },
    );
    assert.equal(status, 201);
    assert.equal(body.name, "cdsk-stdio");
    const yaml = readConfig(SENTINEL_SLUG);
    assert.match(yaml, /cdsk-stdio/);
    assert.match(yaml, /node/);
  });
});

// ── DELETE tests ──────────────────────────────────────────────────────────

describe("DELETE /api/v1/admin/profiles/:slug/mcp/:name", () => {
  it("returns 409 for a reserved profile (workers)", async () => {
    const { status, body } = await invokeRoute(
      "DELETE",
      "/api/v1/admin/profiles/:slug/mcp/:name",
      { slug: "workers", name: "something" },
    );
    assert.equal(status, 409);
    assert.match(body.error.message ?? body.error, /reserved_profile/);
  });

  it("returns 404 if the MCP server name is absent from the profile", async () => {
    // Ensure config.yaml exists but does not contain the target server.
    writeConfig(SENTINEL_SLUG, `mcp_servers:\n  other-srv:\n    url: "http://x"\n`);
    const { status, body } = await invokeRoute(
      "DELETE",
      "/api/v1/admin/profiles/:slug/mcp/:name",
      { slug: SENTINEL_SLUG, name: "no-such-server" },
    );
    assert.equal(status, 404);
    assert.match(body.error.message ?? body.error, /not found/i);
  });

  it("removes the server and returns 200; nudges supervisor", async () => {
    // First add a server to remove.
    writeConfig(
      SENTINEL_SLUG,
      `mcp_servers:\n  to-delete:\n    url: "http://to-delete.invalid"\n  keep-me:\n    url: "http://keep.invalid"\n`,
    );
    nudgeCalls.length = 0;
    const { status, body } = await invokeRoute(
      "DELETE",
      "/api/v1/admin/profiles/:slug/mcp/:name",
      { slug: SENTINEL_SLUG, name: "to-delete" },
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(nudgeCalls.length > 0, "supervisor was nudged after delete");
    // Verify to-delete is gone; keep-me survives.
    const yaml = readConfig(SENTINEL_SLUG);
    assert.doesNotMatch(yaml, /to-delete/);
    assert.match(yaml, /keep-me/);
  });
});
