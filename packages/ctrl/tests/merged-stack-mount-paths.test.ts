import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ---------------------------------------------------------------------------
// Merged single-VM stack mount-path regression (LANE I, batch 6).
//
// ctrl-api on the merged stack mounts `vault_data:/vault` and
// `alfred_data:/alfred-data` (see docker-compose.yaml). It does NOT have any
// `/mnt/encrypted/*` path — that was the OLD per-tenant deploy template
// (src/templates/docker-compose.yaml.njk). Several route files hardcoded the
// dead `/mnt/encrypted/{vault,alfred}` host paths for fs reads/writes, so on
// the merged stack they read/write a non-existent directory and silently
// fail.
//
// This test reads each fixed source file, strips comments, and asserts the
// fs-path STRING CONSTANTS no longer reference `/mnt/encrypted`. It explicitly
// tolerates `/mnt/encrypted` appearing inside a multi-line compose-template
// string literal (the legacy tenant stack, where the path IS correct) by
// scoping the scan to const/path-join declarations.
// ---------------------------------------------------------------------------

const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/api/routes",
);

function read(file: string): string {
  return readFileSync(path.join(SRC, file), "utf-8");
}

// Strip // line comments and /* */ block comments so a /mnt/encrypted mention
// inside a docstring doesn't trip the scan (we only fix load-bearing
// constants, not prose).
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("merged-stack mount paths — no /mnt/encrypted fs constants in fixed routes", () => {
  // Files whose ENTIRE non-comment body must be free of /mnt/encrypted.
  const cleanFiles = [
    "chores.ts",
    "vault.ts",
    "omi.ts",
    "webhooksInbound.ts",
    "channelsAttachment.ts",
    "sureAssistant.ts",
    "email.ts",
  ];

  for (const file of cleanFiles) {
    it(`${file} has no /mnt/encrypted outside comments`, () => {
      const body = stripComments(read(file));
      assert.ok(
        !body.includes("/mnt/encrypted"),
        `${file}: found a /mnt/encrypted reference in non-comment code`,
      );
    });
  }

  it("learning.ts: only the legacy compose-template strings keep /mnt/encrypted", () => {
    const body = stripComments(read("learning.ts"));
    // The bootstrap route embeds the LEGACY tenant compose YAML as a template
    // string; `/mnt/encrypted/{vault,alfred}` is correct there. Every other
    // occurrence (consts, fs paths) must be gone.
    const occurrences = body.match(/\/mnt\/encrypted/g) ?? [];
    // Exactly the two compose volume lines: vault + alfred.
    assert.strictEqual(
      occurrences.length,
      2,
      `learning.ts: expected exactly 2 /mnt/encrypted refs (legacy compose template), found ${occurrences.length}`,
    );
    assert.ok(
      body.includes("- /mnt/encrypted/vault:/vault") &&
        body.includes("- /mnt/encrypted/alfred:/alfred-data"),
      "learning.ts: the 2 surviving refs must be the legacy compose volume lines",
    );
    // The runtime constants must point at the real mounts.
    assert.ok(
      body.includes('process.env.VAULT_PATH ?? "/vault"'),
      "learning.ts: VAULT_PATH must default to /vault",
    );
    assert.ok(
      body.includes('process.env.ALFRED_DATA_DIR ?? "/alfred-data"'),
      "learning.ts: ALFRED_DATA must default to /alfred-data",
    );
  });

  it("phone.ts: vault + alfred-data constants point at real mounts (workspace paths handled separately)", () => {
    const body = stripComments(read("phone.ts"));
    assert.ok(
      body.includes('process.env.VAULT_PATH ?? "/vault"'),
      "phone.ts: VAULT_PATH must default to /vault",
    );
    assert.ok(
      body.includes('"/alfred-data/streams"') ||
        body.includes('"/alfred-data"'),
      "phone.ts: STREAMS_DIR/ALFRED_DATA_DIR must point at /alfred-data",
    );
  });
});
