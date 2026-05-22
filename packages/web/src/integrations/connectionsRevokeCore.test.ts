/**
 * F72 — revoke modal: last-account-of-toolkit detection + conditional copy. The
 * old confirm() over-promised ("removes the stream, skill, and all tool access")
 * even when a sibling account survives; the copy must be conditional.
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/integrations/connectionsRevokeCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isLastAccountOfToolkit,
  revokeConsequenceCopy,
} from "./connectionsRevokeCore";

const gmailA = { id: "ca_a", toolkit: "gmail", status: "ACTIVE" };
const gmailB = { id: "ca_b", toolkit: "gmail", status: "ACTIVE" };
const youtube = { id: "ca_y", toolkit: "youtube", status: "ACTIVE" };

test("last account when no other ACTIVE sibling of the toolkit", () => {
  assert.equal(isLastAccountOfToolkit(youtube, [youtube, gmailA]), true);
});

test("NOT last when a sibling ACTIVE account remains (two Gmail)", () => {
  assert.equal(isLastAccountOfToolkit(gmailA, [gmailA, gmailB, youtube]), false);
});

test("INITIATED siblings don't keep it from being the last ACTIVE", () => {
  const pending = { id: "ca_p", toolkit: "gmail", status: "INITIATED" };
  assert.equal(isLastAccountOfToolkit(gmailA, [gmailA, pending]), true);
});

test("webhook rows are always last (singletons)", () => {
  const wh = { id: "webhook:abc", toolkit: "alfred-webhook" };
  assert.equal(isLastAccountOfToolkit(wh, [wh]), true);
});

test("consequence copy is conditional on last-of-toolkit", () => {
  assert.match(revokeConsequenceCopy("Gmail", true), /stream, skill, and all tool access/);
  assert.match(revokeConsequenceCopy("Gmail", false), /stay connected/);
});
