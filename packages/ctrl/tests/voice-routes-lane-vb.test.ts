// #120 Lane Vb — per-profile voice routes (PUT/DELETE/test/inbound).
//
// Lane I's voice-routes.test.ts covers /status; this file covers the
// per-profile credential surface added in Lane Vb. We mirror the SMS test
// shape (docker exec + Twilio API + assertWritableProfile mocks) so the
// surface stays consistent.

import { mock, describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voice-vb-"));
process.env.COMPOSE_DIR = tmp;
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_CLI_URL = "http://vault-cli-stub:8087";
process.env.HERMES_HOME_IN_CONTAINER = "/hermes-state";
process.env.DOMAIN = "home.alfred.black";

const SENTINEL_PROFILE_DIR = "/hermes-state/profiles/sentinel-vb";
const SENTINEL_ENV_PATH = `${SENTINEL_PROFILE_DIR}/.env`;
const MAIN_PROFILE_DIR = "/hermes-state/profiles/main";
const MAIN_ENV_PATH = `${MAIN_PROFILE_DIR}/.env`;

const VALID_SID = "AC" + "1".repeat(32);
const VALID_TOKEN = "1".repeat(32);
const VALID_FROM = "+15552222222";
const VALID_OPENAI = "sk-test_lane_vb_per_profile_key_value_12345";

// ── docker exec mock state ───────────────────────────────────────────────
let containerFiles: Record<string, string> = {};
const dockerExecCalls: { service: string; command: string[] }[] = [];
const dockerExecWithStdinCalls: {
  service: string;
  command: string[];
  stdin: string;
}[] = [];
const dockerComposeCalls: string[][] = [];

function defaultDockerExec(_service: string, command: string[]): string {
  if (command[0] === "sh" && command[1] === "-c") {
    const script = command[2] ?? "";
    const catMatch = script.match(/^cat\s+(\S+)\s+2>\/dev\/null\s+\|\|\s+true$/);
    if (catMatch) return containerFiles[catMatch[1]] ?? "";
    return "";
  }
  return "";
}

const realHelpers = await import("../src/api/helpers.js");
mock.module("../src/api/helpers.js", {
  namedExports: {
    ...realHelpers,
    dockerExec: async (service: string, command: string[]) => {
      dockerExecCalls.push({ service, command: [...command] });
      return defaultDockerExec(service, command);
    },
    dockerExecWithStdin: async (
      service: string,
      command: string[],
      stdin: string,
    ) => {
      dockerExecWithStdinCalls.push({ service, command: [...command], stdin });
      const script = command[2] ?? "";
      const mvMatch = script.match(/mv\s+\S+\s+(\S+)$/);
      if (mvMatch) containerFiles[mvMatch[1]] = stdin;
      return { stdout: "", stderr: "" };
    },
    dockerComposeCmd: async (args: string[]) => {
      dockerComposeCalls.push([...args]);
      // ps voice-bridge — return empty (service missing) so /status's compose
      // probe doesn't crash. Tests that need a present service override
      // later via mock.fn().
      if (args[0] === "ps" && args[1] === "voice-bridge") return "";
      return "";
    },
  },
});

// ── Twilio account probe mock ────────────────────────────────────────────

let twilioAccountsOk = true;
const originalFetch = globalThis.fetch;
function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: any, _init?: any) => {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  const acctMatch = url.match(
    /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/(AC[a-f0-9]+)\.json$/,
  );
  if (acctMatch) {
    if (!twilioAccountsOk) {
      return makeJsonResponse(
        { code: 20003, message: "Authentication Error" },
        401,
      );
    }
    return makeJsonResponse(
      { sid: acctMatch[1], friendly_name: "Sentinel Test", status: "active" },
      200,
    );
  }
  throw new Error(`unexpected fetch in voice-vb test: ${url}`);
}) as typeof fetch;

// ── agentProfiles mock: writability + binding default ────────────────────
//
// assertWritableProfile must succeed for sentinel-vb; resolveProfileForChannel
// returns "main" as the default binding (matching the real seed). We mock
// the whole module so tests don't need a real state.db.

