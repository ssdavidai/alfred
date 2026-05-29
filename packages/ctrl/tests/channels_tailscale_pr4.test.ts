// channels_tailscale_pr4 — Tailscale PR4 cert + serve + funnel routes.
//
// What's under test (issue #109 PR 4)
// -----------------------------------
//   1. POST /cert — `tailscale cert <domain>` invoked + Caddy snippet
//      written + `caddy reload` fired. Bind-mounted .crt/.key visible on
//      the host directory shared with Caddy.
//   2. POST /cert — sidecar not running → 503 SIDECAR_DOWN.
//   3. POST /cert — invalid domain → 400 VALIDATION_ERROR (path traversal
//      / non-hostname strings rejected).
//   4. POST /serve — happy path returns `https://<host>.ts.net`.
//   5. POST /serve — idempotent: same port→path replays cleanly.
//   6. POST /funnel — happy path returns `{public_url}`.
//   7. POST /funnel — denied by tailnet policy → 403 FUNNEL_NOT_ENABLED.
//   8. Every PR 4 route writes an audit row (action_type tailscale_*).
//   9. POST /cert — Caddy reload failure surfaces as `caddy_reload_ok:false`
//      without losing the cert files (defence-in-depth).
//
// Same harness pattern as channels_tailscale.test.ts: mock the helpers
// module before importing the route module, capture docker* invocations,
// drive each route through `matchRoute`.

import { mock, describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-tailscale-pr4-"));
process.env.COMPOSE_DIR = tmp;
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.SQLITE_VEC_PATH = "";

// ── helpers mock — capture every docker call ─────────────────────────────

interface DockerExecCall {
  service: string;
  command: string[];
}
const dockerExecCalls: DockerExecCall[] = [];
const dockerComposeCalls: string[][] = [];

// Per-test handlers; tests flip these between cases.
let dockerExecHandler: (
  service: string,
  command: string[],
) => string | Promise<string> = () => "";
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
    COMPOSE_DIR: tmp,
  },
});

// ── module imports (after env + mocks are wired) ─────────────────────────

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const {
  registerChannelsTailscaleRoutes,
  _setTailscaleProbeForTests,
} = await import("../src/api/routes/channels_tailscale.js");
const { getStateDb } = await import("../src/db/state.js");
registerChannelsTailscaleRoutes();

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

/** Self-signed-ish PEM body just for cat round-trip — the cert route doesn't
 *  cryptographically verify the chain; X509Certificate parses real PEMs only
 *  so we either supply a real PEM or accept that `expires_at` will be null. */
const FIXTURE_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBkTCB+wIJANxr+v1XK3KWMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNVBAMMCWxv
Y2FsaG9zdDAeFw0yNjA1MjkwMDAwMDBaFw0yNjA4MjcwMDAwMDBaMBQxEjAQBgNV
BAMMCWxvY2FsaG9zdDBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQDmFAKE6dB4Z8xJ
TEST-DATA-NOT-A-REAL-CERT-PR4-FIXTURE-ONLY-TEST-DATA-TEST-DATA
TEST-DATA-NOT-A-REAL-CERT-PR4-FIXTURE-ONLY-TEST-DATA-TEST-DATA
TEST-AwIDAQABMA0GCSqGSIb3DQEBCwUAA0EAhEy5l0w==
-----END CERTIFICATE-----
`;
const FIXTURE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
TEST-KEY-NOT-A-REAL-KEY-PR4-FIXTURE-ONLY-TEST-DATA-TEST-DATA-AB
-----END PRIVATE KEY-----
`;

function clearAll(): void {
  dockerExecCalls.length = 0;
  dockerComposeCalls.length = 0;
  dockerExecHandler = () => "";
  dockerComposeHandler = () => "";
  _setTailscaleProbeForTests(null);
  const db = getStateDb();
  db.exec("DELETE FROM tailscale_connection");
  db.exec("DELETE FROM audit");
  // Reset bind-mount dirs.
  for (const sub of ["caddy/tailscale-certs", "caddy/tailscale-snippets"]) {
    const dir = path.join(tmp, sub);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* may not exist */
    }
  }
}

function listAudit(): { action_type: string; summary: string }[] {
  return getStateDb()
    .prepare("SELECT action_type, summary FROM audit ORDER BY ts ASC")
    .all() as { action_type: string; summary: string }[];
}

