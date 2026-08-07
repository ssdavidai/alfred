// #470 — `commitment` is a canonical vault record type.
//
// Phase 0b of #467. ctrl-api is the sole vault writer and enforces the
// promotion contract on the write path; without `commitment` in the canonical
// set every write to `commitment/` returns 422 PROMOTION_CONTRACT_VIOLATION.
//
// These also pin the surrounding behaviour, because the risk in widening a
// canonical set is widening it too far.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_RECORD_TYPES,
  CANONICAL_NON_RECORD_DIRS,
  assertCanonicalVaultPath,
} from "../src/db/promotionContract.js";

test("commitment is a canonical record type", () => {
  assert.ok(
    (CANONICAL_RECORD_TYPES as readonly string[]).includes("commitment"),
    "commitment must be canonical or every write to commitment/ 422s",
  );
});

test("a commitment record path is accepted", () => {
  assert.doesNotThrow(() =>
    assertCanonicalVaultPath("commitment/acme-com-2026-001.md"),
  );
});

test("commitment records survive a state-transition subdirectory", () => {
  // Terminal records may be moved into <type>/_closed/ and stay canonical.
  assert.doesNotThrow(() =>
    assertCanonicalVaultPath("commitment/_closed/acme-com-2026-001.md"),
  );
});

test("widening the set did not admit the demoted types", () => {
  // The whole point of the promotion contract. If one of these starts
  // passing, a demoted record type has leaked back into the vault.
  for (const demoted of [
    "observation",
    "signal",
    "stream_event",
    "synthesis",
    "assumption",
    "contradiction",
  ]) {
    assert.throws(
      () => assertCanonicalVaultPath(`${demoted}/x.md`),
      new RegExp(demoted),
      `${demoted}/ must still be rejected`,
    );
  }
});

test("the documented exemptions are unchanged", () => {
  for (const p of [
    "_templates/task.md",
    "needs_attention/2026-08-07T00-00-00Z-abc.md",
    "SOUL.md",
    "RULES.md",
  ]) {
    assert.doesNotThrow(() => assertCanonicalVaultPath(p), `${p} must be exempt`);
  }
  assert.deepEqual(
    [...CANONICAL_NON_RECORD_DIRS].sort(),
    ["_templates", "needs_attention"],
    "exemption list changed — update CLAUDE.md §5.1 in the same PR",
  );
});
