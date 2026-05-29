import { mock, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocks — registered before any code-under-test import.
//
// Contract C-OB1 (the onboarding promotion-quality gate) reads vault/USER.md
// to allow-list org names. Stub fs the same way tests/vault.test.ts does,
// then drive `readFileSyncFn` per-test to swap USER.md content in.
// ---------------------------------------------------------------------------

let execFileStdout = '{"ok":true}';
const execFileFn = mock.fn((...args: any[]) => {
  const cb = args[args.length - 1] as Function;
  cb(null, execFileStdout, "");
});

mock.module("node:child_process", {
  namedExports: {
    execFile: execFileFn,
    // execFileSync needed by src/api/routes/system.ts (ssh-keygen, unused here).
    execFileSync: mock.fn(() => ""),
    spawn: mock.fn(() => ({ stderr: { on: mock.fn() }, stdin: { write: mock.fn(), end: mock.fn() }, on: mock.fn() })),
  },
});

const mkdirFn = mock.fn(async () => undefined);
const writeFileFn = mock.fn(async () => undefined);
const readFileSyncFn = mock.fn((_p: string) => "");
const writeFileSyncFn = mock.fn(() => {});
const readdirSyncFn = mock.fn(() => [] as any[]);
const mkdirSyncFn = mock.fn();
const existsSyncFn = mock.fn(() => false);
const statSyncFn = mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false }));
const unlinkSyncFn = mock.fn();
const renameSyncFn = mock.fn();
const appendFileSyncFn = mock.fn();
const openSyncFn = mock.fn(() => 0);
const readSyncFn = mock.fn(() => 0);
const closeSyncFn = mock.fn();
const createReadStreamFn = mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() }));

const fsMock = {
  readFileSync: readFileSyncFn,
  writeFileSync: writeFileSyncFn,
  readdirSync: readdirSyncFn,
  mkdirSync: mkdirSyncFn,
  existsSync: existsSyncFn,
  statSync: statSyncFn,
  unlinkSync: unlinkSyncFn,
  renameSync: renameSyncFn,
  appendFileSync: appendFileSyncFn,
  openSync: openSyncFn,
  readSync: readSyncFn,
  closeSync: closeSyncFn,
  createReadStream: createReadStreamFn,
  Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: mkdirFn, writeFile: writeFileFn },
};

mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: {
    readFileSync: readFileSyncFn,
    writeFileSync: writeFileSyncFn,
    readdirSync: readdirSyncFn,
    mkdirSync: mkdirSyncFn,
    existsSync: existsSyncFn,
    statSync: statSyncFn,
    unlinkSync: unlinkSyncFn,
    renameSync: renameSyncFn,
    appendFileSync: appendFileSyncFn,
    openSync: openSyncFn,
    readSync: readSyncFn,
    closeSync: closeSyncFn,
    createReadStream: createReadStreamFn,
    Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  },
});

const { createApiServer } = await import("../src/api/server.js");
const { _resetQualityGateCacheForTest } = await import(
  "../src/api/middleware/onboarding_quality_gate.js"
);

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(payload)),
              }
            : {}),
          ...headers,
        },
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

// ---------------------------------------------------------------------------
// Contract C-OB1 — the promotion-quality gate.
//
// Triggered on vault POST/PATCH when the caller is the onboarding pipeline
// (frontmatter.created_by ∈ {onboarding_pipeline, alfred_vault_curator})
// OR the request carries `X-Onboarding-Write: true`. Rejects low-quality
// records with 422 QUALITY_REJECTED so the onboarding seed lands gold.
// ---------------------------------------------------------------------------

