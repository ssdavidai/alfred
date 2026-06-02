// ctrl-api auth.ts accepts a SCOPED voice-bridge bearer, but ONLY for the
// explicit allowlist (exact strings + anchored regex patterns). Anything
// outside that catalogue 401s — same outcome as if no token were sent.
//
// History:
//   - Phase 4.1 (commit 85be684e): two routes — /phone/voice-context,
//     /phone/transcript.
//   - PR #95 (2026-05-28): + POST /integrations/execute (the
//     `composio_execute` realtime tool).
//   - PR #98 (2026-05-28): + the read-only `self` surface — vault reads,
//     briefings, decisions, schedules, workflows, matters, chores,
//     signals/observations, learning. Parameterised paths land in
//     VOICE_BRIDGE_PATTERN_ALLOWLIST (anchored regex). NO writes.
//   - #114 PR4 (2026-05-29): + the read-only `files__*` surface — list,
//     usage (exact); stat, blob (anchored regex with `.+` tail because
//     the ULID/safe-name shape carries a `/`). Voice writes (upload,
//     PATCH, DELETE) intentionally NOT in the allowlist.
//
// What this pins:
//
//   1. The master AAS_API_KEY accepts every route (unchanged).
//   2. The voice-bridge token accepts every documented allowlisted route
//      — exact + pattern.
//   3. The voice-bridge token REJECTS every other /api/v1/* route — admin
//      mutations, settings, sibling channels, etc.
//   4. The voice-bridge token REJECTS WRITES against `self`'s read
//      catalogue (PATCH /decisions/:id, POST /streams/events, etc.)
//      — voice writes via MCP (alfred__act_on_decision &c.), not `self`.
//   5. A wrong token (neither master nor voice-bridge) rejects.
//   6. Prefix-match anti-regression — `/voice-context/raw`, `/decisions`
//      with a trailing-slash, etc. — must still 401.
//   7. Wrong method on an allowlisted path also rejects (POST on
//      /voice-context, DELETE on /decisions/:id).
//
// Why this matters: voice-bridge is a network-edge service that talks to
// Twilio (mulaw parser) and OpenAI Realtime (WebSocket). If it's ever
// compromised the blast radius MUST be bounded — read-only on the
// surfaces the realtime agent actually needs, nothing else.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";

import {
  setApiKey,
  setVoiceBridgeKey,
  authenticate,
  _resetAuthForTests,
} from "../src/api/auth.js";
import { AuthError } from "../src/api/errors.js";

const MASTER_KEY = "test-master-" + "x".repeat(40);
const VOICE_KEY = "test-voice-" + "y".repeat(40);

function fakeReq(token: string | undefined): IncomingMessage {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as IncomingMessage;
}

beforeEach(() => {
  _resetAuthForTests();
  setApiKey(MASTER_KEY);
  setVoiceBridgeKey(VOICE_KEY);
});

// ----------------------------------------------------------------------- master

test("master key accepts every route (vault, journal, voice-context, settings)", () => {
  for (const route of [
    { method: "GET", pathname: "/api/v1/vault/context" },
    { method: "POST", pathname: "/api/v1/alfred-journal" },
    { method: "GET", pathname: "/api/v1/phone/voice-context" },
    { method: "POST", pathname: "/api/v1/phone/transcript" },
    { method: "GET", pathname: "/api/v1/settings" },
    { method: "DELETE", pathname: "/api/v1/channels/sms/credentials" },
  ]) {
    assert.doesNotThrow(
      () => authenticate(fakeReq(MASTER_KEY), route),
      `master key must accept ${route.method} ${route.pathname}`,
    );
  }
});

// ------------------------------------------------------------------ voice-bridge accept

test("voice-bridge token accepts GET /api/v1/phone/voice-context", () => {
  assert.doesNotThrow(() =>
    authenticate(fakeReq(VOICE_KEY), {
      method: "GET",
      pathname: "/api/v1/phone/voice-context",
    }),
  );
});

test("voice-bridge token accepts POST /api/v1/phone/transcript", () => {
  assert.doesNotThrow(() =>
    authenticate(fakeReq(VOICE_KEY), {
      method: "POST",
      pathname: "/api/v1/phone/transcript",
    }),
  );
});

