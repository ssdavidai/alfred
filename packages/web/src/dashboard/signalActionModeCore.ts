// signalActionModeCore — pure shape derivation for the /study#settings
// "Agent autonomy" toggle (Gap 3b).
//
// Lane I ships GET/PUT /api/v1/settings/signal-action-mode which return
// the effective mode + a `source` discriminator + an `env_override_active`
// flag (env var still wins for emergencies). This module derives the UI
// view-model from that shape so the React component is dumb and the
// branching is testable under node:test (same pattern as terminalCardCore).

export type SignalActionMode = "live" | "shadow";
export type SignalActionModeSource =
  | "default"
  | "settings_file"
  | "env_override";

export interface SignalActionModeResp {
  mode?: SignalActionMode | string | null;
  source?: SignalActionModeSource | string | null;
  env_override_active?: boolean | null;
}

export interface SignalActionModeState {
  // Effective mode that is actually in force on the tenant right now.
  mode: SignalActionMode;
  // Where the effective mode came from. Drives the small footnote under
  // the toggle ("Set via environment variable" vs default vs settings).
  source: SignalActionModeSource;
  // True iff the env var is currently overriding whatever is on disk.
  // When true, the toggle MUST be disabled — flipping it would do nothing
  // until the env var is unset, and silently no-op'ing a toggle is the
  // exact failure mode Sir is trying to retire.
  envOverrideActive: boolean;
  // Convenience: the toggle's disabled state. True when env-override is
  // active OR the response itself was malformed (defensive — don't let
  // the principal toggle a thing whose effective state we couldn't read).
  toggleDisabled: boolean;
  // Convenience: the *other* mode, for the button label / next-state.
  otherMode: SignalActionMode;
}

const DEFAULT_STATE: SignalActionModeState = {
  // Sir's chosen default once shadow-mode-by-env retires.
  mode: "live",
  source: "default",
  envOverrideActive: false,
  toggleDisabled: false,
  otherMode: "shadow",
};

function coerceMode(value: unknown): SignalActionMode | null {
  if (value === "live" || value === "shadow") return value;
  return null;
}

function coerceSource(value: unknown): SignalActionModeSource | null {
  if (
    value === "default" ||
    value === "settings_file" ||
    value === "env_override"
  ) {
    return value;
  }
  return null;
}

export function deriveSignalActionModeState(
  resp: SignalActionModeResp | null | undefined,
): SignalActionModeState {
  if (!resp || typeof resp !== "object") {
    // Response missing or unparseable — show default-live but disable the
    // toggle so we don't pretend a flip worked.
    return { ...DEFAULT_STATE, toggleDisabled: true };
  }
  const mode = coerceMode(resp.mode);
  const source = coerceSource(resp.source);
  if (!mode) {
    return { ...DEFAULT_STATE, toggleDisabled: true };
  }
  const envOverrideActive = Boolean(resp.env_override_active);
  // If env-override is active the source MUST be env_override; if the
  // backend forgot to set it that way, normalise so the footnote matches
  // the disabled-toggle reality the user sees.
  const effectiveSource: SignalActionModeSource = envOverrideActive
    ? "env_override"
    : (source ?? "default");
  return {
    mode,
    source: effectiveSource,
    envOverrideActive,
    toggleDisabled: envOverrideActive,
    otherMode: mode === "live" ? "shadow" : "live",
  };
}

// Sir-facing copy for each effective state. Kept here (not inline in the
// JSX) so the test suite can pin the wording — the toggle's whole job is
// to be unambiguous about what's about to happen, so the description copy
// IS part of the contract.
export const MODE_DESCRIPTIONS: Record<SignalActionMode, string> = {
  live:
    "Alfred dispatches actions on his own when his discretion clears the bar. Anything below the bar still surfaces on the Desk for you to decide.",
  shadow:
    "Alfred records every action he would have taken, but never dispatches. Everything surfaces on the Desk for your approval first.",
};

export function describeSource(state: SignalActionModeState): string | null {
  if (state.envOverrideActive) {
    return "Currently overridden by environment variable. Toggle is informational.";
  }
  if (state.source === "settings_file") {
    return "Set from this toggle.";
  }
  // "default" — no footnote needed; the toggle is on the canonical default.
  return null;
}
