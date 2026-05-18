// In-process metrics collector for the ctrl-api HTTP layer.
//
// STORE-X-3 (storage-architecture epic #898): we need per-tenant visibility
// into request latency + storage state during the multi-phase migration.
// Prometheus would be overkill — ctrl-api is one Node process per tenant,
// metrics are read by a single SaaS-side admin dashboard, and we have no
// long-term retention requirement (the admin staring at the page IS the
// retention). So: ring buffers in memory, sorted at read time.
//
// Endpoint keys are *route patterns*, not URLs. The router resolves the
// match-pattern via `matchRoute()` in server.ts and passes it here, so
// `/api/v1/vault/list/matter` and `/api/v1/vault/list/event` collapse into
// the single `/api/v1/vault/list/:type` bucket. Otherwise we'd unbounded-
// allocate one Histogram per id and the map would balloon.

const SAMPLE_CAP = 1000;

export interface Histogram {
  count: number;
  sum_ms: number;
  p50: number;
  p95: number;
  p99: number;
}

interface RingBuffer {
  samples: number[]; // ring buffer of last SAMPLE_CAP latencies (ms)
  pos: number;       // next write position
  count: number;     // total observations (monotonic; not capped)
  sum_ms: number;    // monotonic sum (for avg if anyone wants it)
}

const buffers = new Map<string, RingBuffer>();

/** Record one request observation against a route-pattern endpoint key. */
export function recordRequestLatency(endpoint: string, ms: number): void {
  if (!endpoint) return;
  let buf = buffers.get(endpoint);
  if (!buf) {
    buf = { samples: [], pos: 0, count: 0, sum_ms: 0 };
    buffers.set(endpoint, buf);
  }
  // Ring buffer write.
  if (buf.samples.length < SAMPLE_CAP) {
    buf.samples.push(ms);
  } else {
    buf.samples[buf.pos] = ms;
    buf.pos = (buf.pos + 1) % SAMPLE_CAP;
  }
  buf.count += 1;
  buf.sum_ms += ms;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank percentile. Sufficient for ops-level latency observation
  // — we are not building an SLO calculator here.
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[idx]);
}

/** Snapshot of every observed endpoint's latency distribution. */
export function getRequestLatencies(): Record<string, Histogram> {
  const out: Record<string, Histogram> = {};
  for (const [endpoint, buf] of buffers) {
    if (buf.samples.length === 0) continue;
    const sorted = [...buf.samples].sort((a, b) => a - b);
    out[endpoint] = {
      count: buf.count,
      sum_ms: Math.round(buf.sum_ms),
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    };
  }
  return out;
}

/** Test/maintenance helper — wipes the in-memory state. */
export function resetMetrics(): void {
  buffers.clear();
}