const realAgentProfiles = await import("../src/db/agentProfiles.js");
let profileExists = true;
let profileIsArchived = false;
mock.module("../src/db/agentProfiles.js", {
  namedExports: {
    ...realAgentProfiles,
    assertWritableProfile: (_db: any, slug: string) => {
      if (!profileExists) {
        throw new Error(`profile '${slug}' not found`);
      }
      if (profileIsArchived) {
        throw new Error(`profile '${slug}' is archived`);
      }
      return { slug, label: slug, status: "running" };
    },
    resolveProfileForChannel: (_db: any, _kind: string, _id: any) => "main",
    resolveProfileContextForChannel: (
      _db: any,
      _kind: string,
      identity: any,
    ) => ({
      slug: "main",
      deployment_shape: "supervised",
      bound_slug: "main",
      cascaded: false,
      api_server_port: 18789,
      api_server_key: null,
      profile_dir: "/hermes-state/profiles/main",
      journal_scope_key: "main",
    }),
  },
});

// Audit rows land in the real state.db via appendAudit. We open it to query
// rows after each mutation rather than mocking the import (which races
// voice.ts's top-level import). The state.db path is the per-test tmpdir
// (set above), so the rows are scoped to this file.

const { registerVoiceRoutes } = await import("../src/api/routes/voice.js");
const { getStateDb } = await import("../src/db/state.js");

function queryAuditRows(targetPath: string): any[] {
  try {
    const db = getStateDb();
    const rows = db
      .prepare(
        "SELECT action_type, actor, source, target_path, target_kind, subject_ref, summary, payload_json FROM audit WHERE target_path = ? ORDER BY id DESC LIMIT 50",
      )
      .all(targetPath) as any[];
    return rows.map((r) => ({
      ...r,
      payload: r.payload_json ? JSON.parse(r.payload_json) : null,
    }));
  } catch {
    return [];
  }
}
const { matchRoute } = await import("../src/api/server.js");
registerVoiceRoutes();

interface CallResult {
  status: number;
  payload: any;
  rawBody?: string;
  contentType?: string;
}

async function call(
  method: string,
  p: string,
  body?: unknown,
  opts: { contentType?: string; rawBody?: string } = {},
): Promise<CallResult> {
  const [pathOnly, queryRaw] = p.split("?");
  const m = matchRoute(method, pathOnly);
  assert.ok(m, `${method} ${pathOnly} must be registered`);
  let status = 0;
  let payload: any;
  let rawBody: string | undefined;
  let contentType: string | undefined;
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 0,
    setHeader(name: string, val: string) {
      headers[String(name).toLowerCase()] = val;
    },
    writeHead(c: number, h?: Record<string, string>) {
      status = c;
      if (h) {
        for (const [k, v] of Object.entries(h)) {
          headers[k.toLowerCase()] = v;
        }
      }
      contentType = headers["content-type"];
    },
    end(j?: string) {
      rawBody = j;
      try {
        payload = j ? JSON.parse(j) : undefined;
      } catch {
        payload = undefined;
      }
    },
  };
  const req: any = {
    method,
    headers: { "content-type": opts.contentType ?? "application/json" },
  };
  if (opts.rawBody && opts.contentType?.includes("urlencoded")) {
    // Simulate the request stream for the inbound route's raw-body reader.
    const { Readable } = await import("node:stream");
    const stream = Readable.from([Buffer.from(opts.rawBody)]);
    Object.assign(req, {
      on: stream.on.bind(stream),
      pipe: stream.pipe.bind(stream),
    });
  }
  try {
    await m!.handler({
      req,
      res,
      params: {},
      body: opts.rawBody && opts.contentType?.includes("urlencoded") ? undefined : body,
      query: new URLSearchParams(queryRaw ?? ""),
    });
  } catch (e: any) {
    if (e?.statusCode) {
      status = e.statusCode;
      payload = { error: { code: e.code, message: e.message } };
    } else {
      throw e;
    }
  }
  return { status: status || res.statusCode, payload, rawBody, contentType };
}

