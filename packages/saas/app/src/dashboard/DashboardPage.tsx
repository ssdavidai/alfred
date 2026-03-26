import { useState, useEffect } from "react";
import {
  useQuery,
  getDashboardData,
} from "wasp/client/operations";
import { Loader2, WifiOff, RefreshCw } from "lucide-react";
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
import TasksSection from "./components/TasksSection";
import ChoresSection from "./components/ChoresSection";
import RemindersSection from "./components/RemindersSection";
import RulesSection from "./components/RulesSection";
import StreamsSection from "./components/StreamsSection";
import IntuitionSection from "./components/IntuitionSection";

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

          {/* Coming Soon sections — 2-column grid */}
          <div className="grid gap-6 lg:grid-cols-2">
            <TasksSection />
            <ChoresSection />
            <RemindersSection />
            <RulesSection />
          </div>
          <StreamsSection />
          <IntuitionSection />

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
