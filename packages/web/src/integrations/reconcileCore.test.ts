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
  type PendingRow,
  type ReconcileDeps,
} from "./reconcileCore";

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
        schedule_created: "al-stream-pull-composio-composio-gmail-gma",
        skill_generated: "/home/node/.openclaw/workspace/skills/alfred-composio-gmail",
        actions_count: 12,
      };
    },
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
  assert.strictEqual(where.status, "ACTIVE");
  assert.ok(Array.isArray(where.OR));
  const pendingPredicate = where.OR.find((p: any) => p.autoConfigState === "pending");
  assert.ok(pendingPredicate, "must include `autoConfigState: pending`");
  assert.strictEqual(
    Object.keys(pendingPredicate).length,
    1,
    "pending predicate should NOT carry a lastSyncedAt filter",
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
