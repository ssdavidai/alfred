import { mock, describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// In-memory virtual filesystem for the skills dirs.
//
// Two trees:
//   /mnt/encrypted/openclaw/workspace/skills/<name>/SKILL.md
//   /mnt/encrypted/openclaw-workers/workspace/skills/<name>/SKILL.md
//
// Mirror writes hit both. Tests assert against the openclaw side for reads
// and against both sides where the assertion is "deployed to both".
// ---------------------------------------------------------------------------

interface FakeFile {
  content: string;
  mtime: number;
}

const files = new Map<string, FakeFile>(); // absolute path → file
const dirs = new Set<string>(); // absolute paths of dirs we've created

function ensureDirs(p: string): void {
  // Add p and every ancestor.
  const parts = p.split("/").filter(Boolean);
  let acc = "";
  for (const part of parts) {
    acc += "/" + part;
    dirs.add(acc);
  }
}

const existsSyncFn = mock.fn((p: string) => files.has(p) || dirs.has(p));
const mkdirSyncFn = mock.fn((p: string, _opts?: any) => { ensureDirs(p); });
const writeFileSyncFn = mock.fn((p: string, content: string) => {
  ensureDirs(p.substring(0, p.lastIndexOf("/")));
  files.set(p, { content, mtime: Date.now() });
});
const readFileSyncFn = mock.fn((p: string) => {
  const f = files.get(p);
  if (!f) {
    const err: any = new Error(`ENOENT: no such file or directory, open '${p}'`);
    err.code = "ENOENT";
    throw err;
  }
  return f.content;
});
const statSyncFn = mock.fn((p: string) => {
  const f = files.get(p);
  if (!f) {
    if (dirs.has(p)) {
      return { mtimeMs: Date.now(), isDirectory: () => true, isFile: () => false, size: 0 };
    }
    const err: any = new Error(`ENOENT: ${p}`);
    err.code = "ENOENT";
    throw err;
  }
  return {
    mtimeMs: f.mtime,
    isDirectory: () => false,
    isFile: () => true,
    size: Buffer.byteLength(f.content, "utf-8"),
  };
});
const readdirSyncFn = mock.fn((p: string, opts?: any) => {
  const wantDirent = opts && opts.withFileTypes;
  const children = new Set<string>();
  // Direct subdirectories of p
  for (const d of dirs) {
    if (d === p) continue;
    if (!d.startsWith(p + "/")) continue;
    const rest = d.slice(p.length + 1);
    const first = rest.split("/")[0];
    children.add(first);
  }
  // Direct files inside p (we don't currently have any in test setup)
  for (const f of files.keys()) {
    const dir = f.substring(0, f.lastIndexOf("/"));
    if (dir === p) {
      const name = f.substring(f.lastIndexOf("/") + 1);
      children.add(name);
    }
  }
  const sorted = [...children].sort();
  if (!wantDirent) return sorted;
  return sorted.map((name) => ({
    name,
    isDirectory: () => dirs.has(p + "/" + name),
    isFile: () => files.has(p + "/" + name),
  }));
});
const rmSyncFn = mock.fn((p: string, _opts?: any) => {
  // Recursive delete: drop p, all descendants.
  for (const f of [...files.keys()]) {
    if (f === p || f.startsWith(p + "/")) files.delete(f);
  }
  for (const d of [...dirs]) {
    if (d === p || d.startsWith(p + "/")) dirs.delete(d);
  }
});
const chownSyncFn = mock.fn(() => {});
const writeFileAsyncFn = mock.fn(async () => undefined);
const mkdirAsyncFn = mock.fn(async () => undefined);

const fsMock = {
  existsSync: existsSyncFn,
  mkdirSync: mkdirSyncFn,
  writeFileSync: writeFileSyncFn,
  readFileSync: readFileSyncFn,
  statSync: statSyncFn,
  readdirSync: readdirSyncFn,
  rmSync: rmSyncFn,
  chownSync: chownSyncFn,
  unlinkSync: mock.fn(),
  renameSync: mock.fn(),
  appendFileSync: mock.fn(),
  openSync: mock.fn(() => 0),
  readSync: mock.fn(() => 0),
  closeSync: mock.fn(),
  createReadStream: mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() })),
  Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: mkdirAsyncFn, writeFile: writeFileAsyncFn },
};

mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: fsMock,
});

// child_process — admin/vault routes use these on import; provide noops.
mock.module("node:child_process", {
  namedExports: {
    execFile: mock.fn((...args: any[]) => {
      const cb = args[args.length - 1] as Function;
      cb(null, "{}", "");
    }),
    spawn: mock.fn(() => ({
      stderr: { on: mock.fn() },
      stdin: { write: mock.fn(), end: mock.fn() },
      on: mock.fn(),
    })),
  },
});

// ---------------------------------------------------------------------------
// Server setup — dynamic import after mocks
// ---------------------------------------------------------------------------

const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  files.clear();
  dirs.clear();
  // Re-create the base dirs so existsSync on them returns true.
  ensureDirs("/mnt/encrypted/openclaw/workspace/skills");
  ensureDirs("/mnt/encrypted/openclaw-workers/workspace/skills");
});

const OC = "/mnt/encrypted/openclaw/workspace/skills";
const OCW = "/mnt/encrypted/openclaw-workers/workspace/skills";

function seedSkill(baseDir: string, name: string, content: string, opts: { hashFile?: boolean } = {}): void {
  const skillDir = `${baseDir}/${name}`;
  ensureDirs(skillDir);
  files.set(`${skillDir}/SKILL.md`, { content, mtime: Date.now() });
  if (opts.hashFile) {
    files.set(`${skillDir}/.content-hash`, { content: "deadbeef", mtime: Date.now() });
  }
}

const VALID_FRONTMATTER = `---
name: user-onboarding-emails
description: Handle client onboarding emails by drafting responses and creating tasks.
---

# User Skill

Body content.
`;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function req(
  method: string,
  path: string,
  body?: unknown,
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
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(payload)),
            }
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/skills", () => {
  it("returns an empty list when no skills are present", async () => {
    const { status, data } = await req("GET", "/api/v1/skills");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data, { skills: [] });
  });

  it("classifies platform / auto-generated / user skills correctly", async () => {
    seedSkill(OC, "alfred-vault-operations", VALID_FRONTMATTER, { hashFile: true });
    seedSkill(OC, "alfred-composio-gmail", VALID_FRONTMATTER);
    seedSkill(OC, "user-onboarding-emails", VALID_FRONTMATTER);

    const { status, data } = await req("GET", "/api/v1/skills");
    assert.strictEqual(status, 200);
    const byName = new Map(data.skills.map((s: any) => [s.name, s.kind]));
    assert.strictEqual(byName.get("alfred-vault-operations"), "platform");
    assert.strictEqual(byName.get("alfred-composio-gmail"), "auto-generated");
    assert.strictEqual(byName.get("user-onboarding-emails"), "user");
    // Each entry has size_bytes and updated_at
    for (const s of data.skills) {
      assert.ok(typeof s.size_bytes === "number" && s.size_bytes > 0);
      assert.ok(typeof s.updated_at === "string");
    }
  });

  it("classifies hash-file-bearing user-prefixed skills as platform (defensive)", async () => {
    // Init container hash-marks everything it manages. If somehow a name without
    // an `alfred-` prefix carries one, treat it as platform too.
    seedSkill(OC, "weird-name-from-init", VALID_FRONTMATTER, { hashFile: true });
    const { data } = await req("GET", "/api/v1/skills");
    const found = data.skills.find((s: any) => s.name === "weird-name-from-init");
    assert.strictEqual(found.kind, "platform");
  });
});

