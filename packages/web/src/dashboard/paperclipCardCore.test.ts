/**
 * /channels — Paperclip card derivation tests.
 *
 * Covers the contract laid out in the P2 Lane III brief:
 *   • derive each of the 3 visual states
 *     (missing_secret / awaiting / connected)
 *   • derivePaperclipOrigin swaps host → paperclip.<host>
 *   • visibleRuns + hasMoreRuns capping at 5
 *   • runs with malformed `status` fall back to "ok"
 *   • lastHeartbeatRelative formats just-now / N min / N hours
 *   • truncateTaskId shortens long ids
 *
 * Run with:  cd packages/web && npx tsx --test src/dashboard/paperclipCardCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  derivePaperclipCardState,
  derivePaperclipOrigin,
  relativeTimeFromIso,
  runStatusLabel,
  truncateTaskId,
  type PaperclipRun,
  type PaperclipStatus,
} from "./paperclipCardCore";

const BASE: PaperclipStatus = {
  configured: false,
  heartbeat_url: "https://home.alfred.black/api/v1/channels/paperclip/heartbeat",
  has_signing_secret: false,
  last_heartbeat_at: null,
  recent_runs: [],
};

const FROZEN_NOW = new Date("2026-05-26T12:00:00Z");

function isoMinutesAgo(min: number): string {
  return new Date(FROZEN_NOW.getTime() - min * 60_000).toISOString();
}

test("derive: missing_secret (default fresh install pre-bootstrap)", () => {
  const card = derivePaperclipCardState(
    { ...BASE, has_signing_secret: false },
    FROZEN_NOW,
  );
  assert.equal(card.status, "missing_secret");
  assert.equal(card.pillLabel, "Setup required");
  assert.equal(card.pillTone, "error");
  assert.equal(card.canTest, false);
  assert.match(card.description, /bootstrap\.sh/);
});

test("derive: awaiting — secret set but no heartbeat yet", () => {
  const card = derivePaperclipCardState(
    { ...BASE, has_signing_secret: true, last_heartbeat_at: null },
    FROZEN_NOW,
  );
  assert.equal(card.status, "awaiting");
  assert.equal(card.pillLabel, "Awaiting first task");
  assert.equal(card.pillTone, "available");
  assert.equal(card.canTest, true);
  assert.equal(card.lastHeartbeatRelative, null);
  // Heartbeat URL surfaced for paste-into-Paperclip.
  assert.equal(
    card.heartbeatUrl,
    "https://home.alfred.black/api/v1/channels/paperclip/heartbeat",
  );
  // Deep-link origin derived.
  assert.equal(card.paperclipOrigin, "https://paperclip.home.alfred.black");
});

test("derive: connected — heartbeat received, runs visible", () => {
  const runs: PaperclipRun[] = [
    {
      ts: isoMinutesAgo(2),
      run_id: "run-1",
      paperclip_agent_id: "agt-1",
      task_id: "task-abc123def456",
      status: "ok",
      duration_ms: 1234,
    },
    {
      ts: isoMinutesAgo(40),
      run_id: "run-2",
      paperclip_agent_id: "agt-1",
      task_id: "task-2",
      status: "ok",
      duration_ms: 980,
    },
  ];
  const card = derivePaperclipCardState(
    {
      ...BASE,
      has_signing_secret: true,
      last_heartbeat_at: isoMinutesAgo(3),
      recent_runs: runs,
    },
    FROZEN_NOW,
  );
  assert.equal(card.status, "connected");
  assert.equal(card.pillLabel, "Connected");
  assert.equal(card.pillTone, "active");
  assert.equal(card.canTest, true);
  assert.equal(card.lastHeartbeatRelative, "3 min ago");
  assert.match(card.description, /Last heartbeat: 3 min ago/);
  assert.equal(card.visibleRuns.length, 2);
  assert.equal(card.hasMoreRuns, false);
});

test("derive: connected — visibleRuns caps at 5, hasMoreRuns when more", () => {
  const runs: PaperclipRun[] = Array.from({ length: 8 }, (_, i) => ({
    ts: isoMinutesAgo(i),
    run_id: `run-${i}`,
    paperclip_agent_id: "agt-1",
    task_id: `task-${i}`,
    status: "ok" as const,
    duration_ms: 1000,
  }));
  const card = derivePaperclipCardState(
    {
      ...BASE,
      has_signing_secret: true,
      last_heartbeat_at: isoMinutesAgo(0),
      recent_runs: runs,
    },
    FROZEN_NOW,
  );
  assert.equal(card.visibleRuns.length, 5);
  assert.equal(card.hasMoreRuns, true);
  assert.equal(card.allRuns.length, 8);
});

test("derive: connected — allRuns clamps at 10 even if API returns more", () => {
  const runs: PaperclipRun[] = Array.from({ length: 20 }, (_, i) => ({
    ts: isoMinutesAgo(i),
    run_id: `run-${i}`,
    paperclip_agent_id: "agt-1",
    task_id: `task-${i}`,
    status: "ok" as const,
    duration_ms: 1000,
  }));
  const card = derivePaperclipCardState(
    {
      ...BASE,
      has_signing_secret: true,
      last_heartbeat_at: isoMinutesAgo(0),
      recent_runs: runs,
    },
    FROZEN_NOW,
  );
  assert.equal(card.allRuns.length, 10);
});

test("derive: needs_admin_signup — paperclip-init wrote the invite, principal hasn't claimed yet", () => {
  // Card state when ctrl-api's probeSetupState saw the "Instance setup
  // required" wall on /sign-in AND paperclip-init wrote the invite URL.
  const card = derivePaperclipCardState(
    {
      ...BASE,
      has_signing_secret: true,
      setup_state: "needs_admin_signup",
      admin_invite_url:
        "https://paperclip.home.alfred.black/admin/setup?token=abc123",
    },
    FROZEN_NOW,
  );
  assert.equal(card.status, "needs_admin_signup");
  assert.equal(card.pillLabel, "Setup required");
  assert.equal(card.pillTone, "available");
  assert.equal(card.canTest, false);
  assert.equal(
    card.adminInviteUrl,
    "https://paperclip.home.alfred.black/admin/setup?token=abc123",
  );
  // Copy explicitly mentions the one-click setup.
  assert.match(card.heading, /admin/i);
});

test("derive: needs_admin_signup with no invite URL → state surfaces, adminInviteUrl empty", () => {
  // paperclip-init may still be running on a freshly-deployed tenant.
  // The card should still pick the right state so the UI can render a
  // "preparing your invite…" placeholder.
  const card = derivePaperclipCardState(
    {
      ...BASE,
      has_signing_secret: true,
      setup_state: "needs_admin_signup",
      // admin_invite_url omitted — ctrl-api withholds when file missing.
    },
    FROZEN_NOW,
  );
  assert.equal(card.status, "needs_admin_signup");
  assert.equal(card.adminInviteUrl, "");
});

test("derive: missing_secret state takes precedence over any last_heartbeat_at", () => {
  // Defensive: even if ctrl-api returns last_heartbeat_at + has_signing_secret=false
  // (shouldn't happen, but we should fail loudly to "Setup required").
  const card = derivePaperclipCardState(
    {
      ...BASE,
      has_signing_secret: false,
      last_heartbeat_at: isoMinutesAgo(5),
    },
    FROZEN_NOW,
  );
  assert.equal(card.status, "missing_secret");
});

test("derive: null status (no data yet) → missing_secret with empty fields", () => {
  const card = derivePaperclipCardState(null, FROZEN_NOW);
  assert.equal(card.status, "missing_secret");
  assert.equal(card.heartbeatUrl, "");
  assert.equal(card.paperclipOrigin, "");
});

test("derive: malformed recent_runs entry is dropped or normalised", () => {
  // The runtime normaliser must survive garbage from the wire — null entries,
  // strings instead of objects, unknown status enums, non-numeric durations.
  // Tests must cast through `unknown` because the statically-typed shape
  // forbids this on purpose; the *whole point* is that the runtime defends
  // against an API that has drifted.
  const card = derivePaperclipCardState(
    {
      ...BASE,
      has_signing_secret: true,
      last_heartbeat_at: isoMinutesAgo(1),
      recent_runs: [
        null,
        "not-an-object",
        { run_id: "ok", paperclip_agent_id: "a", task_id: "t", ts: "", status: "ok", duration_ms: 100 },
        // bad status string → normalises to "ok"; non-numeric duration → 0
        { run_id: "bs", paperclip_agent_id: "a", task_id: "t2", ts: "", status: "blew_up", duration_ms: "fast" },
      ] as unknown as PaperclipStatus["recent_runs"],
    },
    FROZEN_NOW,
  );
  assert.equal(card.visibleRuns.length, 2);
  assert.equal(card.visibleRuns[1].status, "ok");
  assert.equal(card.visibleRuns[1].duration_ms, 0);
});

test("derivePaperclipOrigin: swaps host → paperclip.<host>", () => {
  assert.equal(
    derivePaperclipOrigin(
      "https://home.alfred.black/api/v1/channels/paperclip/heartbeat",
    ),
    "https://paperclip.home.alfred.black",
  );
  // Already prefixed → don't double-prefix.
  assert.equal(
    derivePaperclipOrigin(
      "https://paperclip.home.alfred.black/api/v1/channels/paperclip/heartbeat",
    ),
    "https://paperclip.home.alfred.black",
  );
  // Empty / garbage → empty string (caller hides the deep-link).
  assert.equal(derivePaperclipOrigin(""), "");
  assert.equal(derivePaperclipOrigin("not-a-url"), "");
  // Preserves scheme + non-default ports.
  assert.equal(
    derivePaperclipOrigin("http://localhost:3100/api/v1/channels/paperclip/heartbeat"),
    "http://paperclip.localhost:3100",
  );
});

test("relativeTimeFromIso: just now / N min / N hours / N days", () => {
  const at = (ms: number) => new Date(FROZEN_NOW.getTime() - ms).toISOString();
  assert.equal(relativeTimeFromIso(at(10_000), FROZEN_NOW), "just now");
  assert.equal(relativeTimeFromIso(at(7 * 60_000), FROZEN_NOW), "7 min ago");
  assert.equal(relativeTimeFromIso(at(60 * 60_000), FROZEN_NOW), "1 hour ago");
  assert.equal(relativeTimeFromIso(at(5 * 60 * 60_000), FROZEN_NOW), "5 hours ago");
  assert.equal(relativeTimeFromIso(at(86_400_000), FROZEN_NOW), "1 day ago");
  assert.equal(relativeTimeFromIso(at(3 * 86_400_000), FROZEN_NOW), "3 days ago");
  assert.equal(relativeTimeFromIso("not-a-date"), "unknown");
});

test("truncateTaskId: keeps short ids, shortens long ones", () => {
  assert.equal(truncateTaskId("short"), "short");
  assert.equal(truncateTaskId("exactly-12ch"), "exactly-12ch");
  assert.equal(truncateTaskId("task-abc123def456789"), "task-a…6789");
});

test("runStatusLabel: maps each status to a human label", () => {
  assert.equal(runStatusLabel("ok"), "ok");
  assert.equal(runStatusLabel("auth_failed"), "auth failed");
  assert.equal(runStatusLabel("translation_failed"), "translation failed");
  assert.equal(runStatusLabel("hermes_unreachable"), "hermes unreachable");
  assert.equal(runStatusLabel("replay"), "replay");
});
