import { useState } from "react";
import {
  useQuery,
  getTasks,
  getTaskDetail,
  updateTaskStatus,
  updateTask,
} from "wasp/client/operations";
import DashboardLayout from "../dashboard/DashboardLayout";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../client/components/ui/select";
import {
  ClipboardList,
  Loader2,
  ChevronDown,
  ChevronUp,
  Save,
  Zap,
  ShieldAlert,
} from "lucide-react";

type FilterTab = "all" | "queued" | "active" | "blocked" | "done" | "cancelled";

const STATUS_OPTIONS = [
  { value: "queued", label: "Queued" },
  { value: "active", label: "Active" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_COLORS: Record<string, string> = {
  queued: "border-zinc-500/40 bg-zinc-500/10 text-zinc-400",
  active: "border-blue-500/40 bg-blue-500/10 text-blue-400",
  blocked: "border-red-500/40 bg-red-500/10 text-red-400",
  done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  cancelled: "border-zinc-600/40 bg-zinc-600/10 text-zinc-500",
};

const PRIORITY_COLORS: Record<string, string> = {
  low: "border-zinc-500/40 bg-zinc-500/10 text-zinc-400",
  medium: "border-gold/40 bg-gold/10 text-gold",
  high: "border-orange-500/40 bg-orange-500/10 text-orange-400",
  urgent: "border-red-500/40 bg-red-500/10 text-red-400",
};

const KIND_COLORS: Record<string, string> = {
  task: "border-blue-400/30 bg-blue-400/10 text-blue-400",
  discussion: "border-purple-400/30 bg-purple-400/10 text-purple-400",
  reminder: "border-amber-400/30 bg-amber-400/10 text-amber-400",
};

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "queued", label: "Queued" },
  { key: "active", label: "Active" },
  { key: "blocked", label: "Blocked" },
  { key: "done", label: "Done" },
  { key: "cancelled", label: "Cancelled" },
];

