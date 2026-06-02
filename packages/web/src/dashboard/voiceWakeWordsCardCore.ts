// voiceWakeWordsCardCore — pure derivation for the /channels
// "Voice satellites & wake words" card (#112 PR3).
//
// Card B in the Wave-C twofer with HaConversationSetupCard. The
// upstream catalogue lives at:
//
//   https://github.com/fwartner/home-assistant-wakewords-collection
//
// It's a community-curated repository of microWakeWord + openWakeWord
// models. We bake a small allowlist of the eight most-used entries —
// just metadata, no model bytes — so the principal can multi-select +
// generate ESPHome YAML without leaving the page. A footer link points
// at the upstream repo for browsing the long tail.
//
// Import-free (no React, no Wasp) so the helpers unit-test under
// node:test the same way the other ChannelsPage cores do.

export type WakeWordModel = "microWakeWord" | "openWakeWord";

export interface WakeWordEntry {
  /** Stable slug used as the React key + the YAML key when generating
   *  ESPHome manifests. ASCII lower-snake-case. */
  slug: string;
  /** What the principal sees in the multi-select grid. */
  displayName: string;
  /** Where the model runs:
   *   - microWakeWord runs on-device (ESP32-S3) — zero latency, free.
   *   - openWakeWord runs on the voice-bridge — heavier accuracy, costs
   *     a couple of CPU cores. The card surfaces this tradeoff. */
  model: WakeWordModel;
  /** Path within fwartner/home-assistant-wakewords-collection (relative
   *  to the repo root). Used to build the "Open in upstream" link. */
  githubPath: string;
  /** sha256 of the model's primary `.tflite` (microWakeWord) or
   *  `.onnx` (openWakeWord), lowercase hex. NULL when we haven't
   *  pinned it yet — the catalogue ships pin-as-you-go so the PR
   *  doesn't carry 8 weight-file SHAs the maintainer would have to
   *  re-verify. The renderer surfaces "(unpinned — verify upstream)"
   *  on null. */
  sha256: string | null;
}

/** Eight most-used entries from
 *  github.com/fwartner/home-assistant-wakewords-collection, chosen by
 *  ★-count + canonical-ness. sha256s left null in this PR — the
 *  catalogue is documentation-only here; voice-bridge / ESPHome pulls
 *  the bytes itself from the upstream URL at flash-time. Pinning the
 *  hashes is a separate housekeeping pass once the catalogue ships. */
export const WAKE_WORD_CATALOGUE: ReadonlyArray<WakeWordEntry> = [
  {
    slug: "alexa",
    displayName: "Alexa",
    model: "openWakeWord",
    githubPath: "openWakeWord/alexa/alexa_v0.1.onnx",
    sha256: null,
  },
  {
    slug: "computer",
    displayName: "Computer",
    model: "microWakeWord",
    githubPath: "microWakeWord/computer.json",
    sha256: null,
  },
  {
    slug: "hey_jarvis",
    displayName: "Hey Jarvis",
    model: "openWakeWord",
    githubPath: "openWakeWord/hey_jarvis/hey_jarvis_v0.1.onnx",
    sha256: null,
  },
  {
    slug: "hey_mycroft",
    displayName: "Hey Mycroft",
    model: "openWakeWord",
    githubPath: "openWakeWord/hey_mycroft/hey_mycroft_v0.1.onnx",
    sha256: null,
  },
  {
    slug: "hey_rhasspy",
    displayName: "Hey Rhasspy",
    model: "openWakeWord",
    githubPath: "openWakeWord/hey_rhasspy/hey_rhasspy_v0.1.onnx",
    sha256: null,
  },
  {
    slug: "jarvis",
    displayName: "Jarvis",
    model: "microWakeWord",
    githubPath: "microWakeWord/jarvis.json",
    sha256: null,
  },
  {
    slug: "ok_nabu",
    displayName: "Ok Nabu",
    model: "microWakeWord",
    githubPath: "microWakeWord/ok_nabu.json",
    sha256: null,
  },
  {
    slug: "sherlock",
    displayName: "Sherlock",
    model: "microWakeWord",
    githubPath: "microWakeWord/sherlock.json",
    sha256: null,
  },
];

/** Upstream HACS-style URL root for the wake-words collection. */
export const WAKE_WORD_UPSTREAM_URL =
  "https://github.com/fwartner/home-assistant-wakewords-collection";

/** Build a per-entry upstream link the principal can open in a new tab
 *  to read the model card / training notes upstream maintains. */
export function upstreamUrlForEntry(entry: WakeWordEntry): string {
  return `${WAKE_WORD_UPSTREAM_URL}/blob/main/${entry.githubPath}`;
}

/** Given a list of selected slugs, return the ESPHome YAML snippet
 *  the principal pastes into their satellite device's `.yaml`. Output:
 *
 *    micro_wake_word:
 *      models:
 *        - model: ok_nabu
 *        - model: computer
 *    voice_assistant:
 *      use_wake_word: true
 *
 *  microWakeWord models are emitted under `micro_wake_word.models`
 *  (one per line); openWakeWord models render as a YAML comment block
 *  at the top, because openWakeWord runs on the voice-bridge, not the
 *  device — the principal enables it through HA's Assist pipeline UI,
 *  not through ESPHome YAML.
 *
 *  Unknown slugs are skipped silently — the UI only ever passes us
 *  catalogue slugs, so this is belt-and-braces. */
