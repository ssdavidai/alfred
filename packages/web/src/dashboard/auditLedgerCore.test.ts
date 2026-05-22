/**
 * F53 — audit-ledger action_type display normalisation. The SQL ledger stores
 * mixed conventions (signal-action / desk_action / needs_attention_action /
 * decision); the page shows one casing.
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/dashboard/auditLedgerCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { auditKindLabel } from "./auditLedgerCore";

test("auditKindLabel: collapses hyphens and underscores to spaces, uppercases", () => {
  assert.equal(auditKindLabel("signal-action"), "SIGNAL ACTION");
  assert.equal(auditKindLabel("desk_action"), "DESK ACTION");
  assert.equal(auditKindLabel("needs_attention_action"), "NEEDS ATTENTION ACTION");
  assert.equal(auditKindLabel("decision"), "DECISION");
});

test("auditKindLabel: empty / missing falls back to ACTION", () => {
  assert.equal(auditKindLabel(""), "ACTION");
  assert.equal(auditKindLabel(undefined as unknown as string), "ACTION");
});
