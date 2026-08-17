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
  markStatusActive,
} from "./connectionRepo";

// Per-tick concurrency cap. We don't want to flood any one tenant with
// parallel auto-config calls (each spawns docker execs against temporal),
// but cross-tenant concurrency is fine — different VPSes.
const DEFAULT_CONCURRENCY = 4;

// Single-VM: there is no fleet, no per-user Hetzner instance. The auto-config
// reconciler always hits the one local ctrl-api. This sentinel keeps the
// `fetchAutoConfig` seam (and its unit tests) signature-stable; the value is
// not consulted any more.
export type PendingRowInstance = Record<string, never>;

export interface PendingRow {
  id: string;
  userId: string;
  connectionId: string;
  toolkit: string;
  /**
   * The local mirror of Composio's connection status. Historically the
   * reconciler only looked at rows whose status was already `ACTIVE`, but
   * the inbound webhook can silently fail to flip the row from `INITIATED`
   * (see the client-tenant incident, 2026-05-27 — Gmail sat at
   * INITIATED for 36 minutes while Composio reported ACTIVE). The
   * reconciler now picks up `INITIATED` rows too and resolves their
   * status from Composio's API as ground truth.
   */
  status: string;
  autoConfigState: string;
  lastSyncedAt: Date;
  user: {
    id: string;
  };
}

/**
 * Subset of the Composio `GET /api/v3/connected_accounts/{id}` response
 * the reconciler needs. We only consume `status`; keeping the shape narrow
 * makes the test stub trivial. `null` means "Composio replied with 404 or
 * a transport error" — the reconciler treats those the same as "not yet
 * ACTIVE" and lets the next tick try again.
 */
export interface ComposioConnectionSnapshot {
  status: string;
}

export interface ReconcileDeps {
  delegate: any; // ComposioConnection prisma delegate (or test fake)
  fetchAutoConfig: (
    instance: PendingRowInstance,
    connectionId: string,
  ) => Promise<any>;
  /**
   * Fetch the live connection state from Composio. Only called for rows
   * whose local status is `INITIATED` — the common ACTIVE case stays at
   * one Composio fetch per tick (the auto-config call itself). Return
   * `null` if Composio rejects the request or the network call fails; the
   * reconciler will skip the row and retry on the next tick.
   */
  fetchComposioConnection: (
    connectionId: string,
  ) => Promise<ComposioConnectionSnapshot | null>;
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

  // ───────────────────────────────────────────────────────────────────────
  // INITIATED safety net.
  //
  // The inbound Composio webhook is supposed to flip the local row from
  // INITIATED → ACTIVE the moment OAuth completes. When it doesn't (handler
  // missing, request lost, header-validation throw, …) the row stays at
  // INITIATED forever and the principal sees "still connecting…" while
  // Composio shows the account as live.
  //
  // For rows the SaaS still has at INITIATED we ask Composio directly: if
  // their API reports ACTIVE we flip the local row and continue with
  // auto-config exactly as we would have if the webhook had fired. For
  // anything else (still INITIATED, FAILED, EXPIRED, …) we leave the row
  // alone and let the next tick try again. We do not mark `error`: the
  // failure is on Composio's side, not the tenant's.
  // ───────────────────────────────────────────────────────────────────────
  if (row.status === "INITIATED") {
    let snapshot: ComposioConnectionSnapshot | null;
    try {
      snapshot = await deps.fetchComposioConnection(row.connectionId);
    } catch (err: any) {
      console.info(
        `[reconcileComposioAutoConfig] composio-status fetch failed for ${row.toolkit}/${row.connectionId} (will retry next tick): ${err?.message ?? err}`,
      );
      return { outcome: "skipped" };
    }
    if (!snapshot) {
      console.info(
        `[reconcileComposioAutoConfig] composio reports no row for ${row.toolkit}/${row.connectionId} (404 or transport error) — will retry next tick`,
      );
      return { outcome: "skipped" };
    }
    if (snapshot.status !== "ACTIVE") {
      console.info(
        `[reconcileComposioAutoConfig] ${row.toolkit}/${row.connectionId} still ${snapshot.status} on Composio's side — leaving local row at INITIATED`,
      );
      return { outcome: "skipped" };
    }
    // Composio's truth says ACTIVE. Flip the local row, then fall through
    // to the existing auto-config path.
    try {
      await markStatusActive(deps.delegate, row.userId, row.connectionId);
      console.info(
        `[reconcileComposioAutoConfig] lifted ${row.toolkit}/${row.connectionId}: INITIATED → ACTIVE per Composio API`,
      );
    } catch (err: any) {
      console.error(
        `[reconcileComposioAutoConfig] markStatusActive failed for ${row.toolkit}/${row.connectionId}: ${err?.message ?? err}`,
      );
      // Treat as a skip — next tick will retry the lift.
      return { outcome: "skipped" };
    }
  }

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
 * - `status in {ACTIVE, INITIATED}` — ACTIVE is the common case; INITIATED
 *   covers the client-tenant incident where the inbound webhook failed
 *   to flip the row and Composio's API was the only source of truth.
 *   `reconcileOne` consults Composio for INITIATED rows and lifts them
 *   in-band before continuing to auto-config.
 * - `autoConfigState in {pending, error}` — `configured` rows are done,
 *   `running` rows are mid-flight from another caller.
 * - `error` rows additionally must be older than `errorBackoffMs` so we
 *   don't hammer a tenant whose ctrl-api is down.
 */
export function buildPendingRowsWhere(now: Date, errorBackoffMs: number): any {
  const cutoff = new Date(now.getTime() - errorBackoffMs);
  return {
    status: { in: ["ACTIVE", "INITIATED"] },
    OR: [
      { autoConfigState: "pending" },
      {
        autoConfigState: "error",
        lastSyncedAt: { lt: cutoff },
      },
    ],
  };
}
