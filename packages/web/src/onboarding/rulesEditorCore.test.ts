/**
 * Phase-3 Lane III · Commit 1 — failing-test-first for the C-OB2 RULES.md
 * editor helpers. Run: cd packages/web && npx tsx --test src/onboarding/rulesEditorCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRulesMarkdown, serializeRules } from "./rulesEditorCore";

const FULL_BODY = `# Standing Rules

## Personal sovereignty rules
- Never publish before sir signs.
- Decline meetings before 10am London.

## Household rules
- Quiet hours after 22:00.

## Communication rules
- Reply to family within 4 hours.

## Decision rules
- Confirm any outbound move > £5,000.
`;

const TWO_SECTION_BODY = `# Standing Rules

## Personal sovereignty rules
- Never publish before sir signs.

## Decision rules
- Confirm any outbound move > £5,000.
`;

const normalise = (s: string) =>
  s.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/, "")).join("\n")
    .replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "\n");

test("(a) full body parses to 4 non-empty arrays", () => {
  const p = parseRulesMarkdown(FULL_BODY);
  assert.equal(p.sovereignty.length, 2);
  assert.equal(p.household.length, 1);
  assert.equal(p.communication.length, 1);
  assert.equal(p.decision.length, 1);
  assert.deepEqual(p.sovereignty, [
    "Never publish before sir signs.",
    "Decline meetings before 10am London.",
  ]);
});

test("(b) 2-section body → 2 arrays + 2 empty", () => {
  const p = parseRulesMarkdown(TWO_SECTION_BODY);
  assert.equal(p.sovereignty.length, 1);
  assert.equal(p.household.length, 0);
  assert.equal(p.communication.length, 0);
  assert.equal(p.decision.length, 1);
});

test("(c) round-trip preserves content modulo whitespace", () => {
  assert.equal(normalise(serializeRules(parseRulesMarkdown(FULL_BODY))), normalise(FULL_BODY));
  assert.equal(normalise(serializeRules(parseRulesMarkdown(TWO_SECTION_BODY))), normalise(TWO_SECTION_BODY));
});

test("(d) serializeRules omits empty sections", () => {
  const body = serializeRules({
    sovereignty: ["one rule"], household: [], communication: [], decision: [],
  });
  assert.match(body, /^# Standing Rules\n/);
  assert.match(body, /## Personal sovereignty rules\n- one rule/);
  assert.equal(body.includes("## Household rules"), false);
  assert.equal(body.includes("## Communication rules"), false);
  assert.equal(body.includes("## Decision rules"), false);
});

test("(e) parseRulesMarkdown('') → 4 empty arrays", () => {
  const p = parseRulesMarkdown("");
  assert.deepEqual(p, { sovereignty: [], household: [], communication: [], decision: [] });
});

test("tolerates `*` bullets, missing title, trailing whitespace", () => {
  const body = `## Personal sovereignty rules\n* Rule one.   \n`;
  assert.deepEqual(parseRulesMarkdown(body).sovereignty, ["Rule one."]);
});

test("alternate error shape: status from .status (regression cover)", () => {
  // All-empty round-trip re-parses to all-empty arrays.
  const body = serializeRules({ sovereignty: [], household: [], communication: [], decision: [] });
  assert.deepEqual(parseRulesMarkdown(body), {
    sovereignty: [], household: [], communication: [], decision: [],
  });
});
