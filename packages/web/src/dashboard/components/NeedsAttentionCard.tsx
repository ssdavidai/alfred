// NeedsAttentionCard — Phase 6 dashboard surface (#160).
//
// Reads vault/needs_attention/*.md via the ctrl-api proxy
// (getNeedsAttention) and renders one card per pending record. Each row
// has three resolution buttons:
//
//   - "I'll do it"     → POST /api/v1/admin/needs-attention/:id/done
//   - "Alfred do it"   → POST /api/v1/admin/needs-attention/:id/dispatch
//   - "Skip"           → POST /api/v1/admin/needs-attention/:id/skip
//
// Empty/error states render the same "No items needing your attention"
// message — older tenants don't have the route yet, so we degrade
// silently rather than blocking the rest of the dashboard.
import { useState } from "react";
import {
  useQuery,
  getNeedsAttention,
  resolveNeedsAttentionDone,
  resolveNeedsAttentionDispatch,
  resolveNeedsAttentionSkip,
} from "wasp/client/operations";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle,
  Bot,
  XCircle,
  Loader2,
} from "lucide-react";

interface NeedsAttentionRecord {
  id: string;
  path: string;
  status: string;
  created?: string;
  action_what?: string;
  suggested_actor?: string;
  target_path?: string;
  target_kind?: string;
  confidence?: number;
  decision_reason?: string;
  raw_quote?: string;
  body_preview?: string;
}

type ActionKind = "done" | "dispatch" | "skip";

export default function NeedsAttentionCard() {
  const { data, refetch, isLoading } = useQuery(getNeedsAttention, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const [actingOn, setActingOn] = useState<{ id: string; kind: ActionKind } | null>(
    null,
  );

  const records: NeedsAttentionRecord[] = data?.records ?? [];

  const handle = async (id: string, kind: ActionKind) => {
    setActingOn({ id, kind });
    try {
      if (kind === "done") {
        await resolveNeedsAttentionDone({ id });
      } else if (kind === "dispatch") {
        await resolveNeedsAttentionDispatch({ id });
      } else {
        await resolveNeedsAttentionSkip({ id });
      }
      refetch();
    } catch (err: any) {
      console.error(`needs-attention ${kind} failed:`, err);
    } finally {
      setActingOn(null);
    }
  };

  // Empty state — also rendered on error/404 since getNeedsAttention
  // catches and returns []. This keeps the homepage from breaking on
  // tenants whose ctrl-api predates the route.
  if (!isLoading && records.length === 0) {
    return null;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="pointer-events-auto mt-6 w-full max-w-2xl rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4 backdrop-blur-sm"
    >
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-400" />
        <span className="font-serif text-base font-medium text-amber-400">
          Needs your attention
        </span>
        <span className="ml-auto rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 font-mono text-[0.6rem] font-medium text-amber-400">
          {records.length}
        </span>
      </div>

      {isLoading && records.length === 0 ? (
        <div className="flex items-center gap-2 py-3 text-amber-400/70">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="font-mono text-xs">Loading...</span>
        </div>
      ) : (
        <div className="space-y-2">
          {records.map((rec) => {
            const what = rec.action_what || rec.decision_reason || rec.id;
            const target = rec.target_path
              ? rec.target_path.replace(/^matter\//, "").replace(/^task\//, "")
              : null;
            const isActing = actingOn?.id === rec.id;
            return (
              <motion.div
                key={rec.id}
                whileHover={{
                  scale: 1.005,
                  boxShadow: "0 0 8px rgba(245,158,11,0.08)",
                }}
                transition={{
                  type: "spring" as const,
                  stiffness: 300,
                  damping: 20,
                }}
                className="flex flex-col gap-2 rounded-lg border border-amber-500/20 bg-black/30 px-3 py-2.5 backdrop-blur-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs font-medium text-[#F0EDE8]">
                    {what}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2">
                    {target && (
                      <span className="font-mono text-[0.6rem] text-[#C9A84C]/60">
                        {target}
                      </span>
                    )}
                    {rec.target_kind && (
                      <span className="rounded-sm border border-zinc-500/30 bg-zinc-500/10 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-zinc-400">
                        {rec.target_kind}
                      </span>
                    )}
                    {typeof rec.confidence === "number" && (
                      <span className="font-mono text-[0.55rem] text-[#F0EDE8]/40">
                        confidence {Math.round(rec.confidence * 100)}%
                      </span>
                    )}
                    {rec.created && (
                      <span className="font-mono text-[0.55rem] text-[#F0EDE8]/30">
                        {new Date(String(rec.created)).toLocaleString()}
                      </span>
                    )}
                  </div>
                  {rec.raw_quote && (
                    <p className="mt-1 line-clamp-2 font-sans text-[0.65rem] font-light italic text-[#F0EDE8]/50">
                      &ldquo;{rec.raw_quote}&rdquo;
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handle(rec.id, "done")}
                    disabled={isActing}
                    className="flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 font-mono text-[0.6rem] uppercase tracking-wider text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    {isActing && actingOn?.kind === "done" ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <CheckCircle className="h-3 w-3" />
                    )}
                    I&apos;ll do it
                  </button>
                  <button
                    type="button"
                    onClick={() => handle(rec.id, "dispatch")}
                    disabled={isActing}
                    className="flex items-center gap-1 rounded-lg border border-[#C9A84C]/40 bg-[#C9A84C]/10 px-2.5 py-1.5 font-mono text-[0.6rem] uppercase tracking-wider text-[#C9A84C] transition-colors hover:bg-[#C9A84C]/20 disabled:opacity-50"
                  >
                    {isActing && actingOn?.kind === "dispatch" ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Bot className="h-3 w-3" />
                    )}
                    Alfred do it
                  </button>
                  <button
                    type="button"
                    onClick={() => handle(rec.id, "skip")}
                    disabled={isActing}
                    className="flex items-center gap-1 rounded-lg border border-zinc-500/30 bg-zinc-500/10 px-2.5 py-1.5 font-mono text-[0.6rem] uppercase tracking-wider text-zinc-400 transition-colors hover:bg-zinc-500/20 disabled:opacity-50"
                  >
                    {isActing && actingOn?.kind === "skip" ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <XCircle className="h-3 w-3" />
                    )}
                    Skip
                  </button>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}
