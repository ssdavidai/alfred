/**
 * Unit tests for the Composio auto-config reconciler core.
 *
 * Covers Defect A from
 * `fix/composio-auto-config-on-callback-and-stale-schedule`: a tenant with
 * an ACTIVE Composio connection but `pending`/`error` auto-config state
 * gets reconciled server-side without requiring the dashboard to be open.
 *
 * Run with:
 *   cd packages/saas/app
 *   npx tsx --test src/integrations/reconcileCore.test.ts
 *
 * or via `make test-saas-unit`.
 *
 * We import only `reconcileCore` (no `wasp/server` deps) so the test runs
 * cleanly under tsx without spinning up Prisma. The Prisma delegate is
 * faked directly here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPendingRowsWhere,
  reconcileBatch,
  type ComposioConnectionSnapshot,
  type PendingRow,
  type ReconcileDeps,
} from "./reconcileCore";

// Stub that should never be called in tests whose row is already ACTIVE.
// Wrapped in a factory so each test can assert independently whether it was
// invoked. Tests that exercise the INITIATED→ACTIVE lift path supply their
// own stub instead.
function neverFetchComposio(): ComposioConnectionSnapshot {
  throw new Error("fetchComposioConnection must not be called for ACTIVE rows");
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeRow {
  connectionId: string;
  userId: string;
  toolkit: string;
  status: string;
  autoConfigState: "pending" | "running" | "configured" | "error";
  autoConfigError: string | null;
  autoConfiguredAt: Date | null;
  streamsCreated: number;
  toolsEnabled: number;
  skillName: string | null;
  lastSyncedAt: Date;
}

function makeFakeDelegate(rows: FakeRow[]) {
  const map = new Map<string, FakeRow>();
  for (const r of rows) map.set(r.connectionId, { ...r });

  return {
    rows: map,
    findUnique: async ({ where }: any) => {
      const id = where?.connectionId;
      if (!id) return null;
      return map.get(id) ?? null;
    },
    update: async ({ where, data }: any) => {
      const id = where?.connectionId;
      const row = map.get(id);
      if (!row) throw new Error(`fake delegate: no row ${id}`);
      Object.assign(row, data);
      return row;
    },
    findMany: async () => [...map.values()],
    create: async () => { throw new Error("not used"); },
    upsert: async () => { throw new Error("not used"); },
    deleteMany: async () => { throw new Error("not used"); },
  };
}

function makeRow(overrides: Partial<PendingRow> & {
  connectionId: string;
  toolkit: string;
}): PendingRow {
  return {
    id: overrides.id ?? `row-${overrides.connectionId}`,
    userId: overrides.userId ?? "user-david",
    connectionId: overrides.connectionId,
    toolkit: overrides.toolkit,
    // Default ACTIVE so the existing tests preserve their prior semantics.
    // INITIATED→ACTIVE coverage lives in its own block below.
    status: overrides.status ?? "ACTIVE",
    autoConfigState: overrides.autoConfigState ?? "pending",
    lastSyncedAt: overrides.lastSyncedAt ?? new Date(0),
    // Single-VM: no per-user instance — the reconciler always hits the one
    // local ctrl-api.
    user: overrides.user ?? { id: "user-david" },
  };
}

// ---------------------------------------------------------------------------
// Defect A — auto-config fires server-side
// ---------------------------------------------------------------------------

test("reconcileBatch: fires auto-config on a pending ACTIVE row and flips it to configured", async () => {
  const fakeRows: FakeRow[] = [{
    connectionId: "ca_gmail_raj",
    userId: "user-david",
    toolkit: "gmail",
    status: "ACTIVE",
    autoConfigState: "pending",
    autoConfigError: null,
    autoConfiguredAt: null,
    streamsCreated: 0,
    toolsEnabled: 0,
    skillName: null,
    lastSyncedAt: new Date(0),
  }];
  const delegate = makeFakeDelegate(fakeRows);
  const fetchCalls: Array<{ connectionId: string }> = [];

  const deps: ReconcileDeps = {
    delegate,
    fetchAutoConfig: async (_instance, connectionId) => {
      fetchCalls.push({ connectionId });
      return {
        toolkit: "gmail",
        composio_execute_enabled: true,
        stream_created: "composio-gmail-gmail-fetch-emails",
        // (#53) auto-config no longer creates a per-stream schedule —
        // the `schedule_created` field was dropped from its response.
        skill_generated: "/home/node/.openclaw/workspace/skills/alfred-composio-gmail",
        actions_count: 12,
      };
    },
    fetchComposioConnection: async () => neverFetchComposio(),
  };

  const summary = await reconcileBatch(
    [makeRow({ connectionId: "ca_gmail_raj", toolkit: "gmail" })],
    deps,
  );

  assert.deepStrictEqual(summary, {
    attempted: 1,
    configured: 1,
    errored: 0,
    skipped: 0,
  });
  assert.strictEqual(fetchCalls.length, 1, "auto-config must be called exactly once");
  assert.strictEqual(fetchCalls[0].connectionId, "ca_gmail_raj");

  const updated = delegate.rows.get("ca_gmail_raj")!;
  assert.strictEqual(updated.autoConfigState, "configured");
  assert.strictEqual(updated.streamsCreated, 1, "applyAutoConfigResult sets streamsCreated=1");
  assert.strictEqual(updated.toolsEnabled, 12);
  assert.strictEqual(updated.skillName, "alfred-composio-gmail");
  assert.ok(updated.autoConfiguredAt instanceof Date, "autoConfiguredAt populated");
});

test("reconcileBatch: marks the row 'error' when the tenant call rejects", async () => {
  const fakeRows: FakeRow[] = [{
    connectionId: "ca_calendar_raj",
    userId: "user-david",
    toolkit: "googlecalendar",
    status: "ACTIVE",
    autoConfigState: "pending",
    autoConfigError: null,
    autoConfiguredAt: null,
    streamsCreated: 0,
    toolsEnabled: 0,
    skillName: null,
    lastSyncedAt: new Date(0),
  }];
  const delegate = makeFakeDelegate(fakeRows);
  const deps: ReconcileDeps = {
    delegate,
    fetchAutoConfig: async () => {
      throw new Error("tenant auto-config returned 502: bad gateway");
    },
    fetchComposioConnection: async () => neverFetchComposio(),
  };

  const summary = await reconcileBatch(
    [makeRow({ connectionId: "ca_calendar_raj", toolkit: "googlecalendar" })],
    deps,
  );

  assert.deepStrictEqual(summary, {
    attempted: 1,
    configured: 0,
    errored: 1,
    skipped: 0,
  });
  const updated = delegate.rows.get("ca_calendar_raj")!;
  assert.strictEqual(updated.autoConfigState, "error");
  assert.ok(
    updated.autoConfigError && updated.autoConfigError.includes("502"),
    `expected autoConfigError to mention 502, got ${JSON.stringify(updated.autoConfigError)}`,
  );
});

// NOTE: the legacy "skips rows whose tenant instance isn't running" /
// "...has no instance row" tests are intentionally dropped. Single-VM has
// no fleet and no provisioning gate — the reconciler always targets the one
// local ctrl-api, so there is no skip-when-not-provisioned path to cover.

test("reconcileBatch: respects the per-tick concurrency cap", async () => {
  const ids = ["a", "b", "c", "d", "e"];
  const fakeRows: FakeRow[] = ids.map((i) => ({
    connectionId: `ca_${i}`,
    userId: "user-david",
    toolkit: "gmail",
    status: "ACTIVE",
    autoConfigState: "pending" as const,
    autoConfigError: null,
    autoConfiguredAt: null,
    streamsCreated: 0,
    toolsEnabled: 0,
    skillName: null,
    lastSyncedAt: new Date(0),
  }));
  const delegate = makeFakeDelegate(fakeRows);

  let inFlight = 0;
  let maxInFlight = 0;
  const deps: ReconcileDeps = {
    delegate,
    concurrency: 2,
    fetchAutoConfig: async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      // Yield to the event loop to give the cap a chance to be exceeded
      // if it weren't enforced.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { stream_created: "x", actions_count: 0 };
    },
    fetchComposioConnection: async () => neverFetchComposio(),
  };

  const rows = ids.map((i) =>
    makeRow({ connectionId: `ca_${i}`, toolkit: "gmail" }),
  );
  const summary = await reconcileBatch(rows, deps);

  assert.strictEqual(summary.configured, 5);
  assert.ok(
    maxInFlight <= 2,
    `concurrency cap=2 violated, observed maxInFlight=${maxInFlight}`,
  );
});

// ---------------------------------------------------------------------------
// buildPendingRowsWhere
// ---------------------------------------------------------------------------

test("buildPendingRowsWhere: includes pending rows unconditionally", () => {
  const where = buildPendingRowsWhere(new Date("2026-04-29T10:00:00Z"), 5 * 60 * 1000);
  // The reconciler now picks up ACTIVE + INITIATED rows (the latter so the
  // safety net can catch webhooks that never fired).
  assert.deepStrictEqual(where.status, { in: ["ACTIVE", "INITIATED"] });
  assert.ok(Array.isArray(where.OR));
  const pendingPredicate = where.OR.find((p: any) => p.autoConfigState === "pending");
  assert.ok(pendingPredicate, "must include `autoConfigState: pending`");
  assert.strictEqual(
    Object.keys(pendingPredicate).length,
    1,
    "pending predicate should NOT carry a lastSyncedAt filter",
  );
});

test("buildPendingRowsWhere: status filter accepts both ACTIVE and INITIATED", () => {
  const where = buildPendingRowsWhere(new Date("2026-05-27T10:00:00Z"), 5 * 60 * 1000);
  assert.ok(where.status?.in, "status must be an `in` filter, not an equality");
  assert.ok(where.status.in.includes("ACTIVE"), "ACTIVE must remain in the filter");
  assert.ok(
    where.status.in.includes("INITIATED"),
    "INITIATED must be in the filter so the safety net picks up rows where the webhook never fired (a client tenant, 2026-05-27)",
  );
});

test("buildPendingRowsWhere: error rows must be older than the backoff window", () => {
  const now = new Date("2026-04-29T10:00:00Z");
  const where = buildPendingRowsWhere(now, 5 * 60 * 1000);
  const errorPredicate = where.OR.find((p: any) => p.autoConfigState === "error");
  assert.ok(errorPredicate, "must include `autoConfigState: error`");
  assert.ok(errorPredicate.lastSyncedAt?.lt instanceof Date);
  const expectedCutoff = new Date(now.getTime() - 5 * 60 * 1000);
  assert.strictEqual(
    errorPredicate.lastSyncedAt.lt.getTime(),
    expectedCutoff.getTime(),
    "error rows touched within the backoff window stay out of this tick",
  );
});

// ---------------------------------------------------------------------------
// INITIATED → ACTIVE safety net
//
// Regression coverage for the client-tenant incident (2026-05-27): the
// inbound Composio webhook failed to flip the local row from INITIATED to
// ACTIVE for 36 minutes while Composio's API was reporting ACTIVE the whole
// time. The reconciler now consults Composio directly for INITIATED rows
// and lifts the local row before continuing with auto-config.
// ---------------------------------------------------------------------------

test("reconcileBatch: INITIATED + Composio ACTIVE → lifts row to ACTIVE + fires auto-config", async () => {
  const fakeRows: FakeRow[] = [{
    connectionId: "ca_gmail_joe",
    userId: "user-david",
    toolkit: "gmail",
    status: "INITIATED",                       // ← stuck — webhook never fired
    autoConfigState: "pending",
    autoConfigError: null,
    autoConfiguredAt: null,
    streamsCreated: 0,
    toolsEnabled: 0,
    skillName: null,
    lastSyncedAt: new Date(0),
  }];
  const delegate = makeFakeDelegate(fakeRows);
  const composioCalls: string[] = [];
  const autoConfigCalls: string[] = [];

  const deps: ReconcileDeps = {
    delegate,
    fetchComposioConnection: async (connectionId) => {
      composioCalls.push(connectionId);
      return { status: "ACTIVE" };             // Composio confirms truth
    },
    fetchAutoConfig: async (_instance, connectionId) => {
      autoConfigCalls.push(connectionId);
      return {
        stream_created: "composio-gmail-gmail-fetch-emails",
        skill_generated: "/skills/alfred-composio-gmail",
        actions_count: 7,
      };
    },
  };

  const summary = await reconcileBatch(
    [makeRow({ connectionId: "ca_gmail_joe", toolkit: "gmail", status: "INITIATED" })],
    deps,
  );

  assert.deepStrictEqual(summary, {
    attempted: 1,
    configured: 1,
    errored: 0,
    skipped: 0,
  });
  assert.deepStrictEqual(composioCalls, ["ca_gmail_joe"], "Composio API queried once");
  assert.deepStrictEqual(autoConfigCalls, ["ca_gmail_joe"], "auto-config fired exactly once");
  const updated = delegate.rows.get("ca_gmail_joe")!;
  assert.strictEqual(updated.status, "ACTIVE", "row lifted to ACTIVE");
  assert.strictEqual(updated.autoConfigState, "configured");
  assert.strictEqual(updated.toolsEnabled, 7);
});

test("reconcileBatch: INITIATED + Composio still INITIATED → skip, no autoconfig, no error", async () => {
  const fakeRows: FakeRow[] = [{
    connectionId: "ca_drive_joe",
    userId: "user-david",
    toolkit: "googledrive",
    status: "INITIATED",
    autoConfigState: "pending",
    autoConfigError: null,
    autoConfiguredAt: null,
    streamsCreated: 0,
    toolsEnabled: 0,
    skillName: null,
    lastSyncedAt: new Date(0),
  }];
  const delegate = makeFakeDelegate(fakeRows);
  let autoConfigCalled = false;

  const deps: ReconcileDeps = {
    delegate,
    fetchComposioConnection: async () => ({ status: "INITIATED" }),
    fetchAutoConfig: async () => {
      autoConfigCalled = true;
      return {};
    },
  };

  const summary = await reconcileBatch(
    [makeRow({ connectionId: "ca_drive_joe", toolkit: "googledrive", status: "INITIATED" })],
    deps,
  );

  assert.deepStrictEqual(summary, {
    attempted: 1,
    configured: 0,
    errored: 0,
    skipped: 1,
  });
  assert.strictEqual(autoConfigCalled, false, "auto-config must NOT fire while Composio is still INITIATED");
  const row = delegate.rows.get("ca_drive_joe")!;
  assert.strictEqual(row.status, "INITIATED", "row stays INITIATED");
  assert.strictEqual(row.autoConfigState, "pending", "autoConfigState stays pending (no error mark)");
  assert.strictEqual(row.autoConfigError, null, "no error string recorded — Composio simply hasn't completed OAuth yet");
});

test("reconcileBatch: INITIATED + Composio FAILED → skip, leave local row alone", async () => {
  const fakeRows: FakeRow[] = [{
    connectionId: "ca_calendar_joe",
    userId: "user-david",
    toolkit: "googlecalendar",
    status: "INITIATED",
    autoConfigState: "pending",
    autoConfigError: null,
    autoConfiguredAt: null,
    streamsCreated: 0,
    toolsEnabled: 0,
    skillName: null,
    lastSyncedAt: new Date(0),
  }];
  const delegate = makeFakeDelegate(fakeRows);
  let autoConfigCalled = false;

  const deps: ReconcileDeps = {
    delegate,
    fetchComposioConnection: async () => ({ status: "FAILED" }),
    fetchAutoConfig: async () => {
      autoConfigCalled = true;
      return {};
    },
  };

  const summary = await reconcileBatch(
    [makeRow({ connectionId: "ca_calendar_joe", toolkit: "googlecalendar", status: "INITIATED" })],
    deps,
  );

  assert.deepStrictEqual(summary, {
    attempted: 1,
    configured: 0,
    errored: 0,
    skipped: 1,
  });
  assert.strictEqual(autoConfigCalled, false);
  const row = delegate.rows.get("ca_calendar_joe")!;
  assert.strictEqual(row.status, "INITIATED", "do not mirror Composio's FAILED — the principal may retry OAuth");
  assert.strictEqual(row.autoConfigState, "pending", "no error mark — the failure is on Composio's side");
  assert.strictEqual(row.autoConfigError, null);
});

test("reconcileBatch: INITIATED + Composio returns null (transport/404) → skip cleanly", async () => {
  const fakeRows: FakeRow[] = [{
    connectionId: "ca_slack_joe",
    userId: "user-david",
    toolkit: "slack",
    status: "INITIATED",
    autoConfigState: "pending",
    autoConfigError: null,
    autoConfiguredAt: null,
    streamsCreated: 0,
    toolsEnabled: 0,
    skillName: null,
    lastSyncedAt: new Date(0),
  }];
  const delegate = makeFakeDelegate(fakeRows);
  let autoConfigCalled = false;

  const deps: ReconcileDeps = {
    delegate,
    fetchComposioConnection: async () => null,        // 404, network error, etc.
    fetchAutoConfig: async () => {
      autoConfigCalled = true;
      return {};
    },
  };

  const summary = await reconcileBatch(
    [makeRow({ connectionId: "ca_slack_joe", toolkit: "slack", status: "INITIATED" })],
    deps,
  );

  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(summary.configured, 0);
  assert.strictEqual(summary.errored, 0);
  assert.strictEqual(autoConfigCalled, false);
  const row = delegate.rows.get("ca_slack_joe")!;
  assert.strictEqual(row.status, "INITIATED");
  assert.strictEqual(row.autoConfigState, "pending");
});

test("reconcileBatch: ACTIVE row does NOT query Composio (cost-flat regression guard)", async () => {
  // This is the existing common path. We re-pin it explicitly to lock in
  // the invariant that the safety-net fetch only runs for INITIATED rows.
  const fakeRows: FakeRow[] = [{
    connectionId: "ca_gmail_active",
    userId: "user-david",
    toolkit: "gmail",
    status: "ACTIVE",
    autoConfigState: "pending",
    autoConfigError: null,
    autoConfiguredAt: null,
    streamsCreated: 0,
    toolsEnabled: 0,
    skillName: null,
    lastSyncedAt: new Date(0),
  }];
  const delegate = makeFakeDelegate(fakeRows);
  let composioCalled = false;

  const deps: ReconcileDeps = {
    delegate,
    fetchComposioConnection: async () => {
      composioCalled = true;
      return { status: "ACTIVE" };
    },
    fetchAutoConfig: async () => ({
      stream_created: "composio-gmail-gmail-fetch-emails",
      skill_generated: "/skills/alfred-composio-gmail",
      actions_count: 4,
    }),
  };

  const summary = await reconcileBatch(
    [makeRow({ connectionId: "ca_gmail_active", toolkit: "gmail" })],
    deps,
  );

  assert.strictEqual(summary.configured, 1);
  assert.strictEqual(
    composioCalled,
    false,
    "ACTIVE rows must NOT spend a Composio API call per tick — keeps the common-case cost flat",
  );
  const row = delegate.rows.get("ca_gmail_active")!;
  assert.strictEqual(row.status, "ACTIVE");
  assert.strictEqual(row.autoConfigState, "configured");
});
