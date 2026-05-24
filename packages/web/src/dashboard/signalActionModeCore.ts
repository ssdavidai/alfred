// signalActionModeCore — pure shape derivation for the /study#settings
// "Agent autonomy" section (Gap 3b + sir-matter-task #6).
//
// Lane I ships GET /api/v1/settings → { settings: { [key]: { mode, source,
// env_override_active } } } returning all autonomy-affecting flags at once,
// plus PUT /api/v1/settings/:key for the per-toggle flip. Single-key
// GET/PUT /api/v1/settings/signal-action-mode stay as backwards-compat
// for callers that still want just the one knob.
//
// This module derives the UI view-model from those shapes so the React
// component is dumb and the branching is testable under node:test (same
// pattern as terminalCardCore). It is intentionally named
// `signalActionModeCore` for filename stability — the exported surface
// generalises to all three Agent-autonomy keys.

// ---------------------------------------------------------------------------
// Per-key shape (single source of truth for one autonomy knob)
// ---------------------------------------------------------------------------

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

// Sir-facing copy for each effective state of the original signal-action
// toggle. Kept here (not inline in the JSX) so the test suite can pin the
// wording — the toggle's whole job is to be unambiguous about what's
// about to happen, so the description copy IS part of the contract.
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

// ---------------------------------------------------------------------------
// Multi-key Agent-autonomy view (sir-matter-task #6)
// ---------------------------------------------------------------------------
//
// Three knobs share the same shape; render them as three stacked toggles
// under one heading. Lane I serves GET /api/v1/settings → all three in
// one payload, then PUT /api/v1/settings/:key for the flip. Each key
// also keeps a backwards-compatible single-key GET/PUT (already shipped
// for `signal_action_mode`) — but the page should use the unified GET.

export type AgentSettingKey =
  | "signal_action_mode"
  | "state_mutator_mode"
  | "auto_task_create_mode";

export const AGENT_SETTING_KEYS: readonly AgentSettingKey[] = [
  "signal_action_mode",
  "state_mutator_mode",
  "auto_task_create_mode",
] as const;

export interface AgentSettingDescriptor {
  key: AgentSettingKey;
  label: string;
  // Sir-facing description shown under the label, same idiom as the
  // existing single-toggle description: a sentence or two of plain prose
  // explaining what Live means and (where useful) what Shadow does
  // instead. Pinned by tests so copy drift can't sneak in.
  description: string;
}

// Order matters — this is the visual order on the page (signal first,
// the existing toggle stays at the top, the two new ones beneath it).
export const AGENT_SETTING_DESCRIPTORS: readonly AgentSettingDescriptor[] = [
  {
    key: "signal_action_mode",
    label: "Signal action",
    description:
      "Whether I dispatch autonomously when my discretion clears the bar. In shadow, I record every action I would have taken and surface it on the Desk for your approval.",
  },
  {
    key: "state_mutator_mode",
    label: "State updates",
    description:
      "Whether I update the narrative state on matters and tasks as I learn. In shadow, I record what I would write but don't touch your records.",
  },
  {
    key: "auto_task_create_mode",
    label: "Auto-create tasks",
    description:
      "Whether I create new tasks from signals on my own. In shadow, I surface the suggestion on the Desk for your approval first.",
  },
] as const;

// Shape returned by GET /api/v1/settings (Lane I). The settings map is
// keyed by AgentSettingKey but defensively typed — backend may add new
// keys before the UI knows about them, and we just ignore those.
export interface AgentSettingsResp {
  settings?: Partial<Record<AgentSettingKey, SignalActionModeResp>> | null;
}

export interface AgentSettingView extends AgentSettingDescriptor {
  state: SignalActionModeState;
}

// Derive the full Agent-autonomy view-model: one entry per descriptor,
// in display order, each carrying its derived per-key state. Missing
// keys in the response fall through to the default-state-with-disabled-
// toggle path, same as deriveSignalActionModeState(null) — the UI
// surfaces "couldn't read" rather than pretending it's live.
export function deriveAgentSettingsView(
  resp: AgentSettingsResp | null | undefined,
): AgentSettingView[] {
  const settings = resp && typeof resp === "object" ? resp.settings ?? null : null;
  return AGENT_SETTING_DESCRIPTORS.map((d) => {
    const perKey =
      settings && typeof settings === "object" ? settings[d.key] : null;
    return {
      ...d,
      state: deriveSignalActionModeState(perKey),
    };
  });
}
