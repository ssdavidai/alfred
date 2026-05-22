import { mock, describe, it } from "node:test";
import assert from "node:assert/strict";

// Importing the route modules transitively loads streams.ts, which does an
// unguarded mkdirSync('/alfred-data/streams') at module-load. Mock node:fs so
// that side effect is a no-op on dev machines / CI (same approach as
// integrations-skill-gen.test.ts). We only assert exported string constants,
// not fs behaviour.
const noop = mock.fn();
const fsMock = {
  mkdirSync: noop,
  writeFileSync: noop,
  readFileSync: mock.fn(() => ""),
  readdirSync: mock.fn(() => [] as any[]),
  existsSync: mock.fn(() => false),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false })),
  unlinkSync: noop,
  renameSync: noop,
  appendFileSync: noop,
  openSync: mock.fn(() => 0),
  readSync: mock.fn(() => 0),
  closeSync: noop,
  createReadStream: mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() })),
  chownSync: noop,
};
mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: fsMock,
});

// ---------------------------------------------------------------------------
// Skills / SOUL.md / MEMORY.md path resolution (LANE I, batch 7).
//
// Three ctrl routes used to read skills + SOUL.md + MEMORY.md from the dead
// `/mnt/encrypted/openclaw/workspace*` path. The merged single-VM stack has no
// openclaw mount, so those reads silently returned empty (no skills in the
// Claude-setup bundle, "voice agent doesn't know who Sir is", empty SMS
// system prompt).
//
// DECIDED layout (owner, batch 7):
//   * SKILLS  live under the Hermes per-profile workspace skills dir — the
//     SAME location integrations.ts WRITES the alfred-composio-* folders to,
//     so the readers must match the writer or they find nothing. The writer's
//     authoritative constants are:
//        HERMES_HOME          = process.env.HERMES_HOME      ?? "/opt/data"
//        HERMES_PROFILES_DIR  = process.env.HERMES_CONFIG_DIR ?? `${HERMES_HOME}/profiles`
//        skills dir           = `${HERMES_PROFILES_DIR}/main/workspace/skills`
//   * SOUL.md / MEMORY.md are VAULT-canonical top-level files — read from
//     `${process.env.VAULT_PATH ?? "/vault"}`.
//
// These tests assert the RESOLVED path constants exported by each route, so a
// future regression back to /mnt/encrypted (or a drift away from where
// integrations.ts writes) fails loudly.
// ---------------------------------------------------------------------------

const claudeSetup = await import("../src/api/routes/claudeSetup.js");
const phone = await import("../src/api/routes/phone.js");
const workspace = await import("../src/api/routes/workspace.js");

const EXPECTED_SKILLS_DIR = "/opt/data/profiles/main/workspace/skills";
const EXPECTED_VAULT = "/vault";

describe("skills / SOUL / MEMORY path resolution", () => {
  describe("claudeSetup.ts", () => {
    it("resolves the composio-skills dir to the Hermes main-profile workspace skills (where integrations.ts writes)", () => {
      assert.strictEqual(claudeSetup.RESOLVED_SKILLS_DIR, EXPECTED_SKILLS_DIR);
    });
    it("does not resolve to the dead /mnt/encrypted openclaw path", () => {
      assert.ok(!claudeSetup.RESOLVED_SKILLS_DIR.includes("/mnt/encrypted"));
    });
  });

  describe("phone.ts", () => {
    it("resolves the skills dir to the Hermes main-profile workspace skills", () => {
      assert.strictEqual(phone.RESOLVED_SKILLS_DIR, EXPECTED_SKILLS_DIR);
    });
    it("resolves SOUL.md / MEMORY.md to the vault root", () => {
      assert.strictEqual(phone.RESOLVED_VAULT_PATH, EXPECTED_VAULT);
      assert.strictEqual(phone.RESOLVED_MEMORY_PATH, `${EXPECTED_VAULT}/MEMORY.md`);
      assert.strictEqual(phone.RESOLVED_SOUL_PATH, `${EXPECTED_VAULT}/SOUL.md`);
    });
    it("resolves the voice skill under the skills dir", () => {
      assert.strictEqual(
        phone.RESOLVED_VOICE_SKILL_PATH,
        `${EXPECTED_SKILLS_DIR}/alfred-voice/SKILL.md`,
      );
    });
    it("does not resolve any skills/SOUL/MEMORY read to /mnt/encrypted", () => {
      assert.ok(!phone.RESOLVED_SKILLS_DIR.includes("/mnt/encrypted"));
      assert.ok(!phone.RESOLVED_MEMORY_PATH.includes("/mnt/encrypted"));
      assert.ok(!phone.RESOLVED_SOUL_PATH.includes("/mnt/encrypted"));
    });
  });

  describe("workspace.ts", () => {
    // F14/C13 — SOUL.md / AGENTS.md now route to the Hermes main profile dir
    // (the gateway loads them from there); the NON-gateway-loaded files
    // (MEMORY.md, USER.md, TOOLS.md, KNOWN_CONTACTS.md) still resolve to the
    // vault root, which is what RESOLVED_WORKSPACE_DIR exports.
    it("resolves the non-gateway-loaded top-level files to the vault root", () => {
      assert.strictEqual(workspace.RESOLVED_WORKSPACE_DIR, EXPECTED_VAULT);
    });
    it("does not resolve the vault root to /mnt/encrypted", () => {
      assert.ok(!workspace.RESOLVED_WORKSPACE_DIR.includes("/mnt/encrypted"));
    });
  });

  it("phone + claudeSetup agree on the skills dir (single source of truth)", () => {
    assert.strictEqual(phone.RESOLVED_SKILLS_DIR, claudeSetup.RESOLVED_SKILLS_DIR);
  });
});