describe("GET /api/v1/skills/:name", () => {
  it("returns full content + parsed frontmatter for an existing skill", async () => {
    seedSkill(OC, "user-onboarding-emails", VALID_FRONTMATTER);
    const { status, data } = await req("GET", "/api/v1/skills/user-onboarding-emails");
    assert.strictEqual(status, 200);
    assert.strictEqual(data.name, "user-onboarding-emails");
    assert.strictEqual(data.kind, "user");
    assert.strictEqual(data.frontmatter.name, "user-onboarding-emails");
    assert.ok(data.content.includes("# User Skill"));
  });

  it("returns 404 for a missing skill", async () => {
    const { status, data } = await req("GET", "/api/v1/skills/user-does-not-exist");
    assert.strictEqual(status, 404);
    assert.strictEqual(data.error.code, "NOT_FOUND");
  });

  it("returns 400 for a malformed name", async () => {
    const { status } = await req("GET", "/api/v1/skills/Bad_Name");
    assert.strictEqual(status, 400);
  });
});

describe("POST /api/v1/skills", () => {
  it("creates a user skill and writes to both openclaw and openclaw-workers", async () => {
    const { status, data } = await req("POST", "/api/v1/skills", {
      name: "user-test-skill",
      content: VALID_FRONTMATTER,
    });
    assert.strictEqual(status, 201);
    assert.strictEqual(data.name, "user-test-skill");
    assert.strictEqual(data.kind, "user");
    assert.deepStrictEqual([...data.deployed].sort(), ["openclaw", "openclaw-workers"]);
    assert.strictEqual(data.reload_required, false);
    // Verify both mirror writes happened.
    assert.ok(files.has(`${OC}/user-test-skill/SKILL.md`));
    assert.ok(files.has(`${OCW}/user-test-skill/SKILL.md`));
  });

  it("rejects names that don't start with user-", async () => {
    const { status, data } = await req("POST", "/api/v1/skills", {
      name: "alfred-something",
      content: VALID_FRONTMATTER,
    });
    assert.strictEqual(status, 400);
    assert.ok(/must start with `user-`/.test(data.error.message));
  });

  it("rejects malformed slugs", async () => {
    const cases = ["UserBadCase", "user--double-dash", "-user-leading-dash", "user-trailing-", "u"];
    for (const name of cases) {
      const { status } = await req("POST", "/api/v1/skills", { name, content: VALID_FRONTMATTER });
      assert.strictEqual(status, 400, `expected 400 for slug ${JSON.stringify(name)}`);
    }
  });

  it("rejects content larger than 50 KB", async () => {
    const big = "---\nname: user-big\ndescription: x\n---\n" + "a".repeat(51 * 1024);
    const { status, data } = await req("POST", "/api/v1/skills", {
      name: "user-big",
      content: big,
    });
    assert.strictEqual(status, 400);
    assert.ok(/50 KB|max is/.test(data.error.message));
  });

  it("rejects content missing frontmatter", async () => {
    const { status } = await req("POST", "/api/v1/skills", {
      name: "user-no-fm",
      content: "# Just a heading, no frontmatter\n",
    });
    assert.strictEqual(status, 400);
  });

  it("rejects frontmatter without description", async () => {
    const { status, data } = await req("POST", "/api/v1/skills", {
      name: "user-no-desc",
      content: "---\nname: user-no-desc\n---\n# Body\n",
    });
    assert.strictEqual(status, 400);
    assert.ok(/description/.test(data.error.message));
  });

  it("rejects frontmatter without name", async () => {
    const { status, data } = await req("POST", "/api/v1/skills", {
      name: "user-no-name",
      content: "---\ndescription: yes\n---\n# Body\n",
    });
    assert.strictEqual(status, 400);
    assert.ok(/name/.test(data.error.message));
  });

  it("returns 409 when the skill already exists", async () => {
    seedSkill(OC, "user-already-here", VALID_FRONTMATTER);
    const { status, data } = await req("POST", "/api/v1/skills", {
      name: "user-already-here",
      content: VALID_FRONTMATTER,
    });
    assert.strictEqual(status, 409);
    assert.strictEqual(data.error.code, "CONFLICT");
  });
});

