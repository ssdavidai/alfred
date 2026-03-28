import { useState, useEffect, useMemo, useCallback } from "react";
import {
  useQuery,
  getDashboardData,
} from "wasp/client/operations";
import { Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import DashboardLayout from "./DashboardLayout";
import VaultNebula from "../components/nebula/VaultNebula";
import type { NebulaData } from "../components/nebula/NebulaScene";

// ---------------------------------------------------------------------------
// Color mapping — vault type to nebula cluster color
// ---------------------------------------------------------------------------

const NEBULA_COLORS: Record<string, string> = {
  // Notes / conversations → gold
  note: "#C9A84C",
  conversation: "#C9A84C",
  // Tasks → bright white
  task: "#FFFFFF",
  // Decision / assumption / constraint → deep teal
  decision: "#1E4D5E",
  assumption: "#1E4D5E",
  constraint: "#1E4D5E",
  // Triage → warm red
  triage: "#FF6B6B",
  inbox: "#FF6B6B",
  // Project / matter → bright gold
  project: "#D4AF37",
  matter: "#D4AF37",
  // Fallback types
  person: "#B8976A",
  org: "#A89270",
  event: "#B86B8A",
  location: "#B8A56B",
  process: "#6BB8A8",
  account: "#7A8AB8",
  resource: "#6B8AB8",
  log: "#B8B86B",
  // Learning types
  observation: "#9B7FCB",
  instinct: "#7FCBB8",
  intuition: "#CB7F9B",
  reflection: "#7F9BCB",
  judgment: "#CBB87F",
};

// ---------------------------------------------------------------------------
// Transform dashboard data → nebula data
// ---------------------------------------------------------------------------

function buildNebulaData(vaultTypes: Record<string, number> | undefined): NebulaData | null {
  if (!vaultTypes) return null;

  const entries = Object.entries(vaultTypes).filter(([, count]) => count > 0);
  if (entries.length === 0) return null;

  const clusters = entries.map(([type, count]) => ({
    id: type,
    label: type.charAt(0).toUpperCase() + type.slice(1),
    color: NEBULA_COLORS[type] || "#8A8680",
    recordCount: count,
  }));

  // Generate plausible inter-cluster links (every type pair with > 5 records
  // each gets a filament connection). This is a visual heuristic —
  // real wikilink data can replace this once getVaultGraph is wired up.
  const links: { source: string; target: string; weight: number }[] = [];
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const a = clusters[i];
      const b = clusters[j];
      if (a.recordCount >= 3 && b.recordCount >= 3) {
        links.push({
          source: a.id,
          target: b.id,
          weight: Math.min(a.recordCount, b.recordCount),
        });
      }
    }
  }

  return { clusters, links };
}

// ---------------------------------------------------------------------------
// Dashboard cache (preserved from original)
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
// DashboardPage — VaultNebula is the primary view
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const navigate = useNavigate();
  const [persistedCache, setPersistedCache] = useState<{
    data: any;
    cachedAt: number;
  } | null>(() => loadDashboardCache());

  const { data, isLoading, error } = useQuery(
    getDashboardData,
    undefined,
    { refetchInterval: 30_000 },
  );

  // Persist last good data
  useEffect(() => {
    if (data) {
      const cache = { data, cachedAt: Date.now() };
      setPersistedCache(cache);
      saveDashboardCache(data);
    }
  }, [data]);

  const displayData =
    data || (error && persistedCache ? persistedCache.data : null);

  const nebulaData = useMemo(
    () => buildNebulaData(displayData?.vault?.types),
    [displayData?.vault?.types],
  );

  const handleRecordClick = useCallback(
    (clusterId: string) => {
      navigate(`/dashboard/vault?type=${encodeURIComponent(clusterId)}`);
    },
    [navigate],
  );

  return (
    <DashboardLayout>
      {/* VaultNebula — full viewport background */}
      <VaultNebula
        nebulaData={nebulaData}
        onRecordClick={handleRecordClick}
      />

      {/* Floating overlay — loading or error states only */}
      <div className="pointer-events-none fixed inset-0 z-10 flex flex-col items-center justify-end pb-8">
        {isLoading && !displayData && (
          <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-[#C9A84C]/20 bg-black/60 px-4 py-3 backdrop-blur-sm">
            <Loader2 className="h-4 w-4 animate-spin text-[#C9A84C]" />
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-[#F0EDE8]/60">
              Loading vault topology...
            </p>
          </div>
        )}

        {error && !displayData && (
          <div className="pointer-events-auto rounded-xl border border-destructive/30 bg-black/60 p-4 text-destructive backdrop-blur-sm">
            <p className="font-sans text-sm font-light">
              Tenant unreachable — showing empty nebula.
            </p>
          </div>
        )}

        {/* Subtle record count badge */}
        {displayData?.vault?.total_records != null && (
          <div className="pointer-events-auto mt-4 rounded-full border border-[#C9A84C]/15 bg-black/40 px-4 py-1.5 backdrop-blur-sm">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-[#F0EDE8]/40">
              {displayData.vault.total_records} records
            </span>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
