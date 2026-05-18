// STORE-X-3: per-tenant storage observability for the Storage Architecture
// migration epic (#898). Renders one card per running tenant with vault
// file count, state.db size, index drift, and top-5 endpoint p95 latencies.
// Thresholds drive red/amber colour cues — there is no external alerting;
// the admin loading this page IS the alert.

import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useQuery, getStorageMetrics } from "wasp/client/operations";
import { useAuth } from "wasp/client/auth";
import DashboardLayout from "../dashboard/DashboardLayout";

// --- Thresholds --------------------------------------------------------------
//
// These match the targets in STORE-X-3's acceptance criteria. Anything red
// is a "look at this now" signal; amber is "watch this".

const LATENCY_P95_RED_MS = 500;
const INDEX_DRIFT_YELLOW = 10;
const INDEX_DRIFT_RED = 100;
const STATE_DB_RED_BYTES = 500 * 1024 * 1024;

type Severity = "ok" | "warn" | "alert";

function driftSeverity(drift: number): Severity {
  const abs = Math.abs(drift);
  if (abs >= INDEX_DRIFT_RED) return "alert";
  if (abs >= INDEX_DRIFT_YELLOW) return "warn";
  return "ok";
}

function stateDbSeverity(bytes: number): Severity {
  if (bytes >= STATE_DB_RED_BYTES) return "alert";
  return "ok";
}

function latencySeverity(p95: number): Severity {
  if (p95 >= LATENCY_P95_RED_MS) return "alert";
  return "ok";
}

