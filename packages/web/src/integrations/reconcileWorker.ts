/**
 * Composio auto-config reconciler — server-side fallback for the
 * dashboard-side auto-fire effect in IntegrationsPage.tsx.
 *
 * Defect A (fix/composio-auto-config-on-callback-and-stale-schedule):
 *   The Composio OAuth callback redirects the user's browser back to the
 *   IntegrationsPage at `/dashboard/integrations?composio_callback=success`
 *   and the page kicks off `autoConfigIntegration` once it sees the connection
 *   transition to ACTIVE. That flow is fragile — a closed popup, a slow
 *   Composio status race, or the user navigating away mid-OAuth all leave the
 *   ComposioConnection row stuck in `pending` (or `error` after a transient
 *   failure) with the connection LIVE but the tenant having no stream / skill
 *   / Temporal schedule.
 *
 *   Live evidence: raj313 connected Gmail, Calendar, and Drive ~5h before we
 *   noticed; all three sat in `pending` until a manual auto-config sweep.
 *
 *   This job runs on a 1-minute cron (see main.wasp). For every
 *   ComposioConnection where:
 *     - Composio's truth is `status: ACTIVE`, AND
 *     - Our SaaS row is `autoConfigState in ('pending','error')`, AND
 *     - We haven't bounced off this row too recently (backoff for `error` rows),
 *   the reconciler calls the tenant ctrl-api's auto-config endpoint and
 *   applies the result via the same `applyAutoConfigResult` helper used by
 *   `autoConfigIntegration` and `finalizeComposioConnections`. The job is
 *   idempotent — re-running it on a `configured` row is a no-op (filtered
 *   out by the autoConfigState predicate).
 */
import {
  buildPendingRowsWhere,
  reconcileBatch,
  type PendingRow,
  type PendingRowInstance,
} from "./reconcileCore";

// Single-VM: the auto-config reconciler always calls the one local ctrl-api.
const CTRL_API_URL = process.env.CTRL_API_URL ?? "http://ctrl-api:3100";
const CTRL_API_KEY = process.env.AAS_API_KEY ?? "";

// Don't re-fire on rows we just bounced off — Composio's OAuth handshake
// can take seconds to settle into ACTIVE, and a tenant ctrl-api outage
// would have us hammering the failed call every minute. Only rows whose
// last attempt was older than this window get retried.
const ERROR_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes
// Hard upper bound on rows touched per tick — keeps a freshly-onboarded
// tenant with N pending rows from monopolising the job's runtime.
const MAX_ROWS_PER_TICK = 25;
// Per-call timeout. Auto-config can do up to four sequential things on the
// tenant (stream + schedule + skill + tools allow), each backed by a
// docker-exec, so we give it more headroom than the standard 15s tenant
// proxy timeout.
const AUTO_CONFIG_TIMEOUT_MS = 30_000;

export async function reconcileComposioAutoConfigJob(
  _args: unknown,
  context: any,
): Promise<{
  attempted: number;
  configured: number;
  errored: number;
  skipped: number;
}> {
  if (process.env.WASP_DISABLE_JOBS === 'true') {
    console.log('[WASP_DISABLE_JOBS] skipping reconcileComposioAutoConfigJob');
    return { attempted: 0, configured: 0, errored: 0, skipped: 0 };
  }
  // Pull ACTIVE rows that need auto-config. Errored rows wait out the
  // ERROR_BACKOFF_MS window via lastSyncedAt; pending rows go through
  // immediately.
  const rows: PendingRow[] = await context.entities.ComposioConnection.findMany({
    where: buildPendingRowsWhere(new Date(), ERROR_BACKOFF_MS),
    include: {
      user: { select: { id: true } },
    },
    orderBy: { lastSyncedAt: "asc" },
    take: MAX_ROWS_PER_TICK,
  });

  if (rows.length === 0) {
    return { attempted: 0, configured: 0, errored: 0, skipped: 0 };
  }

  return reconcileBatch(rows, {
    delegate: context.entities.ComposioConnection,
    fetchAutoConfig: callTenantAutoConfig,
  });
}

/**
 * Call the local ctrl-api's `/auto-config` endpoint directly. We do NOT use
 * `proxyToTenant` here because that helper depends on Wasp's HttpError
 * machinery, which the PgBoss worker context doesn't carry. The shape we send
 * mirrors what `autoConfigIntegration` produces in operations.ts.
 */
async function callTenantAutoConfig(
  _instance: PendingRowInstance,
  connectionId: string,
): Promise<any> {
  if (!CTRL_API_KEY) {
    throw new Error("AAS_API_KEY is not configured — cannot reach ctrl-api");
  }
  const url = `${CTRL_API_URL}/api/v1/integrations/${encodeURIComponent(connectionId)}/auto-config`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTO_CONFIG_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CTRL_API_KEY}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`tenant auto-config returned ${response.status}: ${text.slice(0, 200)}`);
    }
    const ct = response.headers.get("content-type") || "";
    return ct.includes("application/json") ? response.json() : response.text();
  } finally {
    clearTimeout(timeout);
  }
}
