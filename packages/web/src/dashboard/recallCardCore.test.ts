/**
 * /channels — Recall.ai card derivation tests.
 *
 * Covers the contract in spec §5.4 + the PR3 brief:
 *   • status string by enabled state (disabled / configured / error)
 *   • settings form serialize / deserialize (round-trip & diff PATCH)
 *   • dial-range validation (wake-word, monthly-hours-cap, leave-after-minutes)
 *   • recent-bots derivation by status (active vs terminal split, normaliser)
 *   • webhook URL formatter (https default + trailing slash + bare host)
 *   • cost-threshold parser (comma / space / "%" / dedupe / sort / range)
 *   • cost-alert trigger boolean (month-hours ≥ cap * lowest-threshold / 100)
 *   • bot duration + timestamp formatters
 *
 * Run with:  cd packages/web && npx tsx --test src/dashboard/recallCardCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RECALL_DEFAULT_FORM,
  RECALL_REGION_OPTIONS,
  RECALL_AUTO_JOIN_POLICY_OPTIONS,
  RECALL_RESPOND_MODE_OPTIONS,
  RECALL_CALENDAR_SOURCE_OPTIONS,
  RECALL_MONTHLY_HOURS_CAP_RANGE,
  RECALL_LEAVE_AFTER_MINUTES_RANGE,
  RECALL_WAKE_WORD_RANGE,
  RECALL_COST_THRESHOLD_RANGE,
  botDurationMs,
  botStatusLabel,
  configToFormValues,
  deriveBotsByStatus,
  deriveRecallCardState,
  formatBotDuration,
  formatBotTimestamp,
  formatCostThresholdList,
  formatHours,
  formatRecallWebhookUrl,
  isProbablyValidWakeWord,
  isValidBotName,
  isValidLeaveAfterMinutes,
  isValidMonthlyHoursCap,
  parseCostThresholdList,
  serializeFormPatch,
  truncateBotId,
  type RecallBot,
  type RecallConfig,
  type RecallStatus,
} from "./recallCardCore";

const FROZEN_NOW = new Date("2026-05-29T12:00:00Z");
const FROZEN_NOW_MS = FROZEN_NOW.getTime();

function msAgo(min: number): number {
  return FROZEN_NOW_MS - min * 60_000;
}

const BASE_CONFIG: RecallConfig = {
  region: "us-east-1",
  bot_name: "Alfred's note-taker",
  announces_on_join: true,
  auto_join_policy: "principal_attendee",
  calendar_source: "composio",
  monthly_hours_cap: 60,
  leave_after_minutes: 90,
  respond_mode: "on_mention",
  wake_word: "Alfred",
  cost_alert_thresholds: [80, 100],
  updated_at: FROZEN_NOW_MS,
};

// ── 1. status by enabled state ───────────────────────────────────────────

test("derive: disabled — no API key on file (fresh tenant pre-paste)", () => {
  const status: RecallStatus = {
    enabled: false,
    config: null,
    usage: null,
    active_bots: [],
    error: null,
  };
  const card = deriveRecallCardState(status, FROZEN_NOW);
  assert.equal(card.status, "disabled");
  assert.equal(card.pillLabel, "Not connected");
  assert.equal(card.pillTone, "available");
  assert.match(card.heading, /Activate Recall/i);
  // Even disabled, the form gets the defaults so the principal sees the
  // shape of what they're configuring.
  assert.deepEqual(card.formValues, RECALL_DEFAULT_FORM);
  // No live data → bots table hidden, can't test webhook, can't edit dials.
  assert.equal(card.visibleBots.length, 0);
  assert.equal(card.canEditDials, false);
  assert.equal(card.canTest, false);
  assert.equal(card.monthHours, null);
});

test("derive: configured — config + usage live; pill = Connected", () => {
  const status: RecallStatus = {
    enabled: true,
    config: BASE_CONFIG,
    usage: { this_month_hours: 12.5, monthly_hours_cap: 60, bot_count_active: 1 },
    active_bots: [],
    error: null,
  };
  const card = deriveRecallCardState(status, FROZEN_NOW);
  assert.equal(card.status, "configured");
  assert.equal(card.pillLabel, "Connected");
  assert.equal(card.pillTone, "active");
  assert.equal(card.canEditDials, true);
  assert.equal(card.canTest, true);
  assert.equal(card.monthHours, 12.5);
  // Address bakes the live usage rollup.
  assert.match(card.address, /12.50h \/ 60h this month/);
  assert.match(card.address, /1 bot active/);
});

test("derive: error — enabled but probe failed; surface verbatim error", () => {
  const status: RecallStatus = {
    enabled: true,
    config: BASE_CONFIG,
    usage: null,
    active_bots: [],
    error: "Recall returned HTTP 500 — internal server error",
  };
  const card = deriveRecallCardState(status, FROZEN_NOW);
  assert.equal(card.status, "error");
  assert.equal(card.pillLabel, "Needs attention");
  assert.equal(card.pillTone, "error");
  assert.match(card.description, /HTTP 500/);
  // Edits + test disabled in error state — operator fixes upstream first.
  assert.equal(card.canEditDials, false);
  assert.equal(card.canTest, false);
});

test("derive: null status (no data yet) → disabled with defaults", () => {
  const card = deriveRecallCardState(null, FROZEN_NOW);
  assert.equal(card.status, "disabled");
  assert.deepEqual(card.formValues, RECALL_DEFAULT_FORM);
});

// ── 2. settings form serialize / deserialize ─────────────────────────────

test("configToFormValues: live config round-trips to the form shape", () => {
  const form = configToFormValues({
    ...BASE_CONFIG,
    region: "eu-central-1",
    bot_name: "Custom Bot",
    monthly_hours_cap: 120,
    respond_mode: "always",
    cost_alert_thresholds: [50, 80, 100],
  });
  assert.equal(form.region, "eu-central-1");
  assert.equal(form.bot_name, "Custom Bot");
  assert.equal(form.monthly_hours_cap, 120);
  assert.equal(form.respond_mode, "always");
  assert.deepEqual(form.cost_alert_thresholds, [50, 80, 100]);
});

test("configToFormValues: bad enum values fall back to defaults", () => {
  // Cast through `unknown` — runtime defends against an upstream that
  // drifted the enum without telling the snapshot.
  const form = configToFormValues({
    ...BASE_CONFIG,
    region: "mars-1" as unknown as RecallConfig["region"],
    auto_join_policy:
      "any_meeting" as unknown as RecallConfig["auto_join_policy"],
    respond_mode: "loud" as unknown as RecallConfig["respond_mode"],
  });
  assert.equal(form.region, RECALL_DEFAULT_FORM.region);
  assert.equal(form.auto_join_policy, RECALL_DEFAULT_FORM.auto_join_policy);
  assert.equal(form.respond_mode, RECALL_DEFAULT_FORM.respond_mode);
});

test("configToFormValues: out-of-range numbers clamp into range", () => {
  const form = configToFormValues({
    ...BASE_CONFIG,
    monthly_hours_cap: 9999, // route validator allows 0-10000 but the card caps at 500
    leave_after_minutes: 0, // below min=1
  });
  assert.equal(form.monthly_hours_cap, RECALL_MONTHLY_HOURS_CAP_RANGE.max);
  assert.equal(form.leave_after_minutes, RECALL_LEAVE_AFTER_MINUTES_RANGE.min);
});

test("configToFormValues: null config falls back to RECALL_DEFAULT_FORM", () => {
  const form = configToFormValues(null);
  assert.deepEqual(form, RECALL_DEFAULT_FORM);
});

test("serializeFormPatch: only changed fields land in the PATCH body", () => {
  const prev = { ...RECALL_DEFAULT_FORM };
  const next = {
    ...prev,
    region: "eu-central-1" as const,
    monthly_hours_cap: 120,
  };
  const patch = serializeFormPatch(next, prev);
  assert.deepEqual(patch, {
    region: "eu-central-1",
    monthly_hours_cap: 120,
  });
});

test("serializeFormPatch: no-op when nothing changed → empty object", () => {
  const prev = { ...RECALL_DEFAULT_FORM };
  const next = { ...prev };
  const patch = serializeFormPatch(next, prev);
  assert.deepEqual(patch, {});
});

test("serializeFormPatch: threshold-array equality is element-wise, not reference", () => {
  const prev = { ...RECALL_DEFAULT_FORM, cost_alert_thresholds: [80, 100] };
  // Same array contents but a different reference — must NOT appear in the patch.
  const next = { ...prev, cost_alert_thresholds: [80, 100] };
  const patch = serializeFormPatch(next, prev);
  assert.deepEqual(patch, {});
  // Different contents → does appear.
  const changed = { ...prev, cost_alert_thresholds: [50, 80, 100] };
  const patch2 = serializeFormPatch(changed, prev);
  assert.deepEqual(patch2.cost_alert_thresholds, [50, 80, 100]);
});

test("serializeFormPatch: trims wake_word + bot_name before diffing", () => {
  const prev = { ...RECALL_DEFAULT_FORM, wake_word: "Alfred" };
  // Pure whitespace-only diff → no patch line.
  const next = { ...prev, wake_word: "  Alfred  " };
  const patch = serializeFormPatch(next, prev);
  assert.equal(patch.wake_word, undefined);
});

// ── 3. dial-range validation ──────────────────────────────────────────────

test("isProbablyValidWakeWord: trims + accepts non-empty ≤64", () => {
  assert.equal(isProbablyValidWakeWord("Alfred"), true);
  assert.equal(isProbablyValidWakeWord("  Sir  "), true);
  assert.equal(isProbablyValidWakeWord(""), false);
  assert.equal(isProbablyValidWakeWord("   "), false);
  assert.equal(isProbablyValidWakeWord("x".repeat(65)), false);
  // Embedded control char (mid-string \u0001 survives .trim()).
  assert.equal(isProbablyValidWakeWord("Alfred\u0001Sir"), false);
  // A trailing newline alone is trimmed off, so the wake word survives.
  assert.equal(isProbablyValidWakeWord("Alfred\n"), true);
  assert.equal(isProbablyValidWakeWord(123 as unknown as string), false);
});

test("isValidMonthlyHoursCap: enforces [1, 500] integer range", () => {
  assert.equal(isValidMonthlyHoursCap(60), true);
  assert.equal(isValidMonthlyHoursCap(RECALL_MONTHLY_HOURS_CAP_RANGE.min), true);
  assert.equal(isValidMonthlyHoursCap(RECALL_MONTHLY_HOURS_CAP_RANGE.max), true);
  assert.equal(isValidMonthlyHoursCap(0), false);
  assert.equal(isValidMonthlyHoursCap(501), false);
  assert.equal(isValidMonthlyHoursCap(60.5), false);
  assert.equal(isValidMonthlyHoursCap("60" as unknown as number), false);
});

test("isValidLeaveAfterMinutes: enforces [1, 1440] integer range", () => {
  assert.equal(isValidLeaveAfterMinutes(90), true);
  assert.equal(isValidLeaveAfterMinutes(RECALL_LEAVE_AFTER_MINUTES_RANGE.min), true);
  assert.equal(isValidLeaveAfterMinutes(RECALL_LEAVE_AFTER_MINUTES_RANGE.max), true);
  assert.equal(isValidLeaveAfterMinutes(0), false);
  assert.equal(isValidLeaveAfterMinutes(1441), false);
});

test("isValidBotName: non-empty + ≤200 chars", () => {
  assert.equal(isValidBotName("Alfred's note-taker"), true);
  assert.equal(isValidBotName(""), false);
  assert.equal(isValidBotName("   "), false);
  assert.equal(isValidBotName("x".repeat(201)), false);
});

// ── 4. recent-bots derivation by status ──────────────────────────────────

test("deriveBotsByStatus: splits active vs terminal, newest-first", () => {
  const bots: unknown[] = [
    {
      id: "bot-old-done",
      status: "done",
      created_at: msAgo(60),
      joined_at: msAgo(60),
      left_at: msAgo(50),
    },
    {
      id: "bot-active",
      status: "in_meeting",
      created_at: msAgo(5),
      joined_at: msAgo(4),
    },
    {
      id: "bot-newer-fail",
      status: "fail",
      created_at: msAgo(2),
    },
    {
      id: "bot-joining",
      status: "joining",
      created_at: msAgo(1),
    },
  ];
  const { active, terminal } = deriveBotsByStatus(bots);
  // active: joining (1min ago) then in_meeting (5min ago)
  assert.deepEqual(
    active.map((b) => b.id),
    ["bot-joining", "bot-active"],
  );
  // terminal: fail (2min ago) then done (60min ago)
  assert.deepEqual(
    terminal.map((b) => b.id),
    ["bot-newer-fail", "bot-old-done"],
  );
});

test("deriveBotsByStatus: malformed entries dropped; unknown statuses ignored", () => {
  const bots: unknown[] = [
    null,
    "not-an-object",
    { id: "no-status" }, // missing status
    { id: "bad-status", status: "shrugging", created_at: msAgo(1) }, // unknown enum
    { id: "ok", status: "joining", created_at: msAgo(2) },
    { status: "joining", created_at: msAgo(3) }, // missing id
  ];
  const { active, terminal } = deriveBotsByStatus(bots);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, "ok");
  assert.equal(terminal.length, 0);
});

test("deriveRecallCardState: visibleBots caps at 10 active rows", () => {
  const bots: RecallBot[] = Array.from({ length: 15 }, (_, i) => ({
    id: `bot-${i}`,
    calendar_event_id: null,
    meeting_url: null,
    status: "joining" as const,
    created_at: msAgo(i),
    joined_at: null,
    left_at: null,
    transcript_url: null,
  }));
  const status: RecallStatus = {
    enabled: true,
    config: BASE_CONFIG,
    usage: { this_month_hours: 0, monthly_hours_cap: 60, bot_count_active: 15 },
    active_bots: bots,
    error: null,
  };
  const card = deriveRecallCardState(status, FROZEN_NOW);
  assert.equal(card.visibleBots.length, 10);
});

// ── 5. webhook URL formatter ─────────────────────────────────────────────

test("formatRecallWebhookUrl: composes /api/v1/webhooks/recall onto origin", () => {
  assert.equal(
    formatRecallWebhookUrl("https://home.alfred.black"),
    "https://home.alfred.black/api/v1/webhooks/recall",
  );
  // Trailing slash + extra path are dropped.
  assert.equal(
    formatRecallWebhookUrl("https://home.alfred.black/"),
    "https://home.alfred.black/api/v1/webhooks/recall",
  );
  // Bare host → defaults to https.
  assert.equal(
    formatRecallWebhookUrl("home.alfred.black"),
    "https://home.alfred.black/api/v1/webhooks/recall",
  );
  // Empty / nullish → empty string (caller hides Copy button).
  assert.equal(formatRecallWebhookUrl(""), "");
  assert.equal(formatRecallWebhookUrl(null), "");
  assert.equal(formatRecallWebhookUrl(undefined), "");
  // http preserved (localhost dev).
  assert.equal(
    formatRecallWebhookUrl("http://localhost:3000"),
    "http://localhost:3000/api/v1/webhooks/recall",
  );
});

// ── 6. cost-threshold parser ─────────────────────────────────────────────

test("parseCostThresholdList: comma + space + %, dedupe + sort, range check", () => {
  assert.deepEqual(parseCostThresholdList("80, 100"), [80, 100]);
  assert.deepEqual(parseCostThresholdList("80 100 150"), [80, 100, 150]);
  assert.deepEqual(parseCostThresholdList("80%, 100%"), [80, 100]);
  // Out-of-order + duplicate → sorted + deduped.
  assert.deepEqual(parseCostThresholdList("100, 80, 80"), [80, 100]);
  // Empty input → null (the form surfaces "must enter at least one").
  assert.equal(parseCostThresholdList(""), null);
  assert.equal(parseCostThresholdList("   "), null);
  // Below min=1 → null.
  assert.equal(parseCostThresholdList("0, 100"), null);
  // Above max=200 → null.
  assert.equal(parseCostThresholdList("100, 250"), null);
  // Non-numeric → null.
  assert.equal(parseCostThresholdList("abc"), null);
  assert.equal(parseCostThresholdList("80, xyz"), null);
});

test("formatCostThresholdList: round-trips through parse for canonical input", () => {
  const parsed = parseCostThresholdList("80, 100");
  assert.deepEqual(parsed, [80, 100]);
  assert.equal(formatCostThresholdList(parsed!), "80, 100");
  assert.equal(formatCostThresholdList([]), "");
  // Non-finite entries dropped, no quotes/whitespace artefacts.
  assert.equal(
    formatCostThresholdList([80, Number.NaN as unknown as number, 100]),
    "80, 100",
  );
});

// ── 7. cost-alert trigger (the badge boolean) ────────────────────────────

test("derive: costAlertTriggered fires when month-hours ≥ cap × lowest-threshold/100", () => {
  // cap=60, thresholds=[80, 100] → trigger at 60 * 0.80 = 48h
  const status: RecallStatus = {
    enabled: true,
    config: BASE_CONFIG,
    usage: { this_month_hours: 48, monthly_hours_cap: 60, bot_count_active: 0 },
    active_bots: [],
    error: null,
  };
  const card = deriveRecallCardState(status, FROZEN_NOW);
  assert.equal(card.costAlertTriggered, true);
});

test("derive: costAlertTriggered stays false below first threshold", () => {
  const status: RecallStatus = {
    enabled: true,
    config: BASE_CONFIG,
    usage: { this_month_hours: 12, monthly_hours_cap: 60, bot_count_active: 0 },
    active_bots: [],
    error: null,
  };
  const card = deriveRecallCardState(status, FROZEN_NOW);
  assert.equal(card.costAlertTriggered, false);
});

// ── 8. bot duration / timestamp helpers ──────────────────────────────────

test("botDurationMs: null when not yet joined; capped at now for in-flight", () => {
  const queued: RecallBot = {
    id: "q",
    calendar_event_id: null,
    meeting_url: null,
    status: "joining",
    created_at: msAgo(2),
    joined_at: null,
    left_at: null,
    transcript_url: null,
  };
  assert.equal(botDurationMs(queued, FROZEN_NOW), null);

  const inflight: RecallBot = {
    ...queued,
    status: "in_meeting",
    joined_at: msAgo(30),
    left_at: null,
  };
  assert.equal(botDurationMs(inflight, FROZEN_NOW), 30 * 60_000);

  const done: RecallBot = {
    ...queued,
    status: "done",
    joined_at: msAgo(60),
    left_at: msAgo(15),
  };
  assert.equal(botDurationMs(done, FROZEN_NOW), 45 * 60_000);
});

test("formatBotDuration: h+m / m-only / s-only / em-dash for null", () => {
  assert.equal(formatBotDuration(null), "—");
  assert.equal(formatBotDuration(0), "0s");
  assert.equal(formatBotDuration(47_000), "47s");
  assert.equal(formatBotDuration(12 * 60_000), "12m");
  assert.equal(formatBotDuration(72 * 60_000), "1h 12m");
});

test("formatBotTimestamp + truncateBotId + formatHours + botStatusLabel", () => {
  assert.equal(formatBotTimestamp(null), "—");
  assert.equal(
    formatBotTimestamp(Date.UTC(2026, 4, 29, 12, 34)),
    "2026-05-29 12:34 UTC",
  );
  assert.equal(truncateBotId("abc"), "abc");
  // Truncation keeps first 6 + last 4 chars.
  assert.equal(truncateBotId("abcdef-1234-5678-90"), "abcdef…8-90");
  assert.equal(truncateBotId("exactly-12ch"), "exactly-12ch");
  assert.equal(formatHours(12.345), "12.35h");
  assert.equal(formatHours(0), "0.00h");
  assert.equal(formatHours(Number.NaN), "—");

  assert.equal(botStatusLabel("requested"), "Requested");
  assert.equal(botStatusLabel("in_meeting"), "In meeting");
  assert.equal(botStatusLabel("done"), "Done");
  assert.equal(botStatusLabel("fail"), "Failed");
});

// ── 9. sanity: option lists match the route validator's expectations ─────

test("enum option lists carry the exact strings the route validator accepts", () => {
  // These constants are imported by the React layer's <select> and
  // by the route validator in channels_recall.ts; if either drifts,
  // the union types blow up first. Just sanity-check membership here.
  assert.ok(RECALL_REGION_OPTIONS.includes("us-east-1"));
  assert.ok(RECALL_REGION_OPTIONS.includes("eu-central-1"));
  assert.ok(RECALL_AUTO_JOIN_POLICY_OPTIONS.includes("principal_attendee"));
  assert.ok(RECALL_AUTO_JOIN_POLICY_OPTIONS.includes("off"));
  assert.ok(RECALL_RESPOND_MODE_OPTIONS.includes("on_mention"));
  assert.ok(RECALL_CALENDAR_SOURCE_OPTIONS.includes("composio"));
  // Range sanity — these drive the <input min/max>.
  assert.equal(RECALL_MONTHLY_HOURS_CAP_RANGE.min, 1);
  assert.equal(RECALL_MONTHLY_HOURS_CAP_RANGE.max, 500);
  assert.equal(RECALL_WAKE_WORD_RANGE.max, 64);
  assert.equal(RECALL_COST_THRESHOLD_RANGE.max, 200);
});
