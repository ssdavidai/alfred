/**
 * Pure orchestration core for the Composio auto-config reconciler.
 *
 * Lives in its own file (no `wasp/server`/Prisma imports) so the unit tests
 * in reconcileCore.test.ts can drive it under `tsx --test` without dragging
 * the whole Wasp runtime into the harness. The IO seam — fetching
 * auto-config from a tenant, the Prisma delegate — is injected via
 * `ReconcileDeps`. The PgBoss-driven worker in reconcileWorker.ts wires
 * production deps in.
 *
 * See reconcileWorker.ts for the design rationale (Defect A).
 */
import {
  applyAutoConfigResult,
  markAutoConfigError,
  markAutoConfigRunning,
} from "./connectionRepo";

// Per-tick concurrency cap. We don't want to flood any one tenant with
// parallel auto-config calls (each spawns docker execs against temporal),
// but cross-tenant concurrency is fine — different VPSes.
const DEFAULT_CONCURRENCY = 4;

// Single-VM: there is no fleet, no per-user Acme Cloud instance. The auto-config
// reconciler always hits the one local ctrl-api. This sentinel keeps the
// `fetchAutoConfig` seam (and its unit tests) signature-stable; the value is
// not consulted any more.
export type PendingRowInstance = Record<string, never>;

export interface PendingRow {
  id: string;
  userId: string;
  connectionId: string;
  toolkit: string;
  autoConfigState: string;
  lastSyncedAt: Date;
  user: {
    id: string;
  };
}

export interface ReconcileDeps {
  delegate: any; // ComposioConnection prisma delegate (or test fake)
  fetchAutoConfig: (
    instance: PendingRowInstance,
    connectionId: string,
  ) => Promise<any>;
  concurrency?: number;
}

export interface ReconcileSummary {
  attempted: number;
  configured: number;
  errored: number;
  skipped: number;
}

export async function reconcileBatch(
  rows: PendingRow[],
  deps: ReconcileDeps,
): Promise<ReconcileSummary> {
  let configured = 0;
  let errored = 0;
  let skipped = 0;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((row) =>
        reconcileOne(row, deps).catch((err) => {
          console.error(
            `[reconcileComposioAutoConfig] unexpected error on row ${row.connectionId}:`,
            err,
          );
          return { outcome: "errored" as const };
        }),
      ),
    );
    for (const r of results) {
      if (r.outcome === "configured") configured++;
      else if (r.outcome === "errored") errored++;
      else skipped++;
    }
  }

  return { attempted: rows.length, configured, errored, skipped };
}

export async function reconcileOne(
  row: PendingRow,
  deps: ReconcileDeps,
): Promise<{ outcome: "configured" | "errored" | "skipped" }> {
  // Single-VM: the local ctrl-api is always the target. No provisioning
  // gate — go straight to marking the row running and firing auto-config.
  const instance: PendingRowInstance = {};

  try {
    await markAutoConfigRunning(deps.delegate, row.userId, row.connectionId);
  } catch (err) {
    console.error("[reconcileComposioAutoConfig] markRunning failed:", err);
    // Continue regardless — the call below is the actual side-effect.
  }

  let result: any;
  try {
    result = await deps.fetchAutoConfig(instance, row.connectionId);
  } catch (err: any) {
    const message = err?.message ?? String(err);
    try {
      await markAutoConfigError(deps.delegate, row.userId, row.connectionId, message);
    } catch { /* best-effort */ }
    console.error(
      `[reconcileComposioAutoConfig] auto-config FAILED for ${row.toolkit}/${row.connectionId}: ${message}`,
    );
    return { outcome: "errored" };
  }

  try {
    await applyAutoConfigResult(deps.delegate, row.userId, row.connectionId, result || {});
  } catch (err) {
    console.error("[reconcileComposioAutoConfig] applyResult failed:", err);
    // Side-effect on the tenant succeeded; row stays in `running` until the
    // next tick re-enters. Treat as configured anyway — the tenant filesystem
    // is correct, the row state is just slightly out of date.
  }

  console.info(
    `[reconcileComposioAutoConfig] configured ${row.toolkit}/${row.connectionId}`,
  );
  return { outcome: "configured" };
}

/**
 * Build the Prisma `where` clause used to find rows that need
 * reconciliation. Exported so the test can mirror the production query
 * predicate against the same fake-row inputs.
 *
 * - `status: "ACTIVE"` — Composio's truth. The reconciler only touches
 *   connections Composio reports as live.
 * - `autoConfigState in {pending, error}` — `configured` rows are done,
 *   `running` rows are mid-flight from another caller.
 * - `error` rows additionally must be older than `errorBackoffMs` so we
 *   don't hammer a tenant whose ctrl-api is down.
 */
export function buildPendingRowsWhere(now: Date, errorBackoffMs: number): any {
  const cutoff = new Date(now.getTime() - errorBackoffMs);
  return {
    status: "ACTIVE",
    OR: [
      { autoConfigState: "pending" },
      {
        autoConfigState: "error",
        lastSyncedAt: { lt: cutoff },
      },
    ],
  };
}
