import { useQuery, getActivityFeed } from "wasp/client/operations";
import { Card, CardContent, CardTitle } from "../../client/components/ui/card";
import { BarChart3 } from "lucide-react";
import { AGENT_CONFIG } from "../constants";

interface ActivityItem {
  timestamp: string;
  tool: string;
  level: string;
  event: string;
  message: string;
}

/** Build per-worker activity counts bucketed into 6 time slots over the last hour. */
function buildActivityBuckets(items: ActivityItem[]) {
  const now = Date.now();
  const bucketCount = 6;
  const bucketDuration = 10 * 60 * 1000; // 10 min per bucket

  const workerBuckets: Record<string, number[]> = {};
  for (const agent of AGENT_CONFIG) {
    workerBuckets[agent.key] = new Array(bucketCount).fill(0);
  }

  for (const item of items) {
    const key = item.tool;
    if (!workerBuckets[key]) continue;
    const ts = new Date(
      item.timestamp.endsWith("Z") ? item.timestamp : item.timestamp + "Z",
    ).getTime();
    const age = now - ts;
    const bucketIndex = Math.floor(age / bucketDuration);
    if (bucketIndex >= 0 && bucketIndex < bucketCount) {
      workerBuckets[key][bucketCount - 1 - bucketIndex]++;
    }
  }

  return workerBuckets;
}

function formatLastActive(items: ActivityItem[], workerKey: string): string {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].tool === workerKey) {
      try {
        const ts = items[i].timestamp;
        const d = new Date(ts.endsWith("Z") ? ts : ts + "Z");
        const diff = Date.now() - d.getTime();
        if (diff < 60_000) return "Just now";
        if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
        if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
        return d.toLocaleDateString();
      } catch {
        return "—";
      }
    }
  }
  return "—";
}

/** Get milliseconds since last activity for a worker. Returns Infinity if none. */
function getLastActiveMs(items: ActivityItem[], workerKey: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].tool === workerKey) {
      try {
        const ts = items[i].timestamp;
        const d = new Date(ts.endsWith("Z") ? ts : ts + "Z");
        return Date.now() - d.getTime();
      } catch {
        return Infinity;
      }
    }
  }
  return Infinity;
}

/** Status dot color based on recency. */
function getStatusColor(lastActiveMs: number): string {
  if (lastActiveMs === Infinity) return "#6b7280"; // gray — never active (idle/fresh)
  if (lastActiveMs < 10 * 60_000) return "#22c55e"; // green — < 10 min (running)
  if (lastActiveMs < 60 * 60_000) return "#f59e0b"; // amber — < 1 hour
  return "#ef4444"; // red — > 1 hour (stopped/error)
}

/** ASCII activity preview: one char per bucket. */
function buildAsciiPreview(values: number[]): string {
  return values
    .map((v) => {
      if (v === 0) return "_";
      if (v <= 2) return "w";
      if (v <= 5) return "W";
      return "~";
    })
    .join("");
}

/** Derive activity level label from total events in last hour. */
function getActivityLevel(total: number): string {
  if (total === 0) return "Idle";
  if (total <= 5) return "Low";
  if (total <= 15) return "Nominal";
  return "High";
}

/** SVG sparkline with filled area below the line. */
function Sparkline({
  values,
  color,
  max,
}: {
  values: number[];
  color: string;
  max: number;
}) {
  const w = 120;
  const h = 28;
  const pad = 1;
  const usableW = w - pad * 2;
  const usableH = h - pad * 2;

  const points = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * usableW;
    const y = pad + usableH - (max > 0 ? (v / max) * usableH : 0);
    return { x, y };
  });

  const linePoints = points.map((p) => `${p.x},${p.y}`).join(" ");

  // Closed polygon for fill area
  const areaPoints = [
    `${points[0].x},${h}`,
    ...points.map((p) => `${p.x},${p.y}`),
    `${points[points.length - 1].x},${h}`,
  ].join(" ");

  const gradientId = `spark-grad-${color.replace("#", "")}`;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="flex-shrink-0"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill={`url(#${gradientId})`} />
      <polyline
        points={linePoints}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Dot on the latest value */}
      <circle
        cx={points[points.length - 1].x}
        cy={points[points.length - 1].y}
        r={2}
        fill={color}
      />
    </svg>
  );
}

export default function WorkerActivityCharts() {
  const { data } = useQuery(getActivityFeed, undefined, {
    refetchInterval: 10_000,
  });

  const items: ActivityItem[] = Array.isArray(data?.items) ? data.items : [];
  const buckets = buildActivityBuckets(items);

  // Find global max for consistent scaling
  const allValues = Object.values(buckets).flat();
  const globalMax = Math.max(...allValues, 1);

  // Count total events per worker
  const totalCounts: Record<string, number> = {};
  for (const agent of AGENT_CONFIG) {
    totalCounts[agent.key] = items.filter(
      (it) => it.tool === agent.key,
    ).length;
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4 flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-gold" />
          <CardTitle className="font-serif text-base font-light text-cream">
            Worker Activity
          </CardTitle>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {AGENT_CONFIG.map((agent) => {
            const values = buckets[agent.key];
            const lastActiveMs = getLastActiveMs(items, agent.key);
            const statusColor = getStatusColor(lastActiveMs);
            const ascii = buildAsciiPreview(values);
            const total = totalCounts[agent.key];
            const level = getActivityLevel(total);

            return (
              <div
                key={agent.key}
                className="rounded-sm border border-gold-dim/20 bg-black/20 px-3 py-3"
              >
                {/* Header: status dot + label + ASCII preview */}
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className="text-[0.5rem]"
                    style={{ color: statusColor }}
                  >
                    ●
                  </span>
                  <span
                    className="font-mono text-[0.6rem] font-medium uppercase tracking-[0.2em]"
                    style={{ color: agent.color }}
                  >
                    {agent.label}
                  </span>
                  <span className="ml-auto font-mono text-[0.6rem] text-muted-foreground/30">
                    {ascii}
                  </span>
                </div>

                {/* Sparkline */}
                <Sparkline
                  values={values}
                  color={agent.color}
                  max={globalMax}
                />

                {/* Status footer */}
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-mono text-[0.55rem] text-muted-foreground/60">
                    {level}
                  </span>
                  <span className="text-muted-foreground/20">·</span>
                  <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                    {total} events
                  </span>
                  <span className="text-muted-foreground/20">·</span>
                  <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                    {formatLastActive(items, agent.key)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
