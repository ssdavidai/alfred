// StewardFeedPage — Phase 6 command-center surface (#160).
//
// Chronological feed of recent steward audits + signal-action audits +
// reversals + auto-task-created records. We pull vault/event/ via
// ctrl-api (getStewardFeed) and filter client-side by filename prefix:
//
//   - steward-action-*           → Steward decisions (mode/decision/target)
//   - signal-action-*            → SignalRouter actions (route/dispatch)
//   - auto-task-created-*        → SignalRouter auto-task creations
//   - needs_attention_action-*   → Sir's resolution of a needs_attention card
//
// Each row links to its underlying vault record. Reversal records get
// an inline "Undo" link (steward-action only — that's the prefix the
// existing /api/v1/steward/undo/:id route handles).
//
// Empty/error: getStewardFeed swallows tenant errors and returns
// {results: []}, so the page renders the same "No activity yet"
// message in both cases without breaking the dashboard for tenants
// without the route.
import { useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  useQuery,
  getStewardFeed,
  undoStewardAction,
} from "wasp/client/operations";
import {
  History,
  Bot,
  ArrowRightLeft,
  Sparkles,
  AlertTriangle,
  RotateCcw,
  Loader2,
  Eye,
} from "lucide-react";
import DashboardLayout from "./DashboardLayout";
import SpotlightCard from "../components/ui/SpotlightCard";

type FeedKind =
  | "steward-action"
  | "signal-action"
  | "auto-task-created"
  | "needs_attention_action";

interface FeedRow {
  path: string;
  name: string;
  kind: FeedKind;
  timestamp: string;
  target: string;
  decision?: string;
  mode?: string;
  is_reversible?: boolean;
  action?: string;
  actionId?: string; // for steward-action rows — usable by /api/v1/steward/undo/:id
}

