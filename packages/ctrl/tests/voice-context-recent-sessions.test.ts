// Phase 4 regression pin — buildVoiceContext.recentSessions reads alfred_journal
// (not the defunct streams/system-openclaw-sessions.jsonl).
//
// The previous JSONL-tail code is an OpenClaw-era artifact that doesn't exist
// on the Hermes-only stack — `recentSessions` therefore arrived empty and the
// voice agent's "## Recent conversations across channels" primer section
// never appeared in the system prompt. This test pins:
//
//   1. `buildVoiceContext` imports the journal query helper (compile-time
//      contract pin: the old code imported nothing from db/alfredJournal.js
//      under this name)
//   2. the wire is via `queryRecentJournal(db, { principal_id: 'owner' }, …)`
//   3. a long message (>200 chars) is truncated with a "…" suffix so a
//      single overlong entry can't blow the primer budget
//
// Verified at run-time by:
//   * smoke-test against the live tenant after deploy — the bundle's
//     recentSessions[] is populated when alfred_journal has entries
//   * the broader test suite (phone-provision, voice-routes, etc.) catches
//     any regression in the imports / module shape

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const PHONE_TS = fs.readFileSync(
  new URL("../src/api/routes/phone.ts", import.meta.url),
  "utf-8",
);

test("phone.ts imports queryRecentJournal from db/alfredJournal", () => {
  // Compile-time contract: without this import, buildVoiceContext can't
  // call the journal query.
  assert.match(
    PHONE_TS,
    /import\s*\{[^}]*queryRecentJournal[^}]*\}\s*from\s*["']\.\.\/\.\.\/db\/alfredJournal\.js["']/,
    "phone.ts must import queryRecentJournal from db/alfredJournal",
  );
});

test("buildVoiceContext no longer READS the defunct openclaw-sessions JSONL", () => {
  // Anti-regression pin: the OpenClaw-era stream file does not exist on the
  // Hermes-only stack. The filename CAN still appear in a comment block
  // explaining the Phase 4 fix — what matters is that no readJsonlTail()
  // call targets it from inside buildVoiceContext at runtime.
  const buildBlock =
    PHONE_TS.match(/function\s+buildVoiceContext[\s\S]+?\n\}/)?.[0] ?? "";
  assert.ok(
    buildBlock.length > 0,
    "expected to find buildVoiceContext function body",
  );
  assert.doesNotMatch(
    buildBlock,
    /readJsonlTail\(/,
    "buildVoiceContext must not call readJsonlTail — recent sessions come from alfred_journal",
  );
  assert.match(
    buildBlock,
    /safeRecentJournal\(\)/,
    "buildVoiceContext must delegate recent sessions to safeRecentJournal()",
  );
});

test("safeRecentJournal queries the owner principal with a 7-day window", () => {
  // Pin the exact query shape so a future edit that narrows the principal
  // (or the time window) is a deliberate, reviewable change rather than
  // an accidental silent loss of recent-session coverage.
  assert.match(
    PHONE_TS,
    /principal_id:\s*["']owner["']/,
    "must scope the journal query to principal_id='owner'",
  );
  assert.match(
    PHONE_TS,
    /within_hours:\s*168/,
    "must use a 168-hour (7-day) lookback window",
  );
  assert.match(
    PHONE_TS,
    /limit:\s*20/,
    "must request up to 20 entries (formatContextPrimer slices to 10)",
  );
});

test("safeRecentJournal truncates long messages with a … suffix", () => {
  // Truncation must be present so one verbose message doesn't blow the
  // primer budget. The exact cap (200 chars) is a soft contract — what
  // we pin is "the truncation logic exists, and it ends in an ellipsis".
  // The variable holding the length-check is `cleaned`, not `message`,
  // because sanitizeSessionSummary runs first (see test below).
  assert.match(
    PHONE_TS,
    /cleaned\.length\s*>\s*200/,
    "must check for sanitized messages over 200 chars",
  );
  assert.match(
    PHONE_TS,
    /slice\(0,\s*200\)\s*\+\s*["']…["']/,
    "must truncate to 200 chars + ellipsis",
  );
});

test("safeRecentJournal strips 'Last user: …' suffix before truncating", () => {
  // The alfred_journal voice records carry the last user utterance verbatim
  // in the summary. Leaving it in echoed whatever language Sir last spoke
  // (Hungarian, Spanish, …) back into the next session prompt — against
  // a one-paragraph English persona, that was the code-switching cause on
  // 2026-05-26. Strip the suffix before the 200-char cap so primer stays
  // English-anchored.
  assert.match(
    PHONE_TS,
    /function\s+sanitizeSessionSummary[\s\S]{0,400}Last user:/i,
    "must define sanitizeSessionSummary that strips 'Last user: …'",
  );
  assert.match(
    PHONE_TS,
    /sanitizeSessionSummary\s*\(\s*e\.message\s*\)/,
    "safeRecentJournal must call sanitizeSessionSummary(e.message) before truncating",
  );
});

test("safeRecentJournal is wrapped in try/catch (best-effort, never 5xx)", () => {
  // The voice-context bundle is a best-effort primer — a transient DB
  // hiccup must downgrade to "no recent sessions section" rather than
  // 500ing the /voice-context endpoint.
  assert.match(
    PHONE_TS,
    /function\s+safeRecentJournal[\s\S]{0,2000}try\s*\{[\s\S]+?catch/,
    "safeRecentJournal must wrap the journal query in try/catch",
  );
});