test("voice-bridge token accepts POST /api/v1/integrations/execute (composio_execute)", () => {
  assert.doesNotThrow(() =>
    authenticate(fakeReq(VOICE_KEY), {
      method: "POST",
      pathname: "/api/v1/integrations/execute",
    }),
  );
});

// ── `self` read-only surface — PR #98 (2026-05-28). ──────────────────────

test("voice-bridge token accepts `self` read-only catalogue (exact paths)", () => {
  for (const pathname of [
    "/api/v1/briefings",
    "/api/v1/vault/context",
    "/api/v1/vault/search",
    "/api/v1/vault/index",
    "/api/v1/vault/schema",
    "/api/v1/vault/inbox",
    "/api/v1/vault/graph",
    "/api/v1/vault/nebula-data",
    "/api/v1/decisions",
    "/api/v1/decisions/in-flight",
    "/api/v1/matters",
    "/api/v1/chores",
    "/api/v1/chore-actions",
    "/api/v1/workflows",
    "/api/v1/schedules",
    "/api/v1/state/signals",
    "/api/v1/state/observations",
    "/api/v1/admin/needs-attention",
    "/api/v1/learning/status",
    "/api/v1/learning/observations",
    "/api/v1/learning/instincts",
    "/api/v1/learning/reflections",
    "/api/v1/learning/sessions",
  ]) {
    assert.doesNotThrow(
      () => authenticate(fakeReq(VOICE_KEY), { method: "GET", pathname }),
      `voice-bridge token must accept GET ${pathname}`,
    );
  }
});

test("voice-bridge token accepts `self` parameterised reads (regex allowlist)", () => {
  for (const pathname of [
    "/api/v1/briefings/2026-05-28",
    "/api/v1/decisions/abc123-decision-id",
    "/api/v1/vault/list/task",
    "/api/v1/vault/list/note",
    "/api/v1/vault/records/task/some/slash/separated/path.md",
    "/api/v1/matters/some-matter-id",
    "/api/v1/chores/morning-brief",
    "/api/v1/chores/morning-brief/runs",
    "/api/v1/chores/morning-brief/source",
    "/api/v1/workflows/wf-12345",
    "/api/v1/workflows/wf-12345/history",
    "/api/v1/schedules/sched-1",
    "/api/v1/state/signals/sig-1",
    "/api/v1/state/observations/obs-1",
    "/api/v1/learning/observations/obs-1",
    "/api/v1/learning/instincts/inst-1",
  ]) {
    assert.doesNotThrow(
      () => authenticate(fakeReq(VOICE_KEY), { method: "GET", pathname }),
      `voice-bridge token must accept GET ${pathname}`,
    );
  }
});

// ------------------------------------------------------------------ voice-bridge reject

test("voice-bridge token REJECTS alfred-journal recall (cross-channel memory, master-only)", () => {
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "GET",
        pathname: "/api/v1/alfred-journal/recent",
      }),
    AuthError,
  );
});

test("voice-bridge token REJECTS settings mutation", () => {
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "PUT",
        pathname: "/api/v1/settings/state-mutator-mode",
      }),
    AuthError,
  );
});

test("voice-bridge token REJECTS sibling channel ops (SMS credentials)", () => {
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "DELETE",
        pathname: "/api/v1/channels/sms/credentials",
      }),
    AuthError,
  );
});

test("voice-bridge token REJECTS writes against `self` read surfaces", () => {
  // `self` is intentionally read-only — voice writes via MCP
  // (alfred__act_on_decision, alfred__reverse_decision, alfred__notify_*,
  // alfred__create_vault_record). PATCH/POST/DELETE on the read catalogue
  // MUST 401, even on a path that's GET-allowed.
  for (const route of [
    { method: "PATCH", pathname: "/api/v1/decisions/abc123" },
    { method: "POST", pathname: "/api/v1/decisions/abc123/reverse" },
    { method: "POST", pathname: "/api/v1/streams/events" },
    { method: "POST", pathname: "/api/v1/vault/records" },
    { method: "PATCH", pathname: "/api/v1/vault/records/task/foo.md" },
    { method: "DELETE", pathname: "/api/v1/vault/records/task/foo.md" },
    { method: "POST", pathname: "/api/v1/chores/morning-brief/trigger" },
    { method: "POST", pathname: "/api/v1/workflows" },
    { method: "DELETE", pathname: "/api/v1/schedules/sched-1" },
    { method: "PATCH", pathname: "/api/v1/state/signals/sig-1" },
  ]) {
    assert.throws(
      () => authenticate(fakeReq(VOICE_KEY), route),
      AuthError,
      `voice-bridge token MUST reject ${route.method} ${route.pathname}`,
    );
  }
});