export function selectedWakeWordsToManifest(selected: string[]): string {
  if (!Array.isArray(selected) || selected.length === 0) {
    return "# Select at least one wake word above to generate ESPHome YAML.\n";
  }
  const slugSet = new Set(selected);
  const micro = WAKE_WORD_CATALOGUE.filter(
    (e) => e.model === "microWakeWord" && slugSet.has(e.slug),
  );
  const open = WAKE_WORD_CATALOGUE.filter(
    (e) => e.model === "openWakeWord" && slugSet.has(e.slug),
  );

  const lines: string[] = [];
  lines.push("# Generated by Alfred — paste under your ESPHome device YAML.");
  lines.push("# Reference: " + WAKE_WORD_UPSTREAM_URL);
  lines.push("");

  if (micro.length > 0) {
    lines.push("micro_wake_word:");
    lines.push("  models:");
    for (const e of micro) {
      lines.push(`    - model: ${e.slug}`);
    }
    lines.push("");
    lines.push("voice_assistant:");
    lines.push("  use_wake_word: true");
  }

  if (open.length > 0) {
    if (micro.length > 0) lines.push("");
    lines.push(
      "# The following models run as openWakeWord on the voice-bridge,",
    );
    lines.push(
      "# not on this device. Enable them under HA → Settings → Voice",
    );
    lines.push("# Assistants → Wake word service → openWakeWord:");
    for (const e of open) {
      lines.push(`#   - ${e.slug}  (${upstreamUrlForEntry(e)})`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Detected ESPHome devices — surfaced by voice-bridge once #112 PR2's
// ESPHome Native API listener is enabled. The shape mirrors what the
// listener will publish to ctrl-api / GET /api/v1/channels/voice/
// esphome/devices when that endpoint lands; for now ChannelsPage treats
// a 404 as "feature off" and shows a hint to set ESPHOME_API_ENABLED=1.
// ---------------------------------------------------------------------------

export type EsphomeDeviceStatus = "connected" | "disconnected" | "error";

export interface EsphomeDevice {
  /** mDNS / .local hostname, e.g. `voice-pe-living-room.local`. */
  hostname: string;
  /** Last-seen IP. */
  ip: string;
  /** Unix ms of the most recent successful connection. */
  lastSeenAt: number | null;
  /** Free-form model string ESPHome publishes via API, e.g.
   *  `voice-assistant-pe` or `m5stack-atom-echo`. */
  model: string | null;
  /** The wake-word the satellite is currently booted with. Null when
   *  none is configured (HA Assist will use the cloud wake word). */
  currentWakeWord: string | null;
  /** Coarse health state. */
  status: EsphomeDeviceStatus;
  /** Verbatim message from the listener for "error" rows. */
  errorMessage: string | null;
}

export interface EsphomeDeviceRowView {
  /** Friendly hostname (just the bit before `.local`) or hostname
   *  verbatim when there's no `.local` suffix. */
  shortHost: string;
  /** IP as supplied. */
  ip: string;
  /** "Just now" / "5 min ago" / "Never". Mirrors formatLastUsed in
   *  haConversationCardCore but locally so this file unit-tests on
   *  its own. */
  lastSeenRelative: string;
  /** Pretty label for the model field. */
  modelLabel: string;
  /** What to show in the "Wake word" column. Null falls back to the
   *  literal "—" so the column never collapses. */
  wakeWordLabel: string;
  /** Pill tone for the row: green/yellow/red. */
  pill: "active" | "available" | "error";
  /** Pill text. */
  pillLabel: string;
  /** Optional error line under the row (only for `status: "error"`). */
  errorLine: string | null;
}

function formatRelative(unixMs: number | null, now: Date): string {
  if (unixMs == null) return "Never";
  const deltaSec = Math.floor((now.getTime() - unixMs) / 1000);
  if (deltaSec < 0 || deltaSec < 60) return "Just now";
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)} min ago`;
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3600)} h ago`;
  return `${Math.floor(deltaSec / 86_400)} d ago`;
}

export function formatEsphomeDeviceRow(
  device: EsphomeDevice,
  now: Date = new Date(),
): EsphomeDeviceRowView {
  const shortHost = device.hostname.endsWith(".local")
    ? device.hostname.slice(0, -".local".length)
    : device.hostname;
  const pill: "active" | "available" | "error" =
    device.status === "connected"
      ? "active"
      : device.status === "error"
        ? "error"
        : "available";
  const pillLabel =
    device.status === "connected"
      ? "Connected"
      : device.status === "error"
        ? "Error"
        : "Offline";
  return {
    shortHost,
    ip: device.ip,
    lastSeenRelative: formatRelative(device.lastSeenAt, now),
    modelLabel: device.model && device.model.trim() ? device.model : "—",
    wakeWordLabel:
      device.currentWakeWord && device.currentWakeWord.trim()
        ? device.currentWakeWord
        : "—",
    pill,
    pillLabel,
    errorLine:
      device.status === "error"
        ? device.errorMessage && device.errorMessage.trim()
          ? device.errorMessage
          : "ESPHome connection failed (no detail)."
        : null,
  };
}