describe("/api/v1/channels/voice/* — per-profile (Lane Vb)", () => {
  beforeEach(() => {
    containerFiles = {};
    dockerExecCalls.length = 0;
    dockerExecWithStdinCalls.length = 0;
    dockerComposeCalls.length = 0;
    twilioAccountsOk = true;
    // Wipe any prior audit rows so this test's assertions are scoped to
    // its own writes. The state.db is a per-suite tmpdir file so this is
    // a cheap rm.
    try {
      const db = getStateDb();
      db.prepare("DELETE FROM audit WHERE target_path LIKE 'channels/voice/%'").run();
    } catch {
      /* ignore — state.db not initialised yet */
    }
    profileExists = true;
    profileIsArchived = false;
  });

  it("GET /status?profile=sentinel-vb returns webhook_url + profile_slug echoed", async () => {
    containerFiles[SENTINEL_ENV_PATH] = "# empty\n";
    const r = await call(
      "GET",
      "/api/v1/channels/voice/status?profile=sentinel-vb",
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.profile_slug, "sentinel-vb");
    assert.equal(
      r.payload.webhook_url,
      "https://voice.home.alfred.black/twiml/inbound?profile=sentinel-vb",
    );
    assert.equal(r.payload.configured, false);
  });

  it("PUT /credentials valid triple → writes per-profile .env + audit + Twilio probe", async () => {
    const r = await call(
      "PUT",
      "/api/v1/channels/voice/credentials?profile=sentinel-vb",
      {
        account_sid: VALID_SID,
        auth_token: VALID_TOKEN,
        from_number: VALID_FROM,
        openai_key: VALID_OPENAI,
      },
    );
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.profile, "sentinel-vb");

    const wrote = dockerExecWithStdinCalls.find((c) =>
      c.command[2]?.includes(SENTINEL_ENV_PATH),
    );
    assert.ok(wrote, "dockerExecWithStdin should have written sentinel-vb's .env");
    assert.equal(wrote.service, "hermes");
    assert.match(wrote.stdin, new RegExp(`TWILIO_ACCOUNT_SID=${VALID_SID}`));
    assert.match(wrote.stdin, new RegExp(`TWILIO_AUTH_TOKEN=${VALID_TOKEN}`));
    assert.match(
      wrote.stdin,
      new RegExp(`TWILIO_VOICE_FROM_NUMBER=\\${VALID_FROM}`),
    );
    assert.match(wrote.stdin, /OPENAI_API_KEY=sk-test_lane_vb/);

    // The .env write target is sentinel-vb's, never main's.
    const wroteToMain = dockerExecWithStdinCalls.find((c) =>
      c.command[2]?.includes(MAIN_ENV_PATH),
    );
    assert.equal(
      wroteToMain,
      undefined,
      "credentials write must NOT touch main's .env",
    );

    // Audit row with profile_slug = sentinel-vb (persisted via real
    // state.db).
    const rows = queryAuditRows("channels/voice/credentials");
    const setRow = rows.find((r) => r.action_type === "channel_token_set");
    assert.ok(setRow, "expected channel_token_set audit row");
    assert.equal(setRow.subject_ref, "sentinel-vb");
    assert.equal(setRow.payload.profile_slug, "sentinel-vb");
    assert.equal(setRow.payload.channel_kind, "voice");
    assert.equal(setRow.payload.openai_key_set, true);
  });

  it("PUT /credentials rejects malformed SID → 400, no .env write, no audit", async () => {
    const r = await call(
      "PUT",
      "/api/v1/channels/voice/credentials?profile=sentinel-vb",
      {
        account_sid: "not-a-sid",
        auth_token: VALID_TOKEN,
        from_number: VALID_FROM,
      },
    );
    assert.equal(r.status, 400);
    assert.equal(
      dockerExecWithStdinCalls.length,
      0,
      "no .env write on validation failure",
    );
    const rowsAfterFail = queryAuditRows("channels/voice/credentials");
    assert.equal(rowsAfterFail.length, 0, "no audit row on validation failure");
  });

  it("PUT /credentials rejects archived profile → 400", async () => {
    profileIsArchived = true;
    const r = await call(
      "PUT",
      "/api/v1/channels/voice/credentials?profile=sentinel-vb",
      {
        account_sid: VALID_SID,
        auth_token: VALID_TOKEN,
        from_number: VALID_FROM,
      },
    );
    assert.equal(r.status, 400);
  });

  it("DELETE /credentials wipes the 4 voice .env keys + audit row", async () => {
    containerFiles[SENTINEL_ENV_PATH] =
      `TWILIO_ACCOUNT_SID=${VALID_SID}\n` +
      `TWILIO_AUTH_TOKEN=${VALID_TOKEN}\n` +
      `TWILIO_VOICE_FROM_NUMBER=${VALID_FROM}\n` +
      `OPENAI_API_KEY=${VALID_OPENAI}\n` +
      `OTHER_KEEP_ME=preserved\n`;

    const r = await call(
      "DELETE",
      "/api/v1/channels/voice/credentials?profile=sentinel-vb",
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);

    const wrote = dockerExecWithStdinCalls.find((c) =>
      c.command[2]?.includes(SENTINEL_ENV_PATH),
    );
    assert.ok(wrote, "dockerExecWithStdin must have rewritten sentinel's .env");
    assert.doesNotMatch(wrote.stdin, /^TWILIO_ACCOUNT_SID=/m);
    assert.doesNotMatch(wrote.stdin, /^TWILIO_AUTH_TOKEN=/m);
    assert.doesNotMatch(wrote.stdin, /^TWILIO_VOICE_FROM_NUMBER=/m);
    assert.doesNotMatch(wrote.stdin, /^OPENAI_API_KEY=/m);
    assert.match(wrote.stdin, /OTHER_KEEP_ME=preserved/);

    const rowsAfterDelete = queryAuditRows("channels/voice/credentials");
    const clearRow = rowsAfterDelete.find(
      (r) => r.action_type === "channel_token_cleared",
    );
    assert.ok(clearRow);
    assert.equal(clearRow.subject_ref, "sentinel-vb");
  });

  it("POST /test probes Twilio with the profile's stored creds", async () => {
    containerFiles[SENTINEL_ENV_PATH] =
      `TWILIO_ACCOUNT_SID=${VALID_SID}\n` +
      `TWILIO_AUTH_TOKEN=${VALID_TOKEN}\n` +
      `TWILIO_VOICE_FROM_NUMBER=${VALID_FROM}\n`;

    const r = await call(
      "POST",
      "/api/v1/channels/voice/test?profile=sentinel-vb",
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);
    assert.match(r.payload.account_sid_masked, /^AC\*+[0-9a-f]{4}$/);
  });

  it("POST /inbound?profile=sentinel-vb&format=json resolves to sentinel-vb in TwiML wss URL", async () => {
    const r = await call(
      "POST",
      "/api/v1/channels/voice/inbound?profile=sentinel-vb&format=json",
      { To: "+15552222222", From: "+15555550100", CallSid: "CAtest-vb" },
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.resolved_profile, "sentinel-vb");
    assert.equal(r.payload.resolved_by, "query");
    assert.match(r.payload.wss_url, /\/voice\/sentinel-vb$/);
    assert.match(r.payload.twiml, /<Parameter name="profile" value="sentinel-vb"/);
  });

  it("POST /inbound without ?profile= falls back to main (default binding)", async () => {
    const r = await call(
      "POST",
      "/api/v1/channels/voice/inbound?format=json",
      { To: "+15551111111", From: "+15555550100", CallSid: "CAtest-vb-main" },
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.resolved_profile, "main");
    assert.equal(r.payload.resolved_by, "to-binding");
    assert.match(r.payload.wss_url, /\/voice\/main$/);
  });

  it("GET /internal/openai-key?profile=sentinel-vb returns the profile's key", async () => {
    containerFiles[SENTINEL_ENV_PATH] = `OPENAI_API_KEY=${VALID_OPENAI}\n`;
    const r = await call(
      "GET",
      "/api/v1/channels/voice/internal/openai-key?profile=sentinel-vb",
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.profile, "sentinel-vb");
    assert.equal(r.payload.openai_api_key, VALID_OPENAI);
  });

  it("GET /internal/openai-key for sentinel-vb without per-profile key returns null (no main fallback)", async () => {
    containerFiles[SENTINEL_ENV_PATH] = "# no openai\n";
    const r = await call(
      "GET",
      "/api/v1/channels/voice/internal/openai-key?profile=sentinel-vb",
    );
    assert.equal(r.status, 200);
    assert.equal(r.payload.openai_api_key, null);
  });
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
});