test("voice-bridge token REJECTS admin mutation surfaces", () => {
  // /admin/needs-attention (GET) is in the read catalogue, but the wider
  // /admin surface — containers restart, env, chores emergency-pause,
  // backups, tailscale — must stay master-only.
  for (const route of [
    { method: "GET", pathname: "/api/v1/admin/containers" },
    { method: "POST", pathname: "/api/v1/admin/containers/hermes/restart" },
    { method: "GET", pathname: "/api/v1/admin/config/env" },
    { method: "PATCH", pathname: "/api/v1/admin/config/env" },
    { method: "POST", pathname: "/api/v1/admin/chores/emergency-pause-all" },
    { method: "GET", pathname: "/api/v1/admin/dashboard" },
    { method: "GET", pathname: "/api/v1/admin/credentials" },
    { method: "POST", pathname: "/api/v1/admin/desk-action" },
  ]) {
    assert.throws(
      () => authenticate(fakeReq(VOICE_KEY), route),
      AuthError,
      `voice-bridge token MUST reject ${route.method} ${route.pathname}`,
    );
  }
});

// ---------------------------------------------------------------- exact-match pins

test("voice-bridge token REJECTS prefix-match anti-regression cases", () => {
  // Anti-regression: anchored matching only. No prefix inheritance.
  for (const pathname of [
    // Exact-allowlist neighbours.
    "/api/v1/phone/voice-context/raw",
    "/api/v1/phone/voice-context-extended",
    "/api/v1/briefings-archive",
    "/api/v1/decisions/in-flight/extra",
    "/api/v1/vault/contexts", // trailing s, ≠ /vault/context
    // Pattern-allowlist neighbours — the `[^/]+` segment must not gobble
    // up extra segments outside the explicit route shape.
    "/api/v1/briefings/2026-05-28/raw",
    "/api/v1/decisions/abc/extra",
    "/api/v1/matters/some-id/extra",
    "/api/v1/chores/morning-brief/extra-thing",
    "/api/v1/workflows/wf-1/extra",
    "/api/v1/schedules/sched-1/extra",
    "/api/v1/state/signals/sig-1/extra",
  ]) {
    assert.throws(
      () => authenticate(fakeReq(VOICE_KEY), { method: "GET", pathname }),
      AuthError,
      `prefix neighbour ${pathname} must be rejected`,
    );
  }
});

test("voice-bridge token REJECTS wrong-method on allowlisted path", () => {
  // POST /voice-context, GET /transcript — wrong verb, must reject.
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "POST",
        pathname: "/api/v1/phone/voice-context",
      }),
    AuthError,
  );
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "GET",
        pathname: "/api/v1/phone/transcript",
      }),
    AuthError,
  );
});

// ---------------------------------------------------------------- bad-token paths

test("no Bearer header rejects (with master key configured)", () => {
  assert.throws(
    () =>
      authenticate(fakeReq(undefined), {
        method: "GET",
        pathname: "/api/v1/health",
      }),
    AuthError,
  );
});

test("wrong token rejects on every route", () => {
  for (const route of [
    { method: "GET", pathname: "/api/v1/phone/voice-context" },
    { method: "GET", pathname: "/api/v1/vault/context" },
  ]) {
    assert.throws(
      () => authenticate(fakeReq("definitely-not-a-real-token"), route),
      AuthError,
    );
  }
});

test("voice-bridge key may be disabled (set to empty string)", () => {
  setVoiceBridgeKey("");
  // Now the scoped token should be rejected EVERYWHERE.
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "GET",
        pathname: "/api/v1/phone/voice-context",
      }),
    AuthError,
  );
  // Master still works.
  assert.doesNotThrow(() =>
    authenticate(fakeReq(MASTER_KEY), {
      method: "GET",
      pathname: "/api/v1/phone/voice-context",
    }),
  );
});

test("when no master key is configured, authenticate is open (dev mode)", () => {
  _resetAuthForTests();
  // No setApiKey call — both keys null.
  assert.doesNotThrow(() =>
    authenticate(fakeReq(undefined), {
      method: "GET",
      pathname: "/api/v1/anything",
    }),
  );
});