function classifyEventFile(filename: string): FeedKind | null {
  // The vault list endpoint returns ``path`` like ``event/<stem>.md``,
  // so we strip the directory + extension before prefix-matching.
  const stem = filename
    .replace(/^event\//, "")
    .replace(/^events\//, "")
    .replace(/\.md$/, "");
  if (stem.startsWith("steward-action-")) return "steward-action";
  if (stem.startsWith("signal-action-")) return "signal-action";
  if (stem.startsWith("auto-task-created-")) return "auto-task-created";
  if (stem.startsWith("needs_attention_action-")) return "needs_attention_action";
  return null;
}

function buildRow(rec: any): FeedRow | null {
  if (!rec || typeof rec.path !== "string") return null;
  const kind = classifyEventFile(rec.path);
  if (!kind) return null;
  const fm = rec.frontmatter ?? {};
  const stem = rec.path.replace(/^event\//, "").replace(/\.md$/, "");
  // steward-action rows are the only ones the existing undo endpoint
  // accepts — the action_id is the stem after "steward-action-".
  let actionId: string | undefined;
  if (kind === "steward-action") {
    const m = stem.match(/^steward-action-(.+)$/);
    actionId = m ? m[1] : undefined;
  }
  const target = String(
    fm.target ?? fm.target_path ?? fm.task_path ?? rec.name ?? "",
  );
  const created = String(fm.created ?? rec.created ?? "");
  return {
    path: rec.path,
    name: String(rec.name ?? stem),
    kind,
    timestamp: created,
    target,
    decision: fm.decision != null ? String(fm.decision) : undefined,
    mode: fm.mode != null ? String(fm.mode) : undefined,
    is_reversible:
      fm.is_reversible === true || String(fm.is_reversible) === "true",
    action: fm.action != null ? String(fm.action) : undefined,
    actionId,
  };
}

const KIND_META: Record<
  FeedKind,
  { label: string; icon: React.ComponentType<{ className?: string }>; color: string }
> = {
  "steward-action": {
    label: "Steward",
    icon: Bot,
    color: "border-emerald-500/30 bg-emerald-500/5 text-emerald-400",
  },
  "signal-action": {
    label: "Signal action",
    icon: ArrowRightLeft,
    color: "border-[#C9A84C]/30 bg-[#C9A84C]/5 text-[#C9A84C]",
  },
  "auto-task-created": {
    label: "Auto-task",
    icon: Sparkles,
    color: "border-blue-500/30 bg-blue-500/5 text-blue-400",
  },
  "needs_attention_action": {
    label: "Sir resolved",
    icon: AlertTriangle,
    color: "border-amber-500/30 bg-amber-500/5 text-amber-400",
  },
};

// M4 #861 — /dashboard/command-center/steward-feed redirects to /decisions.
// The legacy implementation is preserved as LegacyStewardFeedPage so the
// cutover can be reverted with one line.
export default function StewardFeedPage() {
  return <Navigate to="/decisions" replace />;
}

function LegacyStewardFeedPage() {
  const { data, isLoading, error, refetch } = useQuery(
    getStewardFeed,
    undefined,
    { refetchInterval: 30_000, retry: false },
  );

  const [undoingPath, setUndoingPath] = useState<string | null>(null);

  const rows: FeedRow[] = useMemo(() => {
    const raw: any[] = data?.results ?? [];
    const built = raw
      .map(buildRow)
      .filter((r): r is FeedRow => r != null);
    // Newest first.
    built.sort((a, b) => {
      const ta = Date.parse(a.timestamp || "") || 0;
      const tb = Date.parse(b.timestamp || "") || 0;
      return tb - ta;
    });
    return built;
  }, [data]);

  const handleUndo = async (row: FeedRow) => {
    if (!row.actionId) return;
    setUndoingPath(row.path);
    try {
      await undoStewardAction({ actionId: row.actionId });
      refetch();
    } catch (err: any) {
      console.error("Steward undo failed:", err);
    } finally {
      setUndoingPath(null);
    }
  };

  return (
    <DashboardLayout>
      <div className="mb-6 flex items-center gap-3">
        <History className="h-5 w-5 text-gold" />
        <h1 className="font-serif text-2xl font-light text-cream">
          Steward Feed
        </h1>
      </div>
      <p className="text-muted-foreground mb-6 text-sm">
        Chronological log of Steward decisions, signal-router actions, and Sir&apos;s
        resolutions of needs-attention items. Reversible Steward actions
        expose an Undo link inline.
      </p>

      <SpotlightCard>
        {isLoading && rows.length === 0 ? (
          <div className="flex items-center gap-2 py-6">
            <Loader2 className="h-4 w-4 animate-spin text-gold" />
            <span className="text-muted-foreground font-mono text-xs">
              Loading feed...
            </span>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Eye className="mb-3 h-8 w-8 text-muted-foreground/30" />
            <p className="font-mono text-xs text-muted-foreground">
              {error ? "Feed unavailable" : "No activity yet"}
            </p>
            <p className="mt-1 font-mono text-[0.6rem] text-muted-foreground/50">
              Steward actions and signal-router decisions will show up here as
              they happen.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {rows.map((row) => {
              const meta = KIND_META[row.kind];
              const Icon = meta.icon;
              const detail =
                row.decision ||
                row.action ||
                (row.kind === "auto-task-created" ? "task created" : "");
              const canUndo =
                row.kind === "steward-action" &&
                row.is_reversible === true &&
                !!row.actionId;
              return (
                <div
                  key={row.path}
                  className="flex flex-wrap items-center gap-3 rounded-sm px-3 py-2 transition-colors hover:bg-gold-dim/5"
                >
                  <span
                    className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider ${meta.color}`}
                  >
                    <Icon className="h-3 w-3" />
                    {meta.label}
                  </span>
                  <Link
                    to={`/dashboard/vault/${row.path}`}
                    className="min-w-0 flex-1 font-mono text-xs text-cream/80 hover:text-gold"
                  >
                    <span className="block truncate">
                      {detail ? `${detail}` : row.name}
                      {row.target && (
                        <span className="ml-2 text-muted-foreground/70">
                          → {row.target}
                        </span>
                      )}
                    </span>
                  </Link>
                  {row.mode && row.mode !== "live" && (
                    <span className="rounded-sm border border-zinc-500/30 bg-zinc-500/10 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-zinc-400">
                      {row.mode}
                    </span>
                  )}
                  {row.timestamp && (
                    <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                      {new Date(row.timestamp).toLocaleString()}
                    </span>
                  )}
                  {canUndo && (
                    <button
                      type="button"
                      onClick={() => handleUndo(row)}
                      disabled={undoingPath === row.path}
                      className="flex items-center gap-1 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                    >
                      {undoingPath === row.path ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3 w-3" />
                      )}
                      Undo
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SpotlightCard>
    </DashboardLayout>
  );
}
