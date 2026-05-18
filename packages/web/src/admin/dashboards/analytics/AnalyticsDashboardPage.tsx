import { useAuth } from "wasp/client/auth";
import { Navigate } from "react-router-dom";
import { useMemo } from "react";
import {
  getDailyStats,
  getAdminSettings,
  updateAdminSetting,
  getStateChanges,
  useQuery,
} from "wasp/client/operations";
import { cn } from "../../../client/utils";
import { Switch } from "../../../client/components/ui/switch";
import { Label } from "../../../client/components/ui/label";
import {
  Card,
  CardContent,
} from "../../../client/components/ui/card";
import DashboardLayout from "../../../dashboard/DashboardLayout";
import RevenueAndProfitChart from "./RevenueAndProfitChart";
import SourcesTable from "./SourcesTable";
import TotalPageViewsCard from "./TotalPageViewsCard";
import TotalPayingUsersCard from "./TotalPayingUsersCard";
import TotalRevenueCard from "./TotalRevenueCard";
import TotalSignupsCard from "./TotalSignupsCard";

const Dashboard = () => {
  const { data: user } = useAuth();
  const { data: stats, isLoading, error } = useQuery(getDailyStats);
  const { data: adminSettings } = useQuery(getAdminSettings);

  const isClosedBeta = adminSettings?.closed_beta === "true";

  const handleBetaToggle = async (checked: boolean) => {
    try {
      await updateAdminSetting({
        key: "closed_beta",
        value: checked ? "true" : "false",
      });
    } catch (err) {
      console.error("Failed to update beta gate:", err);
    }
  };

  if (!user) return null;
  if (!user.isAdmin) return <Navigate to="/" replace />;

  // M7 #869 — admin tokens pass. Paper surface, Playfair headings, brass
  // accents on key states. No IA / logic changes; the existing Card / Switch
  // primitives have already been re-skinned in M0 (#845).
  return (
    <DashboardLayout>
      {error ? (
        <div className="flex h-full items-center justify-center paper">
          <div className="border border-rule p-8">
            <p className="font-display text-2xl" style={{ color: "var(--brass)" }}>
              Error
            </p>
            <p
              className="font-body italic mt-2 text-sm"
              style={{ color: "var(--marginalia)" }}
            >
              {error.message || "Something went wrong while fetching stats."}
            </p>
          </div>
        </div>
      ) : (
        <div className="relative paper">
          <div
            className={cn({
              "opacity-25": !stats,
            })}
          >
            <div className="mb-6">
              <Card>
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <div
                      className={cn("h-2 w-2 rounded-full")}
                      style={{
                        background: isClosedBeta
                          ? "var(--brass)"
                          : "color-mix(in oklab, var(--brass) 60%, var(--ink))",
                      }}
                    />
                    <Label
                      className="font-mono text-xs font-light uppercase tracking-[0.35em]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      Closed Beta Gate
                    </Label>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className="font-mono text-[0.62rem] font-light uppercase tracking-[0.35em]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      {isClosedBeta ? "ON" : "OFF"}
                    </span>
                    <Switch
                      checked={isClosedBeta}
                      onCheckedChange={handleBetaToggle}
                    />
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="2xl:gap-7.5 grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6 xl:grid-cols-4">
              <TotalPageViewsCard
                totalPageViews={stats?.dailyStats?.totalViews}
                prevDayViewsChangePercent={
                  stats?.dailyStats?.prevDayViewsChangePercent
                }
              />
              <TotalRevenueCard
                dailyStats={stats?.dailyStats}
                weeklyStats={stats?.weeklyStats}
                isLoading={isLoading}
              />
              <TotalPayingUsersCard
                dailyStats={stats?.dailyStats}
                isLoading={isLoading}
              />
              <TotalSignupsCard
                dailyStats={stats?.dailyStats}
                isLoading={isLoading}
              />
            </div>

            <div className="2xl:mt-7.5 2xl:gap-7.5 mt-4 grid grid-cols-12 gap-4 md:mt-6 md:gap-6">
              <RevenueAndProfitChart
                weeklyStats={stats?.weeklyStats}
                isLoading={isLoading}
              />

              <div className="col-span-12 xl:col-span-8">
                <SourcesTable sources={stats?.dailyStats?.sources} />
              </div>
            </div>

            {/* STATE-MUTATION Phase I (#897 §11.3) — observability panels. */}
            <StateMutationPanels />
          </div>

          {!stats && !isLoading && (
            <div
              className="absolute inset-0 flex items-start justify-center"
              style={{ background: "color-mix(in oklab, var(--paper) 50%, transparent)" }}
            >
              <div className="border border-rule p-8 paper">
                <p className="font-display text-2xl">No analytics data yet.</p>
                <p
                  className="font-body italic mt-2 max-w-md text-sm"
                  style={{ color: "var(--marginalia)" }}
                >
                  Plausible tracking has been enabled. Data will appear here
                  once the hourly stats job has collected page views from your
                  Plausible instance.
                </p>
              </div>
            </div>
          )}

          {isLoading && !stats && (
            <div
              className="absolute inset-0 flex items-start justify-center"
              style={{ background: "color-mix(in oklab, var(--paper) 50%, transparent)" }}
            >
              <div className="border border-rule p-8 paper">
                <p className="font-display italic text-2xl">Composing…</p>
              </div>
            </div>
          )}
        </div>
      )}
    </DashboardLayout>
  );
};

