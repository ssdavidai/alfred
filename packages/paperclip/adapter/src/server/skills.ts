/**
 * Skills surface — list / sync.
 *
 * Upstream scans `~/.hermes/skills/` and surfaces the read-only result.
 * In HTTP mode we don't have a Hermes filesystem to scan (the
 * paperclip container doesn't have `hermes_data` mounted), and even if we
 * did, the skills list belongs to Hermes' own runtime not Paperclip.
 *
 * We return an empty snapshot with `mode: "unsupported"` so the Paperclip
 * UI surfaces "skill management is delegated to Hermes" rather than
 * dangling "Loading…". `syncSkills` is a no-op for the same reason —
 * trying to push skills from Paperclip into Hermes would silently fail.
 *
 * The follow-up issue for upstream tracks adding an OpenAI-Responses-API
 * extension that lets the gateway report its loaded skill set; until
 * then, this is the honest shape.
 */

import { ADAPTER_TYPE } from "../shared/constants.js";

import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "../types/paperclip.js";

function emptySnapshot(): AdapterSkillSnapshot {
  return {
    adapterType: ADAPTER_TYPE,
    supported: false,
    mode: "unsupported",
    desiredSkills: [],
    entries: [],
    warnings: [
      "Skill management is delegated to Hermes when running in HTTP mode. " +
        "Hermes loads its own ~/.hermes/skills/ at startup; Paperclip cannot " +
        "inspect or sync them from here.",
    ],
  };
}

export async function listSkills(
  _ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return emptySnapshot();
}

export async function syncSkills(
  _ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  // No-op; surface a snapshot so the UI doesn't loop.
  return emptySnapshot();
}

/**
 * Upstream's `resolveDesiredSkillNames` reads `adapter-utils`'
 * helper. We don't have desired skills in HTTP mode — return [] so
 * Paperclip's "missing" detector never lights up.
 */
export function resolveDesiredSkillNames(
  _config: Record<string, unknown>,
  _availableEntries: unknown[],
): string[] {
  return [];
}
