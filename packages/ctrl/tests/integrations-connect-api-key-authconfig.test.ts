// F18 — API-key connect: the Composio v3 `POST /auth_configs` body must nest
// the custom-auth directive under `auth_config`, NOT under `options`.
//
// Composio v3 ignores `type` when it lives under `options`, defaults to
// managed auth, and 400s for toolkits with no managed credentials (SERP, Exa,
// …) with code 306 Auth_Config_DefaultAuthConfigNotFound. The correct shape is
//   { toolkit: { slug }, auth_config: { type: "use_custom_auth", authScheme, credentials: {} } }
// (proven live: serp-apikey-toolkit-findings.md TEST A=400 / TEST B=201).
//
// This test captures the create-auth-config request body and asserts the new
// shape. It must FAIL against the pre-fix `options:{type:...}` body.

import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocked Composio backend — capture the auth_configs create body.
// ---------------------------------------------------------------------------

const composioCalls: Array<{ method: string; url: string; body?: any }> = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  let parsedBody: any;
  if (init?.body) {
    try { parsedBody = JSON.parse(init.body); } catch { /* ignore */ }
  }
  composioCalls.push({ method, url: u, body: parsedBody });

  // GET /api/v3/auth_configs?toolkit_slug=... — none exist, force the create path.
  if (method === "GET" && /\/api\/v3\/auth_configs(?:\?|$)/.test(u)) {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }

  // GET /api/v3/toolkits/:slug — toolkit detail (needed by the field lookup).
  const tkMatch = u.match(/\/api\/v3\/toolkits\/([^?/]+)$/);
  if (method === "GET" && tkMatch) {
    return new Response(JSON.stringify({
      slug: decodeURIComponent(tkMatch[1]),
      auth_config_details: [{
        mode: "API_KEY",
        fields: {
          connected_account_initiation: {
            required: [{ name: "generic_api_key", legacy_template_name: "apikey", is_secret: true }],
          },
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  // POST /api/v3/auth_configs — return a created config id.
  if (method === "POST" && /\/api\/v3\/auth_configs$/.test(u)) {
    return new Response(JSON.stringify({ auth_config: { id: "ac_test123" } }), {
      status: 201, headers: { "content-type": "application/json" },
    });
  }

  // POST /api/v3/connected_accounts — return ACTIVE.
  if (method === "POST" && /\/api\/v3\/connected_accounts$/.test(u)) {
    return new Response(JSON.stringify({ id: "ca_test456", status: "ACTIVE" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: "unmocked", url: u, method }), { status: 501 });
}) as typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// Minimal fs mock so module import doesn't touch the real disk.
// ---------------------------------------------------------------------------
const fsMock = {
  existsSync: mock.fn(() => false),
  readFileSync: mock.fn(() => { const e = new Error("ENOENT") as any; e.code = "ENOENT"; throw e; }),
  writeFileSync: mock.fn(),
  mkdirSync: mock.fn(),
  readdirSync: mock.fn(() => []),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false })),
  unlinkSync: mock.fn(),
  renameSync: mock.fn(),
  appendFileSync: mock.fn(),
  rmSync: mock.fn(),
  chownSync: mock.fn(),
  openSync: mock.fn(() => 0),
  readSync: mock.fn(() => 0),
  closeSync: mock.fn(),
  createReadStream: mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() })),
  Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: mock.fn(async () => undefined), writeFile: mock.fn(async () => undefined) },
};
mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: { ...fsMock },
});

process.env.COMPOSIO_API_KEY = "test-composio-key";
process.env.COMPOSIO_USER_ID = "alfred-test-user";

await import("../src/api/routes/integrations.js");
const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  composioCalls.length = 0;
});

async function req(method: string, pathname: string, body?: unknown): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: pathname,
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

describe("F18 — connect-api-key auth_config body shape", () => {
  it("nests use_custom_auth under auth_config, not options", async () => {
    const { status } = await req("POST", "/api/v1/integrations/connect-api-key", {
      toolkit_slug: "serpapi",
      credential: "dummy-key",
      auth_scheme: "API_KEY",
    });
    assert.strictEqual(status, 200);

    const createCall = composioCalls.find(
      (c) => c.method === "POST" && /\/api\/v3\/auth_configs$/.test(c.url),
    );
    assert.ok(createCall, "expected a POST /auth_configs call");
    const ac = createCall!.body?.auth_config;
    assert.ok(ac, "body.auth_config must be present (not under options)");
    assert.strictEqual(ac.type, "use_custom_auth", "auth_config.type must be use_custom_auth");
    assert.strictEqual(ac.authScheme, "API_KEY", "auth_config.authScheme must echo the scheme");
    assert.deepStrictEqual(ac.credentials, {}, "auth_config.credentials must be {}");
    assert.strictEqual(
      createCall!.body?.options,
      undefined,
      "the broken `options` wrapper must be gone",
    );
    assert.strictEqual(createCall!.body?.toolkit?.slug, "serpapi");
  });
});
