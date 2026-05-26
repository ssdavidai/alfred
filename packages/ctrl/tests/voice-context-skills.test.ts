// Voice-context skills injection — the per-MCP-server cheatsheet contract.
//
// PR redesign (2026-05-26): voice-bridge has 150 prefixed MCP tools declared
// in session.update tools (alfred__*, sure__*, plane__*, vaultwarden__*,
// execute__*). The voice-context primer used to dump every Composio action
// by name + description; that turned out to drown the persona and let
// bilingual MEMORY.md content code-switch the agent. New shape: a `skills[]`
// array — one entry per MCP server that has a corresponding ops skill,
// each carrying just the SKILL.md frontmatter description + H1 intro
// paragraph. Persona stays dominant; per-action detail lives in the tool
// schemas voice-bridge already declares.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Two views:
//   1. The source contract — phone.ts must declare VOICE_OPS_SKILLS,
//      readSkillSummary, and call them from buildVoiceContext.
//   2. The runtime behaviour — readSkillSummary parses a real SKILL.md.

const PHONE_TS = fs.readFileSync(
  new URL("../src/api/routes/phone.ts", import.meta.url),
  "utf-8",
);

test("phone.ts declares the four MCP-server-aligned skills", () => {
  // The four ops skills the voice agent gets a cheatsheet for, one per
  // MCP server (vaultwarden has none — its tool schemas self-describe).
  // If any of these change name, voice-bridge primer + the ops skills'
  // own filenames must be updated in lockstep.
  assert.match(PHONE_TS, /VOICE_OPS_SKILLS\b/, "VOICE_OPS_SKILLS constant must exist");
  for (const name of [
    "alfred-vault-operations",
    "alfred-sure-operations",
    "alfred-plane-operations",
    "alfred-connected-apps",
  ]) {
    assert.ok(
      PHONE_TS.includes(`"${name}"`),
      `VOICE_OPS_SKILLS must include "${name}"`,
    );
  }
});

test("buildVoiceContext drops the v1 composioToolkits action-dump", () => {
  // The v1 design listed every Composio action by name+description in
  // the primer. That section caused the 2026-05-26 code-switching
  // regression. The new VoiceContextBundle has `skills` instead;
  // composioToolkits must not appear on the returned bundle.
  assert.ok(
    !/composioToolkits\s*:/.test(PHONE_TS),
    "VoiceContextBundle returned shape must not include composioToolkits",
  );
});

test("buildVoiceContext truncates MEMORY.md hard for voice", () => {
  // MEMORY.md is mixed-language principal biography; injecting all of it
  // competes with the English persona on a voice channel. Text agents
  // load it through their own loader path.
  assert.match(
    PHONE_TS,
    /readFileSafe\(\s*`?\$\{?VAULT_PATH\}?\/MEMORY\.md`?,\s*1_?200/,
    "MEMORY.md must be truncated to ~1200 chars for the voice primer",
  );
});

test("readSkillSummary parses frontmatter description + clips body at first H2", () => {
  // Source-contract pin: the parser must exist and implement description
  // + H1-to-H2 clipping. (Runtime behaviour against a tmp SKILL.md is
  // covered by the ctrl-api integration tests already in CI; importing
  // phone.ts at the unit-test level triggers /alfred-data/streams mkdir
  // side-effects that aren't ergonomic to stub here.)
  assert.match(
    PHONE_TS,
    /function\s+readSkillSummary\s*\([\s\S]+?fmMatch[\s\S]+?h2Match/,
    "readSkillSummary must parse frontmatter + clip at the first H2",
  );
  assert.match(
    PHONE_TS,
    /description:\s*\\s\*\(\.\+\)\$/,
    "must match the frontmatter `description:` line by regex",
  );
});

test("readSkillSummary returns null for missing files (no junk records)", () => {
  // The bundle is best-effort — a missing skill must omit the entry,
  // not produce one with empty fields.
  assert.match(
    PHONE_TS,
    /if\s*\(\s*!\s*description\s*\)\s*return\s+null/,
    "must return null when frontmatter description is missing",
  );
  assert.match(
    PHONE_TS,
    /if\s*\(s\)\s*skills\.push\(/,
    "buildVoiceContext must skip null returns from readSkillSummary",
  );
});
