/**
 * ChoresContent — list view for the Chores tab in Intelligence [Plan C.3]
 *
 * Each chore renders as a card with name, user-facing description,
 * schedule rendered in plain English, status badge, last run, and
 * action buttons (Pause / Resume / Trigger now / Delete). Generated
 * chores in quarantine show a quarantine badge with the remaining
 * dry-run count.
 *
 * Data source: getChores Wasp query → ctrl-api GET /api/v1/chores.
 * Refetches every 30s while the tab is mounted.
 */
import { useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  useQuery,
  getChores,
  pauseChore,
  resumeChore,
  deleteChore,
  triggerChore,
} from "wasp/client/operations";
import {
  CalendarClock,
  Loader2,
  Play,
  Pause,
  Trash2,
  Zap,
  Settings,
  ExternalLink,
  Sparkles,
} from "lucide-react";
import SpotlightCard from "../components/ui/SpotlightCard";

// ---------------------------------------------------------------------------
// Cron → English helper
// ---------------------------------------------------------------------------

const _DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * Convert a 5-field cron expression to a human-readable string.
 *
 * Handles the common patterns the chore generator emits — anything
 * exotic falls back to the original cron string in a code span. We
 * deliberately do NOT pull in a full cron parser library because
 * (a) it's a big dependency for a tiny use case and (b) the chore
 * generator's output is bounded to a small set of patterns.
 *
 * Examples (cron → English):
 *   "0 9 * * 1"       → "Every Monday at 9:00 AM"
 *   "0 18 * * 5"      → "Every Friday at 6:00 PM"
 *   "0 18 * * 0"      → "Every Sunday at 6:00 PM"
 *   "0 9 * * *"       → "Every day at 9:00 AM"
 *   "0 9 1 * *"       → "On the 1st of every month at 9:00 AM"
 *   slash-15 minute   → "Every 15 minutes"
 *   slash-2 hour      → "Every 2 hours"
 */
export function cronToEnglish(cron: string): string {
  if (!cron || typeof cron !== "string") return "(no schedule)";
  const trimmed = cron.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return trimmed;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  // Every N minutes
  const minMatch = /^\*\/(\d+)$/.exec(minute);
  if (minMatch && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every ${minMatch[1]} minute${minMatch[1] === "1" ? "" : "s"}`;
  }

  // Every N hours (at minute 0)
  const hourMatch = /^\*\/(\d+)$/.exec(hour);
  if (hourMatch && minute === "0" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every ${hourMatch[1]} hour${hourMatch[1] === "1" ? "" : "s"}`;
  }

  // Format the time of day
  let timeStr = "";
  const minNum = parseInt(minute, 10);
  const hourNum = parseInt(hour, 10);
  if (!isNaN(minNum) && !isNaN(hourNum) && minNum >= 0 && hourNum >= 0) {
    const period = hourNum >= 12 ? "PM" : "AM";
    const displayHour = hourNum === 0 ? 12 : hourNum > 12 ? hourNum - 12 : hourNum;
    const displayMin = String(minNum).padStart(2, "0");
    timeStr = `${displayHour}:${displayMin} ${period}`;
  }

  // Single day of week
  if (
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek !== "*" &&
    /^[0-7]$/.test(dayOfWeek)
  ) {
    const dayNum = parseInt(dayOfWeek, 10) % 7;
    return `Every ${_DAYS[dayNum]} at ${timeStr}`;
  }

  // Range of days of week (e.g. 1-5 for weekdays)
  if (dayOfMonth === "*" && month === "*") {
    if (dayOfWeek === "1-5") return `Every weekday at ${timeStr}`;
    if (dayOfWeek === "0,6") return `Every weekend day at ${timeStr}`;
    if (dayOfWeek === "*") return `Every day at ${timeStr}`;
  }

  // Day of month
  if (dayOfWeek === "*" && month === "*" && /^\d+$/.test(dayOfMonth)) {
    const dom = parseInt(dayOfMonth, 10);
    const ord = ordinalSuffix(dom);
    return `On the ${dom}${ord} of every month at ${timeStr}`;
  }

  // Fall back to the raw cron expression
  return trimmed;
}

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

// ---------------------------------------------------------------------------
// Time formatting helper
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  if (isNaN(ms)) return "—";
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

