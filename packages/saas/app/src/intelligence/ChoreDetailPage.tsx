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
import { useParams, Link as RouterLink, Navigate } from "react-router-dom";
import {
  useQuery,
  getChore,
  getChoreSource,
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
  CheckCircle2,
  AlertTriangle,
  XCircle,
  FileWarning,
  ArrowDownToLine,
  ArrowUpFromLine,
  Brain,
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

// M4 #862 — /dashboard/chores/:slug redirects to /chores/:slug. The
// legacy implementation is preserved as LegacyChoreDetailPage.
export default function ChoreDetailPage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? "";
  return (
    <Navigate
      to={slug ? `/chores/${encodeURIComponent(slug)}` : "/chores"}
      replace
    />
  );
}

function LegacyChoreDetailPage() {
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
          <Badge text="Archived" colorClass="border-muted/40 bg-muted/10 text-muted-foreground" />
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

      {/* Source code + dependency audit (collapsible) */}
      <ChoreSourceSection slug={slug} showSource={showSource} setShowSource={setShowSource} />
    </DashboardLayout>
  );
}

/**
 * ChoreSourceSection — anti-hallucination audit for a chore
 *
 * Fetches the full workflow source via `getChoreSource` and renders:
 *   1. A dependency panel — for each chore_action the workflow imports,
 *      show description, data reads/writes, LLM flag, required data, and
 *      a live data-readiness probe (green/yellow/red per vault source).
 *   2. A warning panel for unknown_activities — names the workflow
 *      references that DON'T exist in the manifest. If this is non-empty,
 *      the chore is built on a hallucination and needs to be deleted.
 *   3. A collapsible raw Python source block so power users can audit
 *      exactly what the code does.
 *
 * For standard-library chores (generated: false), just surfaces a
 * pointer to the source-controlled template file.
 */