describe("PUT /api/v1/skills/:name", () => {
  it("updates an existing user skill", async () => {
    seedSkill(OC, "user-existing", VALID_FRONTMATTER);
    seedSkill(OCW, "user-existing", VALID_FRONTMATTER);
    const updated = VALID_FRONTMATTER.replace("Body content.", "Updated body content.");
    const { status, data } = await req("PUT", "/api/v1/skills/user-existing", {
      content: updated,
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(data.kind, "user");
    assert.deepStrictEqual([...data.deployed].sort(), ["openclaw", "openclaw-workers"]);
    assert.ok(files.get(`${OC}/user-existing/SKILL.md`)!.content.includes("Updated body content."));
    assert.ok(files.get(`${OCW}/user-existing/SKILL.md`)!.content.includes("Updated body content."));
  });

  it("returns 404 when the skill doesn't exist", async () => {
    const { status } = await req("PUT", "/api/v1/skills/user-nope", { content: VALID_FRONTMATTER });
    assert.strictEqual(status, 404);
  });

  it("refuses to update a platform skill", async () => {
    seedSkill(OC, "alfred-vault-operations", VALID_FRONTMATTER, { hashFile: true });
    const { status, data } = await req("PUT", "/api/v1/skills/alfred-vault-operations", {
      content: VALID_FRONTMATTER,
    });
    assert.strictEqual(status, 403);
    assert.strictEqual(data.error.code, "PLATFORM_PROTECTED");
  });

  it("refuses to update an auto-generated composio skill", async () => {
    seedSkill(OC, "alfred-composio-gmail", VALID_FRONTMATTER);
    const { status, data } = await req("PUT", "/api/v1/skills/alfred-composio-gmail", {
      content: VALID_FRONTMATTER,
    });
    assert.strictEqual(status, 403);
    assert.strictEqual(data.error.code, "AUTO_GENERATED");
  });

  it("validates content on update too", async () => {
    seedSkill(OC, "user-valid-name", VALID_FRONTMATTER);
    const { status } = await req("PUT", "/api/v1/skills/user-valid-name", {
      content: "no frontmatter here",
    });
    assert.strictEqual(status, 400);
  });
});

describe("DELETE /api/v1/skills/:name", () => {
  it("deletes a user skill from both openclaw and openclaw-workers", async () => {
    seedSkill(OC, "user-to-delete", VALID_FRONTMATTER);
    seedSkill(OCW, "user-to-delete", VALID_FRONTMATTER);
    const { status, data } = await req("DELETE", "/api/v1/skills/user-to-delete");
    assert.strictEqual(status, 200);
    assert.deepStrictEqual([...data.removed].sort(), ["openclaw", "openclaw-workers"]);
    assert.ok(!files.has(`${OC}/user-to-delete/SKILL.md`));
    assert.ok(!files.has(`${OCW}/user-to-delete/SKILL.md`));
  });

  it("returns 404 when the skill doesn't exist", async () => {
    const { status } = await req("DELETE", "/api/v1/skills/user-ghost");
    assert.strictEqual(status, 404);
  });

  it("refuses to delete a platform skill", async () => {
    seedSkill(OC, "alfred-ops-health", VALID_FRONTMATTER, { hashFile: true });
    const { status, data } = await req("DELETE", "/api/v1/skills/alfred-ops-health");
    assert.strictEqual(status, 403);
    assert.strictEqual(data.error.code, "PLATFORM_PROTECTED");
  });

  it("refuses to delete an auto-generated composio skill", async () => {
    seedSkill(OC, "alfred-composio-notion", VALID_FRONTMATTER);
    const { status, data } = await req("DELETE", "/api/v1/skills/alfred-composio-notion");
    assert.strictEqual(status, 403);
    assert.strictEqual(data.error.code, "AUTO_GENERATED");
  });
});