describe("POST /api/v1/vault/records — onboarding quality gate", () => {
  function resetUserMd(content = "") {
    _resetQualityGateCacheForTest();
    readFileSyncFn.mock.mockImplementation((p: string) => {
      if (typeof p === "string" && p.endsWith("/USER.md")) return content;
      return "";
    });
  }

  it("(a) rejects a domain-stub matter with body<300 chars + fm.domain", async () => {
    resetUserMd();
    const content =
      "---\ntype: matter\ncreated_by: onboarding_pipeline\ndomain: github.com\n---\nA stub.";
    const { status, data } = await req("POST", "/api/v1/vault/records", {
      type: "matter",
      name: "Github Project",
      content,
    });
    assert.strictEqual(status, 422);
    assert.strictEqual(data.error.code, "QUALITY_REJECTED");
    assert.ok(typeof data.suggestion === "string", "suggestion should be set");
    assert.ok(
      data.suggestion.toLowerCase().includes("domain") ||
        data.suggestion.toLowerCase().includes("sender"),
      `suggestion should mention domain/sender, got: ${data.suggestion}`,
    );
  });

  it("(b) rejects a non-human person (sender identity 'Github Notifications')", async () => {
    resetUserMd();
    const content =
      "---\ntype: person\ncreated_by: onboarding_pipeline\n---\nAuto-generated";
    const { status, data } = await req("POST", "/api/v1/vault/records", {
      type: "person",
      name: "Github Notifications",
      content,
    });
    assert.strictEqual(status, 422);
    assert.strictEqual(data.error.code, "QUALITY_REJECTED");
    assert.ok(
      data.suggestion.toLowerCase().includes("stream") ||
        data.suggestion.toLowerCase().includes("event"),
      `suggestion should mention streams/event log, got: ${data.suggestion}`,
    );
  });

  it("(c) rejects org=github.com when USER.md doesn't mention github.com", async () => {
    resetUserMd("# USER.md\nI work at Acme.");
    const content = "---\ntype: org\ncreated_by: onboarding_pipeline\n---\n";
    const { status, data } = await req("POST", "/api/v1/vault/records", {
      type: "org",
      name: "github.com",
      content,
    });
    assert.strictEqual(status, 422);
    assert.strictEqual(data.error.code, "QUALITY_REJECTED");
  });

  it("(d) rejects an instinct with 0 observations + confidence >= 0.5", async () => {
    resetUserMd();
    const content =
      "---\ntype: instinct\ncreated_by: onboarding_pipeline\nobservation_count: 0\nconfidence_score: 0.91\n---\n";
    const { status, data } = await req("POST", "/api/v1/vault/records", {
      type: "instinct",
      name: "Bold Onboarding Instinct",
      content,
    });
    assert.strictEqual(status, 422);
    assert.strictEqual(data.error.code, "QUALITY_REJECTED");
    assert.ok(
      data.suggestion.toLowerCase().includes("asking") ||
        data.suggestion.toLowerCase().includes("unconfirmed"),
      `suggestion should mention Asking/unconfirmed seeding, got: ${data.suggestion}`,
    );
  });

  it("(e) rejects a per-service notification note (alfred_vault_curator)", async () => {
    resetUserMd();
    const content = "---\ntype: note\ncreated_by: alfred_vault_curator\n---\n";
    const { status, data } = await req("POST", "/api/v1/vault/records", {
      type: "note",
      name: "GitHub Service & Notification Summary",
      content,
    });
    assert.strictEqual(status, 422);
    assert.strictEqual(data.error.code, "QUALITY_REJECTED");
    assert.ok(
      data.suggestion.toLowerCase().includes("observation") ||
        data.suggestion.toLowerCase().includes("state"),
      `suggestion should route to observations, got: ${data.suggestion}`,
    );
  });

  it("(f) accepts a substantive Kondorosi matter from onboarding (gold survives)", async () => {
    resetUserMd();
    const longBody =
      "The Kondorosi townhouse renovation matter. ".repeat(20) +
      "Multiple workstreams: structural, planning permission, finishes, and a six-month timeline tracked against the contractor schedule.";
    const content = `---\ntype: matter\ncreated_by: onboarding_pipeline\ntier: inner_circle\n---\n${longBody}`;
    const { status } = await req("POST", "/api/v1/vault/records", {
      type: "matter",
      name: "Kondorosi Renovation",
      content,
    });
    assert.strictEqual(status, 201, "substantive onboarding matter must pass");
  });

  it("(g) does not fire when there is no onboarding trigger (user-created matter)", async () => {
    resetUserMd();
    // Same shape as (a)'s domain-stub matter, but WITHOUT created_by — the gate
    // must not fire, so this trivially passes.
    const content = "---\ntype: matter\ndomain: github.com\n---\nA stub.";
    const { status } = await req("POST", "/api/v1/vault/records", {
      type: "matter",
      name: "Github Project",
      content,
    });
    assert.strictEqual(status, 201, "non-onboarding writes must bypass the gate");
  });

  // ---------------------------------------------------------------------
  // Unicode-aware capitalisation (C-OB1 Hungarian/accented-name fix).
  //
  // The original gate used `/^[A-Z]/` which only matches ASCII uppercase,
  // so Hungarian names like "Üveges Gábor" or "Tóth Zsuzsa" were rejected
  // as "<2 capitalised tokens" — every accented name silently disappeared
  // from a tenant's vault during onboarding. The fix swaps to `\p{Lu}/u`,
  // a Unicode property escape that recognises uppercase across scripts.
  //
  // Regression cases (h–k) MUST accept; guards (l–o) MUST still reject.
  // ---------------------------------------------------------------------

  for (const name of [
    "Üveges Gábor",
    "Tóth Zsuzsa",
    "Ágnes Sirhuber",
    "Sándor Szöllősi",
    "Éva Bíró",
  ]) {
    it(`(unicode) accepts plausibly-human person name "${name}"`, async () => {
      resetUserMd();
      const content = "---\ntype: person\ncreated_by: onboarding_pipeline\n---\n";
      const { status } = await req("POST", "/api/v1/vault/records", {
        type: "person",
        name,
        content,
      });
      assert.strictEqual(
        status,
        201,
        `unicode-uppercase person "${name}" must pass the gate`,
      );
    });
  }

  it("(unicode-regression) still accepts ASCII 'RJ Johnson'", async () => {
    resetUserMd();
    const content = "---\ntype: person\ncreated_by: onboarding_pipeline\n---\n";
    const { status } = await req("POST", "/api/v1/vault/records", {
      type: "person",
      name: "RJ Johnson",
      content,
    });
    assert.strictEqual(status, 201, "ASCII baseline must keep passing");
  });

  it("(unicode-guard) still rejects 'Github Notifications' (Notifications? suffix rule)", async () => {
    resetUserMd();
    const content = "---\ntype: person\ncreated_by: onboarding_pipeline\n---\n";
    const { status, data } = await req("POST", "/api/v1/vault/records", {
      type: "person",
      name: "Github Notifications",
      content,
    });
    assert.strictEqual(status, 422);
    assert.strictEqual(data.error.code, "QUALITY_REJECTED");
  });

  it("(unicode-guard) still rejects 'alice@example.com' (@ rule)", async () => {
    resetUserMd();
    const content = "---\ntype: person\ncreated_by: onboarding_pipeline\n---\n";
    const { status, data } = await req("POST", "/api/v1/vault/records", {
      type: "person",
      name: "alice@example.com",
      content,
    });
    assert.strictEqual(status, 422);
    assert.strictEqual(data.error.code, "QUALITY_REJECTED");
  });

  it("(unicode-guard) still rejects 'alice.com' (TLD rule)", async () => {
    resetUserMd();
    const content = "---\ntype: person\ncreated_by: onboarding_pipeline\n---\n";
    const { status, data } = await req("POST", "/api/v1/vault/records", {
      type: "person",
      name: "alice.com",
      content,
    });
    assert.strictEqual(status, 422);
    assert.strictEqual(data.error.code, "QUALITY_REJECTED");
  });

  it("(unicode-guard) still rejects 'Madonna' (single capitalised token rule)", async () => {
    resetUserMd();
    const content = "---\ntype: person\ncreated_by: onboarding_pipeline\n---\n";
    const { status, data } = await req("POST", "/api/v1/vault/records", {
      type: "person",
      name: "Madonna",
      content,
    });
    assert.strictEqual(status, 422);
    assert.strictEqual(data.error.code, "QUALITY_REJECTED");
  });
});
