/**
 * Shared constants for the alfred-black HTTP-mode Hermes adapter.
 *
 * Identifier stays `hermes_local` so Paperclip's registry resolves us
 * through the same adapter slot — the only thing that changes is the
 * backend (HTTP call instead of child-process spawn).
 */

export const ADAPTER_TYPE = "hermes_local";
export const ADAPTER_LABEL = "Hermes Agent (HTTP)";

/** Default Hermes gateway URL — the main profile (compose-network DNS). */
export const DEFAULT_HERMES_GATEWAY_URL = "http://hermes:18789";

/**
 * Compose-internal URL for the sealed `codex-builder` Hermes profile
 * (docs/codex-builder-runtime.md). Fleet-wide port :18793 — name-based
 * routing (see CODEX_BUILDER_AGENT_NAMES) works identically on every
 * tenant. Never published to the host; reachable only inside the compose
 * network from the paperclip container.
 */
export const HERMES_CODEX_BUILDER_GATEWAY_URL = "http://hermes:18793";

/**
 * Agent names that route to the sealed codex-builder profile.
 *
 * Sir's decision #3 (docs/codex-builder-runtime.md §11.6): match on
 * agent.name for v1, accept the small risk that a UI-side rename
 * silently re-routes traffic back to main. The list lives here so
 * adding a second sealed-runtime agent in v2 is one constant edit.
 *
 * Comparison is case-insensitive — the helper lowercases the
 * incoming name before lookup, so a UI capitalisation tweak
 * ("Codex-Feature-Builder") doesn't bypass the route.
 */
export const CODEX_BUILDER_AGENT_NAMES: ReadonlySet<string> = new Set([
  "codex-feature-builder",
]);

/** Default per-call timeout. Mirrors upstream's DEFAULT_TIMEOUT_SEC. */
export const DEFAULT_TIMEOUT_SEC = 300;

/** Where to read Hermes' API_SERVER_KEY from on disk. */
export const DEFAULT_HERMES_CONFIG_DIR = "/hermes-state/profiles";

/**
 * Profile names whose .env we know how to read for API_SERVER_KEY.
 * Used by readHermesProfileApiKey() to validate the argument.
 */
export type HermesProfileName = "main" | "codex-builder";

/** Session-key prefix used to derive a stable Hermes session per Paperclip agent. */
export const SESSION_KEY_PREFIX = "paperclip-";

/**
 * Profile whose skills the Paperclip UI surfaces. The user-facing Hermes
 * agent runs the `main` profile, so its `skills/` directory is what an
 * operator expects to see in Paperclip. (`workers` / `heavy` share the same
 * skill set at deploy time, but `main` is the canonical reference.)
 */
export const DEFAULT_SKILLS_PROFILE: HermesProfileName = "main";

/**
 * Per-profile skills subdirectory, relative to a profile dir under
 * DEFAULT_HERMES_CONFIG_DIR. The hermes-init container deploys each
 * `<slug>/SKILL.md` here, and the paperclip container mounts
 * `hermes_data:/hermes-state:ro` so this path is readable (read-only)
 * from inside paperclip — see DESIGN.md "Compose changes".
 *
 * Resolves to e.g. `/hermes-state/profiles/main/skills`.
 */
export const SKILLS_SUBDIR = "skills";
