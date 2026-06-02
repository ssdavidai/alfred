/**
 * /channels — VoiceWakeWordsCard helper tests (#112 PR3).
 *
 * Covers:
 *   • WAKE_WORD_CATALOGUE: 8 entries, all required fields present
 *   • selectedWakeWordsToManifest: empty / micro-only / open-only / mixed
 *   • selectedWakeWordsToManifest: unknown slugs silently ignored
 *   • upstreamUrlForEntry: builds GitHub blob URL
 *   • formatEsphomeDeviceRow: connected / disconnected / error rows
 *   • formatEsphomeDeviceRow: missing model + wake-word fall back to —
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/dashboard/voiceWakeWordsCardCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WAKE_WORD_CATALOGUE,
  WAKE_WORD_UPSTREAM_URL,
  selectedWakeWordsToManifest,
  upstreamUrlForEntry,
  formatEsphomeDeviceRow,
  type EsphomeDevice,
} from "./voiceWakeWordsCardCore";

const FROZEN_NOW = new Date("2026-05-29T12:00:00Z");

// ---------------------------------------------------------------------------
// WAKE_WORD_CATALOGUE: shape contract
// ---------------------------------------------------------------------------

test("catalogue: exactly 8 entries — matches task brief", () => {
  assert.equal(WAKE_WORD_CATALOGUE.length, 8);
});

test("catalogue: every entry has slug / displayName / model / githubPath", () => {
  for (const e of WAKE_WORD_CATALOGUE) {
    assert.ok(typeof e.slug === "string" && e.slug.length > 0, "slug");
    assert.ok(
      typeof e.displayName === "string" && e.displayName.length > 0,
      "displayName",
    );
    assert.ok(
      e.model === "microWakeWord" || e.model === "openWakeWord",
      "model",
    );
    assert.ok(
      typeof e.githubPath === "string" && e.githubPath.length > 0,
      "githubPath",
    );
    // sha256 is allowed to be null (unpinned) — that's the documented
    // shape. We assert the field is present, null or string.
    assert.ok(
      e.sha256 === null || typeof e.sha256 === "string",
      "sha256 must be string|null",
    );
  }
});

test("catalogue: slugs are unique", () => {
  const slugs = WAKE_WORD_CATALOGUE.map((e) => e.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

test("catalogue: covers BOTH model families", () => {
  const models = new Set(WAKE_WORD_CATALOGUE.map((e) => e.model));
  assert.ok(models.has("microWakeWord"));
  assert.ok(models.has("openWakeWord"));
});

test("catalogue: every brief-listed wake word is present", () => {
  // The Wave-C brief enumerates these eight specifically.
  const required = [
    "alexa",
    "computer",
    "hey_jarvis",
    "hey_mycroft",
    "hey_rhasspy",
    "jarvis",
    "ok_nabu",
    "sherlock",
  ];
  const slugs = new Set(WAKE_WORD_CATALOGUE.map((e) => e.slug));
  for (const s of required) {
    assert.ok(slugs.has(s), `missing brief-listed slug ${s}`);
  }
});

// ---------------------------------------------------------------------------
// selectedWakeWordsToManifest: ESPHome YAML output
// ---------------------------------------------------------------------------

test("manifest: empty selection → instruction comment, no YAML", () => {
  const out = selectedWakeWordsToManifest([]);
  assert.match(out, /Select at least one wake word/);
  assert.doesNotMatch(out, /micro_wake_word:/);
});

test("manifest: microWakeWord only → emits micro_wake_word block + use_wake_word", () => {
  const out = selectedWakeWordsToManifest(["ok_nabu", "jarvis"]);
  assert.match(out, /micro_wake_word:/);
  assert.match(out, /- model: ok_nabu/);
  assert.match(out, /- model: jarvis/);
  assert.match(out, /voice_assistant:\n  use_wake_word: true/);
  // No openWakeWord comment block since none were selected.
  assert.doesNotMatch(out, /openWakeWord on the voice-bridge/);
});

test("manifest: openWakeWord only → comment block, no micro_wake_word", () => {
  const out = selectedWakeWordsToManifest(["alexa", "hey_jarvis"]);
  assert.doesNotMatch(out, /micro_wake_word:/);
  assert.match(out, /openWakeWord on the voice-bridge/);
  assert.match(out, /alexa/);
  assert.match(out, /hey_jarvis/);
  // Upstream URL appears for each openWakeWord entry.
  assert.match(out, /github\.com\/fwartner/);
});

test("manifest: mixed selection → both blocks", () => {
  const out = selectedWakeWordsToManifest(["ok_nabu", "alexa"]);
  assert.match(out, /micro_wake_word:/);
  assert.match(out, /- model: ok_nabu/);
  assert.match(out, /openWakeWord on the voice-bridge/);
  assert.match(out, /alexa/);
});

test("manifest: unknown slugs are silently ignored", () => {
  const out = selectedWakeWordsToManifest(["ok_nabu", "no-such-wakeword"]);
  assert.match(out, /- model: ok_nabu/);
  assert.doesNotMatch(out, /no-such-wakeword/);
});

test("manifest: header references the upstream catalogue", () => {
  const out = selectedWakeWordsToManifest(["ok_nabu"]);
  assert.match(out, new RegExp(WAKE_WORD_UPSTREAM_URL.replace(/\./g, "\\.")));
});

// ---------------------------------------------------------------------------
// upstreamUrlForEntry
// ---------------------------------------------------------------------------

test("upstreamUrlForEntry: returns a github.com blob URL", () => {
  const entry = WAKE_WORD_CATALOGUE.find((e) => e.slug === "ok_nabu")!;
  const url = upstreamUrlForEntry(entry);
  assert.match(url, /^https:\/\/github\.com\/fwartner\/.*\/blob\/main\//);
  assert.ok(url.endsWith(entry.githubPath));
});

// ---------------------------------------------------------------------------
// formatEsphomeDeviceRow: status formatter
// ---------------------------------------------------------------------------

const BASE_DEVICE: EsphomeDevice = {
  hostname: "voice-pe-living-room.local",
  ip: "192.168.1.42",
  lastSeenAt: FROZEN_NOW.getTime() - 30_000, // 30s ago
  model: "voice-assistant-pe",
  currentWakeWord: "ok_nabu",
  status: "connected",
  errorMessage: null,
};

test("formatEsphomeDeviceRow: connected → active pill + short host", () => {
  const row = formatEsphomeDeviceRow(BASE_DEVICE, FROZEN_NOW);
  assert.equal(row.pill, "active");
  assert.equal(row.pillLabel, "Connected");
  assert.equal(row.shortHost, "voice-pe-living-room");
  assert.equal(row.modelLabel, "voice-assistant-pe");
  assert.equal(row.wakeWordLabel, "ok_nabu");
  assert.equal(row.lastSeenRelative, "Just now");
  assert.equal(row.errorLine, null);
});

test("formatEsphomeDeviceRow: disconnected → available pill + Offline label", () => {
  const row = formatEsphomeDeviceRow(
    { ...BASE_DEVICE, status: "disconnected", lastSeenAt: null },
    FROZEN_NOW,
  );
  assert.equal(row.pill, "available");
  assert.equal(row.pillLabel, "Offline");
  assert.equal(row.lastSeenRelative, "Never");
  assert.equal(row.errorLine, null);
});

test("formatEsphomeDeviceRow: error → error pill + surfaced message", () => {
  const row = formatEsphomeDeviceRow(
    {
      ...BASE_DEVICE,
      status: "error",
      errorMessage: "ESPHome refused encryption key",
    },
    FROZEN_NOW,
  );
  assert.equal(row.pill, "error");
  assert.equal(row.pillLabel, "Error");
  assert.equal(row.errorLine, "ESPHome refused encryption key");
});

test("formatEsphomeDeviceRow: error with null message → fallback line", () => {
  const row = formatEsphomeDeviceRow(
    { ...BASE_DEVICE, status: "error", errorMessage: null },
    FROZEN_NOW,
  );
  assert.equal(row.pill, "error");
  assert.match(row.errorLine ?? "", /no detail/);
});

test("formatEsphomeDeviceRow: missing model + wake word → em-dash fallback", () => {
  const row = formatEsphomeDeviceRow(
    { ...BASE_DEVICE, model: null, currentWakeWord: null },
    FROZEN_NOW,
  );
  assert.equal(row.modelLabel, "—");
  assert.equal(row.wakeWordLabel, "—");
});

test("formatEsphomeDeviceRow: hostname without .local left verbatim", () => {
  const row = formatEsphomeDeviceRow(
    { ...BASE_DEVICE, hostname: "192.168.1.42" },
    FROZEN_NOW,
  );
  assert.equal(row.shortHost, "192.168.1.42");
});

test("formatEsphomeDeviceRow: lastSeenAt minutes/hours/days roll up", () => {
  const min = formatEsphomeDeviceRow(
    { ...BASE_DEVICE, lastSeenAt: FROZEN_NOW.getTime() - 120_000 },
    FROZEN_NOW,
  );
  assert.equal(min.lastSeenRelative, "2 min ago");
  const hr = formatEsphomeDeviceRow(
    { ...BASE_DEVICE, lastSeenAt: FROZEN_NOW.getTime() - 7_200_000 },
    FROZEN_NOW,
  );
  assert.equal(hr.lastSeenRelative, "2 h ago");
  const day = formatEsphomeDeviceRow(
    { ...BASE_DEVICE, lastSeenAt: FROZEN_NOW.getTime() - 86_400_000 * 3 },
    FROZEN_NOW,
  );
  assert.equal(day.lastSeenRelative, "3 d ago");
});
