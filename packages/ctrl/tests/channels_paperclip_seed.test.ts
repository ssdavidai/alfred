// Lane I — /api/v1/channels/paperclip/status full-seed coverage.
//
// What's under test
// -----------------
// The "ready" setup_state path added by the headless full-seed PR
// (2026-05-27). When PAPERCLIP_AGENT_TOKEN is set in env AND
// /alfred-data/paperclip-seed-credentials.json carries valid seed
// metadata, ctrl-api MUST:
//
//   1. flip setup_state to "ready" (highest-priority state)
//   2. surface seed_company_name + seed_agent_name on /status
//   3. include seed_company_id + seed_agent_id when present
//   4. NOT roundtrip against paperclip:3100 (no http.request call)
//   5. NOT surface admin_invite_url even when the invite file still exists
//      (it's stale once the seed has landed)
//
// And the inverse: without PAPERCLIP_AGENT_TOKEN, the legacy
// needs_admin_signup / needs_api_key paths still hold.
//
// Privacy: this is a public OSS repo. We use the dummy `pcp_test_…` token
// shape to avoid tripping gitleaks.

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-paperclip-seed-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "alfred-state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.DOMAIN = "seedtest.alfred.black";
process.env.AAS_HOST = "127.0.0.1";
process.env.AAS_PORT = "3100";

// Per-profile Hermes API key file the channels_paperclip module reads;
// give it a value so the module's read-on-import path doesn't blow up.
const hermesProfilesDir = path.join(tmp, "hermes-profiles");
fs.mkdirSync(path.join(hermesProfilesDir, "main"), { recursive: true });
fs.writeFileSync(
  path.join(hermesProfilesDir, "main", ".env"),
  "API_SERVER_KEY=test-hermes-key\n",
);
process.env.HERMES_CONFIG_DIR = hermesProfilesDir;

// Drive the seed-metadata file location via env. The route reads
// PAPERCLIP_SEED_CREDENTIALS_FILE first, then falls back to
// /alfred-data/paperclip-seed-credentials.json.
const seedCredentialsFile = path.join(tmp, "paperclip-seed-credentials.json");
process.env.PAPERCLIP_SEED_CREDENTIALS_FILE = seedCredentialsFile;
// The invite file path — used by the legacy needs_admin_signup branch.
const paperclipInviteFile = path.join(tmp, "paperclip-ceo-invite.txt");
process.env.PAPERCLIP_INVITE_FILE = paperclipInviteFile;

// Intercept http.request — the legacy non-ready branches call out to
// paperclip:3100, and we want to be SURE the ready branch never does.
const originalHttpRequest = http.request;
let paperclipHttpCalls = 0;
(http as any).request = ((options: any, cb?: (resp: any) => void) => {
  const host = options?.hostname ?? "";
  if (host === "paperclip") {
    paperclipHttpCalls += 1;
    // Synthesize a 200 OK with empty body so the legacy paths don't see
    // an "unreachable" branch — we want to be able to assert the call
    // count, not have the route die.
    const handlers: Record<string, ((arg?: any) => void)[]> = {};
    const msg: any = {
      statusCode: 200,
      on(ev: string, h: (arg?: any) => void) {
        (handlers[ev] ||= []).push(h);
        return msg;
      },
      resume() {
        setImmediate(() => (handlers["end"] || []).forEach((cb) => cb()));
      },
    };
    const req: any = {
      on() {
        return req;
      },
      end() {
        // Fire the response callback first (synchronously-ish via
        // setImmediate so it doesn't run before .on('error') etc. are
        // attached). After the route's handler attaches its data/end
        // handlers on `msg`, we deliver the body bytes + end in a
        // following microtask.
        setImmediate(() => {
          cb?.(msg);
          setImmediate(() => {
            (handlers["data"] || []).forEach((h) =>
              h(Buffer.from("<!doctype html><html></html>", "utf-8")),
            );
            (handlers["end"] || []).forEach((h) => h());
          });
        });
        return req;
      },
      destroy() {},
      setTimeout() {},
    };
    return req;
  }
  return (originalHttpRequest as any)(options, cb);
}) as typeof http.request;

// Module imports must happen after env setup so the route binds against
// our overrides.
const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { registerPaperclipChannelRoutes } = await import(
  "../src/api/routes/channels_paperclip.js"
);
registerPaperclipChannelRoutes();

async function invokeRoute(
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead(c: number) {
      status = c;
      return res;
    },
    end(j?: string) {
      payload = j ? JSON.parse(j) : undefined;
    },
  } as unknown as ServerResponse;
  try {
    await m!.handler({
      req: { method, url: p, headers } as any,
      res,
      params: m!.params,
      body,
      query: new URLSearchParams(),
    });
  } catch (err) {
    handleError(res, err);
  }
  return { status, payload };
}

// Lightweight reset between tests.
function clearSeedState() {
  delete process.env.PAPERCLIP_AGENT_TOKEN;
  delete process.env.PAPERCLIP_AGENT_ID;
  delete process.env.PAPERCLIP_COMPANY_ID;
  delete process.env.PAPERCLIP_API_KEY;
  delete process.env.PAPERCLIP_HEARTBEAT_SECRET;
  delete process.env.PAPERCLIP_SEED_COMPANY;
  delete process.env.PAPERCLIP_SEED_AGENT_NAME;
  for (const f of [seedCredentialsFile, paperclipInviteFile]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* may not exist */
    }
  }
  paperclipHttpCalls = 0;
}

