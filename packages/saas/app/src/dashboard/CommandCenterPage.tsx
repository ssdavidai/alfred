import { useState, useEffect } from "react";
import {
  useQuery,
  getDashboardData,
  getIntuitionStatus,
  getPendingApprovals,
  approveAction,
  rejectAction,
} from "wasp/client/operations";
import {
  Loader2,
  WifiOff,
  RefreshCw,
  BookOpen,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Bot,
} from "lucide-react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import DashboardLayout from "./DashboardLayout";
import { Switch } from "../client/components/ui/switch";
import { Button } from "../client/components/ui/button";
import TopBar from "./components/TopBar";
import DevicesPanel from "./components/DevicesPanel";
import VaultGraph from "./components/VaultGraph";
import VaultCompositionChart from "./components/VaultCompositionChart";
import ActivityFeed from "./components/ActivityFeed";
import WorkerActivityCharts from "./components/WorkerActivityCharts";
import FirstBrief from "./components/FirstBrief";
import SpotlightCard from "../components/ui/SpotlightCard";
import { BentoGrid, BentoItem } from "../components/ui/BentoGrid";

// ---------------------------------------------------------------------------
// Cache helpers (shared key with DashboardPage)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// CommandCenterPage — the bento grid stats dashboard
// ---------------------------------------------------------------------------

