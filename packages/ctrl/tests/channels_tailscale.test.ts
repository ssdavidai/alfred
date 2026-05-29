// channels_tailscale — six ctrl-api routes that drive the off-by-default
// Tailscale sidecar (issue #109 PR 2).
//
// What's under test
// -----------------
//   1. GET /status returns `disabled` when the lifecycle row hasn't been
//      touched (sidecar absent), no docker exec attempted.
//   2. GET /status reconciles BackendState=Running into state='connected'
//      with tailnet_ip + tailnet_hostname populated.
//   3. GET /status returns `error` with last_error/reason when the probe
//      throws (no 500).
//   4. POST /connect with a paste-authkey writes to Vaultwarden, upserts
//      TAILSCALE_AUTHKEY + TAILSCALE_ENABLED=true in .env, and runs
//      `docker compose --profile tailscale up -d tailscale`.
//   5. POST /connect without an authkey skips Vaultwarden, still flips
//      TAILSCALE_ENABLED=true, brings the sidecar up, and leaves state in
//      `authenticating` so /status can pull the auth_url on the next poll.
//   6. POST /connect when state='connected' returns 409 (idempotent guard).
//   7. POST /disconnect runs logout + down + compose stop and flips state to
//      `disabled`. Returns 200 even when docker exec warns (best-effort).
//   8. POST /disconnect flips TAILSCALE_ENABLED back to false.
//   9. (was: GET /cert + POST /serve stubs — now in
//      channels_tailscale_pr4.test.ts as real impls).
//  11. GET /peers returns empty list (no error) when sidecar absent.
//  12. GET /peers extracts peers from the probe JSON when sidecar is live.
//  13. Every write emits an audit row (action_type tailscale_*).

