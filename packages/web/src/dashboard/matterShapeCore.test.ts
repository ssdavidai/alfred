/**
 * F54 — matter "shape" section counting. Drives the shape strip that replaces
 * the four zero count-tiles on the matter detail page, counting items in the
 * onboarding-generated body sections (## Key people / ## Open questions / ...).
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/dashboard/matterShapeCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { countSectionItems } from "./matterShapeCore";

const BODY = `# Alfred Black — Product

## Context
Building, dogfooding, and selling Alfred.

## Key people
- Sir David
- Co-founder A
- Advisor B

## Open questions
1. What is the pricing tier?
2. When do we open GA?

## Suggested next actions
- Ship the onboarding fix
`;

test("countSectionItems: dash bullets, numbered items, last-section-to-EOF", () => {
  assert.equal(countSectionItems(BODY, "Key people"), 3);
  assert.equal(countSectionItems(BODY, "Open questions"), 2);
  assert.equal(countSectionItems(BODY, "Suggested next actions"), 1);
});

test("countSectionItems: stops at next heading; case-insensitive", () => {
  assert.equal(countSectionItems(BODY, "Context"), 0); // no bullets
  assert.equal(countSectionItems(BODY, "key people"), 3);
});

test("countSectionItems: absent section and empty body return 0", () => {
  assert.equal(countSectionItems(BODY, "Nonexistent"), 0);
  assert.equal(countSectionItems("", "Key people"), 0);
});
