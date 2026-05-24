/**
 * Gap 3b — /study#settings "Agent autonomy" toggle.
 *
 * Smoke-tests the pure shape derivation that drives the toggle so the
 * three states the principal can see are pinned:
 *   1. live (default)                                    → toggle enabled, no footnote
 *   2. shadow (set from toggle, settings_file source)    → toggle enabled, "Set from this toggle." footnote
 *   3. env override active                               → toggle DISABLED with the env-override footnote
 *
 * Plus the defensive paths: missing response, garbage mode value, mode
 * present but `env_override_active=true` (source must normalise to
 * env_override even if backend forgot to set it).
 *
 * Run with:  cd packages/web && npx tsx --test src/dashboard/signalActionModeCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveSignalActionModeState,
  describeSource,
  MODE_DESCRIPTIONS,
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