export default function CommandCenterPage() {
  const [graphVisible, setGraphVisible] = useState(true);
  const [activePanel, setActivePanel] = useState<string | null>(null);
  const [persistedCache, setPersistedCache] = useState<{
    data: any;
    cachedAt: number;
  } | null>(() => loadDashboardCache());

  const { data, isLoading, error, refetch } = useQuery(
    getDashboardData,
    undefined,
    { refetchInterval: 30_000 },
  );

  useEffect(() => {
    if (data) {
      const cache = { data, cachedAt: Date.now() };
      setPersistedCache(cache);
      saveDashboardCache(data);
    }
  }, [data]);

  const displayData =
    data || (error && persistedCache ? persistedCache.data : null);
  const isStaleBecauseCached = !data && !!error && !!persistedCache;
  const isStaleBecauseRefetchFailed = !!data && !!error;
  const showStaleBanner = isStaleBecauseRefetchFailed || isStaleBecauseCached;
  const staleCachedAt = isStaleBecauseCached ? persistedCache!.cachedAt : null;

  const { data: learningStatus } = useQuery(getIntuitionStatus, undefined, {
    refetchInterval: 60_000,
    retry: false,
  });
  const lastDigest = learningStatus?.lastDigest ?? null;

  const containers: any[] | null = displayData?.containers ?? null;
  const showInitialLoadingState = isLoading && !displayData;

  const runningContainers =
    containers?.filter(
      (c: any) => c.State === "running" && c.Service !== "init",
    ).length ?? 0;
  const totalContainers =
    containers?.filter((c: any) => c.Service !== "init").length ?? 0;

  return (
    <DashboardLayout>
      {/* Header row */}
      <div className="mb-6 flex items-center justify-between">
        <motion.h1
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="font-serif text-2xl font-light text-[#F0EDE8]"
        >
          Command Center
        </motion.h1>
      </div>

      {showStaleBanner && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 backdrop-blur-sm">
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
            <RefreshCw
              className={`mr-2 h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`}
            />
            Retry
          </Button>
        </div>
      )}

      {error && !displayData && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-destructive backdrop-blur-sm">
          <p className="font-sans text-sm font-light">
            Tenant unreachable — try again or contact support.
          </p>
        </div>
      )}

      {showInitialLoadingState && (
        <div className="flex items-center gap-3 rounded-xl border border-[#C9A84C]/20 bg-black/20 px-4 py-3 text-muted-foreground backdrop-blur-sm">
          <Loader2 className="h-4 w-4 animate-spin text-[#C9A84C]" />
          <p className="font-mono text-xs uppercase tracking-[0.2em]">
            Loading dashboard...
          </p>
        </div>
      )}

      {displayData && (
        <div className="space-y-6">
          {/* Floating Glass TopBar */}
          <TopBar
            data={displayData}
            containers={containers}
            activePanel={activePanel}
            onPanelToggle={setActivePanel}
          />

          {/* Devices panel -- expandable below TopBar */}
          {activePanel === "devices" && <DevicesPanel />}

          {/* Pending Approvals */}
          <PendingApprovalsBanner />

          {/* First Brief */}
          <FirstBrief />

          {/* Bento Grid Layout */}
          <BentoGrid>
            {/* Health - 1x1 */}
            <BentoItem>
              <SpotlightCard
                title="System Health"
                icon={<CheckCircle className="h-4 w-4 text-green-500" />}
                className="h-full"
              >
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <div
                      className={`h-2.5 w-2.5 rounded-full ${
                        displayData.health?.status === "ok"
                          ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]"
                          : "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]"
                      }`}
                    />
                    <span className="font-mono text-sm uppercase tracking-wider text-[#F0EDE8]">
                      {displayData.health?.status?.toUpperCase() ?? "UNKNOWN"}
                    </span>
                  </div>
                  <p className="font-mono text-[0.65rem] text-[#F0EDE8]/50">
                    Instance is{" "}
                    {displayData.health?.status === "ok"
                      ? "healthy and responsive"
                      : "experiencing issues"}
                  </p>
                </div>
              </SpotlightCard>
            </BentoItem>

            {/* Vault Count - 1x1 */}
            <BentoItem>
              <SpotlightCard
                title="Vault"
                icon={<BookOpen className="h-4 w-4 text-[#C9A84C]/70" />}
                className="h-full"
              >
                <div className="flex flex-col gap-2">
                  <span className="font-mono text-3xl font-light text-[#F0EDE8]">
                    {displayData.vault?.total_records ?? 0}
                  </span>
                  <span className="font-mono text-[0.65rem] text-[#F0EDE8]/50">
                    records indexed
                  </span>
                  {(displayData.inbox?.count ?? 0) > 0 && (
                    <span className="inline-flex w-fit rounded-full bg-[#C9A84C]/15 px-2 py-0.5 font-mono text-[0.6rem] text-[#C9A84C]">
                      {displayData.inbox.count} in inbox
                    </span>
                  )}
                </div>
              </SpotlightCard>
            </BentoItem>

            {/* Services - 1x1 */}
            <BentoItem>
              <SpotlightCard
                title="Services"
                icon={<Bot className="h-4 w-4 text-[#C9A84C]/70" />}
                className="h-full"
              >
                <div className="flex flex-col gap-2">
                  <span className="font-mono text-3xl font-light text-[#F0EDE8]">
                    {totalContainers > 0
                      ? `${runningContainers}/${totalContainers}`
                      : "..."}
                  </span>
                  <span className="font-mono text-[0.65rem] text-[#F0EDE8]/50">
                    containers running
                  </span>
                </div>
              </SpotlightCard>
            </BentoItem>

            {/* Knowledge Graph - 2x2 */}
            <BentoItem colSpan={2} rowSpan={2}>
              <SpotlightCard className="h-full">
                <div className="mb-3 flex items-center justify-between">
                  <span className="font-serif text-base font-light text-[#F0EDE8]">
                    Knowledge Graph
                  </span>
                  <label className="flex cursor-pointer items-center gap-2">
                    <span className="font-mono text-[0.6rem] font-light uppercase tracking-[0.2em] text-[#F0EDE8]/50">
                      Graph
                    </span>
                    <Switch
                      checked={graphVisible}
                      onCheckedChange={setGraphVisible}
                    />
                  </label>
                </div>
                {graphVisible ? <VaultGraph /> : null}
              </SpotlightCard>
            </BentoItem>

            {/* Daily Digest - 1x2 */}
            <BentoItem rowSpan={2}>
              <SpotlightCard
                title="Daily Digest"
                icon={<BookOpen className="h-4 w-4 text-[#C9A84C]" />}
                className="h-full"
              >
                {lastDigest ? (
                  <div className="space-y-2">
                    <p className="font-sans text-sm font-light leading-relaxed text-[#F0EDE8]/80">
                      {lastDigest.summary}
                    </p>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[0.6rem] text-[#F0EDE8]/30">
                        {lastDigest.timestamp
                          ? new Date(lastDigest.timestamp).toLocaleString()
                          : ""}
                      </span>
                      {lastDigest.path && (
                        <Link
                          to={`/dashboard/vault/${encodeURIComponent(lastDigest.path)}`}
                          className="font-mono text-[0.6rem] text-[#C9A84C]/70 transition-colors hover:text-[#C9A84C]"
                        >
                          View full digest
                        </Link>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="py-2 font-mono text-xs text-[#F0EDE8]/30">
                    No digest yet. Alfred will generate one after observing your
                    daily activity.
                  </p>
                )}
              </SpotlightCard>
            </BentoItem>

            {/* Worker Activity - 1x1 */}
            <BentoItem colSpan={2}>
              <SpotlightCard className="h-full">
                <WorkerActivityCharts />
              </SpotlightCard>
            </BentoItem>

            {/* Activity Feed - full width */}
            <BentoItem colSpan={3}>
              <SpotlightCard className="h-full">
                <ActivityFeed />
              </SpotlightCard>
            </BentoItem>

            {/* Vault Composition */}
            {displayData.vault?.types &&
              Object.keys(displayData.vault.types).length > 0 && (
                <BentoItem colSpan={3}>
                  <SpotlightCard
                    title="Vault Composition"
                    className="h-full"
                  >
                    <VaultCompositionChart types={displayData.vault.types} />
                  </SpotlightCard>
                </BentoItem>
              )}
          </BentoGrid>
        </div>
      )}
    </DashboardLayout>
  );
}

// ---------------------------------------------------------------------------
// PendingApprovalsBanner (local to command center)
// ---------------------------------------------------------------------------

function PendingApprovalsBanner() {
  const { data, refetch } = useQuery(getPendingApprovals, undefined, {
    refetchInterval: 10_000,
    retry: false,
  });

  const [actingOn, setActingOn] = useState<string | null>(null);

  const approvals: any[] = data?.results ?? [];

  if (approvals.length === 0) return null;

  const handleApprove = async (path: string): Promise<void> => {
    setActingOn(path);
    try {
      await approveAction({ path });
      refetch();
    } catch (err: unknown) {
      console.error("Approval failed:", err);
    } finally {
      setActingOn(null);
    }
  };

  const handleReject = async (path: string): Promise<void> => {
    setActingOn(path);
    try {
      await rejectAction({ path });
      refetch();
    } catch (err: unknown) {
      console.error("Rejection failed:", err);
    } finally {
      setActingOn(null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="rounded-xl border border-amber-500/40 bg-amber-500/[0.06] p-4 backdrop-blur-sm"
    >
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
        Alfred wants to take the following actions but needs your permission
        first.
      </p>
      <div className="space-y-2">
        {approvals.map((a: any) => (
          <motion.div
            key={a.path}
            whileHover={{
              scale: 1.005,
              boxShadow: "0 0 8px rgba(245,158,11,0.08)",
            }}
            transition={{
              type: "spring" as const,
              stiffness: 300,
              damping: 20,
            }}
            className="flex items-center gap-3 rounded-lg border border-amber-500/20 bg-black/30 px-3 py-2.5 backdrop-blur-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs font-medium text-[#F0EDE8]">
                {a.name}
              </p>
              {a.description && (
                <p className="mt-0.5 truncate font-sans text-[0.65rem] font-light text-[#F0EDE8]/50">
                  {a.description}
                </p>
              )}
              {a.alfred_instructions && (
                <p className="mt-0.5 truncate font-mono text-[0.6rem] text-[#C9A84C]/60">
                  {a.alfred_instructions}
                </p>
              )}
              {a.created && (
                <span className="mt-1 inline-block font-mono text-[0.55rem] text-[#F0EDE8]/30">
                  {a.created}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleApprove(a.path)}
                disabled={actingOn === a.path}
                className="flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 font-mono text-[0.6rem] uppercase tracking-wider text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
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
                className="flex items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 font-mono text-[0.6rem] uppercase tracking-wider text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
              >
                {actingOn === a.path ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <XCircle className="h-3 w-3" />
                )}
                Reject
              </button>
            </div>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}