const severityClass: Record<Severity, string> = {
  ok: "text-emerald-300",
  warn: "text-amber-300",
  alert: "text-red-400",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// --- Types -------------------------------------------------------------------

interface EndpointLatency {
  count: number;
  sum_ms: number;
  p50: number;
  p95: number;
  p99: number;
}

interface TenantMetrics {
  vault: {
    files_on_disk: number;
    index_rows: number;
    index_drift: number;
    by_type: Record<string, number>;
    by_type_disk: Record<string, number>;
  };
  state_db: {
    path: string;
    size_bytes: number;
    tables: Record<string, number>;
    migrations_applied: number[];
  };
  request_latency: Record<string, EndpointLatency>;
  collected_at: string;
}

interface TenantPayload {
  tenantId: string;
  tenantName: string;
  tenantEmail: string | null;
  reachable: boolean;
  reason: string | null;
  metrics: TenantMetrics | null;
}

// --- Components --------------------------------------------------------------

function ThresholdBanner({ tenants }: { tenants: TenantPayload[] }) {
  const breaches: string[] = [];
  for (const t of tenants) {
    if (!t.metrics) continue;
    if (Math.abs(t.metrics.vault.index_drift) >= INDEX_DRIFT_RED) {
      breaches.push(`${t.tenantName}: vault index drift ${t.metrics.vault.index_drift}`);
    }
    if (t.metrics.state_db.size_bytes >= STATE_DB_RED_BYTES) {
      breaches.push(`${t.tenantName}: state.db ${formatBytes(t.metrics.state_db.size_bytes)}`);
    }
    for (const [endpoint, h] of Object.entries(t.metrics.request_latency)) {
      if (h.p95 >= LATENCY_P95_RED_MS) {
        breaches.push(`${t.tenantName}: ${endpoint} p95 ${h.p95}ms`);
      }
    }
  }
  if (breaches.length === 0) return null;
  return (
    <div
      className="mb-6 border p-4"
      style={{ borderColor: "#dc2626", background: "rgba(127,29,29,0.15)" }}
    >
      <div
        className="font-mono text-[10px] uppercase tracking-[0.28em] mb-2"
        style={{ color: "#fca5a5" }}
      >
        Threshold breaches
      </div>
      <ul className="font-body text-sm text-red-200 space-y-1">
        {breaches.map((b, i) => (
          <li key={i}>· {b}</li>
        ))}
      </ul>
    </div>
  );
}

function TenantCard({ tenant }: { tenant: TenantPayload }) {
  const [showDrift, setShowDrift] = useState(false);

  if (!tenant.reachable || !tenant.metrics) {
    return (
      <div className="border border-rule p-4" style={{ borderColor: "var(--rule)" }}>
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em] mb-2"
          style={{ color: "var(--brass)" }}
        >
          {tenant.tenantName}
        </div>
        <p className="font-body italic text-sm" style={{ color: "var(--marginalia)" }}>
          unreachable — {tenant.reason ?? "no detail"}
        </p>
      </div>
    );
  }

  const m = tenant.metrics;
  const drift = m.vault.index_drift;
  const driftSev = driftSeverity(drift);
  const dbSev = stateDbSeverity(m.state_db.size_bytes);

  // Top 5 endpoints by p95 latency, descending.
  const topEndpoints = Object.entries(m.request_latency)
    .sort((a, b) => b[1].p95 - a[1].p95)
    .slice(0, 5);

  return (
    <div className="border border-rule p-4" style={{ borderColor: "var(--rule)" }}>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--brass)" }}
          >
            {tenant.tenantName}
          </div>
          {tenant.tenantEmail && (
            <div className="font-body text-xs" style={{ color: "var(--marginalia)" }}>
              {tenant.tenantEmail}
            </div>
          )}
        </div>
      </div>

      <dl className="space-y-2 font-body text-sm">
        <div className="flex justify-between">
          <dt style={{ color: "var(--marginalia)" }}>vault files</dt>
          <dd className="font-mono">{m.vault.files_on_disk.toLocaleString()}</dd>
        </div>
        <div className="flex justify-between">
          <dt style={{ color: "var(--marginalia)" }}>index rows</dt>
          <dd className="font-mono">{m.vault.index_rows.toLocaleString()}</dd>
        </div>
        <div className="flex justify-between">
          <dt style={{ color: "var(--marginalia)" }}>index drift</dt>
          <dd className={`font-mono ${severityClass[driftSev]}`}>
            {drift > 0 ? "+" : ""}
            {drift.toLocaleString()}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt style={{ color: "var(--marginalia)" }}>state.db size</dt>
          <dd className={`font-mono ${severityClass[dbSev]}`}>
            {formatBytes(m.state_db.size_bytes)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt style={{ color: "var(--marginalia)" }}>migrations</dt>
          <dd className="font-mono">{m.state_db.migrations_applied.join(", ") || "none"}</dd>
        </div>
      </dl>

      <div className="mt-4">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
          style={{ color: "var(--marginalia)" }}
        >
          top endpoints (p95 ms)
        </div>
        {topEndpoints.length === 0 ? (
          <p className="font-body italic text-xs" style={{ color: "var(--marginalia)" }}>
            no traffic recorded yet
          </p>
        ) : (
          <ul className="font-mono text-xs space-y-1">
            {topEndpoints.map(([endpoint, h]) => (
              <li key={endpoint} className="flex justify-between gap-3">
                <span className="truncate" title={endpoint}>
                  {endpoint}
                </span>
                <span className={severityClass[latencySeverity(h.p95)]}>
                  {h.p95}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowDrift((v) => !v)}
        className="mt-4 font-mono text-[10px] uppercase tracking-[0.22em] border border-rule px-3 py-1"
        style={{ color: "var(--brass)" }}
      >
        {showDrift ? "Hide" : "Show"} drift detail
      </button>
      {showDrift && (
        <div className="mt-3">
          <table className="w-full font-mono text-xs">
            <thead>
              <tr style={{ color: "var(--marginalia)" }}>
                <th className="text-left py-1">type</th>
                <th className="text-right py-1">disk</th>
                <th className="text-right py-1">index</th>
                <th className="text-right py-1">drift</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(
                new Set([
                  ...Object.keys(m.vault.by_type_disk),
                  ...Object.keys(m.vault.by_type),
                ]),
              )
                .sort()
                .map((type) => {
                  const disk = m.vault.by_type_disk[type] ?? 0;
                  const idx = m.vault.by_type[type] ?? 0;
                  const d = disk - idx;
                  return (
                    <tr key={type}>
                      <td className="py-1">{type}</td>
                      <td className="text-right py-1">{disk.toLocaleString()}</td>
                      <td className="text-right py-1">{idx.toLocaleString()}</td>
                      <td className={`text-right py-1 ${severityClass[driftSeverity(d)]}`}>
                        {d > 0 ? "+" : ""}
                        {d}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function StorageDashboard() {
  const { data: user } = useAuth();
  const { data, isLoading, error, refetch } = useQuery(getStorageMetrics, undefined, {
    // Poll every 30s — matches the SaaS-side cache TTL.
    refetchInterval: 30_000,
  });

  if (!user) return null;
  if (!user.isAdmin) return <Navigate to="/" replace />;

  const tenants: TenantPayload[] = data?.tenants ?? [];

  return (
    <DashboardLayout>
      <div className="p-6 paper">
        <div className="mb-6 flex items-baseline justify-between">
          <div>
            <div
              className="font-mono text-[10px] uppercase tracking-[0.28em] mb-2"
              style={{ color: "var(--brass)" }}
            >
              Admin · Storage
            </div>
            <h1 className="font-display text-5xl tracking-tight">
              The pantry inventory.
            </h1>
            {data?.collected_at && (
              <div
                className="font-mono text-[10px] mt-1"
                style={{ color: "var(--marginalia)" }}
              >
                collected at {new Date(data.collected_at).toLocaleTimeString()}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="font-mono text-[10px] uppercase tracking-[0.22em] border border-rule px-3 py-2"
            style={{ color: "var(--brass)" }}
          >
            Refresh
          </button>
        </div>

        {isLoading && (
          <p
            className="font-body italic"
            style={{ color: "var(--marginalia)" }}
          >
            Counting the silver…
          </p>
        )}
        {error && (
          <div className="border border-rule p-4 mb-6" style={{ borderColor: "var(--brass)" }}>
            <p className="font-body" style={{ color: "var(--brass)" }}>
              {(error as Error).message}
            </p>
          </div>
        )}

        <ThresholdBanner tenants={tenants} />

        {tenants.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {tenants.map((t) => (
              <TenantCard key={t.tenantId} tenant={t} />
            ))}
          </div>
        )}

        {tenants.length === 0 && !isLoading && (
          <p className="font-body italic" style={{ color: "var(--marginalia)" }}>
            No tenants to inspect.
          </p>
        )}
      </div>
    </DashboardLayout>
  );
}
