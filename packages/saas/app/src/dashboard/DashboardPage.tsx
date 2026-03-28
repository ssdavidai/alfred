import { useState, useEffect, useMemo } from "react";
import {
  useQuery,
  getDashboardData,
} from "wasp/client/operations";
import { Loader2 } from "lucide-react";
import DashboardLayout from "./DashboardLayout";
import VaultNebula from "../components/nebula/VaultNebula";

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

  return (
    <DashboardLayout>
      {/* VaultNebula — full viewport volumetric shader background */}
      <VaultNebula />

      {/* Floating overlay — loading, error, breathing indicator */}
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

        {/* Record count badge */}
        {displayData?.vault?.total_records != null && (
          <div className="pointer-events-auto mt-4 rounded-full border border-[#C9A84C]/15 bg-black/40 px-4 py-1.5 backdrop-blur-sm">
            <span className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-[#F0EDE8]/40">
              {displayData.vault.total_records} records
            </span>
          </div>
        )}

        {/* Breathing indicator — Alfred is alive */}
        <div className="mt-3">
          <span
            className="font-mono text-[0.55rem] uppercase tracking-[0.25em] text-[#C9A84C]/50"
            style={{
              animation: "breathe 4s ease-in-out infinite",
            }}
          >
            Alfred is watching
          </span>
          <style>{`
            @keyframes breathe {
              0%, 100% { opacity: 0.15; }
              50% { opacity: 0.6; }
            }
          `}</style>
        </div>
      </div>
    </DashboardLayout>
  );
}
