import { useState, useEffect } from "react";
import {
  useQuery,
  getDashboardData,
  getIntuitionStatus,
  getPendingApprovals,
  approveAction,
  rejectAction,
} from "wasp/client/operations";
import { Loader2, WifiOff, RefreshCw, BookOpen, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { Link } from "react-router-dom";
import DashboardLayout from "./DashboardLayout";
import { Card, CardContent, CardTitle } from "../client/components/ui/card";
import { Switch } from "../client/components/ui/switch";
import { Button } from "../client/components/ui/button";
import TopBar from "./components/TopBar";
import DevicesPanel from "./components/DevicesPanel";
import VaultGraph from "./components/VaultGraph";
import VaultCompositionChart from "./components/VaultCompositionChart";
import ActivityFeed from "./components/ActivityFeed";
import WorkerActivityCharts from "./components/WorkerActivityCharts";
import FirstBrief from "./components/FirstBrief";

const DASHBOARD_CACHE_KEY = "alfred:dashboard:lastKnown";

function loadDashboardCache(): { data: any; cachedAt: number } | null {
  try {
    const raw = localStorage.getItem(DASHBOARD_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveDashboardCache(data: any): void {
  try {
    localStorage.setItem(
      DASHBOARD_CACHE_KEY,
      JSON.stringify({ data, cachedAt: Date.now() }),
    );
  } catch {}
}

export default function DashboardPage() {
  const [graphVisible, setGraphVisible] = useState(true);
  const [activePanel, setActivePanel] = useState<string | null>(null);
  const [persistedCache, setPersistedCache] = useState<{ data: any; cachedAt: number } | null>(
    () => loadDashboardCache(),
  );

  // Always poll stats at 30s
  const { data, isLoading, error, refetch } = useQuery(getDashboardData, undefined, {
    refetchInterval: 30_000,
  });

  // Persist last good data to localStorage
  useEffect(() => {
    if (data) {
      const cache = { data, cachedAt: Date.now() };
      setPersistedCache(cache);
      saveDashboardCache(data);
    }
  }, [data]);

  // displayData: live data, or stale from React Query (refetch failure), or localStorage cache
  const displayData = data || (error && persistedCache ? persistedCache.data : null);
  const isStaleBecauseCached = !data && !!error && !!persistedCache;
  const isStaleBecauseRefetchFailed = !!data && !!error;
  const showStaleBanner = isStaleBecauseRefetchFailed || isStaleBecauseCached;
  const staleCachedAt = isStaleBecauseCached ? persistedCache!.cachedAt : null;

  // Fetch learning status for daily digest (silently — don't block dashboard)
  const { data: learningStatus } = useQuery(getIntuitionStatus, undefined, {
    refetchInterval: 60_000,
    retry: false,
  });
  const lastDigest = learningStatus?.lastDigest ?? null;

  // Containers from dashboard data
  const containers: any[] | null = displayData?.containers ?? null;
  const showInitialLoadingState = isLoading && !displayData;

  return (
    <DashboardLayout>
      {/* Header row */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-serif text-2xl font-light text-cream">
          Command Center
        </h1>
      </div>

      {showStaleBanner && (
        <div className="mb-4 flex items-center gap-3 rounded-sm border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <WifiOff className="h-4 w-4 flex-shrink-0 text-amber-500" />
          <p className="flex-1 font-sans text-sm font-light text-amber-400">
            Tenant unreachable —{" "}
            {staleCachedAt
              ? `showing state from ${new Date(staleCachedAt).toLocaleString()}`
              : "showing last known state"}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isLoading}
          >
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
            Retry
          </Button>
        </div>
      )}

      {error && !displayData && (
        <div className="rounded-sm border border-destructive/30 bg-destructive/10 p-4 text-destructive">
          <p className="font-sans text-sm font-light">
            Tenant unreachable — try again or contact support.
          </p>
        </div>
      )}

      {showInitialLoadingState && (
        <div className="flex items-center gap-3 rounded-sm border border-gold-dim/20 bg-black/20 px-4 py-3 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-gold" />
          <p className="font-mono text-xs uppercase tracking-[0.2em]">
            Loading dashboard...
          </p>
        </div>
      )}

      {displayData && (
        <div className="space-y-6">
          {/* TopBar — replaces StatCards */}
          <TopBar
            data={displayData}
            containers={containers}
            activePanel={activePanel}
            onPanelToggle={setActivePanel}
          />

          {/* Devices panel — expandable below TopBar */}
          {activePanel === "devices" && <DevicesPanel />}

          {/* Pending Approvals — sensitive actions awaiting user permission */}
          <PendingApprovalsBanner />

          {/* First Brief — personalized onboarding summary */}
          <FirstBrief />

          {/* Daily Digest */}
          <Card>
            <CardContent className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-gold" />
                <span className="font-serif text-base font-light text-cream">Daily Digest</span>
              </div>
              {lastDigest ? (
                <div className="space-y-2">
                  <p className="font-sans text-sm font-light leading-relaxed text-cream/80">
                    {lastDigest.summary}
                  </p>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[0.6rem] text-muted-foreground/50">
                      {lastDigest.timestamp
                        ? new Date(lastDigest.timestamp).toLocaleString()
                        : ""}
                    </span>
                    {lastDigest.path && (
                      <Link
                        to={`/dashboard/vault/${encodeURIComponent(lastDigest.path)}`}
                        className="font-mono text-[0.6rem] text-gold/70 transition-colors hover:text-gold"
                      >
                        View full digest
                      </Link>
                    )}
                  </div>
                </div>
              ) : (
                <p className="py-2 font-mono text-xs text-muted-foreground/50">
                  No digest yet. Alfred will generate one after observing your daily activity.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Worker Activity Charts */}
          <WorkerActivityCharts />

          {/* Knowledge Graph — full width */}
          <Card>
            <CardContent className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-serif text-base font-light text-cream">Knowledge Graph</span>
                <label className="flex cursor-pointer items-center gap-2">
                  <span className="font-mono text-[0.6rem] font-light uppercase tracking-[0.2em] text-muted-foreground">
                    Graph
                  </span>
                  <Switch checked={graphVisible} onCheckedChange={setGraphVisible} />
                </label>
              </div>
              {graphVisible ? <VaultGraph /> : null}
            </CardContent>
          </Card>

          {/* Activity Feed — full width */}
          <ActivityFeed />

          {/* Vault Composition (standalone at bottom) */}
          {displayData.vault?.types &&
            Object.keys(displayData.vault.types).length > 0 && (
              <Card className="h-full">
                <CardContent className="p-6">
                  <CardTitle className="mb-4 font-serif text-base font-light text-cream">
                    Vault Composition
                  </CardTitle>
                  <VaultCompositionChart types={displayData.vault.types} />
                </CardContent>
              </Card>
            )}
        </div>
      )}
    </DashboardLayout>
  );
}

function PendingApprovalsBanner() {
  const { data, refetch } = useQuery(getPendingApprovals, undefined, {
    refetchInterval: 10_000,
    retry: false,
  });

  const [actingOn, setActingOn] = useState<string | null>(null);

  const approvals: any[] = data?.results ?? [];

  if (approvals.length === 0) return null;

  const handleApprove = async (path: string) => {
    setActingOn(path);
    try {
      await approveAction({ path });
      refetch();
    } catch (err: any) {
      console.error("Approval failed:", err);
    } finally {
      setActingOn(null);
    }
  };

  const handleReject = async (path: string) => {
    setActingOn(path);
    try {
      await rejectAction({ path });
      refetch();
    } catch (err: any) {
      console.error("Rejection failed:", err);
    } finally {
      setActingOn(null);
    }
  };

  return (
    <div className="rounded-sm border border-amber-500/40 bg-amber-500/[0.06] p-4">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-400" />
        <span className="font-serif text-base font-medium text-amber-400">
          Pending Approvals
        </span>
        <span className="ml-auto rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 font-mono text-[0.6rem] font-medium text-amber-400">
          {approvals.length}
        </span>
      </div>
      <p className="mb-3 font-sans text-xs font-light text-amber-400/70">
        Alfred wants to take the following actions but needs your permission first.
      </p>
      <div className="space-y-2">
        {approvals.map((a: any) => (
          <div
            key={a.path}
            className="flex items-center gap-3 rounded-sm border border-amber-500/20 bg-black/30 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs font-medium text-cream">
                {a.name}
              </p>
              {a.description && (
                <p className="mt-0.5 truncate font-sans text-[0.65rem] font-light text-cream/50">
                  {a.description}
                </p>
              )}
              {a.alfred_instructions && (
                <p className="mt-0.5 truncate font-mono text-[0.6rem] text-gold/60">
                  {a.alfred_instructions}
                </p>
              )}
              {a.created && (
                <span className="mt-1 inline-block font-mono text-[0.55rem] text-muted-foreground/50">
                  {a.created}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleApprove(a.path)}
                disabled={actingOn === a.path}
                className="flex items-center gap-1 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 font-mono text-[0.6rem] uppercase tracking-wider text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
              >
                {actingOn === a.path ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <CheckCircle className="h-3 w-3" />
                )}
                Approve
              </button>
              <button
                type="button"
                onClick={() => handleReject(a.path)}
                disabled={actingOn === a.path}
                className="flex items-center gap-1 rounded-sm border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 font-mono text-[0.6rem] uppercase tracking-wider text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
              >
                {actingOn === a.path ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <XCircle className="h-3 w-3" />
                )}
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
