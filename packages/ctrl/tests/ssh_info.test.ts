// Sir #8 — GET /api/v1/system/ssh-info backs the new /channels Terminal
// card. Lane III adds the UI; this lane (I) adds the back-end. The route
// returns the SSH connection details + the bootstrap-installed operator
// pubkey (first non-comment line of /root/.ssh/authorized_keys) + the
// `docker exec` line for the hermes shell.
//
// The card needs all five fields. Missing/unreadable authorized_keys must
// return pubkey:null + an error code, NOT a 500 — the card still has to
// render the host/user/exec info even on a fresh VM.
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-info-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.DOMAIN = "test.alfred.black";

// The route reads a file at a configurable path so tests can fake it.
const fakeKeysPath = path.join(tmp, "authorized_keys");
process.env.AUTHORIZED_KEYS_PATH = fakeKeysPath;

const { matchRoute } = await import("../src/api/server.js");
const { registerSystemRoutes } = await import("../src/api/routes/system.js");
registerSystemRoutes();

async function call(method: string, p: string): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
    writeHead(c: number) { status = c; return res; },
    end(j?: string) { payload = j ? JSON.parse(j) : undefined; },
  } as unknown as ServerResponse;
  await m!.handler({ req: { url: p } as any, res, params: m!.params, body: undefined, query: new URLSearchParams() });
  return { status, payload };
}

describe("GET /api/v1/system/ssh-info — Terminal card backing route (Sir #8)", () => {
  afterEach(() => {
    try { fs.unlinkSync(fakeKeysPath); } catch {}
  });

  it("returns host/port/user/container/exec_command + the first non-comment pubkey line", async () => {
    const pubkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleOperatorKey001 operator@laptop";
    fs.writeFileSync(
      fakeKeysPath,
      [
        "# operator key installed at bootstrap",
        pubkey,
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISecondaryKey0000000000 backup@second",
        "",
      ].join("\n"),
    );

    const { status, payload } = await call("GET", "/api/v1/system/ssh-info");
    assert.equal(status, 200, `expected 200, got ${status}`);
    assert.equal(payload.host, "test.alfred.black", "host should come from DOMAIN");
    assert.equal(payload.port, 22);
    assert.equal(payload.user, "root");
    assert.equal(payload.container, "alfred-black-hermes-1");
    assert.equal(payload.exec_command, "docker exec -it alfred-black-hermes-1 hermes");
    assert.equal(payload.pubkey, pubkey, "must return the FIRST non-comment line of authorized_keys");
    assert.ok(!payload.error, "no error field when key is readable");
  });

  it("skips blank lines and # comments when picking the first key", async () => {
    const pubkey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBlankLineThenCommentThenKey real@host";
    fs.writeFileSync(
      fakeKeysPath,
      [
        "",
        "   ",
        "# comment one",
        "  # indented comment",
        pubkey,
        "ssh-rsa AAAAB3NzaC1yc2EShouldNotBePicked another@host",
      ].join("\n"),
    );

    const { payload } = await call("GET", "/api/v1/system/ssh-info");
    assert.equal(payload.pubkey, pubkey);
  });

  it("returns pubkey:null + error:no_authorized_keys when the file is missing (not 500)", async () => {
    try { fs.unlinkSync(fakeKeysPath); } catch {}
    const { status, payload } = await call("GET", "/api/v1/system/ssh-info");
    assert.equal(status, 200, "must not 500 when authorized_keys is missing");
    assert.equal(payload.pubkey, null);
    assert.equal(payload.error, "no_authorized_keys");
    assert.equal(payload.host, "test.alfred.black", "host/user/exec still populated for the card");
    assert.equal(payload.exec_command, "docker exec -it alfred-black-hermes-1 hermes");
  });

  it("returns pubkey:null + error:no_authorized_keys when the file has no usable keys (only comments/blanks)", async () => {
    fs.writeFileSync(fakeKeysPath, "# nothing here\n\n  # still nothing\n\n");
    const { status, payload } = await call("GET", "/api/v1/system/ssh-info");
    assert.equal(status, 200);
    assert.equal(payload.pubkey, null);
    assert.equal(payload.error, "no_authorized_keys");
  });
});