// ---------------------------------------------------------------------------
// Status badge component
// ---------------------------------------------------------------------------

interface BadgeProps {
  text: string;
  colorClass: string;
}

function Badge({ text, colorClass }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider ${colorClass}`}
    >
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ChoresContent — main list view
// ---------------------------------------------------------------------------

export default function ChoresContent() {
  const { data, isLoading, error, refetch } = useQuery(getChores, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const [actioningSlug, setActioningSlug] = useState<string | null>(null);

  // The ctrl-api list route returns either {chores: [...]} or just an array
  // depending on version — handle both shapes defensively.
  const chores: any[] = Array.isArray(data)
    ? data
    : data?.chores ?? data?.results ?? data?.items ?? [];

  const handlePause = async (slug: string) => {
    setActioningSlug(`pause-${slug}`);
    try {
      await pauseChore({ slug });
      refetch();
    } catch (err) {
      console.error("Pause chore failed:", err);
    } finally {
      setActioningSlug(null);
    }
  };

  const handleResume = async (slug: string) => {
    setActioningSlug(`resume-${slug}`);
    try {
      await resumeChore({ slug });
      refetch();
    } catch (err) {
      console.error("Resume chore failed:", err);
    } finally {
      setActioningSlug(null);
    }
  };

  const handleTrigger = async (slug: string) => {
    setActioningSlug(`trigger-${slug}`);
    try {
      await triggerChore({ slug });
      refetch();
    } catch (err) {
      console.error("Trigger chore failed:", err);
    } finally {
      setActioningSlug(null);
    }
  };

  const handleDelete = async (slug: string) => {
    if (!window.confirm(`Delete chore "${slug}"? This stops its schedule and marks the record completed. The chore record + run history are preserved.`)) {
      return;
    }
    setActioningSlug(`delete-${slug}`);
    try {
      await deleteChore({ slug });
      refetch();
    } catch (err) {
      console.error("Delete chore failed:", err);
    } finally {
      setActioningSlug(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8">
        <Loader2 className="h-5 w-5 animate-spin text-gold" />
        <span className="text-muted-foreground text-sm">Loading chores…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 text-destructive rounded-sm p-4">
        <p className="font-mono text-xs">{(error as any)?.message ?? "Failed to load chores"}</p>
      </div>
    );
  }

  if (chores.length === 0) {
    return (
      <SpotlightCard>
        <div className="text-center py-8">
          <Settings className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
          <p className="font-mono text-sm text-muted-foreground">No chores yet</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground/50">
            Chores are created during onboarding from your discovered opportunities.
          </p>
        </div>
      </SpotlightCard>
    );
  }

  return (
    <div className="space-y-2">
      {chores.map((chore: any) => {
        // Defensive shape extraction — the ctrl-api may return frontmatter
        // either as a top-level object or under a "frontmatter" key
        const fm = chore.frontmatter ?? chore;
        const slug = chore.slug ?? fm.slug ?? fm.schedule_id?.replace(/^chore-/, "") ?? "unknown";
        const name = fm.name ?? slug;
        const status = String(fm.status ?? "active").toLowerCase();
        const schedule = fm.schedule ?? "";
        const userFacingDescription =
          fm.user_facing_description ?? fm.userFacingDescription ?? "";
        const fallbackDescription = fm.description ?? "";
        const lastRun = fm.last_run ?? null;
        const lastResult = fm.last_result ?? null;
        const generated = fm.generated === true || fm.generated === "true";
        const quarantine = fm.quarantine === true || fm.quarantine === "true";
        const quarantineRemaining = parseInt(String(fm.quarantine_remaining ?? "0"), 10);
        const template = fm.template ?? "";
        const workflowClassName = fm.workflow_class_name ?? "";

        const isPaused = status === "paused";
        const isCompleted = status === "completed";

        return (
          <SpotlightCard key={slug}>
            <div className="flex items-start gap-3">
              <CalendarClock className="mt-0.5 h-4 w-4 flex-shrink-0 text-gold/60" />
              <div className="min-w-0 flex-1">
                {/* Title row */}
                <div className="flex flex-wrap items-center gap-2">
                  <RouterLink
                    to={`/dashboard/chores/${encodeURIComponent(slug)}`}
                    className="font-mono text-xs font-medium text-cream hover:text-gold"
                  >
                    {name}
                  </RouterLink>
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
                    <Badge
                      text="Paused"
                      colorClass="border-amber-500/40 bg-amber-500/10 text-amber-400"
                    />
                  )}
                  {isCompleted && (
                    <Badge
                      text="Archived"
                      colorClass="border-muted/40 bg-muted/10 text-muted-foreground"
                    />
                  )}
                  {!isPaused && !isCompleted && (
                    <Badge
                      text="Active"
                      colorClass="border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                    />
                  )}
                </div>

                {/* Description (user_facing_description if present, else opportunity description) */}
                {(userFacingDescription || fallbackDescription) && (
                  <p className="mt-1.5 text-xs text-muted-foreground line-clamp-3">
                    {userFacingDescription || fallbackDescription}
                  </p>
                )}

                {/* Metadata row */}
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[0.6rem] text-muted-foreground/60">
                  <span className="flex items-center gap-1">
                    <CalendarClock className="h-3 w-3" />
                    {cronToEnglish(schedule)}
                  </span>
                  {lastRun && (
                    <span>Last run: {formatRelativeTime(lastRun)}</span>
                  )}
                  {lastResult && (
                    <span className="line-clamp-1">Result: {lastResult}</span>
                  )}
                  {template && !generated && (
                    <span>Template: {template}</span>
                  )}
                  {workflowClassName && generated && (
                    <span title={workflowClassName}>
                      Class: {workflowClassName.length > 30 ? workflowClassName.slice(0, 27) + "…" : workflowClassName}
                    </span>
                  )}
                </div>

                {/* Generation note for quarantined chores */}
                {generated && quarantine && quarantineRemaining > 0 && (
                  <div className="mt-2 flex items-start gap-1.5 rounded-sm border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
                    <Sparkles className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-400" />
                    <span className="text-[0.6rem] text-amber-300/80">
                      First {quarantineRemaining} run{quarantineRemaining === 1 ? "" : "s"} will be dry-runs (no notifications, no vault writes) so we can verify behavior before going live.
                    </span>
                  </div>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex flex-shrink-0 items-center gap-1">
                {!isCompleted && (
                  <button
                    type="button"
                    onClick={() => handleTrigger(slug)}
                    disabled={actioningSlug === `trigger-${slug}`}
                    title="Run this chore now"
                    className="flex items-center gap-1 rounded-sm border border-blue-500/30 bg-blue-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-blue-400 transition-colors hover:bg-blue-500/20 disabled:opacity-50"
                  >
                    {actioningSlug === `trigger-${slug}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Zap className="h-3 w-3" />
                    )}
                    Run
                  </button>
                )}
                {!isCompleted && isPaused && (
                  <button
                    type="button"
                    onClick={() => handleResume(slug)}
                    disabled={actioningSlug === `resume-${slug}`}
                    title="Resume this chore"
                    className="flex items-center gap-1 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    {actioningSlug === `resume-${slug}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Play className="h-3 w-3" />
                    )}
                    Resume
                  </button>
                )}
                {!isCompleted && !isPaused && (
                  <button
                    type="button"
                    onClick={() => handlePause(slug)}
                    disabled={actioningSlug === `pause-${slug}`}
                    title="Pause this chore"
                    className="flex items-center gap-1 rounded-sm border border-amber-500/30 bg-amber-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
                  >
                    {actioningSlug === `pause-${slug}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Pause className="h-3 w-3" />
                    )}
                    Pause
                  </button>
                )}
                {!isCompleted && (
                  <button
                    type="button"
                    onClick={() => handleDelete(slug)}
                    disabled={actioningSlug === `delete-${slug}`}
                    title="Delete this chore"
                    className="flex items-center gap-1 rounded-sm border border-red-500/30 bg-red-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                  >
                    {actioningSlug === `delete-${slug}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                  </button>
                )}
                <RouterLink
                  to={`/dashboard/chores/${encodeURIComponent(slug)}`}
                  title="View chore detail"
                  className="flex items-center gap-1 rounded-sm border border-muted/30 bg-muted/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-muted/20"
                >
                  <ExternalLink className="h-3 w-3" />
                </RouterLink>
              </div>
            </div>
          </SpotlightCard>
        );
      })}
    </div>
  );
}