/** Seed a `connected` lifecycle row + a probe override that pretends the
 *  sidecar is reachable + has a stable hostname. Used by every PR 4 happy
 *  path so the sidecar-down guard doesn't gate the call. */
function seedConnected(): void {
  getStateDb()
    .prepare(
      `INSERT INTO tailscale_connection
         (id, state, tailnet_ip, tailnet_hostname, created_at, updated_at)
       VALUES (1, 'connected', '100.64.1.7', 'home-alfred-black.tail-acme.ts.net', ?, ?)`,
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
      Peer: {},
    },
  }));
}

// ── POST /cert ───────────────────────────────────────────────────────────

describe("POST /api/v1/channels/tailscale/cert — #109 PR 4", () => {
  beforeEach(clearAll);

  it("happy path: invokes `tailscale cert`, writes .crt + .key + snippet, reloads Caddy", async () => {
    seedConnected();
    // dockerExec call routing: the route makes 4 docker exec calls in order:
    //   1. tailscale cert ... (writes to /tmp/<d>.crt + /tmp/<d>.key)
    //   2. cat /tmp/<d>.crt
    //   3. cat /tmp/<d>.key
    //   4. caddy reload
    // We answer each in sequence.
    let execIdx = 0;
    dockerExecHandler = (_svc, cmd) => {
      execIdx++;
      if (cmd[0] === "tailscale" && cmd[1] === "cert") return "";
      if (cmd[0] === "cat" && cmd[1].endsWith(".crt")) return FIXTURE_CERT_PEM;
      if (cmd[0] === "cat" && cmd[1].endsWith(".key")) return FIXTURE_KEY_PEM;
      if (cmd[0] === "caddy" && cmd[1] === "reload") return "";
      return "";
    };

    const domain = "home-alfred-black.tail-acme.ts.net";
    const r = await invoke("POST", "/api/v1/channels/tailscale/cert", {
      domain,
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.domain, domain);
    assert.equal(r.payload.cert_path, `/tailscale-certs/${domain}.crt`);
    assert.equal(r.payload.key_path, `/tailscale-certs/${domain}.key`);
    assert.equal(r.payload.caddy_reload_ok, true);

    // The cert files landed in the bind-mounted host dir.
    const certHost = path.join(tmp, "caddy/tailscale-certs", `${domain}.crt`);
    const keyHost = path.join(tmp, "caddy/tailscale-certs", `${domain}.key`);
    assert.ok(fs.existsSync(certHost), "cert file written to host bind mount");
    assert.ok(fs.existsSync(keyHost), "key file written to host bind mount");
    assert.match(fs.readFileSync(certHost, "utf-8"), /BEGIN CERTIFICATE/);

    // Caddy snippet written.
    const snippet = path.join(
      tmp,
      "caddy/tailscale-snippets",
      `${domain}.caddy`,
    );
    assert.ok(fs.existsSync(snippet), "Caddy snippet file written");
    const snippetText = fs.readFileSync(snippet, "utf-8");
    assert.match(snippetText, new RegExp(`^${domain.replace(/\./g, "\\.")} \\{`, "m"));
    assert.match(
      snippetText,
      new RegExp(
        `tls /tailscale-certs/${domain.replace(/\./g, "\\.")}\\.crt /tailscale-certs/${domain.replace(/\./g, "\\.")}\\.key`,
      ),
    );

    // Verify dockerExec sequence — the `tailscale cert` call + reload at the
    // end.
    const certCall = dockerExecCalls.find(
      (c) => c.command[0] === "tailscale" && c.command[1] === "cert",
    );
    assert.ok(certCall, "tailscale cert invoked");
    assert.equal(certCall.command[certCall.command.length - 1], domain);
    const reloadCall = dockerExecCalls.find(
      (c) => c.command[0] === "caddy" && c.command[1] === "reload",
    );
    assert.ok(reloadCall, "caddy reload invoked");
    assert.equal(reloadCall.service, "caddy");

    // Audit row.
    const audit = listAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action_type, "tailscale_cert_issued");
  });

  it("503 SIDECAR_DOWN when sidecar not running", async () => {
    // No seedConnected — probe override returns failure.
    _setTailscaleProbeForTests(async () => ({
      ok: false,
      reason: "container alfred-black-tailscale-1 not found",
    }));
    // Pre-seed a non-disabled row so the route doesn't short-circuit early
    // on state='disabled'. The lifecycle row's state doesn't gate /cert
    // directly — the probe does, via ensureSidecarRunning.
    getStateDb()
      .prepare(
        `INSERT INTO tailscale_connection (id, state, created_at, updated_at)
         VALUES (1, 'starting', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    const r = await invoke("POST", "/api/v1/channels/tailscale/cert", {
      domain: "home-alfred-black.tail-acme.ts.net",
    });
    assert.equal(r.status, 503);
    assert.equal(r.payload.error.code, "SIDECAR_DOWN");
    // No `tailscale cert` call should have fired.
    assert.equal(
      dockerExecCalls.find(
        (c) => c.command[0] === "tailscale" && c.command[1] === "cert",
      ),
      undefined,
    );
  });

  it("400 VALIDATION_ERROR on path-traversal / non-hostname domain", async () => {
    seedConnected();
    for (const bad of [
      "../etc/passwd",
      "not a domain",
      "",
      "trailing-dot.",
      ".leading-dot.com",
      "a".repeat(260),
    ]) {
      const r = await invoke("POST", "/api/v1/channels/tailscale/cert", {
        domain: bad,
      });
      assert.equal(r.status, 400, `${bad} should be rejected`);
      assert.equal(r.payload.error.code, "VALIDATION_ERROR");
    }
    assert.equal(dockerExecCalls.length, 0, "no docker call should have fired");
  });

  it("Caddy reload failure leaves cert files on disk + reports caddy_reload_ok:false", async () => {
    seedConnected();
    dockerExecHandler = (_svc, cmd) => {
      if (cmd[0] === "tailscale" && cmd[1] === "cert") return "";
      if (cmd[0] === "cat" && cmd[1].endsWith(".crt")) return FIXTURE_CERT_PEM;
      if (cmd[0] === "cat" && cmd[1].endsWith(".key")) return FIXTURE_KEY_PEM;
      if (cmd[0] === "caddy" && cmd[1] === "reload") {
        throw new Error("caddy reload exited 1: parse error in snippet");
      }
      return "";
    };
    const domain = "home-alfred-black.tail-acme.ts.net";
    const r = await invoke("POST", "/api/v1/channels/tailscale/cert", {
      domain,
    });
    // Reload failure does NOT 5xx — the cert is written, the principal can
    // restart Caddy. The flag surfaces the warning.
    assert.equal(r.status, 200);
    assert.equal(r.payload.caddy_reload_ok, false);
    const certHost = path.join(tmp, "caddy/tailscale-certs", `${domain}.crt`);
    assert.ok(fs.existsSync(certHost), "cert still on disk despite reload failure");
  });
});

// ── POST /serve ──────────────────────────────────────────────────────────

describe("POST /api/v1/channels/tailscale/serve — #109 PR 4", () => {
  beforeEach(clearAll);

  it("happy path: returns https://<host>.ts.net + tailscale serve invoked", async () => {
    seedConnected();
    const r = await invoke("POST", "/api/v1/channels/tailscale/serve", {
      port: 9000,
      path: "/voice",
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);
    assert.equal(
      r.payload.url,
      "https://home-alfred-black.tail-acme.ts.net/voice",
    );
    assert.equal(r.payload.port, 9000);
    // tailscale serve invoked with the expected args.
    const serveCall = dockerExecCalls.find(
      (c) => c.command[0] === "tailscale" && c.command[1] === "serve",
    );
    assert.ok(serveCall);
    assert.ok(serveCall.command.includes("http://127.0.0.1:9000"));
    assert.ok(serveCall.command.includes("/voice"));

    const audit = listAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action_type, "tailscale_serve_set");
  });

  it("idempotent: same port + path replays cleanly", async () => {
    seedConnected();
    const body = { port: 9000, path: "/voice" };
    const a = await invoke("POST", "/api/v1/channels/tailscale/serve", body);
    const b = await invoke("POST", "/api/v1/channels/tailscale/serve", body);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.payload.url, b.payload.url);
    // Two serve calls fired — both succeed (idempotent at the tailscale CLI
    // level; ctrl-api doesn't dedupe).
    const serveCalls = dockerExecCalls.filter(
      (c) => c.command[0] === "tailscale" && c.command[1] === "serve",
    );
    assert.equal(serveCalls.length, 2);
  });

  it("defaults path to / when omitted", async () => {
    seedConnected();
    const r = await invoke("POST", "/api/v1/channels/tailscale/serve", {
      port: 3100,
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.path, "/");
    assert.equal(
      r.payload.url,
      "https://home-alfred-black.tail-acme.ts.net/",
    );
  });

  it("503 SIDECAR_DOWN when sidecar not running", async () => {
    _setTailscaleProbeForTests(async () => ({
      ok: false,
      reason: "no such container",
    }));
    getStateDb()
      .prepare(
        `INSERT INTO tailscale_connection (id, state, created_at, updated_at)
         VALUES (1, 'starting', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    const r = await invoke("POST", "/api/v1/channels/tailscale/serve", {
      port: 9000,
    });
    assert.equal(r.status, 503);
    assert.equal(r.payload.error.code, "SIDECAR_DOWN");
  });

  it("rejects out-of-range port", async () => {
    seedConnected();
    for (const bad of [0, -1, 65_536, 70000, 1.5, "9000"] as unknown[]) {
      const r = await invoke("POST", "/api/v1/channels/tailscale/serve", {
        port: bad,
      });
      assert.equal(r.status, 400, `${bad} should be rejected`);
    }
  });
});

// ── POST /funnel ─────────────────────────────────────────────────────────

describe("POST /api/v1/channels/tailscale/funnel — #109 PR 4", () => {
  beforeEach(clearAll);

  it("happy path: returns public_url + tailscale funnel invoked", async () => {
    seedConnected();
    const r = await invoke("POST", "/api/v1/channels/tailscale/funnel", {
      port: 9000,
    });
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);
    assert.equal(
      r.payload.public_url,
      "https://home-alfred-black.tail-acme.ts.net",
    );
    const funnelCall = dockerExecCalls.find(
      (c) => c.command[0] === "tailscale" && c.command[1] === "funnel",
    );
    assert.ok(funnelCall);
    assert.ok(funnelCall.command.includes("9000"));

    const audit = listAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action_type, "tailscale_funnel_set");
  });

  it("403 FUNNEL_NOT_ENABLED when tailnet policy denies funnel", async () => {
    seedConnected();
    dockerExecHandler = (_svc, cmd) => {
      if (cmd[0] === "tailscale" && cmd[1] === "funnel") {
        throw new Error(
          "tailscale funnel exited 1: funnel is not enabled on this tailnet (admin must allow it)",
        );
      }
      return "";
    };
    const r = await invoke("POST", "/api/v1/channels/tailscale/funnel", {
      port: 9000,
    });
    assert.equal(r.status, 403);
    assert.equal(r.payload.error.code, "FUNNEL_NOT_ENABLED");
    // Audit recorded.
    const audit = listAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action_type, "tailscale_funnel_denied");
  });

  it("403 FUNNEL_NOT_ENABLED when HTTPS feature is off (alternate wording)", async () => {
    seedConnected();
    dockerExecHandler = (_svc, cmd) => {
      if (cmd[0] === "tailscale" && cmd[1] === "funnel") {
        throw new Error("HTTPS not enabled");
      }
      return "";
    };
    const r = await invoke("POST", "/api/v1/channels/tailscale/funnel", {
      port: 9000,
    });
    assert.equal(r.status, 403);
    assert.equal(r.payload.error.code, "FUNNEL_NOT_ENABLED");
  });

  it("502 TAILSCALE_FUNNEL_FAILED on unknown errors", async () => {
    seedConnected();
    dockerExecHandler = (_svc, cmd) => {
      if (cmd[0] === "tailscale" && cmd[1] === "funnel") {
        throw new Error("network unreachable");
      }
      return "";
    };
    const r = await invoke("POST", "/api/v1/channels/tailscale/funnel", {
      port: 9000,
    });
    assert.equal(r.status, 502);
    assert.equal(r.payload.error.code, "TAILSCALE_FUNNEL_FAILED");
  });

  it("503 SIDECAR_DOWN when sidecar not running", async () => {
    _setTailscaleProbeForTests(async () => ({
      ok: false,
      reason: "container missing",
    }));
    getStateDb()
      .prepare(
        `INSERT INTO tailscale_connection (id, state, created_at, updated_at)
         VALUES (1, 'starting', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    const r = await invoke("POST", "/api/v1/channels/tailscale/funnel", {
      port: 9000,
    });
    assert.equal(r.status, 503);
    assert.equal(r.payload.error.code, "SIDECAR_DOWN");
  });
});
