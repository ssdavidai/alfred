// The write path and the read path must agree about which types exist.
//
// WHY THIS FILE EXISTS. `promotionContract.ts` decides what may be WRITTEN to
// the vault. `routes/vault.ts` has a separate `KNOWN_TYPES` allowlist deciding
// what may be LISTED. Adding a canonical type to the first and forgetting the
// second produces a type you can create but cannot enumerate: writes return
// 201, `GET /vault/list/<type>` returns 400.
//
// That split has now bitten three times:
//
//   1. `daybook` — fixed after GET /vault/list/daybook 400'd valid records
//   2. `place`   — same commit, same cause
//   3. `commitment` (#469/#470) — the write path was added and the read path
//      was not. Every commitment register bootstrap failed with
//      "Unknown vault type: commitment", while the promotion-contract tests
//      passed, because they only ever exercised the write side.
//
// Each time it was found in production rather than in CI, because no test
// compared the two lists. This one does, so a fourth occurrence fails here
// instead of on a live tenant.
//
// It imports the tables from `api/vaultTypes.ts`, not from the route module.
// The first version imported `routes/vault.js` and died at load with
// `ReferenceError: Cannot access 'VAULT_PATH' before initialization` — that
// module is in an import cycle with `routes/admin.ts` and is only safely
// loadable through the app's entry order.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CANONICAL_RECORD_TYPES } from "../src/db/promotionContract.js";
import { KNOWN_TYPES, STATUS_BY_TYPE } from "../src/api/vaultTypes.js";

test("every canonical record type is listable", () => {
  const listable = new Set(KNOWN_TYPES as readonly string[]);
  const missing = (CANONICAL_RECORD_TYPES as readonly string[]).filter(
    (t) => !listable.has(t),
  );
  assert.deepEqual(
    missing,
    [],
    `These types can be written but not listed — GET /vault/list/<type> will ` +
      `400 for each: ${missing.join(", ")}. Add them to KNOWN_TYPES in ` +
      `routes/vault.ts.`,
  );
});

test("commitment specifically is listable", () => {
  // The regression that motivated the file. Kept as its own case so a failure
  // names the type rather than only the invariant.
  assert.ok(
    (KNOWN_TYPES as readonly string[]).includes("commitment"),
    "commitment must be listable or every register bootstrap fails",
  );
});

test("commitment exposes only the coarse status vocabulary", () => {
  // The 11-state lifecycle lives in `commitment_state`. If the coarse list
  // ever grows lifecycle values, the two state surfaces have been conflated
  // and a false closure becomes expressible.
  assert.deepEqual(
    [...(STATUS_BY_TYPE["commitment"] ?? [])].sort(),
    ["active", "blocked", "done", "todo"],
  );
});

test("a listable type is not thereby canonical", () => {
  // The invariant is one-directional on purpose. KNOWN_TYPES still carries
  // demoted legacy types (signal, observation, stream_event…) so their
  // historical records remain readable. Asserting set equality would demand
  // deleting that read compatibility, which is a separate decision.
  const canonical = new Set(CANONICAL_RECORD_TYPES as readonly string[]);
  const readOnlyLegacy = (KNOWN_TYPES as readonly string[]).filter(
    (t) => !canonical.has(t),
  );
  assert.ok(
    readOnlyLegacy.length > 0,
    "expected legacy read-only types to remain listable",
  );
});
