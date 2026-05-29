/**
 * /channels — Home Assistant card derivation tests.
 *
 * Covers the contract laid out in the lane brief (#110 PR3, 2026-05-29):
 *   • status-string formatter for each of the 5 ctrl-api `state` values
 *     (unconfigured / connecting / connected / error / disconnected)
 *   • parseHaUrl accepts http/https + rejects file://, javascript:,
 *     data:, malformed
 *   • redactLlat first-8-chars contract — only the first 8 may leak
 *   • isProbablyValidLlat — accepts JWT-shaped HA tokens, rejects malformed
 *   • summariseRegistry counts for empty vs populated registries
 *   • pickRecentRuns sorts by created_at desc and tops out at 10
 *
 * SECURITY: all fixture LLATs are synthetic placeholders prefixed
 * `llat_TEST_…`. Real `eyJ…` tokens never appear in this file. The path
 * is allowlisted in .gitguardian.yaml.
 *
 * Run with:  cd packages/web && npx tsx --test src/dashboard/haCardCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveHaCardState,
  parseHaUrl,
  redactLlat,
  isProbablyValidLlat,
  summariseRegistry,
  pickRecentRuns,
  summariseGaps,
  summariseProposals,
  labelForGapKind,
  proposalModalReduce,
  PROPOSAL_MODAL_CLOSED,
  type HaStatus,
  type HaRegistry,
  type HaRunRow,
  type HaGapsResponse,
  type HaProposalsResponse,
  type HaProposalRow,
} from "./haCardCore";

const BASE: HaStatus = {
  connected: false,
  state: "unconfigured",
  ha_url: null,
  ha_version: null,
  label: null,
  last_test_ok: false,
  last_test_at: null,
  error: null,
};

// ── Status formatter — one test per state ────────────────────────────────

test("derive: unconfigured → connect-form CTA + 'available' pill", () => {
  const s = deriveHaCardState({ status: BASE });
  assert.equal(s.state, "unconfigured");
  assert.equal(s.mode, "unconfigured");
  assert.equal(s.pill, "available");
  assert.match(s.heading, /Connect to your HA install/i);
  assert.equal(s.showConnectForm, true);
  assert.equal(s.showDisconnect, false);
  assert.equal(s.showRetry, false);
  assert.equal(s.shouldPoll, false);
  assert.equal(s.errorMessage, null);
});

test("derive: connecting → polls + URL surfaced + spinner heading", () => {
  const s = deriveHaCardState({
    status: {
      ...BASE,
      state: "connecting",
      ha_url: "http://homeassistant.local:8123",
    },
  });
  assert.equal(s.mode, "connecting");
  assert.equal(s.pill, "starting");
  assert.match(s.heading, /Connecting to Home Assistant/i);
  assert.match(s.description, /homeassistant\.local:8123/);
  assert.equal(s.shouldPoll, true);
  assert.equal(s.showConnectForm, false);
  assert.equal(s.showDisconnect, true);
});

test("derive: connecting without ha_url → generic spinner copy, still polls", () => {
  const s = deriveHaCardState({
    status: { ...BASE, state: "connecting", ha_url: null },
  });
  assert.equal(s.mode, "connecting");
  assert.match(s.description, /Probing your Home Assistant install/i);
  assert.equal(s.shouldPoll, true);
  assert.equal(s.haUrl, null);
});

test("derive: connected → ha_url + ha_version in heading, no poll", () => {
  const s = deriveHaCardState({
    status: {
      ...BASE,
      connected: true,
      state: "connected",
      ha_url: "https://home.example.com",
      ha_version: "2026.5.0",
    },
  });
  assert.equal(s.mode, "connected");
  assert.equal(s.pill, "active");
  assert.match(s.heading, /Connected to https:\/\/home\.example\.com/);
  assert.match(s.heading, /HA 2026\.5\.0/);
  assert.equal(s.haUrl, "https://home.example.com");
  assert.equal(s.haVersion, "2026.5.0");
  assert.equal(s.shouldPoll, false);
  assert.equal(s.showDisconnect, true);
  assert.equal(s.showRetry, false);
  assert.equal(s.showConnectForm, false);
});

test("derive: connected without ha_version → heading still renders", () => {
  const s = deriveHaCardState({
    status: {
      ...BASE,
      connected: true,
      state: "connected",
      ha_url: "https://home.example.com",
      ha_version: null,
    },
  });
  assert.equal(s.heading, "Connected to https://home.example.com");
  assert.equal(s.haVersion, null);
});

test("derive: connected without ha_url falls back to a generic heading", () => {
  const s = deriveHaCardState({
    status: {
      ...BASE,
      connected: true,
      state: "connected",
      ha_url: null,
      ha_version: null,
    },
  });
  assert.equal(s.heading, "Connected to Home Assistant");
});

test("derive: error → verbatim last_error + retry button", () => {
  const s = deriveHaCardState({
    status: {
      ...BASE,
      state: "error",
      error: "HA rejected the LLAT (HTTP 401)",
    },
  });
  assert.equal(s.mode, "error");
  assert.equal(s.pill, "error");
  assert.equal(s.description, "HA rejected the LLAT (HTTP 401)");
  assert.equal(s.errorMessage, "HA rejected the LLAT (HTTP 401)");
  assert.equal(s.showRetry, true);
  assert.equal(s.showDisconnect, true);
});

test("derive: error with empty error string falls back to a default copy", () => {
  const s = deriveHaCardState({
    status: { ...BASE, state: "error", error: "" },
  });
  assert.equal(s.mode, "error");
  assert.match(s.description, /Last connect \/ probe failed/i);
  assert.equal(s.errorMessage, null);
});

test("derive: disconnected → calm heading + the connect form re-renders", () => {
  const s = deriveHaCardState({
    status: { ...BASE, state: "disconnected" },
  });
  assert.equal(s.state, "disconnected");
  // Disconnected re-uses the unconfigured view mode so the surface is one
  // switch, but the headline copy is friendlier.
  assert.equal(s.mode, "unconfigured");
  assert.match(s.heading, /HA disconnected/i);
  assert.equal(s.showConnectForm, true);
  assert.equal(s.showDisconnect, false);
  assert.equal(s.pill, "available");
});

test("derive: null/undefined status → safe unconfigured", () => {
  const s1 = deriveHaCardState({ status: null });
  const s2 = deriveHaCardState({ status: undefined });
  assert.equal(s1.mode, "unconfigured");
  assert.equal(s2.mode, "unconfigured");
  assert.equal(s1.pill, "available");
});

// ── parseHaUrl ───────────────────────────────────────────────────────────

test("parseHaUrl: accepts http and https, trims, strips trailing slash", () => {
  assert.deepEqual(parseHaUrl("http://homeassistant.local:8123"), {
    ok: true,
    url: "http://homeassistant.local:8123",
    error: null,
  });
  assert.deepEqual(parseHaUrl("https://home.example.com"), {
    ok: true,
    url: "https://home.example.com",
    error: null,
  });
  // Trailing slash stripped so ctrl-api can append /api/ cleanly.
  assert.deepEqual(parseHaUrl("https://home.example.com/"), {
    ok: true,
    url: "https://home.example.com",
    error: null,
  });
  assert.deepEqual(parseHaUrl("  https://home.example.com  "), {
    ok: true,
    url: "https://home.example.com",
    error: null,
  });
});

test("parseHaUrl: rejects file://, javascript:, data:, ws:", () => {
  const fileRes = parseHaUrl("file:///etc/passwd");
  assert.equal(fileRes.ok, false);
  assert.equal(fileRes.url, null);
  assert.match(fileRes.error || "", /must use http:\/\/ or https:\/\//);

  const jsRes = parseHaUrl("javascript:alert(1)");
  assert.equal(jsRes.ok, false);
  assert.match(jsRes.error || "", /must use http:\/\/ or https:\/\//);

  const dataRes = parseHaUrl("data:text/html,<script>alert(1)</script>");
  assert.equal(dataRes.ok, false);
  assert.match(dataRes.error || "", /must use http:\/\/ or https:\/\//);

  const wsRes = parseHaUrl("ws://homeassistant.local:8123");
  assert.equal(wsRes.ok, false);
  assert.match(wsRes.error || "", /must use http:\/\/ or https:\/\//);
});

test("parseHaUrl: rejects malformed input + empty/whitespace + non-string", () => {
  const garbage = parseHaUrl("not a url at all");
  assert.equal(garbage.ok, false);
  assert.match(garbage.error || "", /doesn't look like a URL/i);

  const empty = parseHaUrl("");
  assert.equal(empty.ok, false);
  assert.match(empty.error || "", /required/i);

  const whitespace = parseHaUrl("   ");
  assert.equal(whitespace.ok, false);
  assert.match(whitespace.error || "", /required/i);

  // Non-string survives without crashing.
  const nonString = parseHaUrl(undefined as unknown as string);
  assert.equal(nonString.ok, false);
  assert.match(nonString.error || "", /must be a string/i);
});

// ── redactLlat — only the first 8 chars may ever leak ────────────────────

test("redactLlat: only the first 8 chars survive, never the token body", () => {
  // Synthetic placeholder — never a real eyJ… token.
  const fake = "llat_TEST_0123456789abcdef_ALWAYS_FAKE_NEVER_REAL";
  const red = redactLlat(fake);
  assert.equal(red, "llat_TES…");
  // The body never leaks.
  assert.equal(red.includes("0123456789"), false);
  assert.equal(red.includes("ALWAYS_FAKE"), false);
  assert.equal(red.includes("NEVER_REAL"), false);
  // A short fake input still gets the redaction-shape (trailing ellipsis)
  // so the caller can never accidentally treat it as the real token.
  assert.equal(redactLlat("short"), "short…");
  // Exactly 8 chars: still gets the ellipsis (contract: NEVER return the
  // raw input verbatim).
  assert.equal(redactLlat("eyJabcde"), "eyJabcde…");
  // 9 chars: only first 8 + ellipsis.
  assert.equal(redactLlat("eyJabcdef"), "eyJabcde…");
  // Empty / non-string / whitespace returns "".
  assert.equal(redactLlat(""), "");
  assert.equal(redactLlat(null), "");
  assert.equal(redactLlat(undefined), "");
  assert.equal(redactLlat("    "), "");
});

// ── isProbablyValidLlat ──────────────────────────────────────────────────

test("isProbablyValidLlat: accepts JWT-shaped strings, rejects malformed", () => {
  // Synthetic JWT-shaped fixture — three base64url segments. NEVER a
  // real HA LLAT.
  const fake =
    "eyJTESTaaaaaaaaaaaaaaa.eyJTESTbbbbbbbbbbbbbbbbbbbbbb.TESTccccccccccccccccc";
  assert.equal(isProbablyValidLlat(fake), true);
  // Surrounding whitespace is trimmed.
  assert.equal(isProbablyValidLlat(`  ${fake}  `), true);
  // Missing the eyJ prefix.
  assert.equal(
    isProbablyValidLlat("notajwt.eyJpayload.signature_short_xxxxxxxxx"),
    false,
  );
  // Too short overall.
  assert.equal(isProbablyValidLlat("eyJ.eyJ.x"), false);
  // Wrong segment count (only two dots — JWT has exactly two).
  assert.equal(isProbablyValidLlat("eyJTESTaaaaa.eyJTESTbbbbb"), false);
  // Empty + non-string.
  assert.equal(isProbablyValidLlat(""), false);
  assert.equal(
    isProbablyValidLlat(undefined as unknown as string),
    false,
  );
});

// ── summariseRegistry ────────────────────────────────────────────────────

test("summariseRegistry: empty registry → all zeros, no crash", () => {
  const empty: HaRegistry = {
    entities: [],
    areas: [],
    devices: [],
    automations: [],
    scenes: [],
    helpers: [],
  };
  const s = summariseRegistry(empty);
  assert.deepEqual(s.counts, {
    lights: 0,
    switches: 0,
    scenes: 0,
    sensors: 0,
    climate: 0,
    cover: 0,
    media_player: 0,
  });
  assert.equal(s.areaCount, 0);
  assert.equal(s.deviceCount, 0);
  assert.equal(s.automationCount, 0);
});

test("summariseRegistry: null/undefined → safe zeros", () => {
  const sNull = summariseRegistry(null);
  const sUndef = summariseRegistry(undefined);
  assert.deepEqual(sNull.counts, sUndef.counts);
  assert.equal(sNull.areaCount, 0);
  assert.equal(sNull.deviceCount, 0);
  assert.equal(sNull.automationCount, 0);
});

test("summariseRegistry: populated registry counts by domain", () => {
  const reg: HaRegistry = {
    entities: [
      { entity_id: "light.kitchen", domain: "light" },
      { entity_id: "light.bedroom", domain: "light" },
      { entity_id: "light.hallway" }, // domain inferred from entity_id
      { entity_id: "switch.kettle", domain: "switch" },
      { entity_id: "sensor.kitchen_temp", domain: "sensor" },
      { entity_id: "sensor.bedroom_temp", domain: "sensor" },
      { entity_id: "sensor.bathroom_temp" }, // domain inferred
      { entity_id: "climate.thermostat", domain: "climate" },
      { entity_id: "cover.garage", domain: "cover" },
      { entity_id: "media_player.lounge", domain: "media_player" },
      { entity_id: "binary_sensor.front_door", domain: "binary_sensor" },
      // ↑ binary_sensor intentionally NOT in the summary counts.
      { entity_id: "fan.bedroom", domain: "fan" },
      // ↑ fan also dropped from the summary.
    ],
    areas: [{ name: "Kitchen" }, { name: "Bedroom" }, { name: "Hallway" }],
    devices: [{ name: "Sonoff plug" }, { name: "Hue bridge" }],
    automations: [{ entity_id: "automation.morning_routine" }],
    scenes: [
      { entity_id: "scene.movie_night" },
      { entity_id: "scene.dinner" },
    ],
    helpers: [{ entity_id: "input_boolean.guest_mode" }],
  };
  const s = summariseRegistry(reg);
  assert.deepEqual(s.counts, {
    lights: 3,
    switches: 1,
    scenes: 2, // from registry.scenes[], NOT entities
    sensors: 3,
    climate: 1,
    cover: 1,
    media_player: 1,
  });
  assert.equal(s.areaCount, 3);
  assert.equal(s.deviceCount, 2);
  assert.equal(s.automationCount, 1);
});

test("summariseRegistry: tolerates a registry missing optional buckets", () => {
  // Some early-PR fixtures may only ship a couple of arrays.
  const partial = { entities: [], areas: [{ name: "Kitchen" }] } as unknown as HaRegistry;
  const s = summariseRegistry(partial);
  assert.equal(s.counts.lights, 0);
  assert.equal(s.areaCount, 1);
  assert.equal(s.deviceCount, 0);
  assert.equal(s.automationCount, 0);
});

// ── pickRecentRuns ───────────────────────────────────────────────────────

test("pickRecentRuns: sorts by created_at desc and caps at 10", () => {
  const rows: HaRunRow[] = [
    { id: 1, created_at: "2026-05-28T10:00:00Z", kind: "service_call" },
    { id: 2, created_at: "2026-05-29T10:00:00Z", kind: "service_call" },
    { id: 3, created_at: "2026-05-27T10:00:00Z", kind: "automation_create" },
    { id: 4, created_at: "2026-05-29T11:00:00Z", kind: "service_call" },
    { id: 5, created_at: "2026-05-26T10:00:00Z", kind: "scene_create" },
    { id: 6, created_at: "2026-05-29T09:00:00Z", kind: "service_call" },
    { id: 7, created_at: "2026-05-29T08:00:00Z", kind: "service_call" },
    { id: 8, created_at: "2026-05-29T07:00:00Z", kind: "service_call" },
    { id: 9, created_at: "2026-05-29T06:00:00Z", kind: "service_call" },
    { id: 10, created_at: "2026-05-29T05:00:00Z", kind: "service_call" },
    { id: 11, created_at: "2026-05-29T04:00:00Z", kind: "service_call" },
    { id: 12, created_at: "2026-05-29T03:00:00Z", kind: "service_call" },
  ];
  const top = pickRecentRuns(rows);
  assert.equal(top.length, 10);
  // Top row is the newest.
  assert.equal(top[0].id, 4); // 2026-05-29T11:00:00Z
  assert.equal(top[1].id, 2); // 2026-05-29T10:00:00Z
  // Oldest row (id=5, 2026-05-26) should NOT be in the top 10.
  assert.equal(top.find((r) => r.id === 5), undefined);
});

test("pickRecentRuns: tolerates non-array + malformed timestamps", () => {
  // Non-array input → [].
  assert.deepEqual(pickRecentRuns(null), []);
  assert.deepEqual(pickRecentRuns(undefined), []);
  assert.deepEqual(
    pickRecentRuns("not an array" as unknown as HaRunRow[]),
    [],
  );

  // Malformed timestamps sort to the bottom (treated as 0).
  const rows: HaRunRow[] = [
    { id: "a", created_at: "not a timestamp" },
    { id: "b", created_at: "2026-05-29T10:00:00Z" },
    { id: "c", created_at: undefined },
    { id: "d", created_at: "2026-05-29T11:00:00Z" },
  ];
  const top = pickRecentRuns(rows);
  assert.equal(top.length, 4);
  // Newest valid timestamp first.
  assert.equal(top[0].id, "d");
  assert.equal(top[1].id, "b");
  // The two malformed rows trail (order between them is preserved by
  // Array#sort being stable in modern V8).
});

test("pickRecentRuns: empty array returns empty array", () => {
  assert.deepEqual(pickRecentRuns([]), []);
});

// ── PR6 — summariseGaps + summariseProposals + modal reducer ────────────

test("summariseGaps: empty/null input → all-zero summary", () => {
  const s = summariseGaps(null);
  assert.equal(s.totalOpen, 0);
  assert.equal(s.totalClosed, 0);
  assert.equal(s.highCount, 0);
  assert.equal(s.mediumCount, 0);
  assert.equal(s.lowCount, 0);
  assert.deepEqual(s.topOpen, []);
});

test("summariseGaps: counts by severity, slices top 5", () => {
  const resp: HaGapsResponse = {
    open: [
      { id: "1", kind: "no_security_camera_notification", summary: "x", severity: "high" },
      { id: "2", kind: "no_morning_routine", summary: "x", severity: "medium" },
      { id: "3", kind: "no_motion_lighting", summary: "x", severity: "low" },
      { id: "4", kind: "no_motion_lighting", summary: "x", severity: "low" },
      { id: "5", kind: "no_motion_lighting", summary: "x", severity: "low" },
      { id: "6", kind: "no_motion_lighting", summary: "x", severity: "low" },
    ],
    closed: [
      { id: "7", kind: "no_party_mode", summary: "x", severity: "low" },
    ],
  };
  const s = summariseGaps(resp);
  assert.equal(s.totalOpen, 6);
  assert.equal(s.totalClosed, 1);
  assert.equal(s.highCount, 1);
  assert.equal(s.mediumCount, 1);
  assert.equal(s.lowCount, 4);
  assert.equal(s.topOpen.length, 5);
});

test("summariseProposals: handles empty + counts pending/applied", () => {
  assert.deepEqual(
    summariseProposals(null),
    { pendingCount: 0, appliedCount: 0, topPending: [] },
  );
  const resp: HaProposalsResponse = {
    pending: [
      { id: "a", kind: "no_morning_routine", summary: "x", yaml: "x", status: "pending" },
      { id: "b", kind: "no_bedtime_routine", summary: "x", yaml: "x", status: "pending" },
    ],
    applied: [
      { id: "c", kind: "no_away_mode", summary: "x", yaml: "x", status: "applied" },
    ],
    other: [],
  };
  const s = summariseProposals(resp);
  assert.equal(s.pendingCount, 2);
  assert.equal(s.appliedCount, 1);
  assert.equal(s.topPending.length, 2);
});

test("labelForGapKind: maps known kinds, falls back to raw kind", () => {
  assert.equal(labelForGapKind("no_morning_routine"), "Morning lighting");
  assert.equal(labelForGapKind("no_motion_lighting"), "Motion lighting");
  assert.equal(labelForGapKind("no_party_mode"), "Party mode");
  assert.equal(labelForGapKind("future_kind_alfred_invents"), "future_kind_alfred_invents");
  assert.equal(labelForGapKind(null), "Gap");
  assert.equal(labelForGapKind(undefined), "Gap");
});

// ── Proposal modal state machine ─────────────────────────────────────────

const SAMPLE_PROPOSAL: HaProposalRow = {
  id: "p1",
  kind: "no_morning_routine",
  summary: "Wake the lights.",
  yaml: "alias: x\ntrigger: []\naction: []\n",
  status: "pending",
};

test("proposalModalReduce: OPEN takes closed → viewing with proposal", () => {
  const next = proposalModalReduce(PROPOSAL_MODAL_CLOSED, {
    type: "OPEN",
    proposal: SAMPLE_PROPOSAL,
  });
  assert.equal(next.mode, "viewing");
  assert.equal(next.proposal?.id, "p1");
  assert.equal(next.error, null);
});

test("proposalModalReduce: APPLY → applying → APPLY_OK → applied", () => {
  const opened = proposalModalReduce(PROPOSAL_MODAL_CLOSED, {
    type: "OPEN",
    proposal: SAMPLE_PROPOSAL,
  });
  const applying = proposalModalReduce(opened, { type: "APPLY" });
  assert.equal(applying.mode, "applying");
  const applied = proposalModalReduce(applying, { type: "APPLY_OK" });
  assert.equal(applied.mode, "applied");
});

test("proposalModalReduce: REJECT → rejecting → REJECT_OK → rejected", () => {
  const opened = proposalModalReduce(PROPOSAL_MODAL_CLOSED, {
    type: "OPEN",
    proposal: SAMPLE_PROPOSAL,
  });
  const rejecting = proposalModalReduce(opened, { type: "REJECT" });
  assert.equal(rejecting.mode, "rejecting");
  const rejected = proposalModalReduce(rejecting, { type: "REJECT_OK" });
  assert.equal(rejected.mode, "rejected");
});

test("proposalModalReduce: FAIL preserves proposal + RETRY returns to viewing", () => {
  const opened = proposalModalReduce(PROPOSAL_MODAL_CLOSED, {
    type: "OPEN",
    proposal: SAMPLE_PROPOSAL,
  });
  const applying = proposalModalReduce(opened, { type: "APPLY" });
  const failed = proposalModalReduce(applying, {
    type: "FAIL",
    error: "HA timed out",
  });
  assert.equal(failed.mode, "error");
  assert.equal(failed.error, "HA timed out");
  assert.equal(failed.proposal?.id, "p1");

  const retried = proposalModalReduce(failed, { type: "RETRY" });
  assert.equal(retried.mode, "viewing");
  assert.equal(retried.error, null);
});

test("proposalModalReduce: CLOSE always returns the closed state", () => {
  const opened = proposalModalReduce(PROPOSAL_MODAL_CLOSED, {
    type: "OPEN",
    proposal: SAMPLE_PROPOSAL,
  });
  const closed = proposalModalReduce(opened, { type: "CLOSE" });
  assert.equal(closed, PROPOSAL_MODAL_CLOSED);
});

test("proposalModalReduce: out-of-order events are no-ops", () => {
  // APPLY_OK without preceding APPLY: state stays unchanged.
  const opened = proposalModalReduce(PROPOSAL_MODAL_CLOSED, {
    type: "OPEN",
    proposal: SAMPLE_PROPOSAL,
  });
  const same = proposalModalReduce(opened, { type: "APPLY_OK" });
  assert.equal(same, opened);
});
