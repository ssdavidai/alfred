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

/** Default per-call timeout. Mirrors upstream's DEFAULT_TIMEOUT_SEC. */
export const DEFAULT_TIMEOUT_SEC = 300;

/** Where to read Hermes' API_SERVER_KEY from on disk. */
export const DEFAULT_HERMES_CONFIG_DIR = "/hermes-state/profiles";

/** Session-key prefix used to derive a stable Hermes session per Paperclip agent. */
export const SESSION_KEY_PREFIX = "paperclip-";
