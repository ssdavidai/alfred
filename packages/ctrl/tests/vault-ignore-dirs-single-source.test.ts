// vault_index IGNORE_DIRS divergence.
//
// src/db/vaultIndex.ts (the reconciler / per-write index) and
// src/api/routes/vault.ts (the list/walk endpoints) each defined their OWN
// IGNORE_DIRS set, and they DIFFERED — vaultIndex ignored `.git` and `inbox`
// while vault.ts walked into them. So the reconciler and the API disagreed on
// which directories are vault content: a file under `inbox/` would be served
// by the list/walk endpoints but never indexed (and vice-versa). They must be
// one shared source of truth.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-ignore-"));
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.ALFRED_DATA_DIR = tmp;
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
fs.mkdirSync(path.join(tmp, "streams"), { recursive: true });

// Import the API server first: it loads every route module in a controlled
// order (vault.ts → its `export const VAULT_PATH` → admin.ts which reads it),
// so by the time it resolves the module graph is fully initialized. Importing
// vault.ts or vaultIndex.ts bare hits a pre-existing init-cycle TDZ
// (vault.ts → server.ts → admin.ts → vault.ts.VAULT_PATH).
await import("../src/api/server.js");
const vaultRoute = await import("../src/api/routes/vault.js");
const vaultIndex = await import("../src/db/vaultIndex.js");

describe("IGNORE_DIRS single source of truth", () => {
  it("both modules export IGNORE_DIRS", () => {
    assert.ok(vaultIndex.IGNORE_DIRS instanceof Set, "vaultIndex must export IGNORE_DIRS");
    assert.ok(vaultRoute.IGNORE_DIRS instanceof Set, "vault route must export IGNORE_DIRS");
  });

  it("the two sets are identical (same membership)", () => {
    const a = [...(vaultIndex.IGNORE_DIRS as Set<string>)].sort();
    const b = [...(vaultRoute.IGNORE_DIRS as Set<string>)].sort();
    assert.deepEqual(a, b, "reconciler and walk endpoints must agree on ignored dirs");
  });

  it("they are the SAME Set instance (one source, not two copies)", () => {
    assert.strictEqual(
      vaultIndex.IGNORE_DIRS,
      vaultRoute.IGNORE_DIRS,
      "IGNORE_DIRS must be a single shared object, not duplicated literals",
    );
  });

  it("the canonical set still ignores the previously-divergent dirs", () => {
    for (const d of ["_templates", "_bases", "_docs", ".obsidian", ".git", "view", "dashboard", "inbox"]) {
      assert.ok((vaultRoute.IGNORE_DIRS as Set<string>).has(d), `must ignore ${d}`);
    }
  });
});