function ChoreSourceSection({
  slug,
  showSource,
  setShowSource,
}: {
  slug: string;
  showSource: boolean;
  setShowSource: (v: boolean) => void;
}) {
  const { data, isLoading, error } = useQuery(
    getChoreSource,
    { slug },
    { retry: false, enabled: !!slug },
  );

  if (isLoading) {
    return (
      <div className="mt-8 flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-gold" />
        <span className="font-mono text-xs text-muted-foreground">
          Auditing chore dependencies…
        </span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mt-8 rounded-sm border border-red-500/30 bg-red-500/10 p-3">
        <p className="font-mono text-xs text-red-300">
          Failed to load chore source: {(error as any)?.message ?? "unknown error"}
        </p>
      </div>
    );
  }

  const isGenerated: boolean = Boolean(data.generated);
  const source: string | null = data.source ?? null;
  const manifest: Array<any> = Array.isArray(data.manifest) ? data.manifest : [];
  const unknownActivities: string[] = Array.isArray(data.unknown_activities)
    ? data.unknown_activities
    : [];
  const activityCalls: Array<{ name: string; line: number; snippet: string }> =
    Array.isArray(data.activity_calls) ? data.activity_calls : [];

  // Aggregate a top-line verdict: does every activity have ok data?
  const allChecks: Array<{ status: string }> = [];
  for (const entry of manifest) {
    if (Array.isArray(entry.readiness_checks)) {
      for (const c of entry.readiness_checks) allChecks.push(c);
    }
  }
  const hasMissing = allChecks.some((c) => c.status === "missing");
  const hasEmpty = allChecks.some((c) => c.status === "empty");
  const hasUnknown = unknownActivities.length > 0;
  const overallOk = !hasMissing && !hasEmpty && !hasUnknown;

  return (
    <div className="mt-8 space-y-4">
      {/* Header: anti-hallucination verdict */}
      <div>
        <h2 className="mb-3 font-mono text-xs uppercase tracking-wider text-muted-foreground">
          What this chore actually does
        </h2>
        {overallOk ? (
          <div className="flex items-start gap-2 rounded-sm border border-emerald-500/30 bg-emerald-500/10 p-3">
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-400" />
            <div className="text-xs text-emerald-200">
              <p className="font-semibold">
                Audit passed — every activity references real, populated data
                sources.
              </p>
              <p className="mt-1 text-emerald-200/70">
                {manifest.length} activit{manifest.length === 1 ? "y" : "ies"} audited,{" "}
                {activityCalls.length} call site{activityCalls.length === 1 ? "" : "s"} in the workflow.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-sm border border-amber-500/40 bg-amber-500/10 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
            <div className="text-xs text-amber-200">
              <p className="font-semibold">
                Audit found potential issues — this chore may not have the data
                it needs to do useful work.
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-200/80">
                {hasUnknown && (
                  <li>
                    References {unknownActivities.length} activit
                    {unknownActivities.length === 1 ? "y" : "ies"} that don't
                    exist in the library (hallucination).
                  </li>
                )}
                {hasMissing && (
                  <li>
                    Reads from vault directories that don't exist on this
                    tenant.
                  </li>
                )}
                {hasEmpty && (
                  <li>
                    Reads from vault directories that exist but are empty — the
                    chore will silently return 0 results every run.
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* Unknown activities warning */}
      {unknownActivities.length > 0 && (
        <div>
          <h3 className="mb-2 font-mono text-[0.65rem] uppercase tracking-wider text-red-400">
            Unknown activities (hallucination)
          </h3>
          <div className="rounded-sm border border-red-500/30 bg-red-500/10 p-3">
            <p className="mb-2 text-xs text-red-200">
              The workflow imports these activity names, but they don't exist in
              the chore_actions library. Alfred made them up. This chore cannot
              run as-is.
            </p>
            <ul className="space-y-0.5 font-mono text-[0.65rem] text-red-300">
              {unknownActivities.map((name) => (
                <li key={name}>• {name}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Activity manifest — per-activity data audit */}
      {manifest.length > 0 && (
        <div>
          <h3 className="mb-2 font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
            Tools & data the workflow uses ({manifest.length})
          </h3>
          <div className="space-y-2">
            {manifest.map((entry) => (
              <ActivityCard key={entry.activity} entry={entry} />
            ))}
          </div>
        </div>
      )}

      {/* Activity call sites — where in the workflow each activity is invoked */}
      {activityCalls.length > 0 && (
        <div>
          <h3 className="mb-2 font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
            Call sites in the workflow ({activityCalls.length})
          </h3>
          <SpotlightCard>
            <ul className="space-y-2">
              {activityCalls.map((call, idx) => (
                <li key={idx} className="border-b border-gold-dim/10 pb-2 last:border-0 last:pb-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[0.65rem] text-muted-foreground/60">
                      line {call.line}
                    </span>
                    <code className="font-mono text-xs text-gold">{call.name}</code>
                  </div>
                  <pre className="mt-1 overflow-x-auto font-mono text-[0.6rem] text-cream/70">
                    {call.snippet}
                  </pre>
                </li>
              ))}
            </ul>
          </SpotlightCard>
        </div>
      )}

      {/* Raw source */}
      <div>
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
          {isGenerated ? "Workflow source" : "Workflow info"}
          {source && (
            <span className="ml-2 font-mono text-[0.6rem] text-muted-foreground/40">
              ({data.source_line_count} lines, {data.source_size_bytes} bytes)
            </span>
          )}
        </button>
        {showSource && (
          <div className="mt-2">
            {source ? (
              <SpotlightCard>
                <pre className="max-h-[600px] overflow-auto font-mono text-[0.6rem] leading-relaxed text-cream/90">
                  {source}
                </pre>
              </SpotlightCard>
            ) : (
              <SpotlightCard>
                <p className="text-xs text-muted-foreground">
                  {data.message ??
                    "This is a standard-library chore. Source is in packages/learn/src/workflows/chores/ in the alfred-platform repo."}
                </p>
                {data.template && (
                  <pre className="mt-2 overflow-x-auto font-mono text-[0.65rem] text-cream">
                    packages/learn/src/workflows/chores/{data.template}.py
                  </pre>
                )}
              </SpotlightCard>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * ActivityCard — one activity's description + what-it-reads/writes + readiness.
 *
 * The readiness checks are the anti-hallucination payload: for each vault
 * directory the activity reads, we render a green (ok), yellow (empty), or
 * red (missing) row so the user can see at a glance whether the data that
 * feeds this chore actually exists on their tenant.
 */
function ActivityCard({ entry }: { entry: any }) {
  const [expanded, setExpanded] = useState(false);
  const reads: Array<any> = Array.isArray(entry.reads) ? entry.reads : [];
  const writes: Array<any> = Array.isArray(entry.writes) ? entry.writes : [];
  const requiredData: string[] = Array.isArray(entry.required_data) ? entry.required_data : [];
  const readinessChecks: Array<{
    kind: string;
    resource: string;
    status: "ok" | "empty" | "missing" | "untested";
    detail: string;
  }> = Array.isArray(entry.readiness_checks) ? entry.readiness_checks : [];

  const hasProblem = readinessChecks.some(
    (c) => c.status === "missing" || c.status === "empty",
  );

  return (
    <SpotlightCard>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-start gap-2 text-left"
      >
        {expanded ? (
          <ChevronDown className="mt-1 h-3 w-3 flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-1 h-3 w-3 flex-shrink-0 text-muted-foreground" />
        )}
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-xs text-gold">{entry.activity}</code>
            {entry.llm && (
              <span className="inline-flex items-center gap-1 rounded-sm border border-purple-500/40 bg-purple-500/10 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-purple-300">
                <Brain className="h-2.5 w-2.5" /> LLM call
              </span>
            )}
            {hasProblem ? (
              <span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-amber-300">
                <AlertTriangle className="h-2.5 w-2.5" /> Data issue
              </span>
            ) : readinessChecks.length > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-emerald-300">
                <CheckCircle2 className="h-2.5 w-2.5" /> Ready
              </span>
            ) : null}
          </div>
          {entry.description && (
            <p className="mt-1 text-xs text-cream/80">{entry.description}</p>
          )}
        </div>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-gold-dim/10 pt-3 pl-5">
          {/* Reads */}
          {reads.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                <ArrowDownToLine className="h-3 w-3" /> Reads
              </div>
              <ul className="space-y-1 pl-1">
                {reads.map((r, idx) => (
                  <li key={idx} className="font-mono text-[0.65rem] text-cream/70">
                    <span className="text-muted-foreground">[{r.kind}]</span> {r.resource}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Writes */}
          {writes.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                <ArrowUpFromLine className="h-3 w-3" /> Writes
              </div>
              <ul className="space-y-1 pl-1">
                {writes.map((w, idx) => (
                  <li key={idx} className="font-mono text-[0.65rem] text-cream/70">
                    <span className="text-muted-foreground">[{w.kind}]</span> {w.resource}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Readiness checks — the anti-hallucination payload */}
          {readinessChecks.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                <FileWarning className="h-3 w-3" /> Live data readiness
              </div>
              <ul className="space-y-1 pl-1">
                {readinessChecks.map((check, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-[0.65rem]">
                    <ReadinessIcon status={check.status} />
                    <div className="flex-1">
                      <div className="font-mono text-cream/80">{check.resource}</div>
                      <div className="text-muted-foreground/60">{check.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Required data — prose prerequisites */}
          {requiredData.length > 0 && (
            <div>
              <div className="mb-1 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
                Prerequisites
              </div>
              <ul className="space-y-1 pl-1 text-[0.65rem] text-cream/60">
                {requiredData.map((r, idx) => (
                  <li key={idx}>• {r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </SpotlightCard>
  );
}

function ReadinessIcon({ status }: { status: string }) {
  if (status === "ok") {
    return <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0 text-emerald-400" />;
  }
  if (status === "empty") {
    return <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-400" />;
  }
  if (status === "missing") {
    return <XCircle className="mt-0.5 h-3 w-3 flex-shrink-0 text-red-400" />;
  }
  return <FileWarning className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground" />;
}
