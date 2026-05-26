// Self-contained Terminal card (Sir 2026-05-26): the /channels card now
// manages SSH keys from the card itself instead of redirecting to /study.
// These tests pin the contract of /api/v1/system/ssh-keys —
// list / add (paste OR generate) / revoke — including the bootstrap-key
// lockout that prevents the operator from locking themselves out.
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ServerResponse } from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-keys-"));
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.DOMAIN = "test.alfred.black";

const fakeKeysPath = path.join(tmp, "authorized_keys");
process.env.AUTHORIZED_KEYS_PATH = fakeKeysPath;

const { matchRoute } = await import("../src/api/server.js");
const { handleError } = await import("../src/api/errors.js");
const { registerSystemRoutes } = await import("../src/api/routes/system.js");
registerSystemRoutes();

// Mimic the server.ts dispatch loop's try/catch so thrown ApiErrors land
// as JSON envelopes rather than bubbling up into the test runner.
async function call(
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; payload: any }> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res = {
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
      req: { url: p } as any,
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

// A small set of real, parseable ed25519 lines. We pre-generate them with
// `ssh-keygen` and inline the strings so the tests don't shell out.
const KEY_A =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINFqANq7VfvBmpiTtbBgaPnq9o5OmBKvIvE7XHL+vIot key-A@laptop";
const KEY_B =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBO+VYO9rVjkPmRY/68XLPL3lT8eK6vDP1cP6OSlfFLM key-B@phone";
const KEY_C =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPLpJ6OG0nQwx5KaH52SI+SqVH9Yfp5gXc2zMs+ZqMRT key-C@desktop";

function seed(content: string) {
  fs.writeFileSync(fakeKeysPath, content);
}

describe("/api/v1/system/ssh-keys — Terminal card self-contained CRUD (Sir 2026-05-26)", () => {
  beforeEach(() => {
    try {
      fs.unlinkSync(fakeKeysPath);
    } catch {}
  });

  describe("GET /ssh-keys", () => {
    it("returns host/port/user/container/exec_command + keys[] with bootstrap flag", async () => {
      seed([KEY_A, KEY_B].join("\n") + "\n");
      const { status, payload } = await call("GET", "/api/v1/system/ssh-keys");
      assert.equal(status, 200);
      assert.equal(payload.host, "test.alfred.black");
      assert.equal(payload.port, 22);
      assert.equal(payload.user, "root");
      assert.equal(payload.container, "alfred-black-hermes-1");
      assert.equal(payload.exec_command, "docker exec -it alfred-black-hermes-1 hermes");
      assert.equal(payload.keys.length, 2);
      assert.equal(payload.keys[0].bootstrap, true, "first key is bootstrap");
      assert.equal(payload.keys[1].bootstrap, false, "second key is not bootstrap");
      assert.equal(payload.keys[0].type, "ssh-ed25519");
      assert.match(payload.keys[0].fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
      assert.equal(payload.keys[0].comment, "key-A@laptop");
    });

    it("returns empty keys[] when the file is missing (no 500)", async () => {
      const { status, payload } = await call("GET", "/api/v1/system/ssh-keys");
      assert.equal(status, 200);
      assert.deepEqual(payload.keys, []);
    });

    it("skips comments and blank lines", async () => {
      seed(["# header", "", "  # indented", KEY_A, "", KEY_B].join("\n") + "\n");
      const { payload } = await call("GET", "/api/v1/system/ssh-keys");
      assert.equal(payload.keys.length, 2);
    });
  });

  describe("POST /ssh-keys — paste-an-existing-pubkey path", () => {
    it("appends the key + returns 201 with fingerprint+type+comment", async () => {
      const { status, payload } = await call("POST", "/api/v1/system/ssh-keys", {
        pubkey: KEY_A,
      });
      assert.equal(status, 201);
      assert.equal(payload.ok, true);
      assert.equal(payload.type, "ssh-ed25519");
      assert.equal(payload.comment, "key-A@laptop");
      assert.match(payload.fingerprint, /^SHA256:/);
      assert.ok(!payload.private_key, "no private_key on paste path");

      const onDisk = fs.readFileSync(fakeKeysPath, "utf8");
      assert.ok(onDisk.includes(KEY_A));
    });

    it("rejects a malformed pubkey with 400", async () => {
      const { status, payload } = await call("POST", "/api/v1/system/ssh-keys", {
        pubkey: "this is not a pubkey",
      });
      assert.equal(status, 400);
      assert.equal(payload.error.code, "VALIDATION_ERROR");
    });

    it("rejects authorized_keys options (command=, from=, …) — privilege-surface", async () => {
      const { status } = await call("POST", "/api/v1/system/ssh-keys", {
        pubkey: `command="/usr/bin/echo no" ${KEY_A}`,
      });
      assert.equal(status, 400, "options must be rejected on user input");
    });

    it("409s when the same blob is already installed (by fingerprint)", async () => {
      seed(KEY_A + "\n");
      // re-paste the same key, even with a different trailing comment
      const variant = KEY_A.replace(/\s+\S+$/, " different-comment");
      const { status, payload } = await call("POST", "/api/v1/system/ssh-keys", {
        pubkey: variant,
      });
      assert.equal(status, 409);
      assert.equal(payload.error.code, "CONFLICT");
    });

    it("rejects body with neither pubkey nor generate", async () => {
      const { status } = await call("POST", "/api/v1/system/ssh-keys", {});
      assert.equal(status, 400);
    });
  });

  describe("POST /ssh-keys — server-side generate path", () => {
    it("generates an ed25519 keypair, returns private_key once, appends pubkey", async function (t) {
      // Skip if ssh-keygen isn't on PATH (some CI minimal images).
      try {
        execFileSync("ssh-keygen", ["-?"], { stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        t.skip("ssh-keygen not on PATH");
        return;
      }
      const { status, payload } = await call("POST", "/api/v1/system/ssh-keys", {
        generate: true,
        comment: "test-host",
      });
      assert.equal(status, 201);
      assert.equal(payload.type, "ssh-ed25519");
      assert.match(payload.fingerprint, /^SHA256:/);
      assert.ok(payload.private_key, "private_key must be returned on generate");
      assert.match(payload.private_key, /BEGIN OPENSSH PRIVATE KEY/);

      const onDisk = fs.readFileSync(fakeKeysPath, "utf8");
      assert.match(onDisk, /^ssh-ed25519 /m);
      assert.ok(
        !onDisk.includes(payload.private_key),
        "private key must NEVER touch authorized_keys",
      );
    });
  });

  describe("POST /ssh-keys/revoke", () => {
    it("removes the requested key by fingerprint", async () => {
      seed([KEY_A, KEY_B, KEY_C].join("\n") + "\n");
      const list = await call("GET", "/api/v1/system/ssh-keys");
      const targetFp = list.payload.keys[1].fingerprint; // KEY_B
      const { status, payload } = await call(
        "POST",
        "/api/v1/system/ssh-keys/revoke",
        { fingerprint: targetFp },
      );
      assert.equal(status, 200);
      assert.equal(payload.revoked, targetFp);

      const after = await call("GET", "/api/v1/system/ssh-keys");
      assert.equal(after.payload.keys.length, 2);
      assert.ok(
        !after.payload.keys.some((k: any) => k.fingerprint === targetFp),
        "the revoked key must be gone",
      );
    });

    it("refuses to revoke the bootstrap (first) key — 409", async () => {
      seed([KEY_A, KEY_B].join("\n") + "\n");
      const list = await call("GET", "/api/v1/system/ssh-keys");
      const bootstrapFp = list.payload.keys[0].fingerprint;
      const { status, payload } = await call(
        "POST",
        "/api/v1/system/ssh-keys/revoke",
        { fingerprint: bootstrapFp },
      );
      assert.equal(status, 409);
      assert.equal(payload.error.code, "CONFLICT");

      // bootstrap key still on disk
      const after = await call("GET", "/api/v1/system/ssh-keys");
      assert.equal(after.payload.keys.length, 2);
      assert.equal(after.payload.keys[0].fingerprint, bootstrapFp);
    });

    it("404s when the fingerprint isn't installed", async () => {
      seed(KEY_A + "\n");
      const { status, payload } = await call(
        "POST",
        "/api/v1/system/ssh-keys/revoke",
        { fingerprint: "SHA256:totallyfakefingerprint" },
      );
      assert.equal(status, 404);
      assert.equal(payload.error.code, "NOT_FOUND");
    });

    it("rejects missing fingerprint with 400", async () => {
      seed(KEY_A + "\n");
      const { status } = await call("POST", "/api/v1/system/ssh-keys/revoke", {});
      assert.equal(status, 400);
    });
  });

  describe("end-to-end: add → list → revoke roundtrip", () => {
    it("starting empty, adding a key, then revoking it leaves the file empty", async () => {
      seed(KEY_A + "\n"); // bootstrap
      const add = await call("POST", "/api/v1/system/ssh-keys", { pubkey: KEY_B });
      assert.equal(add.status, 201);

      const mid = await call("GET", "/api/v1/system/ssh-keys");
      assert.equal(mid.payload.keys.length, 2);

      const revoke = await call("POST", "/api/v1/system/ssh-keys/revoke", {
        fingerprint: add.payload.fingerprint,
      });
      assert.equal(revoke.status, 200);

      const final = await call("GET", "/api/v1/system/ssh-keys");
      assert.equal(final.payload.keys.length, 1);
      assert.equal(final.payload.keys[0].bootstrap, true);
    });
  });
});
