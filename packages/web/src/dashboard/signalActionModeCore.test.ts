/**
 * Gap 3b + sir-matter-task #6 — /study#settings "Agent autonomy" toggles.
 *
 * Smoke-tests the pure shape derivation that drives the toggles so the
 * three states the principal can see are pinned:
 *   1. live (default)                                    → toggle enabled, no footnote
 *   2. shadow (set from toggle, settings_file source)    → toggle enabled, "Set from this toggle." footnote
 *   3. env override active                               → toggle DISABLED with the env-override footnote
 *
 * Plus the defensive paths: missing response, garbage mode value, mode
 * present but `env_override_active=true` (source must normalise to
 * env_override even if backend forgot to set it).
 *
 * Plus the multi-key derivation: GET /api/v1/settings → three keys
 * derive independently, env-override on one key does not disable the
 * other two, and missing keys disable just their own toggle.
 *
 * Run with:  cd packages/web && npx tsx --test src/dashboard/signalActionModeCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveSignalActionModeState,
  describeSource,
  MODE_DESCRIPTIONS,
  AGENT_SETTING_KEYS,
  AGENT_SETTING_DESCRIPTORS,
  deriveAgentSettingsView,
} from "./signalActionModeCore";

test("derive: default live mode → enabled toggle, no footnote", () => {
  const s = deriveSignalActionModeState({
    mode: "live",
    source: "default",
    env_override_active: false,
  });
  assert.equal(s.mode, "live");
  assert.equal(s.source, "default");
  assert.equal(s.envOverrideActive, false);
  assert.equal(s.toggleDisabled, false);
  assert.equal(s.otherMode, "shadow");
  assert.equal(describeSource(s), null);
});

test("derive: shadow mode set from toggle → enabled toggle, source footnote", () => {
  const s = deriveSignalActionModeState({
    mode: "shadow",
    source: "settings_file",
    env_override_active: false,
  });
  assert.equal(s.mode, "shadow");
  assert.equal(s.source, "settings_file");
  assert.equal(s.toggleDisabled, false);
  assert.equal(s.otherMode, "live");
  assert.equal(describeSource(s), "Set from this toggle.");
});

test("derive: env-override active → toggle DISABLED and overridden footnote", () => {
  const s = deriveSignalActionModeState({
    mode: "shadow",
    source: "env_override",
    env_override_active: true,
  });
  assert.equal(s.envOverrideActive, true);
  assert.equal(s.toggleDisabled, true);
  assert.equal(s.source, "env_override");
  assert.equal(
    describeSource(s),
    "Currently overridden by environment variable. Toggle is informational.",
  );
});

test("derive: env_override_active=true normalises source even when backend forgets", () => {
  // Backend sends mode=shadow but source=default and env_override_active=true.
  // The footnote MUST match the disabled-toggle reality (env-override).
  const s = deriveSignalActionModeState({
    mode: "shadow",
    source: "default",
    env_override_active: true,
  });
  assert.equal(s.source, "env_override");
  assert.equal(s.toggleDisabled, true);
});

test("derive: missing response → default-live, toggle disabled", () => {
  const s = deriveSignalActionModeState(null);
  assert.equal(s.mode, "live");
  assert.equal(s.toggleDisabled, true);
});

test("derive: garbage mode value → default-live, toggle disabled", () => {
  const s = deriveSignalActionModeState({
    mode: "weird",
    source: "default",
    env_override_active: false,
  } as any);
  assert.equal(s.mode, "live");
  assert.equal(s.toggleDisabled, true);
});

test("derive: unknown source value falls back to 'default'", () => {
  const s = deriveSignalActionModeState({
    mode: "live",
    source: "from-the-future" as any,
    env_override_active: false,
  });
  assert.equal(s.source, "default");
  assert.equal(s.toggleDisabled, false);
});

test("copy: every mode has a non-empty Sir-facing description", () => {
  assert.ok(MODE_DESCRIPTIONS.live.length > 20);
  assert.ok(MODE_DESCRIPTIONS.shadow.length > 20);
  // The shadow description must mention the Desk so the principal knows
  // where the deferred actions go.
  assert.match(MODE_DESCRIPTIONS.shadow, /desk/i);
});

// ---------------------------------------------------------------------------
// Multi-key Agent autonomy (sir-matter-task #6)
// ---------------------------------------------------------------------------

test("descriptors: the three Agent-autonomy keys are present in display order", () => {
  assert.deepEqual(
    [...AGENT_SETTING_KEYS],
    ["signal_action_mode", "state_mutator_mode", "auto_task_create_mode"],
  );
  assert.equal(AGENT_SETTING_DESCRIPTORS.length, 3);
  assert.equal(AGENT_SETTING_DESCRIPTORS[0].key, "signal_action_mode");
  assert.equal(AGENT_SETTING_DESCRIPTORS[1].key, "state_mutator_mode");
  assert.equal(AGENT_SETTING_DESCRIPTORS[2].key, "auto_task_create_mode");
});

test("descriptors: every key has a label and a Sir-facing description", () => {
  for (const d of AGENT_SETTING_DESCRIPTORS) {
    assert.ok(d.label.length > 0, `${d.key} needs a label`);
    assert.ok(
      d.description.length > 30,
      `${d.key} description is too short`,
    );
    // Each description must mention what shadow does — the principal
    // has to know what flipping the toggle changes.
    assert.match(
      d.description,
      /shadow/i,
      `${d.key} description must explain shadow mode`,
    );
  }
});

test("deriveAgentSettingsView: all three keys live + defaults → three enabled toggles", () => {
  const view = deriveAgentSettingsView({
    settings: {
      signal_action_mode: { mode: "live", source: "default", env_override_active: false },
      state_mutator_mode: { mode: "live", source: "default", env_override_active: false },
      auto_task_create_mode: { mode: "live", source: "default", env_override_active: false },
    },
  });
  assert.equal(view.length, 3);
  for (const v of view) {
    assert.equal(v.state.mode, "live");
    assert.equal(v.state.toggleDisabled, false);
    assert.equal(v.state.envOverrideActive, false);
  }
  assert.equal(view[0].key, "signal_action_mode");
  assert.equal(view[1].key, "state_mutator_mode");
  assert.equal(view[2].key, "auto_task_create_mode");
});

test("deriveAgentSettingsView: env-override on one key doesn't disable the others", () => {
  const view = deriveAgentSettingsView({
    settings: {
      signal_action_mode: { mode: "shadow", source: "env_override", env_override_active: true },
      state_mutator_mode: { mode: "live", source: "default", env_override_active: false },
      auto_task_create_mode: { mode: "shadow", source: "settings_file", env_override_active: false },
    },
  });
  const bySignal = view.find((v) => v.key === "signal_action_mode")!;
  const byState = view.find((v) => v.key === "state_mutator_mode")!;
  const byAuto = view.find((v) => v.key === "auto_task_create_mode")!;
  assert.equal(bySignal.state.toggleDisabled, true);
  assert.equal(bySignal.state.envOverrideActive, true);
  assert.equal(byState.state.toggleDisabled, false);
  assert.equal(byState.state.envOverrideActive, false);
  assert.equal(byAuto.state.toggleDisabled, false);
  assert.equal(byAuto.state.mode, "shadow");
  assert.equal(byAuto.state.source, "settings_file");
});

test("deriveAgentSettingsView: missing key disables only that key's toggle", () => {
  const view = deriveAgentSettingsView({
    settings: {
      // only signal_action_mode present
      signal_action_mode: { mode: "live", source: "default", env_override_active: false },
    },
  });
  const bySignal = view.find((v) => v.key === "signal_action_mode")!;
  const byState = view.find((v) => v.key === "state_mutator_mode")!;
  const byAuto = view.find((v) => v.key === "auto_task_create_mode")!;
  assert.equal(bySignal.state.toggleDisabled, false);
  // Missing keys → derive(null) → toggleDisabled true with default-live mode.
  assert.equal(byState.state.toggleDisabled, true);
  assert.equal(byState.state.mode, "live");
  assert.equal(byAuto.state.toggleDisabled, true);
});

test("deriveAgentSettingsView: missing response → three disabled toggles, all default-live", () => {
  const view = deriveAgentSettingsView(null);
  assert.equal(view.length, 3);
  for (const v of view) {
    assert.equal(v.state.toggleDisabled, true);
    assert.equal(v.state.mode, "live");
  }
});

test("deriveAgentSettingsView: round-trips a shadow mode through the view-model", () => {
  // The UI flips one toggle to shadow — backend re-reads and returns
  // shadow+settings_file. The derived view-model must reflect that
  // unambiguously (enabled toggle, "Set from this toggle." footnote).
  const view = deriveAgentSettingsView({
    settings: {
      signal_action_mode: { mode: "live", source: "default", env_override_active: false },
      state_mutator_mode: { mode: "shadow", source: "settings_file", env_override_active: false },
      auto_task_create_mode: { mode: "live", source: "default", env_override_active: false },
    },
  });
  const byState = view.find((v) => v.key === "state_mutator_mode")!;
  assert.equal(byState.state.mode, "shadow");
  assert.equal(byState.state.source, "settings_file");
  assert.equal(byState.state.toggleDisabled, false);
  assert.equal(describeSource(byState.state), "Set from this toggle.");
});