// ---------------------------------------------------------------------------
// STATE-MUTATION Phase I (#897 §11.3) — three observability panels.
//
// Panel 1: state_changes_per_day_by_source — 30-day sparkline per source.
//   Derived live from getStateChanges({since: 30d-ago, limit: 200}).
//
// Panel 2: state_change_409_retry_rate — % of v2 calls that hit a 409.
//   Honest placeholder: this requires a ctrl-api counter (not yet built);
//   surfaced with a "Coming soon" note rather than a fake number.
//
// Panel 3: pending_confirmation_count_by_source — count of audit records
//   whose target frontmatter still carries `pending_confirmation: true`,
//   grouped by source. Computing this live walks every matter/task in the
//   vault and re-reads frontmatter — too expensive for an admin tick.
//   Surfaced with a "TODO: build aggregator" placeholder.
// ---------------------------------------------------------------------------

function StateMutationPanels() {
  // Look back 30 days. The ctrl-api listing endpoint takes `since`, so we
  // push the filter to the server rather than hauling all entries to the
  // client. limit=200 cap matches the endpoint's max.
  const since = useMemo(
    () =>
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    [],
  );
  const { data: stateData, isLoading: stateLoading } = useQuery(
    getStateChanges,
    { since, limit: 200 },
    { refetchInterval: 5 * 60_000, staleTime: 60_000, retry: false },
  );
  const entries: Array<{ source: string; when: string }> = Array.isArray(
    (stateData as any)?.entries,
  )
    ? (stateData as any).entries
    : [];
  // entries from listing endpoint are capped at 200; total carries the full
  // count so we can warn the operator if we're under-sampling.
  const total = Number((stateData as any)?.total ?? entries.length);

  return (
    <div className="mt-6 md:mt-8">
      <h2
        className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
        style={{ color: "var(--marginalia)" }}
      >
        State-mutation observability
      </h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:gap-6">
        <StateChangesPerDayPanel
          entries={entries}
          loading={stateLoading}
          undersampled={total > entries.length}
          totalCount={total}
        />
        <RetryRatePanel />
        <PendingConfirmationPanel />
      </div>
    </div>
  );
}