import { mock, describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-tailscale-"));
process.env.COMPOSE_DIR = tmp;
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

// ── helpers mock — capture every docker call ─────────────────────────────

const dockerExecCalls: { service: string; command: string[] }[] = [];
const dockerComposeCalls: string[][] = [];

// dockerExec behaviour per call — tests flip these between cases.
let dockerExecHandler: (service: string, command: string[]) => string | Promise<string> =
  () => "";
let dockerComposeHandler: (args: string[]) => string | Promise<string> = () => "";

const realHelpers = await import("../src/api/helpers.js");
mock.module("../src/api/helpers.js", {
  namedExports: {
    ...realHelpers,
    dockerExec: async (service: string, command: string[]) => {
      dockerExecCalls.push({ service, command: [...command] });
      return await dockerExecHandler(service, command);
    },
    dockerComposeCmd: async (args: string[]) => {
      dockerComposeCalls.push([...args]);
      return await dockerComposeHandler(args);
    },
    // Surface COMPOSE_DIR from the test tmp so the .env upsert lands in a
    // writable directory we can inspect.
    COMPOSE_DIR: tmp,
  },
});

// ── module imports (after env + mocks are wired) ─────────────────────────

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const {
  registerChannelsTailscaleRoutes,
  _setTailscaleProbeForTests,
  _setVaultWriteForTests,
} = await import("../src/api/routes/channels_tailscale.js");
const { getStateDb } = await import("../src/db/state.js");
registerChannelsTailscaleRoutes();

// ── tiny in-process invocation harness ───────────────────────────────────

async function invoke(
  method: string,
  pathname: string,
  body: unknown = null,
): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, pathname);
  assert.ok(m, `${method} ${pathname} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
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
      req: {
        method,
        url: pathname,
        headers: {},
        socket: { remoteAddress: "10.0.0.99" },
      } as any,
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

// Reset to a clean slate between tests: drop the singleton row, clear the
// audit table, clear docker-call captures, restore default handlers.
function clearAll(): void {
  dockerExecCalls.length = 0;
  dockerComposeCalls.length = 0;
  dockerExecHandler = () => "";
  dockerComposeHandler = () => "";
  _setTailscaleProbeForTests(null);
  _setVaultWriteForTests(null);
  const db = getStateDb();
  db.exec("DELETE FROM tailscale_connection");
  db.exec("DELETE FROM audit");
  // Reset .env so each test starts from a clean slate.
  try {
    fs.unlinkSync(`${tmp}/.env`);
  } catch {
    /* may not exist */
  }
}

function readEnv(): Record<string, string> {
  const raw = fs.readFileSync(`${tmp}/.env`, "utf-8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1);
  }
  return out;
}

function listAudit(): { action_type: string; summary: string }[] {
  return getStateDb()
    .prepare("SELECT action_type, summary FROM audit ORDER BY ts ASC")
    .all() as { action_type: string; summary: string }[];
}

// ── tests ────────────────────────────────────────────────────────────────

describe("GET /api/v1/channels/tailscale/status — #109 PR 2", () => {
  beforeEach(clearAll);

  it("returns state='disabled' when sidecar absent (no docker exec attempted)", async () => {
    // Probe must NOT be invoked when state is disabled — the override would
    // throw if called, proving the route short-circuits.
    _setTailscaleProbeForTests(async () => {
      throw new Error("probe should not run when disabled");
    });
    const r = await invoke("GET", "/api/v1/channels/tailscale/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.state, "disabled");
    assert.equal(r.payload.tailnet_ip, null);
    assert.equal(r.payload.tailnet_hostname, null);
    // No docker calls should have fired.
    assert.equal(dockerExecCalls.length, 0);
  });

  it("reconciles a Running BackendState into state='connected' with IP + hostname", async () => {
    // Seed the row into a state that allows the probe to run.
    getStateDb()
      .prepare(
        `INSERT INTO tailscale_connection (id, state, created_at, updated_at)
         VALUES (1, 'starting', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    _setTailscaleProbeForTests(async () => ({
      ok: true,
      status: {
        BackendState: "Running",
        Self: {
          HostName: "home-alfred-black",
          DNSName: "home-alfred-black.tail-acme.ts.net.",
          TailscaleIPs: ["100.64.1.7", "fd7a:115c:a1e0::1"],
          Online: true,
        },
        Peer: {},
        MagicDNSSuffix: "tail-acme.ts.net",
      },
    }));
    const r = await invoke("GET", "/api/v1/channels/tailscale/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.state, "connected");
    assert.equal(r.payload.tailnet_ip, "100.64.1.7");
    assert.equal(
      r.payload.tailnet_hostname,
      "home-alfred-black.tail-acme.ts.net",
      "DNSName trailing dot must be stripped",
    );
    assert.equal(r.payload.last_error, null);
  });

  it("returns state='error' with last_error/reason when probe throws (no 500)", async () => {
    getStateDb()
      .prepare(
        `INSERT INTO tailscale_connection (id, state, created_at, updated_at)
         VALUES (1, 'starting', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    _setTailscaleProbeForTests(async () => ({
      ok: false,
      reason: "probe failed: docker exec exited 137",
    }));
    const r = await invoke("GET", "/api/v1/channels/tailscale/status");
    // CRITICAL: must NOT 500 — fail-soft per spec §5.1.
    assert.equal(r.status, 200);
    assert.equal(r.payload.state, "error");
    assert.match(r.payload.last_error, /probe failed/);
    assert.equal(r.payload.reason, r.payload.last_error);
  });

  it("maps BackendState=NeedsLogin into state='authenticating' with auth_url", async () => {
    getStateDb()
      .prepare(
        `INSERT INTO tailscale_connection (id, state, created_at, updated_at)
         VALUES (1, 'starting', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    _setTailscaleProbeForTests(async () => ({
      ok: true,
      status: {
        BackendState: "NeedsLogin",
        AuthURL: "https://login.tailscale.com/a/abc123",
        Self: { HostName: "home-alfred-black", Online: false },
        Peer: {},
      },
    }));
    const r = await invoke("GET", "/api/v1/channels/tailscale/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.state, "authenticating");
    assert.equal(r.payload.auth_url, "https://login.tailscale.com/a/abc123");
  });
});

describe("POST /api/v1/channels/tailscale/connect — paste-authkey path", () => {
  beforeEach(clearAll);

  it("writes to Vaultwarden + flips .env + runs docker compose up + audits", async () => {
    let vaultArg: string | null = null;
    _setVaultWriteForTests(async (key: string) => {
      vaultArg = key;
      return true;
    });
    const r = await invoke("POST", "/api/v1/channels/tailscale/connect", {
      authkey: "tskey-auth-FIXTUREONLY-FIXTURE",
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.path, "A");
    assert.equal(r.payload.vault_write_ok, true);
    assert.equal(r.payload.state, "starting");
    // Vault was given the right key.
    assert.equal(vaultArg, "tskey-auth-FIXTUREONLY-FIXTURE");
    // .env now carries both keys.
    const env = readEnv();
    assert.equal(env.TAILSCALE_AUTHKEY, "tskey-auth-FIXTUREONLY-FIXTURE");
    assert.equal(env.TAILSCALE_ENABLED, "true");
    // docker compose --profile tailscale up -d tailscale was invoked.
    assert.equal(dockerComposeCalls.length, 1);
    assert.deepEqual(dockerComposeCalls[0], [
      "--profile",
      "tailscale",
      "up",
      "-d",
      "tailscale",
    ]);
    // Lifecycle row reflects 'starting' + authkey_used_at.
    const row = getStateDb()
      .prepare("SELECT state, authkey_used_at FROM tailscale_connection WHERE id=1")
      .get() as { state: string; authkey_used_at: number | null };
    assert.equal(row.state, "starting");
    assert.ok(row.authkey_used_at && row.authkey_used_at > 0);
    // Audit row recorded.
    const audit = listAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action_type, "tailscale_connect_initiated");
  });

  it("validates body: empty authkey is rejected (400)", async () => {
    const r = await invoke("POST", "/api/v1/channels/tailscale/connect", {
      authkey: "   ",
    });
    assert.equal(r.status, 400);
    assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    // Nothing should have been written.
    assert.equal(dockerComposeCalls.length, 0);
  });

  it("returns 409 ALREADY_CONNECTED when state='connected' (idempotent guard)", async () => {
    getStateDb()
      .prepare(
        `INSERT INTO tailscale_connection (id, state, created_at, updated_at)
         VALUES (1, 'connected', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    const r = await invoke("POST", "/api/v1/channels/tailscale/connect", {
      authkey: "tskey-auth-FIXTUREONLY-A",
    });
    assert.equal(r.status, 409);
    assert.equal(r.payload.error.code, "ALREADY_CONNECTED");
    // Nothing should have been written.
    assert.equal(dockerComposeCalls.length, 0);
  });

  it("surfaces docker compose failure as 502 DOCKER_COMPOSE_FAILED + state='error'", async () => {
    dockerComposeHandler = () => {
      throw new Error("network unreachable");
    };
    const r = await invoke("POST", "/api/v1/channels/tailscale/connect", {
      authkey: "tskey-auth-FIXTUREONLY-B",
    });
    assert.equal(r.status, 502);
    assert.equal(r.payload.error.code, "DOCKER_COMPOSE_FAILED");
    const row = getStateDb()
      .prepare("SELECT state, last_error FROM tailscale_connection WHERE id=1")
      .get() as { state: string; last_error: string | null };
    assert.equal(row.state, "error");
    assert.match(row.last_error ?? "", /network unreachable/);
    // An audit row should still have been written.
    const audit = listAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action_type, "tailscale_connect_failed");
  });
});

describe("POST /api/v1/channels/tailscale/connect — device-auth path", () => {
  beforeEach(clearAll);

  it("with NO authkey: skips Vaultwarden, brings sidecar up, state='authenticating'", async () => {
    let vaultCalled = false;
    _setVaultWriteForTests(async () => {
      vaultCalled = true;
      return true;
    });
    const r = await invoke("POST", "/api/v1/channels/tailscale/connect", {});
    assert.equal(r.status, 200);
    assert.equal(r.payload.path, "C");
    assert.equal(r.payload.state, "authenticating");
    assert.equal(r.payload.vault_write_ok, null);
    // Vaultwarden was NOT touched — Path C has no key to store yet.
    assert.equal(vaultCalled, false);
    // .env reflects TAILSCALE_ENABLED=true but NO TAILSCALE_AUTHKEY.
    const env = readEnv();
    assert.equal(env.TAILSCALE_ENABLED, "true");
    assert.equal(env.TAILSCALE_AUTHKEY, undefined);
    // Sidecar was started.
    assert.equal(dockerComposeCalls.length, 1);
    // Audit recorded with the Path C marker.
    const audit = listAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action_type, "tailscale_connect_initiated");
    // A subsequent /status probe should reconcile the AuthURL into the row.
    _setTailscaleProbeForTests(async () => ({
      ok: true,
      status: {
        BackendState: "NeedsLogin",
        AuthURL: "https://login.tailscale.com/a/PATH-C-CODE",
        Self: { HostName: "home-alfred-black" },
        Peer: {},
      },
    }));
    const status = await invoke("GET", "/api/v1/channels/tailscale/status");
    assert.equal(status.payload.state, "authenticating");
    assert.equal(
      status.payload.auth_url,
      "https://login.tailscale.com/a/PATH-C-CODE",
      "the device-auth URL is surfaced from the live probe",
    );
  });
});

describe("POST /api/v1/channels/tailscale/disconnect — #109 PR 2", () => {
  beforeEach(clearAll);

  it("runs logout + down + compose stop, flips state to 'disabled', audits", async () => {
    // Pre-seed connected so disconnect has something to take down.
    getStateDb()
      .prepare(
        `INSERT INTO tailscale_connection
           (id, state, tailnet_ip, tailnet_hostname, created_at, updated_at)
         VALUES (1, 'connected', '100.64.1.7', 'home-alfred-black.tail-acme.ts.net', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    const r = await invoke("POST", "/api/v1/channels/tailscale/disconnect");
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.state, "disabled");
    assert.deepEqual(r.payload.warnings, []);
    // Three docker calls fired in order: logout, down, stop.
    assert.equal(dockerExecCalls.length, 2);
    assert.deepEqual(dockerExecCalls[0].command, ["tailscale", "logout"]);
    assert.deepEqual(dockerExecCalls[1].command, ["tailscale", "down"]);
    assert.equal(dockerComposeCalls.length, 1);
    assert.deepEqual(dockerComposeCalls[0], ["stop", "tailscale"]);
    // Row reset.
    const row = getStateDb()
      .prepare(
        "SELECT state, tailnet_ip, tailnet_hostname, auth_url FROM tailscale_connection WHERE id=1",
      )
      .get() as {
      state: string;
      tailnet_ip: string | null;
      tailnet_hostname: string | null;
      auth_url: string | null;
    };
    assert.equal(row.state, "disabled");
    assert.equal(row.tailnet_ip, null);
    assert.equal(row.tailnet_hostname, null);
    // TAILSCALE_ENABLED flipped to false in .env.
    const env = readEnv();
    assert.equal(env.TAILSCALE_ENABLED, "false");
    // Audit recorded.
    const audit = listAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action_type, "tailscale_disconnect");
  });

  it("is best-effort: docker errors land in warnings, still 200 + state='disabled'", async () => {
    dockerExecHandler = (_svc, cmd) => {
      if (cmd[1] === "logout") throw new Error("logout failed: not running");
      return "";
    };
    const r = await invoke("POST", "/api/v1/channels/tailscale/disconnect");
    assert.equal(r.status, 200);
    assert.equal(r.payload.state, "disabled");
    assert.equal(r.payload.warnings.length, 1);
    assert.match(r.payload.warnings[0], /logout/);
  });
});

// (PR 4 stubs replaced by real impls. Coverage moved to
// channels_tailscale_pr4.test.ts.)

describe("GET /api/v1/channels/tailscale/peers — #109 PR 2", () => {
  beforeEach(clearAll);

  it("returns empty list (no error) when sidecar absent", async () => {
    _setTailscaleProbeForTests(async () => {
      throw new Error("probe should not run when disabled");
    });
    const r = await invoke("GET", "/api/v1/channels/tailscale/peers");
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.peers, []);
    assert.match(r.payload.reason, /disabled/);
  });

  it("returns empty list with reason when probe fails (state != disabled)", async () => {
    getStateDb()
      .prepare(
        `INSERT INTO tailscale_connection (id, state, created_at, updated_at)
         VALUES (1, 'connected', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    _setTailscaleProbeForTests(async () => ({
      ok: false,
      reason: "probe failed: container missing",
    }));
    const r = await invoke("GET", "/api/v1/channels/tailscale/peers");
    assert.equal(r.status, 200);
    assert.deepEqual(r.payload.peers, []);
    assert.match(r.payload.reason, /container missing/);
  });

  it("extracts peers from probe JSON when sidecar is live", async () => {
    getStateDb()
      .prepare(
        `INSERT INTO tailscale_connection (id, state, created_at, updated_at)
         VALUES (1, 'connected', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    _setTailscaleProbeForTests(async () => ({
      ok: true,
      status: {
        BackendState: "Running",
        Self: {
          HostName: "home-alfred-black",
          DNSName: "home-alfred-black.tail-acme.ts.net.",
          TailscaleIPs: ["100.64.1.7"],
          Online: true,
        },
        Peer: {
          nABC: {
            ID: "nABC",
            HostName: "ha-server",
            DNSName: "ha-server.tail-acme.ts.net.",
            OS: "linux",
            TailscaleIPs: ["100.64.1.10"],
            Online: true,
            LastSeen: "2026-05-29T08:00:00Z",
          },
          nXYZ: {
            ID: "nXYZ",
            HostName: "sirs-laptop",
            DNSName: "sirs-laptop.tail-acme.ts.net.",
            OS: "macOS",
            TailscaleIPs: ["100.64.1.20"],
            Online: false,
            LastSeen: "2026-05-28T22:00:00Z",
          },
        },
      },
    }));
    const r = await invoke("GET", "/api/v1/channels/tailscale/peers");
    assert.equal(r.status, 200);
    assert.equal(r.payload.peers.length, 2);
    const ha = r.payload.peers.find((p: any) => p.hostname === "ha-server");
    assert.ok(ha);
    assert.equal(ha.dns_name, "ha-server.tail-acme.ts.net");
    assert.deepEqual(ha.tailscale_ips, ["100.64.1.10"]);
    assert.equal(ha.online, true);
    const laptop = r.payload.peers.find((p: any) => p.hostname === "sirs-laptop");
    assert.ok(laptop);
    assert.equal(laptop.online, false);
  });
});