describe("/api/v1/channels/paperclip/status — full-seed (ready state)", () => {
  beforeEach(clearSeedState);

  it("setup_state=ready when PAPERCLIP_AGENT_TOKEN is set + seed JSON is on disk", async () => {
    // Step 11a wrote the seed JSON; step 11b appended PAPERCLIP_AGENT_TOKEN
    // to /opt/alfred/.env, which compose loads into ctrl-api's env.
    process.env.PAPERCLIP_AGENT_TOKEN = "pcp_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    process.env.PAPERCLIP_AGENT_ID = "agt_test_001";
    process.env.PAPERCLIP_COMPANY_ID = "cmp_test_001";
    fs.writeFileSync(
      seedCredentialsFile,
      JSON.stringify({
        email: "alfred@seedtest.alfred.black",
        name: "Alfred",
        password: "redacted",
        company: "Alfred",
        company_id: "cmp_test_001",
        agent: "hermes",
        agent_id: "agt_test_001",
        agent_token: "pcp_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    );
    const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.setup_state, "ready");
    assert.equal(r.payload.seed_company_name, "Alfred");
    assert.equal(r.payload.seed_company_id, "cmp_test_001");
    assert.equal(r.payload.seed_agent_name, "hermes");
    assert.equal(r.payload.seed_agent_id, "agt_test_001");
    // The ready branch MUST NOT roundtrip against paperclip:3100 — every
    // dashboard poll would otherwise hit the upstream and slow the page.
    assert.equal(paperclipHttpCalls, 0, "ready must be probe-free");
  });

  it("setup_state=ready falls back to default labels when seed JSON is missing", async () => {
    // If alfred_data is wiped (operator reset) but PAPERCLIP_AGENT_TOKEN
    // is still in the host .env, we still flip to "ready" with sensible
    // defaults — better than dropping back to needs_admin_signup and
    // confusing the principal.
    process.env.PAPERCLIP_AGENT_TOKEN = "pcp_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    // No seed file written. No env company override either.
    const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.setup_state, "ready");
    assert.equal(r.payload.seed_company_name, "Alfred");
    assert.equal(r.payload.seed_agent_name, "hermes");
  });

  it("setup_state=ready respects PAPERCLIP_SEED_COMPANY override from env", async () => {
    // The bootstrap script lets the operator override the company name
    // (PAPERCLIP_SEED_COMPANY env), and the route prefers seed JSON →
    // env → default in that order. With no JSON, the env value wins.
    process.env.PAPERCLIP_AGENT_TOKEN = "pcp_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    process.env.PAPERCLIP_SEED_COMPANY = "Szabostuban Household";
    process.env.PAPERCLIP_SEED_AGENT_NAME = "alfred";
    const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
    assert.equal(r.payload.seed_company_name, "Szabostuban Household");
    assert.equal(r.payload.seed_agent_name, "alfred");
  });

  it("setup_state=ready does NOT surface admin_invite_url even when the invite file is present", async () => {
    // The invite file may linger after a full-seed run (step 5 wrote it
    // before steps 6–11 redeemed it). The route must NOT surface it on
    // ready — it would be stale and confusing.
    process.env.PAPERCLIP_AGENT_TOKEN = "pcp_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    fs.writeFileSync(
      paperclipInviteFile,
      "https://paperclip.seedtest.alfred.black/invite/pcp_bootstrap_stale\n",
    );
    const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
    assert.equal(r.payload.setup_state, "ready");
    assert.equal(r.payload.admin_invite_url, undefined);
  });

  it("ready takes precedence over needs_api_key/configured (env-token wins over PAPERCLIP_API_KEY)", async () => {
    // Defence in depth: an old tenant might have BOTH PAPERCLIP_API_KEY
    // (legacy paste-key path) AND PAPERCLIP_AGENT_TOKEN (new full-seed
    // path). The new path wins — the principal sees the ready card, not
    // the configured card.
    process.env.PAPERCLIP_AGENT_TOKEN = "pcp_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    process.env.PAPERCLIP_API_KEY = "pcp_test_BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
    assert.equal(r.payload.setup_state, "ready");
    // configured field still reflects whether PAPERCLIP_API_KEY is set
    // (some downstream code keys off it); the principal-facing
    // setup_state is what changes.
    assert.equal(r.payload.configured, true);
  });
});

describe("/api/v1/channels/paperclip/status — legacy paths still hold", () => {
  beforeEach(clearSeedState);
  after(() => {
    // Only restore at the very end so the first describe's tests still
    // see the mock.
    (http as any).request = originalHttpRequest;
  });

  it("setup_state=needs_admin_signup when no token + invite file is present (legacy fallback)", async () => {
    fs.writeFileSync(
      paperclipInviteFile,
      "https://paperclip.seedtest.alfred.black/invite/pcp_bootstrap_xyz\n",
    );
    const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.setup_state, "needs_admin_signup");
    assert.equal(
      r.payload.admin_invite_url,
      "https://paperclip.seedtest.alfred.black/invite/pcp_bootstrap_xyz",
    );
  });

  it("setup_state=needs_api_key when no token + no invite file (legacy fallback)", async () => {
    const r = await invokeRoute("GET", "/api/v1/channels/paperclip/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.setup_state, "needs_api_key");
  });
});