function StateChangesPerDayPanel({
  entries,
  loading,
  undersampled,
  totalCount,
}: {
  entries: Array<{ source: string; when: string }>;
  loading: boolean;
  undersampled: boolean;
  totalCount: number;
}) {
  const { sources, perDay, max } = useMemo(() => {
    // Build a sorted-day axis of the last 30 days.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const days: string[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const dayIdx = new Map(days.map((d, i) => [d, i]));
    const perSource = new Map<string, number[]>();
    for (const e of entries) {
      if (!e.source || !e.when) continue;
      const k = e.when.slice(0, 10);
      const i = dayIdx.get(k);
      if (i == null) continue;
      let row = perSource.get(e.source);
      if (!row) {
        row = new Array(days.length).fill(0);
        perSource.set(e.source, row);
      }
      row[i] += 1;
    }
    const sources = [...perSource.entries()]
      .map(([source, counts]) => ({
        source,
        counts,
        total: counts.reduce((acc, v) => acc + v, 0),
      }))
      .sort((a, b) => b.total - a.total);
    const max = sources.reduce(
      (acc, s) => Math.max(acc, ...s.counts),
      1,
    );
    return { sources, perDay: days, max };
  }, [entries]);
  void perDay;

  return (
    <Card>
      <CardContent className="p-4">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em] mb-2"
          style={{ color: "var(--marginalia)" }}
        >
          State changes / day · by source
        </div>
        <div
          className="font-mono text-[10px]"
          style={{ color: "var(--marginalia)" }}
        >
          30-day window · {totalCount} total{undersampled ? " (showing 200)" : ""}
        </div>
        {loading && sources.length === 0 ? (
          <p className="mt-4 font-body italic text-[14px]" style={{ color: "var(--marginalia)" }}>
            Reading state changes…
          </p>
        ) : sources.length === 0 ? (
          <p
            className="mt-4 font-body italic text-[14px]"
            style={{ color: "var(--marginalia)" }}
          >
            No state-change writers seen in the last 30 days. If you expect
            otherwise, a writer may be broken.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {sources.slice(0, 8).map((s) => (
              <li
                key={s.source}
                className="grid grid-cols-[1fr_120px_36px] gap-3 items-center"
              >
                <code
                  className="font-mono text-[11px] truncate"
                  style={{ color: "var(--ink)" }}
                  title={s.source}
                >
                  {s.source}
                </code>
                <Sparkline counts={s.counts} max={max} />
                <span
                  className="font-mono text-[11px] text-right"
                  style={{ color: "var(--brass)" }}
                >
                  {s.total}
                </span>
              </li>
            ))}
            {sources.length > 8 && (
              <li
                className="font-mono text-[10px] uppercase tracking-[0.22em] pt-1"
                style={{ color: "var(--marginalia)" }}
              >
                + {sources.length - 8} more sources
              </li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Sparkline({ counts, max }: { counts: number[]; max: number }) {
  const w = 120;
  const h = 28;
  const step = w / Math.max(1, counts.length);
  const bars = counts.map((c, i) => {
    const x = i * step;
    const bh = max > 0 ? (c / max) * h : 0;
    const y = h - bh;
    return (
      <rect
        key={i}
        x={x}
        y={y}
        width={Math.max(1, step - 1)}
        height={Math.max(bh, c > 0 ? 1 : 0)}
        fill={c > 0 ? "var(--brass)" : "transparent"}
      />
    );
  });
  return (
    <svg
      width={w}
      height={h}
      role="img"
      aria-label={`sparkline ${counts.length} days, max ${max}`}
    >
      {bars}
    </svg>
  );
}

function RetryRatePanel() {
  return (
    <Card>
      <CardContent className="p-4">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em] mb-2"
          style={{ color: "var(--marginalia)" }}
        >
          409 retry rate · 24h
        </div>
        <p
          className="font-display italic text-[22px] mt-2"
          style={{ color: "var(--marginalia)" }}
        >
          Coming soon
        </p>
        <p
          className="font-body text-[13px] mt-3 leading-[1.5]"
          style={{ color: "var(--marginalia)" }}
        >
          Requires a ctrl-api 409 counter on
          <code className="font-mono mx-1" style={{ color: "var(--brass)" }}>
            POST /api/v1/state-changes
          </code>
          and a `state_mutator` retry tally on the alfred-learn side.
          Tracked as a follow-up to Phase I (#897).
        </p>
      </CardContent>
    </Card>
  );
}

function PendingConfirmationPanel() {
  return (
    <Card>
      <CardContent className="p-4">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em] mb-2"
          style={{ color: "var(--marginalia)" }}
        >
          Pending confirmations · by source
        </div>
        <p
          className="font-display italic text-[22px] mt-2"
          style={{ color: "var(--marginalia)" }}
        >
          TODO: build aggregator
        </p>
        <p
          className="font-body text-[13px] mt-3 leading-[1.5]"
          style={{ color: "var(--marginalia)" }}
        >
          Counting open
          <code className="font-mono mx-1" style={{ color: "var(--brass)" }}>
            pending_confirmation: true
          </code>
          targets per source requires walking every matter/task frontmatter —
          too expensive for an admin tick. Needs a ctrl-api aggregator that
          maintains the index on write. Tracked as a follow-up to Phase I.
        </p>
      </CardContent>
    </Card>
  );
}

export default Dashboard;
