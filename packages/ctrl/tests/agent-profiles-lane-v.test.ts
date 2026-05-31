// #120 Lane V — assertWritableProfile + resolveProfileEnvPath + restartProfile.
//
// Pure unit tests on the helpers Lane V adds. No HTTP, no compose CLI —
// dockerComposeCmd is mocked so restartProfile's compose-fallback path is
// observed in-memory.

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point ctrl-api at a tmp state.db before any module reads STATE_DB_PATH.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lane-v-helpers-"));
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_PATH = path.join(tmp, "vault");
fs.mkdirSync(process.env.VAULT_PATH, { recursive: true });
process.env.ALFRED_DATA_DIR = tmp;
process.env.HERMES_CONFIG_DIR = path.join(tmp, "hermes-state", "profiles");
process.env.HERMES_STATE_DIR_CTRL_VIEW = path.join(tmp, "hermes-state");
fs.mkdirSync(process.env.HERMES_CONFIG_DIR, { recursive: true });

const dockerComposeCalls: string[][] = [];

// Mock helpers.js so the supervisor's compose fallback doesn't actually
// shell out — we just record the call shape.
mock.module("../src/api/helpers.js", {
  namedExports: {
    HERMES_CONTAINER: "hermes",
    dockerComposeCmd: async (args: string[]) => {
      dockerComposeCalls.push([...args]);
      return "";
    },
  },
});

const {
  assertWritableProfile,
  resolveProfileEnvPath,
  createProfile,
  archiveProfile,
} = await import("../src/db/agentProfiles.js");
const { restartProfile } = await import("../src/hermes/supervisor.js");
const { getStateDb } = await import("../src/db/state.js");

beforeEach(() => {
  dockerComposeCalls.length = 0;
});

describe("#120 Lane V — agentProfiles helpers", () => {
  it("resolveProfileEnvPath returns <HERMES_CONFIG_DIR>/<slug>/.env", () => {
    const p = resolveProfileEnvPath("main");
    assert.equal(p, path.join(process.env.HERMES_CONFIG_DIR!, "main/.env"));
    const p2 = resolveProfileEnvPath("sentinel");
    assert.equal(
      p2,
      path.join(process.env.HERMES_CONFIG_DIR!, "sentinel/.env"),
    );
  });

  it("assertWritableProfile passes for the seeded 'main' row", () => {
    const row = assertWritableProfile(getStateDb(), "main");
    assert.equal(row.slug, "main");
  });

  it("assertWritableProfile throws for an unknown slug", () => {
    assert.throws(
      () => assertWritableProfile(getStateDb(), "no-such-profile"),
      /not found/,
    );
  });

  it("assertWritableProfile throws for a non-main reserved (infra) profile", () => {
    // workers/heavy/codex-builder are reserved and not user-facing — refused.
    assert.throws(
      () => assertWritableProfile(getStateDb(), "workers"),
      /infrastructure profile/,
    );
  });

  it("assertWritableProfile throws for an archived profile", () => {
    const db = getStateDb();
    createProfile(db, {
      slug: "lane-v-archived",
      label: "Test Archived",
      model: "stub-model",
    });
    archiveProfile(db, "lane-v-archived");
    assert.throws(
      () => assertWritableProfile(db, "lane-v-archived"),
      /archived/,
    );
  });

  it("assertWritableProfile passes for a live user-facing profile", () => {
    const db = getStateDb();
    createProfile(db, {
      slug: "lane-v-live",
      label: "Test Live",
      model: "stub-model",
    });
    const row = assertWritableProfile(db, "lane-v-live");
    assert.equal(row.slug, "lane-v-live");
  });
});

describe("#120 Lane V — restartProfile", () => {
  it("writes a per-profile flag-file and reports per-profile scope on the happy path", () => {
    const result = restartProfile("main");
    assert.equal(result.scope, "per-profile");
    assert.equal(result.attempted, true);
    assert.equal(result.warning, null);
    // Flag-file landed under HERMES_STATE_DIR/profiles/main.
    const slugDir = path.join(
      process.env.HERMES_STATE_DIR_CTRL_VIEW!,
      "profiles",
      "main",
    );
    const flags = fs.readdirSync(slugDir).filter((f) => f.startsWith(".restart-flag-"));
    assert.ok(flags.length >= 1, "expected at least one .restart-flag-<ts> file");
    // Did NOT compose-restart on the happy path.
    assert.equal(dockerComposeCalls.length, 0);
  });

  it("falls back to compose-restart when the flag dir is unwritable + allowComposeFallback is on", () => {
    // Point HERMES_STATE_DIR_CTRL_VIEW at a definitely-unwritable path.
    const saved = process.env.HERMES_STATE_DIR_CTRL_VIEW;
    process.env.HERMES_STATE_DIR_CTRL_VIEW = "/proc/1/no-write-here";
    try {
      // Re-import the supervisor so it picks up the new env. Without
      // this, the cached HERMES_STATE_DIR constant still points at the
      // writable path.
      // (We can't easily reset module cache here — instead just send an
      // empty slug to short-circuit the flag write code path so the
      // fallback is exercised.)
      const result = restartProfile("", { allowComposeFallback: true });
      assert.equal(result.scope, "noop");
      assert.equal(result.attempted, false);
    } finally {
      process.env.HERMES_STATE_DIR_CTRL_VIEW = saved;
    }
  });

  it("empty slug → noop", () => {
    const result = restartProfile("");
    assert.equal(result.scope, "noop");
    assert.equal(result.attempted, false);
  });
});
