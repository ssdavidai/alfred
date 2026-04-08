/**
 * ChoreDetailPage — per-chore detail view [Plan C.3]
 *
 * Renders the full chore detail: title, description, schedule explanation,
 * status + quarantine state, run history (parsed from the body run log),
 * collapsible raw Python source for power users, and the same action
 * buttons as the list view.
 *
 * Route: /dashboard/chores/:slug (registered in main.wasp)
 */
import { useState } from "react";
import { useParams, Link as RouterLink } from "react-router-dom";
import {
  useQuery,
  getChore,
  pauseChore,
  resumeChore,
  deleteChore,
  triggerChore,
} from "wasp/client/operations";
import {
  ArrowLeft,
  CalendarClock,
  Loader2,
  Play,
  Pause,
  Trash2,
  Zap,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Code,
} from "lucide-react";
import DashboardLayout from "../dashboard/DashboardLayout";
import SpotlightCard from "../components/ui/SpotlightCard";
import { cronToEnglish } from "./ChoresContent";

interface BadgeProps {
  text: string;
  colorClass: string;
}

function Badge({ text, colorClass }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider ${colorClass}`}
    >
      {text}
    </span>
  );
}

/**
 * Parse the run log section out of the chore record body.
 *
 * The chore body convention from S4 onwards is a "## Run log" section
 * followed by a list of "- <iso>: <message>" entries. This helper finds
 * the section and returns the entries newest-first. Tolerates missing
 * section, missing entries, malformed lines.
 */
function parseRunLog(body: string): Array<{ timestamp: string; message: string; isDryRun: boolean }> {
  if (!body || typeof body !== "string") return [];
  const idx = body.indexOf("## Run log");
  if (idx < 0) return [];
  const afterHeading = body.slice(idx + "## Run log".length);
  const lines = afterHeading.split("\n");
  const entries: Array<{ timestamp: string; message: string; isDryRun: boolean }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const rest = trimmed.slice(2);
    const colonIdx = rest.indexOf(":");
    if (colonIdx < 0) continue;
    // Find the FIRST colon outside the ISO timestamp (which has its own colons)
    // ISO format: 2026-04-09T15:42:00.000Z+00:00 — about 24-30 chars before the
    // separator colon. We split on " : " or look for the first non-time colon.
    // Simpler heuristic: ISO timestamps are always followed by ": ".
    const sepIdx = rest.indexOf(": ");
    if (sepIdx < 0) continue;
    const timestamp = rest.slice(0, sepIdx).trim();
    let message = rest.slice(sepIdx + 2).trim();
    let isDryRun = false;
    if (message.startsWith("[dry-run] ")) {
      isDryRun = true;
      message = message.slice("[dry-run] ".length);
    }
    entries.push({ timestamp, message, isDryRun });
  }
  // Newest first
  return entries.reverse();
}

export default function ChoreDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? "";
  const [actioning, setActioning] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  const { data, isLoading, error, refetch } = useQuery(
    getChore,
    { slug },
    {
      refetchInterval: 30_000,
      retry: false,
      enabled: !!slug,
    },
  );

  const handleAction = async (
    fn: (args: { slug: string }) => Promise<any>,
    actionKey: string,
    confirmMessage?: string,
  ) => {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setActioning(actionKey);
    try {
      await fn({ slug });
      refetch();
    } catch (err) {
      console.error(`${actionKey} failed:`, err);
    } finally {
      setActioning(null);
    }
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center gap-2 py-8">
          <Loader2 className="h-5 w-5 animate-spin text-gold" />
          <span className="text-muted-foreground text-sm">Loading chore…</span>
        </div>
      </DashboardLayout>
    );
  }

  if (error || !data) {
    return (
      <DashboardLayout>
        <div className="bg-destructive/10 text-destructive rounded-sm p-4">
          <p className="font-mono text-xs">
            {(error as any)?.message ?? "Chore not found"}
          </p>
          <RouterLink
            to="/dashboard/tasks"
            className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-cream"
          >
            <ArrowLeft className="h-3 w-3" /> Back to Intelligence
          </RouterLink>
        </div>
      </DashboardLayout>
    );
  }

  const fm = data.frontmatter ?? data;
  const body = data.body ?? "";
  const name = fm.name ?? slug;
  const status = String(fm.status ?? "active").toLowerCase();
  const schedule = fm.schedule ?? "";
  const userFacingDescription =
    fm.user_facing_description ?? fm.userFacingDescription ?? "";
  const fallbackDescription = fm.description ?? "";
  const lastRun = fm.last_run ?? null;
  const generated = fm.generated === true || fm.generated === "true";
  const quarantine = fm.quarantine === true || fm.quarantine === "true";
  const quarantineRemaining = parseInt(String(fm.quarantine_remaining ?? "0"), 10);
  const template = fm.template ?? "";
  const workflowClassName = fm.workflow_class_name ?? "";
  const params_json = fm.params ?? "";

  const isPaused = status === "paused";
  const isCompleted = status === "completed";

  const runLog = parseRunLog(body);

  // Try to extract the Python source from the body. If the chore is
  // generated, the source lives in /alfred-data/user-chores/<module>.py
  // and isn't in the body — we'd need a separate endpoint to fetch it.
  // For now, surface the source path so power users can SSH if they
  // really need to read the code.
  return (
    <DashboardLayout>
      <RouterLink
        to="/dashboard/tasks"
        className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-cream"
      >
        <ArrowLeft className="h-3 w-3" /> Back to Intelligence
      </RouterLink>

      {/* Title + status badges */}
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <CalendarClock className="h-5 w-5 text-gold" />
        <h1 className="font-serif text-2xl font-light text-cream">{name}</h1>
        {generated && (
          <Badge
            text="Generated"
            colorClass="border-purple-500/40 bg-purple-500/10 text-purple-300"
          />
        )}
        {quarantine && quarantineRemaining > 0 && (
          <Badge
            text={`Quarantine ${quarantineRemaining}/3`}
            colorClass="border-amber-500/40 bg-amber-500/10 text-amber-400"
          />
        )}
        {isPaused && (
          <Badge text="Paused" colorClass="border-amber-500/40 bg-amber-500/10 text-amber-400" />
        )}
        {isCompleted && (
          <Badge text="Completed" colorClass="border-muted/40 bg-muted/10 text-muted-foreground" />
        )}
        {!isPaused && !isCompleted && (
          <Badge text="Active" colorClass="border-emerald-500/40 bg-emerald-500/10 text-emerald-400" />
        )}
      </div>

      {/* Schedule line */}
      <p className="mb-6 text-sm text-muted-foreground">
        <CalendarClock className="mr-1.5 inline h-3 w-3" />
        {cronToEnglish(schedule)}
        {schedule && (
          <span className="ml-2 font-mono text-[0.6rem] text-muted-foreground/40">
            ({schedule})
          </span>
        )}
      </p>

      {/* Action buttons */}
      <div className="mb-6 flex flex-wrap gap-2">
        {!isCompleted && (
          <button
            type="button"
            onClick={() => handleAction(triggerChore, "trigger")}
            disabled={actioning === "trigger"}
            className="flex items-center gap-1.5 rounded-sm border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-blue-400 transition-colors hover:bg-blue-500/20 disabled:opacity-50"
          >
            {actioning === "trigger" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            Run now
          </button>
        )}
        {!isCompleted && isPaused && (
          <button
            type="button"
            onClick={() => handleAction(resumeChore, "resume")}
            disabled={actioning === "resume"}
            className="flex items-center gap-1.5 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
          >
            {actioning === "resume" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Resume
          </button>
        )}
        {!isCompleted && !isPaused && (
          <button
            type="button"
            onClick={() => handleAction(pauseChore, "pause")}
            disabled={actioning === "pause"}
            className="flex items-center gap-1.5 rounded-sm border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
          >
            {actioning === "pause" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pause className="h-3.5 w-3.5" />}
            Pause
          </button>
        )}
        {!isCompleted && (
          <button
            type="button"
            onClick={() => handleAction(deleteChore, "delete", `Delete chore "${slug}"? This stops its schedule. The vault record + run history are preserved.`)}
            disabled={actioning === "delete"}
            className="flex items-center gap-1.5 rounded-sm border border-red-500/30 bg-red-500/10 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
          >
            {actioning === "delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Delete
          </button>
        )}
      </div>

      {/* Quarantine notice */}
      {generated && quarantine && quarantineRemaining > 0 && (
        <SpotlightCard>
          <div className="flex items-start gap-2">
            <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
            <div>
              <p className="font-mono text-xs text-amber-300">
                Quarantine: {quarantineRemaining} dry-run{quarantineRemaining === 1 ? "" : "s"} remaining
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                This is a generated chore — the first 3 scheduled runs execute in
                dry-run mode (no notifications, no vault writes) so we can confirm
                it behaves as expected before going live. After {quarantineRemaining}{" "}
                more successful run{quarantineRemaining === 1 ? "" : "s"}, it will go live automatically.
              </p>
            </div>
          </div>
        </SpotlightCard>
      )}

      {/* What this does */}
      {(userFacingDescription || fallbackDescription) && (
        <div className="mt-6">
          <h2 className="mb-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
            What this does
          </h2>
          <p className="text-sm text-cream">
            {userFacingDescription || fallbackDescription}
          </p>
        </div>
      )}

      {/* Metadata */}
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SpotlightCard>
          <div className="font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
            Schedule ID
          </div>
          <div className="mt-1 font-mono text-xs text-cream">
            chore-{slug}
          </div>
        </SpotlightCard>
        {template && (
          <SpotlightCard>
            <div className="font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
              Template
            </div>
            <div className="mt-1 font-mono text-xs text-cream">{template}</div>
          </SpotlightCard>
        )}
        {workflowClassName && (
          <SpotlightCard>
            <div className="font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
              Workflow class
            </div>
            <div className="mt-1 break-all font-mono text-xs text-cream">{workflowClassName}</div>
          </SpotlightCard>
        )}
        <SpotlightCard>
          <div className="font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
            Last run
          </div>
          <div className="mt-1 font-mono text-xs text-cream">
            {lastRun ?? "never"}
          </div>
        </SpotlightCard>
      </div>

      {/* Run history */}
      <div className="mt-6">
        <h2 className="mb-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Run history ({runLog.length})
        </h2>
        {runLog.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground/50">
            No runs yet. The chore will fire on its next schedule tick.
          </p>
        ) : (
          <SpotlightCard>
            <ul className="space-y-2">
              {runLog.slice(0, 50).map((entry, idx) => (
                <li
                  key={idx}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-gold-dim/10 pb-2 last:border-0 last:pb-0"
                >
                  <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                    {entry.timestamp}
                  </span>
                  {entry.isDryRun && (
                    <Badge text="Dry-run" colorClass="border-amber-500/40 bg-amber-500/10 text-amber-400" />
                  )}
                  <span className="text-xs text-cream/80">{entry.message}</span>
                </li>
              ))}
            </ul>
          </SpotlightCard>
        )}
      </div>

      {/* Params (json) */}
      {params_json && (
        <div className="mt-6">
          <h2 className="mb-2 font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
            Parameters
          </h2>
          <SpotlightCard>
            <pre className="overflow-x-auto font-mono text-[0.65rem] text-muted-foreground">
              {typeof params_json === "string" ? params_json : JSON.stringify(params_json, null, 2)}
            </pre>
          </SpotlightCard>
        </div>
      )}

      {/* Source code (collapsible) — only shown for generated chores */}
      {generated && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setShowSource(!showSource)}
            className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-muted-foreground hover:text-cream"
          >
            {showSource ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <Code className="h-3 w-3" />
            Workflow source
          </button>
          {showSource && (
            <SpotlightCard>
              <p className="mb-2 text-xs text-muted-foreground">
                Generated chore source lives at:
              </p>
              <pre className="overflow-x-auto font-mono text-[0.65rem] text-cream">
                /alfred-data/user-chores/{template}.py
              </pre>
              <p className="mt-2 text-xs text-muted-foreground/60">
                To view: <code className="font-mono">docker exec compose-alfred-learn-1 cat /alfred-data/user-chores/{template}.py</code>
              </p>
            </SpotlightCard>
          )}
        </div>
      )}
    </DashboardLayout>
  );
}