export function TasksContent() {
  const { data, isLoading, error, refetch } = useQuery(getTasks, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const [filter, setFilter] = useState<FilterTab>("all");
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [updatingPath, setUpdatingPath] = useState<string | null>(null);

  const tasks: any[] = data?.results ?? [];

  const filteredTasks = filter === "all"
    ? tasks
    : tasks.filter((t: any) => t.status === filter);

  const counts = {
    total: tasks.length,
    queued: tasks.filter((t: any) => t.status === "queued").length,
    active: tasks.filter((t: any) => t.status === "active").length,
    blocked: tasks.filter((t: any) => t.status === "blocked").length,
    done: tasks.filter((t: any) => t.status === "done").length,
    cancelled: tasks.filter((t: any) => t.status === "cancelled").length,
  };

  const approvalTasks = tasks.filter(
    (t: any) =>
      (t.frontmatter?.requires_approval || t.requires_approval) &&
      (t.status === "queued" || t.status === "todo"),
  );

  const handleStatusChange = async (path: string, newStatus: string) => {
    setUpdatingPath(path);
    try {
      await updateTaskStatus({ path, status: newStatus });
      refetch();
    } catch (err: any) {
      console.error("Status update failed:", err);
    } finally {
      setUpdatingPath(null);
    }
  };

  return (
    <>
      {/* Approval Queue */}
      {approvalTasks.length > 0 && (
        <div className="mb-4 rounded-sm border border-amber-500/30 bg-amber-500/[0.04] p-3">
          <div className="mb-2 flex items-center gap-2">
            <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
            <span className="font-mono text-xs font-medium text-amber-400">
              {approvalTasks.length} task{approvalTasks.length > 1 ? "s" : ""} awaiting approval
            </span>
          </div>
          <div className="space-y-1">
            {approvalTasks.map((t: any) => (
              <div
                key={t.path}
                className="flex items-center justify-between rounded-sm bg-amber-500/5 px-2 py-1.5"
              >
                <span className="truncate font-mono text-xs text-cream/80">
                  {t.frontmatter?.name || t.name}
                </span>
                <TierBadge tier={t.frontmatter?.tier} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="mb-4 flex gap-1">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setFilter(tab.key)}
            className={`rounded-sm px-3 py-1.5 font-mono text-xs transition-colors ${
              filter === tab.key
                ? "bg-gold/15 text-gold"
                : "text-muted-foreground hover:text-cream"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 py-8">
          <Loader2 className="h-5 w-5 animate-spin text-gold" />
          <span className="text-muted-foreground text-sm">Loading tasks...</span>
        </div>
      )}

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-sm p-4">
          <p>{error.message}</p>
        </div>
      )}

      {data && !isLoading && (
        <>
          {/* Stats Bar */}
          <div className="mb-4 grid grid-cols-3 gap-2 lg:grid-cols-6">
            <StatPill label="Total" value={counts.total} />
            <StatPill label="Queued" value={counts.queued} />
            <StatPill label="Active" value={counts.active} />
            <StatPill label="Blocked" value={counts.blocked} />
            <StatPill label="Done" value={counts.done} />
            <StatPill label="Cancelled" value={counts.cancelled} />
          </div>

          {/* Task List */}
          {filteredTasks.length === 0 ? (
            <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-8 text-center">
              <ClipboardList className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
              <p className="font-mono text-sm text-muted-foreground">
                {filter === "all" ? "No tasks yet" : `No ${filter} tasks`}
              </p>
              <p className="mt-1 font-mono text-xs text-muted-foreground/50">
                Tasks created through Alfred will appear here
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredTasks.map((task: any) => (
                <TaskRow
                  key={task.path}
                  task={task}
                  isExpanded={expandedPath === task.path}
                  isUpdating={updatingPath === task.path}
                  onToggle={() =>
                    setExpandedPath(expandedPath === task.path ? null : task.path)
                  }
                  onStatusChange={handleStatusChange}
                  onRefetch={refetch}
                />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

export default function TasksPage() {
  return (
    <DashboardLayout>
      <div className="mb-6 flex items-center gap-3">
        <ClipboardList className="h-5 w-5 text-gold" />
        <h1 className="font-serif text-2xl font-light text-cream">Tasks</h1>
      </div>
      <p className="text-muted-foreground mb-6 text-sm">
        Your task list managed by Alfred. Track what needs doing, what&apos;s in progress, and what&apos;s done.
      </p>
      <TasksContent />
    </DashboardLayout>
  );
}

function StatPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-sm border border-gold-dim/20 bg-black/20 px-3 py-2 text-center">
      <p className="font-mono text-lg font-light text-cream">{value}</p>
      <p className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
    </div>
  );
}

function Badge({ text, colorClass }: { text: string; colorClass: string }) {
  return (
    <span
      className={`inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider ${colorClass}`}
    >
      {text}
    </span>
  );
}

const TIER_LABELS: Record<number, string> = {
  1: "T1 · Classify",
  2: "T2 · Synthesis",
  3: "T3 · Agentic",
};

function TierBadge({ tier }: { tier?: number }) {
  if (!tier) return null;
  return (
    <span className="inline-flex rounded-sm border border-purple-400/30 bg-purple-400/10 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-purple-400">
      {TIER_LABELS[tier] ?? `T${tier}`}
    </span>
  );
}

function TaskRow({
  task,
  isExpanded,
  isUpdating,
  onToggle,
  onStatusChange,
  onRefetch,
}: {
  task: any;
  isExpanded: boolean;
  isUpdating: boolean;
  onToggle: () => void;
  onStatusChange: (path: string, status: string) => void;
  onRefetch: () => void;
}) {
  const fm = task.frontmatter ?? {};
  const statusClass = STATUS_COLORS[task.status] ?? STATUS_COLORS.queued;
  const priorityClass = fm.priority ? PRIORITY_COLORS[fm.priority] : null;
  const hasAlfredInstructions = !!(fm.alfred_instructions || task.alfred_instructions);

  return (
    <div className="rounded-sm border border-gold-dim/20 bg-black/20">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          {isExpanded ? (
            <ChevronUp className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50" />
          )}
          <span className="truncate font-mono text-xs font-medium text-cream">
            {fm.name || task.name}
          </span>
          {hasAlfredInstructions && (
            <Zap className="h-3 w-3 flex-shrink-0 text-gold/70" />
          )}
        </button>

        <div className="flex items-center gap-2">
          {(fm.project || task.project) && (
            <span className="flex-shrink-0 font-mono text-[0.6rem] text-muted-foreground/50">
              {String(fm.project || task.project).replace(/^\[\[|\]\]$/g, "")}
            </span>
          )}
          {(fm.assigned || task.assigned) && (
            <span className="flex-shrink-0 font-mono text-[0.6rem] text-muted-foreground/50">
              @{String(fm.assigned || task.assigned).replace(/^\[\[|\]\]$/g, "")}
            </span>
          )}
          {(fm.due || task.due) && (
            <span className="flex-shrink-0 font-mono text-[0.6rem] text-muted-foreground/60">
              {fm.due || task.due}
            </span>
          )}
          {priorityClass && (
            <Badge text={fm.priority} colorClass={priorityClass} />
          )}
          <Badge text={task.status} colorClass={statusClass} />
          <div className="flex-shrink-0">
            <Select
              value={task.status}
              onValueChange={(val) => onStatusChange(task.path, val)}
              disabled={isUpdating}
            >
              <SelectTrigger className="h-6 w-[6.5rem] font-mono text-[0.6rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-gold-dim bg-[#0A0A0A]">
                {STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {isUpdating && (
            <Loader2 className="h-3 w-3 animate-spin text-gold" />
          )}
        </div>
      </div>

      {isExpanded && <TaskDetail path={task.path} onRefetch={onRefetch} />}
    </div>
  );
}

function TaskDetail({ path, onRefetch }: { path: string; onRefetch: () => void }) {
  const { data, isLoading, error } = useQuery(getTaskDetail, { path });
  const [instructions, setInstructions] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  if (isLoading) {
    return (
      <div className="border-t border-gold-dim/10 px-3 py-4">
        <div className="flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-gold" />
          <span className="font-mono text-xs text-muted-foreground">Loading detail...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border-t border-gold-dim/10 px-3 py-4">
        <p className="font-mono text-xs text-red-400">Failed to load detail</p>
      </div>
    );
  }

  const fm = data?.frontmatter ?? {};
  const body = data?.body ?? "";

  const currentInstructions = instructions ?? fm.alfred_instructions ?? "";

  const handleSaveInstructions = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateTask({ path, set: { alfred_instructions: currentInstructions } });
      setSaved(true);
      onRefetch();
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      console.error("Failed to save instructions:", err);
    } finally {
      setSaving(false);
    }
  };

  const dependsOn: string[] = Array.isArray(fm.depends_on) ? fm.depends_on : [];
  const blockedBy: string[] = Array.isArray(fm.blocked_by) ? fm.blocked_by : [];
  const tags: string[] = Array.isArray(fm.tags) ? fm.tags : [];
  const statusClass = STATUS_COLORS[fm.status] ?? STATUS_COLORS.queued;
  const priorityClass = fm.priority ? PRIORITY_COLORS[fm.priority] : null;
  const kindClass = fm.kind ? KIND_COLORS[fm.kind] : null;

  return (
    <div className="border-t border-gold-dim/10 px-4 py-4 space-y-4">
      {/* Top badges row */}
      <div className="flex flex-wrap items-center gap-2">
        {fm.status && <Badge text={fm.status} colorClass={statusClass} />}
        {priorityClass && <Badge text={fm.priority} colorClass={priorityClass} />}
        {kindClass && <Badge text={fm.kind} colorClass={kindClass} />}
        <TierBadge tier={fm.tier} />
        {fm.requires_approval && (
          <Badge text="Approval Required" colorClass="border-amber-500/40 bg-amber-500/10 text-amber-400" />
        )}
        {fm.created_by && (
          <Badge text={`via ${fm.created_by}`} colorClass="border-zinc-500/30 bg-zinc-500/10 text-zinc-400" />
        )}
      </div>

      {/* Description */}
      {fm.description && (
        <div>
          <FieldLabel>Description</FieldLabel>
          <p className="font-mono text-[0.7rem] leading-relaxed text-muted-foreground">
            {fm.description}
          </p>
        </div>
      )}

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {fm.owner && (
          <div>
            <FieldLabel>Owner</FieldLabel>
            <p className="font-mono text-[0.7rem] text-cream/80">{fm.owner}</p>
          </div>
        )}
        {fm.project && (
          <div>
            <FieldLabel>Project</FieldLabel>
            <p className="font-mono text-[0.7rem] text-cream/80">
              {String(fm.project).replace(/^\[\[|\]\]$/g, "")}
            </p>
          </div>
        )}
        {fm.assigned && (
          <div>
            <FieldLabel>Assigned</FieldLabel>
            <p className="font-mono text-[0.7rem] text-cream/80">
              {String(fm.assigned).replace(/^\[\[|\]\]$/g, "")}
            </p>
          </div>
        )}
        {fm.due && (
          <div>
            <FieldLabel>Due</FieldLabel>
            <p className="font-mono text-[0.7rem] text-cream/80">{fm.due}</p>
          </div>
        )}
        {fm.skill_entry && (
          <div>
            <FieldLabel>Skill</FieldLabel>
            <p className="font-mono text-[0.7rem] text-blue-400/80">{fm.skill_entry}</p>
          </div>
        )}
        {fm.source_instinct && (
          <div>
            <FieldLabel>Source Instinct</FieldLabel>
            <p className="font-mono text-[0.7rem] text-purple-400/80">{fm.source_instinct}</p>
          </div>
        )}
        {fm.budget_turns && (
          <div>
            <FieldLabel>Budget</FieldLabel>
            <p className="font-mono text-[0.7rem] text-cream/80">{fm.budget_turns} turns</p>
          </div>
        )}
        {fm.run && (
          <div>
            <FieldLabel>Run</FieldLabel>
            <p className="font-mono text-[0.7rem] text-cream/80">
              {String(fm.run).replace(/^\[\[|\]\]$/g, "")}
            </p>
          </div>
        )}
        {fm.created && (
          <div>
            <FieldLabel>Created</FieldLabel>
            <p className="font-mono text-[0.7rem] text-cream/80">{fm.created}</p>
          </div>
        )}
      </div>

      {/* Dependencies */}
      {dependsOn.length > 0 && (
        <div>
          <FieldLabel>Depends On</FieldLabel>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {dependsOn.map((dep, i) => (
              <span key={i} className="rounded-sm border border-zinc-600/30 bg-zinc-800/30 px-2 py-0.5 font-mono text-[0.6rem] text-muted-foreground">
                {String(dep).replace(/^\[\[|\]\]$/g, "")}
              </span>
            ))}
          </div>
        </div>
      )}
      {blockedBy.length > 0 && (
        <div>
          <FieldLabel>Blocked By</FieldLabel>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {blockedBy.map((dep, i) => (
              <span key={i} className="rounded-sm border border-red-500/20 bg-red-500/5 px-2 py-0.5 font-mono text-[0.6rem] text-red-400/80">
                {String(dep).replace(/^\[\[|\]\]$/g, "")}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <div>
          <FieldLabel>Tags</FieldLabel>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {tags.map((tag, i) => (
              <span key={i} className="rounded-full border border-gold-dim/30 bg-gold/5 px-2 py-0.5 font-mono text-[0.55rem] text-gold/80">
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Alfred Instructions — Star Feature */}
      <div className="rounded-sm border border-gold/30 bg-gold/[0.03] p-3 space-y-2">
        <div>
          <div className="flex items-center gap-2">
            <Zap className="h-3.5 w-3.5 text-gold" />
            <span className="font-serif text-sm font-medium text-gold">
              Alfred Instructions
            </span>
          </div>
          <p className="mt-0.5 font-mono text-[0.6rem] text-muted-foreground/60">
            Tell Alfred how to handle this task
          </p>
        </div>
        <textarea
          className="w-full rounded-sm border border-gold/20 bg-black/40 px-3 py-2 font-mono text-xs leading-relaxed text-cream placeholder:text-muted-foreground/30 focus:border-gold/50 focus:outline-none focus:ring-1 focus:ring-gold/20 resize-y min-h-[4rem]"
          rows={3}
          placeholder="e.g. Research this topic and draft a summary, then notify me when done..."
          value={currentInstructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSaveInstructions}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-sm border border-gold/30 bg-gold/10 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wider text-gold transition-colors hover:bg-gold/20 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            {saving ? "Saving..." : saved ? "Saved" : "Save Instructions"}
          </button>
          {saved && (
            <span className="font-mono text-[0.6rem] text-emerald-400">Saved</span>
          )}
        </div>
      </div>

      {/* Janitor Note */}
      {fm.janitor_note && (
        <div className="rounded-sm border border-zinc-700/30 bg-zinc-800/20 px-3 py-2">
          <FieldLabel>Janitor Note</FieldLabel>
          <p className="font-mono text-[0.65rem] leading-relaxed text-muted-foreground/60">
            {fm.janitor_note}
          </p>
        </div>
      )}

      {/* Distiller Learnings */}
      {fm.distiller_learnings && Array.isArray(fm.distiller_learnings) && fm.distiller_learnings.length > 0 && (
        <div className="rounded-sm border border-zinc-700/30 bg-zinc-800/20 px-3 py-2">
          <FieldLabel>Distiller Learnings</FieldLabel>
          <ul className="mt-1 space-y-0.5">
            {fm.distiller_learnings.map((l: string, i: number) => (
              <li key={i} className="font-mono text-[0.65rem] text-muted-foreground/60">
                &bull; {l}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Body */}
      {body && (
        <div className="rounded-sm bg-[#0A0A0A] px-3 py-2">
          <p className="whitespace-pre-wrap font-mono text-[0.65rem] leading-relaxed text-muted-foreground/80">
            {body}
          </p>
        </div>
      )}

      {!fm.description && !body && tags.length === 0 && !fm.alfred_instructions && (
        <p className="font-mono text-xs text-muted-foreground/50">No additional details</p>
      )}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[0.6rem] font-light uppercase tracking-[0.15em] text-muted-foreground/60">
      {children}
    </span>
  );
}
