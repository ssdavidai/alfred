import { useState } from "react";
import {
  useQuery,
  getTasks,
  getTaskDetail,
  getIntuitionQueue,
  getTriage,
  getMatters,
  updateTask,
  updateTaskStatus,
  getQuarantine,
  retryQuarantine,
  dismissQuarantine,
  getSessions,
  getLedgerEntries,
  promoteTriage,
  createVaultRecord,
  triggerErrandExecution,
  getSchedules,
  triggerSchedule,
  pauseSchedule,
  resumeSchedule,
} from "wasp/client/operations";
import DashboardLayout from "../dashboard/DashboardLayout";
import {
  LearningContent,
  JudgmentContent,
  IntuitionActivityContent,
  timeAgo,
} from "../intuition/IntuitionPage";
import ChoresContent from "./ChoresContent";
import {
  Brain,
  ClipboardCheck,
  Activity,
  Clock,
  Inbox,
  Briefcase,
  ExternalLink,
  XCircle,
  Loader2,
  AlertTriangle,
  RotateCcw,
  Trash2,
  FolderOpen,
  BookMarked,
  ArrowRight,
  Plus,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  Link,
  Play,
  Pause,
  Zap,
  Save,
  Settings,
  ShieldAlert,
  User,
  CalendarClock,
} from "lucide-react";
import SpotlightCard from "../components/ui/SpotlightCard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../client/components/ui/select";

// Plan E: streamlined to 5 user-facing tabs.
// - Inbox absorbs the old Triage tab
// - Activity absorbs the old Learning, Judgment, and old Activity tabs into one
//   unified "what Alfred has been doing" view
// - Chores still shows generated chores from C.3 (and quarantine state inline)
// - Workflows is moved out of Intelligence — accessible at /dashboard/admin/workflows
// - Quarantine is no longer a separate tab; chore quarantine state is rendered
//   on each chore card in the Chores tab and in the chore detail page
type IntelligenceTab = "inbox" | "matters" | "errands" | "chores" | "activity";

const TABS: { key: IntelligenceTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "inbox", label: "Inbox", icon: Inbox },
  { key: "matters", label: "Matters", icon: Briefcase },
  { key: "errands", label: "Errands", icon: ClipboardCheck },
  { key: "chores", label: "Chores", icon: CalendarClock },
  { key: "activity", label: "Activity", icon: Activity },
];

export default function IntelligencePage() {
  const [activeTab, setActiveTab] = useState<IntelligenceTab>("inbox");

  // Fetch counts for badge indicators
  const { data: tasksData } = useQuery(getTasks, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });
  const { data: queueData } = useQuery(getIntuitionQueue, undefined, {
    refetchInterval: 15_000,
    retry: false,
  });

  const tasks: any[] = tasksData?.results ?? [];
  // Also match legacy "todo" status for pre-Spec 003 vault records
  const approvalCount = tasks.filter(
    (t: any) =>
      (t.frontmatter?.requires_approval || t.requires_approval) &&
      (t.status === "queued" || t.status === "todo"),
  ).length;
  const queueCount = queueData?.items?.length ?? 0;

  const { data: triageData } = useQuery(getTriage, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });
  const triageCount = triageData?.results?.filter((t: any) => t.status !== "dismissed").length ?? 0;

  const { data: mattersData } = useQuery(getMatters, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });
  const mattersOpenCount = mattersData?.results?.filter((m: any) => m.status === "open" || !m.status).length ?? 0;

  const { data: quarantineData } = useQuery(getQuarantine, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });
  const quarantineCount = quarantineData?.items?.length ?? 0;

  const tabBadge = (tab: IntelligenceTab): number | null => {
    // Plan E: tab badges follow the new 5-tab schema. Inbox shows the
    // legacy triage count + the unrouted-learning queue count.
    if (tab === "inbox") {
      const total = triageCount + queueCount;
      return total > 0 ? total : null;
    }
    if (tab === "errands" && approvalCount > 0) return approvalCount;
    if (tab === "matters" && mattersOpenCount > 0) return mattersOpenCount;
    if (tab === "chores" && quarantineCount > 0) return quarantineCount;
    return null;
  };

  return (
    <DashboardLayout>
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <Brain className="h-5 w-5 text-gold" />
        <h1 className="font-serif text-2xl font-light text-cream">Intelligence</h1>
      </div>

      <p className="text-muted-foreground mb-6 text-sm">
        Alfred&apos;s unified intelligence view — errands, learning, judgment, and activity in one place.
      </p>

      {/* Tab Navigation */}
      <div className="mb-6 flex flex-wrap border-b border-gold-dim/20">
        {TABS.map((tab) => {
          const badge = tabBadge(tab.key);
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 border-b-2 px-4 py-2.5 font-mono text-xs transition-colors ${
                activeTab === tab.key
                  ? "border-gold text-gold"
                  : "border-transparent text-muted-foreground hover:text-cream"
              }`}
            >
              <tab.icon className="h-3.5 w-3.5" />
              {tab.label}
              {badge != null && (
                <span className="ml-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-gold/20 px-1 font-mono text-[0.5rem] text-gold">
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content (Plan E: 5-tab schema) */}
      {activeTab === "inbox" && (
        <div className="space-y-6">
          <TriageContent />
        </div>
      )}
      {activeTab === "matters" && <MattersContent />}
      {activeTab === "errands" && (
        <div className="space-y-6">
          <CreateErrandForm />
          <ErrandsContent />
          <LedgerSection />
        </div>
      )}
      {activeTab === "chores" && <ChoresContent />}
      {activeTab === "activity" && (
        // Plan E: unified Activity merges Learning + Judgment + the old
        // Activity tab into one "what Alfred has been doing" view. Each
        // section is collapsible so the page doesn't become a wall of
        // counters.
        <div className="space-y-6">
          <LearningContent />
          <JudgmentContent />
          <ActivityTab />
        </div>
      )}
    </DashboardLayout>
  );
}

/* ------------------------------------------------------------------ */
/*  Status / Priority constants                                        */
/* ------------------------------------------------------------------ */

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
  normal: "border-gold/40 bg-gold/10 text-gold",
  medium: "border-gold/40 bg-gold/10 text-gold",
  high: "border-orange-500/40 bg-orange-500/10 text-orange-400",
  urgent: "border-red-500/40 bg-red-500/10 text-red-400",
};

const OWNER_OPTIONS = [
  { value: "alfred", label: "Alfred" },
  { value: "human", label: "Human" },
];

const PRIORITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

/* ------------------------------------------------------------------ */
/*  Badge helper                                                       */
/* ------------------------------------------------------------------ */

function Badge({ text, colorClass }: { text: string; colorClass: string }) {
  return (
    <span
      className={`inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider ${colorClass}`}
    >
      {text}
    </span>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[0.6rem] font-light uppercase tracking-[0.15em] text-muted-foreground/60">
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Create Errand inline form                                          */
/* ------------------------------------------------------------------ */

function CreateErrandForm() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [priority, setPriority] = useState("normal");
  const [owner, setOwner] = useState("human");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await createVaultRecord({
        type: "task",
        name: name.trim(),
        fields: { status: "queued", owner, priority },
      });
      setName("");
      setPriority("normal");
      setOwner("human");
      setOpen(false);
    } catch (err: any) {
      console.error("Create errand failed:", err);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-sm border border-gold/30 bg-gold/10 px-3 py-2 font-mono text-xs uppercase tracking-wider text-gold transition-colors hover:bg-gold/20"
      >
        <Plus className="h-3.5 w-3.5" />
        Create Errand
      </button>
    );
  }

  return (
    <SpotlightCard>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex items-center gap-2 mb-2">
          <Plus className="h-3.5 w-3.5 text-gold" />
          <span className="font-mono text-xs font-medium text-gold uppercase tracking-wider">New Errand</span>
        </div>
        <input
          type="text"
          placeholder="Errand name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-sm border border-gold/20 bg-black/40 px-3 py-2 font-mono text-xs text-cream placeholder:text-muted-foreground/30 focus:border-gold/50 focus:outline-none focus:ring-1 focus:ring-gold/20"
          autoFocus
        />
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="mb-1 block font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground/60">
              Priority
            </label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="w-full rounded-sm border border-gold/20 bg-black/40 px-2 py-1.5 font-mono text-xs text-cream focus:border-gold/50 focus:outline-none"
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="mb-1 block font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground/60">
              Owner
            </label>
            <select
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              className="w-full rounded-sm border border-gold/20 bg-black/40 px-2 py-1.5 font-mono text-xs text-cream focus:border-gold/50 focus:outline-none"
            >
              <option value="alfred">Alfred</option>
              <option value="human">Human</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="flex items-center gap-1.5 rounded-sm border border-gold/30 bg-gold/10 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wider text-gold transition-colors hover:bg-gold/20 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            {submitting ? "Creating..." : "Create"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-sm px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground transition-colors hover:text-cream"
          >
            Cancel
          </button>
        </div>
      </form>
    </SpotlightCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Errands Content — replaces TasksContent with matter linking,       */
/*  detail panel, and execute-now                                      */
/* ------------------------------------------------------------------ */

type FilterTab = "all" | "queued" | "active" | "blocked" | "done" | "cancelled";

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "queued", label: "Queued" },
  { key: "active", label: "Active" },
  { key: "blocked", label: "Blocked" },
  { key: "done", label: "Done" },
  { key: "cancelled", label: "Cancelled" },
];

function ErrandsContent() {
  const { data, isLoading, error, refetch } = useQuery(getTasks, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const { data: mattersData } = useQuery(getMatters, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const [filter, setFilter] = useState<FilterTab>("all");
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [updatingPath, setUpdatingPath] = useState<string | null>(null);
  const [linkingPath, setLinkingPath] = useState<string | null>(null);
  const [executingAll, setExecutingAll] = useState(false);

  const tasks: any[] = data?.results ?? [];
  const matters: any[] = mattersData?.results ?? [];

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

  // Also match legacy "todo" status for pre-Spec 003 vault records
  const approvalTasks = tasks.filter(
    (t: any) =>
      (t.frontmatter?.requires_approval || t.requires_approval) &&
      (t.status === "queued" || t.status === "todo"),
  );

  const [approvingPath, setApprovingPath] = useState<string | null>(null);

  const handleApprove = async (path: string) => {
    setApprovingPath(path);
    try {
      await updateTask({ path, set: { requires_approval: false, status: "queued" } });
      refetch();
    } catch (err: any) {
      console.error("Approval failed:", err);
    } finally {
      setApprovingPath(null);
    }
  };

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

  const handleLinkMatter = async (errandPath: string, matterName: string) => {
    setLinkingPath(errandPath);
    try {
      await updateTask({ path: errandPath, set: { matter: `[[matter/${matterName}]]` } });
      refetch();
    } catch (err: any) {
      console.error("Link matter failed:", err);
    } finally {
      setLinkingPath(null);
    }
  };

  const handleExecuteNow = async () => {
    setExecutingAll(true);
    try {
      await triggerErrandExecution();
      refetch();
    } catch (err: any) {
      console.error("Trigger execution failed:", err);
    } finally {
      setExecutingAll(false);
    }
  };

  // Check if there are queued alfred-owned errands
  const hasQueuedAlfredErrands = tasks.some(
    (t: any) => t.status === "queued" && (t.frontmatter?.owner === "alfred" || t.owner === "alfred"),
  );

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
                <button
                  type="button"
                  onClick={() => handleApprove(t.path)}
                  disabled={approvingPath === t.path}
                  className="flex items-center gap-1 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  {approvingPath === t.path ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <CheckCircle className="h-3 w-3" />
                  )}
                  Approve
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Execute Now button for queued alfred errands */}
      {hasQueuedAlfredErrands && (
        <div className="mb-4">
          <button
            type="button"
            onClick={handleExecuteNow}
            disabled={executingAll}
            className="flex items-center gap-2 rounded-sm border border-blue-500/30 bg-blue-500/10 px-3 py-2 font-mono text-xs uppercase tracking-wider text-blue-400 transition-colors hover:bg-blue-500/20 disabled:opacity-50"
          >
            {executingAll ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Execute Now — run queued Alfred errands
          </button>
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
          <span className="text-muted-foreground text-sm">Loading errands...</span>
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

          {/* Errand List */}
          {filteredTasks.length === 0 ? (
            <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-8 text-center">
              <ClipboardCheck className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
              <p className="font-mono text-sm text-muted-foreground">
                {filter === "all" ? "No errands yet" : `No ${filter} errands`}
              </p>
              <p className="mt-1 font-mono text-xs text-muted-foreground/50">
                Errands created through Alfred will appear here
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredTasks.map((task: any) => (
                <ErrandRow
                  key={task.path}
                  task={task}
                  matters={matters}
                  isExpanded={expandedPath === task.path}
                  isUpdating={updatingPath === task.path}
                  isLinking={linkingPath === task.path}
                  onToggle={() =>
                    setExpandedPath(expandedPath === task.path ? null : task.path)
                  }
                  onStatusChange={handleStatusChange}
                  onLinkMatter={handleLinkMatter}
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

/* ------------------------------------------------------------------ */
/*  Errand Row — with Link to Matter + Execute Now                     */
/* ------------------------------------------------------------------ */

function ErrandRow({
  task,
  matters,
  isExpanded,
  isUpdating,
  isLinking,
  onToggle,
  onStatusChange,
  onLinkMatter,
  onRefetch,
}: {
  task: any;
  matters: any[];
  isExpanded: boolean;
  isUpdating: boolean;
  isLinking: boolean;
  onToggle: () => void;
  onStatusChange: (path: string, status: string) => void;
  onLinkMatter: (path: string, matterName: string) => void;
  onRefetch: () => void;
}) {
  const fm = task.frontmatter ?? {};
  const statusClass = STATUS_COLORS[task.status] ?? STATUS_COLORS.queued;
  const priorityClass = fm.priority ? PRIORITY_COLORS[fm.priority] : null;
  const hasMatter = !!(fm.matter || task.matter);
  const matterDisplay = hasMatter
    ? String(fm.matter || task.matter).replace(/^\[\[|\]\]$/g, "").replace(/^matter\//, "")
    : null;

  const [showLinkDropdown, setShowLinkDropdown] = useState(false);

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
          <div className="min-w-0 flex-1">
            <span className="truncate font-mono text-xs font-medium text-cream">
              {fm.name || task.name}
            </span>
            {/* Show why_it_matters from B.2 Opus errands */}
            {(fm.why_it_matters || task.body_preview) && (
              <p className="mt-0.5 text-[0.6rem] text-muted-foreground/60 line-clamp-1">
                {fm.why_it_matters || (task.body_preview ? String(task.body_preview).slice(0, 120) : "")}
              </p>
            )}
          </div>
          {(fm.alfred_instructions || task.alfred_instructions) && (
            <Zap className="h-3 w-3 flex-shrink-0 text-gold/70" />
          )}
        </button>

        <div className="flex items-center gap-2">
          {/* Linked matter or Link button */}
          {matterDisplay ? (
            <a
              href={`/dashboard/vault/matter/${encodeURIComponent(matterDisplay)}.md`}
              className="flex-shrink-0 font-mono text-[0.6rem] text-blue-400/70 hover:text-blue-400"
            >
              {matterDisplay}
            </a>
          ) : (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowLinkDropdown(!showLinkDropdown)}
                disabled={isLinking}
                className="flex items-center gap-1 rounded-sm border border-zinc-500/30 bg-zinc-500/10 px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider text-zinc-400 transition-colors hover:bg-zinc-500/20 disabled:opacity-50"
              >
                {isLinking ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Link className="h-2.5 w-2.5" />
                )}
                Link
              </button>
              {showLinkDropdown && matters.length > 0 && (
                <div className="absolute right-0 top-full z-50 mt-1 max-h-40 w-48 overflow-y-auto rounded-sm border border-gold-dim/30 bg-[#0A0A0A] shadow-xl">
                  {matters.map((m: any) => {
                    const mName = m.frontmatter?.name || m.name || m.path;
                    return (
                      <button
                        key={m.path}
                        type="button"
                        onClick={() => {
                          setShowLinkDropdown(false);
                          onLinkMatter(task.path, mName);
                        }}
                        className="block w-full px-3 py-1.5 text-left font-mono text-xs text-cream/80 transition-colors hover:bg-gold-dim/10"
                      >
                        {mName}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

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
              value={task.status === "todo" ? "queued" : task.status}
              onValueChange={(val: string) => onStatusChange(task.path, val)}
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

      {isExpanded && (
        <ErrandDetailPanel path={task.path} task={task} matters={matters} onLinkMatter={onLinkMatter} onRefetch={onRefetch} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Errand Detail Panel (#69) — inline accordion                       */
/* ------------------------------------------------------------------ */

function ErrandDetailPanel({
  path,
  task,
  matters,
  onLinkMatter,
  onRefetch,
}: {
  path: string;
  task: any;
  matters: any[];
  onLinkMatter: (path: string, matterName: string) => void;
  onRefetch: () => void;
}) {
  const { data, isLoading, error } = useQuery(getTaskDetail, { path });
  const [instructions, setInstructions] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [updatingField, setUpdatingField] = useState<string | null>(null);

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

  const handleFieldUpdate = async (field: string, value: string) => {
    setUpdatingField(field);
    try {
      await updateTask({ path, set: { [field]: value } });
      onRefetch();
    } catch (err: any) {
      console.error(`Failed to update ${field}:`, err);
    } finally {
      setUpdatingField(null);
    }
  };

  // Parse action items from body
  const actionItemsMatch = body.match(/## Action Items\n([\s\S]*?)(?=\n## |\n$|$)/);
  const actionItems = actionItemsMatch
    ? actionItemsMatch[1]
        .split("\n")
        .filter((line: string) => line.trim().startsWith("- "))
        .map((line: string) => line.replace(/^- /, "").trim())
    : [];

  // Body without action items section
  const bodyWithoutActions = body.replace(/## Action Items\n[\s\S]*?(?=\n## |\n$|$)/, "").trim();

  const hasMatter = !!(fm.matter || task.matter);
  const matterDisplay = hasMatter
    ? String(fm.matter || task.matter).replace(/^\[\[|\]\]$/g, "").replace(/^matter\//, "")
    : null;
  const sourceTriagePath = fm.source_triage || fm.promoted_from || null;

  const owner = fm.owner || task.owner || "human";
  const priority = fm.priority || "normal";

  return (
    <div className="border-t border-gold-dim/10 px-4 py-4 space-y-4">
      {/* Body content FIRST — the user wants to see what the errand is about,
          not the control fields. For B.2 Opus errands this includes the
          Context, Why it matters, Dependencies, and First action sections. */}
      {bodyWithoutActions && (
        <div className="rounded-sm bg-black/30 p-4">
          <div className="whitespace-pre-line text-sm leading-relaxed text-cream/80">
            {bodyWithoutActions}
          </div>
        </div>
      )}

      {/* Status with change buttons */}
      <div>
        <FieldLabel>Status</FieldLabel>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {STATUS_OPTIONS.map((opt) => {
            const isActive = (fm.status || task.status) === opt.value;
            const optClass = STATUS_COLORS[opt.value] ?? "";
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => !isActive && handleFieldUpdate("status", opt.value)}
                disabled={updatingField === "status"}
                className={`rounded-sm border px-2 py-1 font-mono text-[0.55rem] uppercase tracking-wider transition-colors disabled:opacity-50 ${
                  isActive
                    ? optClass
                    : "border-zinc-700/30 bg-zinc-800/20 text-zinc-500 hover:bg-zinc-700/20"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
          {updatingField === "status" && <Loader2 className="h-3 w-3 animate-spin text-gold" />}
        </div>
      </div>

      {/* Owner toggle */}
      <div>
        <FieldLabel>Owner</FieldLabel>
        <div className="mt-1 flex gap-1.5">
          {OWNER_OPTIONS.map((opt) => {
            const isActive = owner === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => !isActive && handleFieldUpdate("owner", opt.value)}
                disabled={updatingField === "owner"}
                className={`flex items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-[0.55rem] uppercase tracking-wider transition-colors disabled:opacity-50 ${
                  isActive
                    ? opt.value === "alfred"
                      ? "border-gold/40 bg-gold/10 text-gold"
                      : "border-blue-400/40 bg-blue-400/10 text-blue-400"
                    : "border-zinc-700/30 bg-zinc-800/20 text-zinc-500 hover:bg-zinc-700/20"
                }`}
              >
                {opt.value === "alfred" ? <Zap className="h-2.5 w-2.5" /> : <User className="h-2.5 w-2.5" />}
                {opt.label}
              </button>
            );
          })}
          {updatingField === "owner" && <Loader2 className="h-3 w-3 animate-spin text-gold" />}
        </div>
      </div>

      {/* Priority dropdown */}
      <div>
        <FieldLabel>Priority</FieldLabel>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {PRIORITY_OPTIONS.map((opt) => {
            const isActive = priority === opt.value;
            const optClass = PRIORITY_COLORS[opt.value] ?? "";
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => !isActive && handleFieldUpdate("priority", opt.value)}
                disabled={updatingField === "priority"}
                className={`rounded-sm border px-2 py-1 font-mono text-[0.55rem] uppercase tracking-wider transition-colors disabled:opacity-50 ${
                  isActive
                    ? optClass
                    : "border-zinc-700/30 bg-zinc-800/20 text-zinc-500 hover:bg-zinc-700/20"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
          {updatingField === "priority" && <Loader2 className="h-3 w-3 animate-spin text-gold" />}
        </div>
      </div>

      {/* Linked Matter */}
      <div>
        <FieldLabel>Linked Matter</FieldLabel>
        <div className="mt-1">
          {matterDisplay ? (
            <a
              href={`/dashboard/vault/matter/${encodeURIComponent(matterDisplay)}.md`}
              className="inline-flex items-center gap-1.5 rounded-sm border border-blue-400/30 bg-blue-400/10 px-2 py-1 font-mono text-[0.6rem] text-blue-400 transition-colors hover:bg-blue-400/20"
            >
              <Briefcase className="h-2.5 w-2.5" />
              {matterDisplay}
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          ) : (
            <MatterLinkDropdown
              matters={matters}
              onSelect={(matterName: string) => onLinkMatter(path, matterName)}
            />
          )}
        </div>
      </div>

      {/* Source (promoted from triage) */}
      {sourceTriagePath && (
        <div>
          <FieldLabel>Source</FieldLabel>
          <a
            href={`/dashboard/vault/${sourceTriagePath}`}
            className="mt-1 inline-flex items-center gap-1.5 font-mono text-[0.65rem] text-muted-foreground/80 hover:text-cream"
          >
            <Inbox className="h-3 w-3" />
            Promoted from triage
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        </div>
      )}

      {/* Action Items */}
      {actionItems.length > 0 && (
        <div>
          <FieldLabel>Action Items</FieldLabel>
          <ul className="mt-1 space-y-0.5">
            {actionItems.map((item: string, i: number) => (
              <li key={i} className="flex items-start gap-2 font-mono text-[0.65rem] text-cream/80">
                <CheckCircle className="mt-0.5 h-3 w-3 flex-shrink-0 text-muted-foreground/40" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
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
        {fm.created && (
          <div>
            <FieldLabel>Created</FieldLabel>
            <p className="font-mono text-[0.7rem] text-cream/80">{fm.created}</p>
          </div>
        )}
        {fm.created_by && (
          <div>
            <FieldLabel>Created By</FieldLabel>
            <p className="font-mono text-[0.7rem] text-cream/80">{fm.created_by}</p>
          </div>
        )}
      </div>

      {/* Alfred Instructions */}
      <div className="rounded-sm border border-gold/30 bg-gold/[0.03] p-3 space-y-2">
        <div>
          <div className="flex items-center gap-2">
            <Zap className="h-3.5 w-3.5 text-gold" />
            <span className="font-serif text-sm font-medium text-gold">
              Alfred Instructions
            </span>
          </div>
          <p className="mt-0.5 font-mono text-[0.6rem] text-muted-foreground/60">
            Tell Alfred how to handle this errand
          </p>
        </div>
        <textarea
          className="w-full rounded-sm border border-gold/20 bg-black/40 px-3 py-2 font-mono text-xs leading-relaxed text-cream placeholder:text-muted-foreground/30 focus:border-gold/50 focus:outline-none focus:ring-1 focus:ring-gold/20 resize-y min-h-[4rem]"
          rows={3}
          placeholder="e.g. Research this topic and draft a summary, then notify me when done..."
          value={currentInstructions}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInstructions(e.target.value)}
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

      {/* (Body content is now rendered at the top of the panel — see above) */}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Matter Link Dropdown                                               */
/* ------------------------------------------------------------------ */

function MatterLinkDropdown({
  matters,
  onSelect,
}: {
  matters: any[];
  onSelect: (matterName: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (matters.length === 0) {
    return (
      <span className="font-mono text-[0.6rem] text-muted-foreground/40">
        No matters available
      </span>
    );
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-sm border border-zinc-500/30 bg-zinc-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-zinc-400 transition-colors hover:bg-zinc-500/20"
      >
        <Link className="h-3 w-3" />
        Link to Matter
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-40 w-48 overflow-y-auto rounded-sm border border-gold-dim/30 bg-[#0A0A0A] shadow-xl">
          {matters.map((m: any) => {
            const mName = m.frontmatter?.name || m.name || m.path;
            return (
              <button
                key={m.path}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSelect(mName);
                }}
                className="block w-full px-3 py-1.5 text-left font-mono text-xs text-cream/80 transition-colors hover:bg-gold-dim/10"
              >
                {mName}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Triage with "Convert to Errand" button                             */
/* ------------------------------------------------------------------ */

function TriageContent() {
  const { data, isLoading, error, refetch } = useQuery(getTriage, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const [dismissingPath, setDismissingPath] = useState<string | null>(null);
  const [convertingPath, setConvertingPath] = useState<string | null>(null);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<Record<string, string>>({});

  const items: any[] = data?.results ?? [];

  const saveInstructionAndAct = async (path: string, action: "dismiss" | "convert") => {
    const instruction = instructions[path]?.trim();
    // If user wrote an instruction, save it to the triage record first
    if (instruction) {
      try {
        await updateTask({ path, set: { alfred_instructions: instruction } });
      } catch {
        // Non-fatal — continue with the action even if instruction save fails
      }
    }
    if (action === "dismiss") {
      setDismissingPath(path);
      try {
        await updateTask({ path, set: { status: "dismissed" } });
        refetch();
      } catch (err: any) {
        console.error("Dismiss failed:", err);
      } finally {
        setDismissingPath(null);
      }
    } else {
      setConvertingPath(path);
      try {
        await promoteTriage({ triagePath: path, owner: "human" });
        refetch();
      } catch (err: any) {
        console.error("Convert to errand failed:", err);
      } finally {
        setConvertingPath(null);
      }
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8">
        <Loader2 className="h-5 w-5 animate-spin text-gold" />
        <span className="text-muted-foreground text-sm">Loading triage items...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 text-destructive rounded-sm p-4">
        <p>{error.message}</p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <SpotlightCard>
        <div className="text-center py-4">
          <Inbox className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
          <p className="font-mono text-sm text-muted-foreground">No triage items</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground/50">
            Incoming items that need review will appear here
          </p>
        </div>
      </SpotlightCard>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item: any) => {
        const fm = item.frontmatter ?? {};
        const name = fm.name || item.name || item.path;
        const source = fm.source || fm.created_by || "unknown";
        const priority = fm.priority;
        const received = fm.created || fm.received || item.created;
        const priorityClass = priority ? PRIORITY_COLORS[priority] : null;
        const isActioning = dismissingPath === item.path || convertingPath === item.path;

        const isExpanded = expandedPath === item.path;
        const currentInstruction = instructions[item.path] || "";

        return (
          <div
            key={item.path}
            className="rounded-sm border border-gold-dim/20 bg-black/20"
          >
            <div className="flex items-center gap-3 px-3 py-2.5">
              <div
                className="min-w-0 flex-1 cursor-pointer"
                onClick={() => setExpandedPath(isExpanded ? null : item.path)}
              >
                <p className="truncate font-mono text-xs font-medium text-cream">
                  {name}
                </p>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                    {source}
                  </span>
                  {priority && priorityClass && (
                    <span
                      className={`inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider ${priorityClass}`}
                    >
                      {priority}
                    </span>
                  )}
                  {received && (
                    <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                      {timeAgo(received)}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={`/dashboard/vault/${item.path}`}
                  className="flex items-center gap-1 rounded-sm border border-gold/30 bg-gold/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-gold transition-colors hover:bg-gold/20"
                >
                  <ExternalLink className="h-3 w-3" />
                  Review
                </a>
                <button
                  type="button"
                  onClick={() => saveInstructionAndAct(item.path, "convert")}
                  disabled={isActioning}
                  className="flex items-center gap-1 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  {convertingPath === item.path ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <ArrowRight className="h-3 w-3" />
                  )}
                  Errand
                </button>
                <button
                  type="button"
                  onClick={() => saveInstructionAndAct(item.path, "dismiss")}
                  disabled={isActioning}
                  className="flex items-center gap-1 rounded-sm border border-zinc-500/30 bg-zinc-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-zinc-400 transition-colors hover:bg-zinc-500/20 disabled:opacity-50"
                >
                  {dismissingPath === item.path ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <XCircle className="h-3 w-3" />
                  )}
                  Dismiss
                </button>
              </div>
            </div>
            {/* Expandable instruction field */}
            {isExpanded && (
              <div className="border-t border-gold-dim/10 px-3 py-2.5">
                <label className="mb-1 block font-mono text-[0.55rem] uppercase tracking-wider text-muted-foreground/60">
                  Teach Alfred (optional) — how should similar items be handled?
                </label>
                <input
                  type="text"
                  value={currentInstruction}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setInstructions((prev: Record<string, string>) => ({ ...prev, [item.path]: e.target.value }))
                  }
                  placeholder="e.g. security alerts from Google — always dismiss, not important"
                  className="w-full rounded-sm border border-gold-dim/20 bg-black/30 px-2 py-1.5 font-mono text-xs text-cream placeholder:text-muted-foreground/30 focus:border-gold/40 focus:outline-none"
                />
                <p className="mt-1 font-mono text-[0.5rem] text-muted-foreground/40">
                  Alfred will learn this pattern and handle similar items automatically over time.
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Matters — with Create, detail accordion, linked errands            */
/* ------------------------------------------------------------------ */

function MattersContent() {
  const { data, isLoading, error, refetch } = useQuery(getMatters, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const { data: tasksData } = useQuery(getTasks, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [resolvingPath, setResolvingPath] = useState<string | null>(null);

  const items: any[] = data?.results ?? [];
  const allTasks: any[] = tasksData?.results ?? [];

  const handleResolve = async (path: string) => {
    setResolvingPath(path);
    try {
      await updateTask({ path, set: { status: "resolved" } });
      refetch();
    } catch (err: any) {
      console.error("Resolve matter failed:", err);
    } finally {
      setResolvingPath(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8">
        <Loader2 className="h-5 w-5 animate-spin text-gold" />
        <span className="text-muted-foreground text-sm">Loading matters...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 text-destructive rounded-sm p-4">
        <p>{error.message}</p>
      </div>
    );
  }

  const MATTER_STATUS_COLORS: Record<string, string> = {
    open: "border-blue-500/40 bg-blue-500/10 text-blue-400",
    resolved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  };

  return (
    <div className="space-y-4">
      <CreateMatterForm />

      {/* Tip about projects */}
      <div className="rounded-sm border border-gold-dim/20 bg-gold/[0.03] px-3 py-2">
        <p className="font-mono text-[0.65rem] text-muted-foreground/60">
          Tip: Projects with active errands can be promoted to matters.
        </p>
      </div>

      {items.length === 0 ? (
        <SpotlightCard>
          <div className="text-center py-4">
            <Briefcase className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
            <p className="font-mono text-sm text-muted-foreground">No matters</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground/50">
              Active matters and cases will appear here
            </p>
          </div>
        </SpotlightCard>
      ) : (
        <div className="space-y-2">
          {items.map((item: any) => {
            const fm = item.frontmatter ?? {};
            const name = fm.name || item.name || item.path;
            const status = fm.status || item.status || "open";
            const statusClass = MATTER_STATUS_COLORS[status] ?? MATTER_STATUS_COLORS.open;
            const isExpanded = expandedPath === item.path;
            const created = fm.created || item.created;

            // Linked errands
            const linkedErrands = allTasks.filter((t: any) => {
              const matterField = t.frontmatter?.matter || t.matter || "";
              return String(matterField).includes(name);
            });

            const doneCount = linkedErrands.filter(
              (t: any) => t.status === "done" || t.status === "cancelled",
            ).length;
            const progressPct = linkedErrands.length > 0
              ? Math.round((doneCount / linkedErrands.length) * 100)
              : 0;

            return (
              <div key={item.path} className="rounded-sm border border-gold-dim/20 bg-black/20">
                <button
                  type="button"
                  onClick={() => setExpandedPath(isExpanded ? null : item.path)}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-gold-dim/5"
                >
                  {isExpanded ? (
                    <ChevronUp className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50" />
                  )}
                  <Briefcase className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs font-medium text-cream">
                      {name}
                    </p>
                    {/* Show description from frontmatter (B.1 Opus matters have rich descriptions) */}
                    {fm.description && (
                      <p className="mt-0.5 text-[0.65rem] text-muted-foreground/70 line-clamp-2">
                        {String(fm.description)}
                      </p>
                    )}
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      {fm.category && (
                        <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                          {String(fm.category)}
                        </span>
                      )}
                      {linkedErrands.length > 0 && (
                        <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                          {linkedErrands.length} errand{linkedErrands.length > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </div>
                  <span
                    className={`inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider ${statusClass}`}
                  >
                    {status}
                  </span>
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t border-gold-dim/10 px-4 py-4 space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <span
                        className={`inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider ${statusClass}`}
                      >
                        {status}
                      </span>
                      {created && (
                        <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                          Created {timeAgo(created)}
                        </span>
                      )}
                    </div>

                    {/* Body content — shows the rich content from Opus matter records */}
                    {item.body_preview && (
                      <div className="rounded-sm bg-black/30 p-3 max-h-[600px] overflow-y-auto">
                        <div className="whitespace-pre-line text-xs leading-relaxed text-cream/70">
                          {String(item.body_preview)
                            .replace(/^#[^\n]*\n+/, "")   /* strip h1 title (already shown above) */
                            .replace(/^>[^\n]*\n+/, "")    /* strip blockquote description (already shown above) */
                          }
                        </div>
                      </div>
                    )}

                    {/* Key people */}
                    {fm.key_people && typeof fm.key_people === "string" && fm.key_people !== "[]" && (
                      <div>
                        <span className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground/60">
                          Key people
                        </span>
                        <p className="mt-1 text-xs text-cream/60">{String(fm.key_people).replace(/^\[|\]$/g, "")}</p>
                      </div>
                    )}

                    {/* Progress bar */}
                    {linkedErrands.length > 0 && (
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <span className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground/60">
                            Progress
                          </span>
                          <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                            {doneCount}/{linkedErrands.length} ({progressPct}%)
                          </span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-zinc-800">
                          <div
                            className="h-1.5 rounded-full bg-gold transition-all"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Linked Errands */}
                    <div>
                      <span className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground/60">
                        Linked Errands
                      </span>
                      {linkedErrands.length === 0 ? (
                        <p className="mt-1 font-mono text-xs text-muted-foreground/40">
                          No errands linked to this matter
                        </p>
                      ) : (
                        <div className="mt-1.5 space-y-1">
                          {linkedErrands.map((errand: any) => {
                            const eFm = errand.frontmatter ?? {};
                            const eName = eFm.name || errand.name || errand.path;
                            const eStatus = errand.status || "queued";
                            const ERRAND_STATUS_COLORS: Record<string, string> = {
                              queued: "border-zinc-500/40 bg-zinc-500/10 text-zinc-400",
                              active: "border-blue-500/40 bg-blue-500/10 text-blue-400",
                              blocked: "border-red-500/40 bg-red-500/10 text-red-400",
                              done: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
                              cancelled: "border-zinc-600/40 bg-zinc-600/10 text-zinc-500",
                            };
                            const eStatusClass = ERRAND_STATUS_COLORS[eStatus] ?? ERRAND_STATUS_COLORS.queued;
                            return (
                              <div
                                key={errand.path}
                                className="flex items-center gap-2 rounded-sm px-2 py-1.5 bg-black/30"
                              >
                                <ClipboardCheck className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" />
                                <span className="min-w-0 flex-1 truncate font-mono text-xs text-cream/80">
                                  {eName}
                                </span>
                                <span
                                  className={`inline-flex rounded-sm border px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider ${eStatusClass}`}
                                >
                                  {eStatus}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Resolve button */}
                    {status !== "resolved" && (
                      <button
                        type="button"
                        onClick={() => handleResolve(item.path)}
                        disabled={resolvingPath === item.path}
                        className="flex items-center gap-1.5 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wider text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                      >
                        {resolvingPath === item.path ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <CheckCircle className="h-3 w-3" />
                        )}
                        Resolve Matter
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Create Matter inline form                                          */
/* ------------------------------------------------------------------ */

function CreateMatterForm() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await createVaultRecord({
        type: "matter",
        name: name.trim(),
        fields: { status: "open" },
        ...(description.trim() ? { content: description.trim() } : {}),
      });
      setName("");
      setDescription("");
      setOpen(false);
    } catch (err: any) {
      console.error("Create matter failed:", err);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-sm border border-gold/30 bg-gold/10 px-3 py-2 font-mono text-xs uppercase tracking-wider text-gold transition-colors hover:bg-gold/20"
      >
        <Plus className="h-3.5 w-3.5" />
        Create Matter
      </button>
    );
  }

  return (
    <SpotlightCard>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex items-center gap-2 mb-2">
          <Briefcase className="h-3.5 w-3.5 text-gold" />
          <span className="font-mono text-xs font-medium text-gold uppercase tracking-wider">New Matter</span>
        </div>
        <input
          type="text"
          placeholder="Matter name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-sm border border-gold/20 bg-black/40 px-3 py-2 font-mono text-xs text-cream placeholder:text-muted-foreground/30 focus:border-gold/50 focus:outline-none focus:ring-1 focus:ring-gold/20"
          autoFocus
        />
        <textarea
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-sm border border-gold/20 bg-black/40 px-3 py-2 font-mono text-xs text-cream placeholder:text-muted-foreground/30 focus:border-gold/50 focus:outline-none focus:ring-1 focus:ring-gold/20 resize-y"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="flex items-center gap-1.5 rounded-sm border border-gold/30 bg-gold/10 px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wider text-gold transition-colors hover:bg-gold/20 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            {submitting ? "Creating..." : "Create"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-sm px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground transition-colors hover:text-cream"
          >
            Cancel
          </button>
        </div>
      </form>
    </SpotlightCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Activity tab                                                       */
/* ------------------------------------------------------------------ */

function ActivityTab() {
  const { data: tasksData, isLoading: tasksLoading } = useQuery(getTasks, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const { data: sessionsData, isLoading: sessionsLoading } = useQuery(getSessions, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const tasks: any[] = tasksData?.results ?? [];
  const sessions: any[] = sessionsData?.results ?? [];

  // Build a unified timeline from task events
  const taskEvents = tasks
    .filter((t: any) => t.frontmatter?.created || t.created)
    .map((t: any) => ({
      id: `task-${t.path}`,
      type: "task" as const,
      description: `Task ${t.status}: ${t.frontmatter?.name || t.name}`,
      timestamp: t.frontmatter?.created || t.created || "",
      source: t.frontmatter?.created_by || "unknown",
    }));

  return (
    <div className="space-y-4">
      <IntuitionActivityContent />

      {/* Recent Sessions */}
      <SpotlightCard title="Recent Sessions" icon={<FolderOpen className="h-4 w-4 text-gold" />}>
        {sessionsLoading ? (
          <div className="flex items-center gap-2 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-gold" />
            <span className="text-muted-foreground font-mono text-xs">Loading sessions...</span>
          </div>
        ) : sessions.length === 0 ? (
          <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
            No sessions recorded yet
          </p>
        ) : (
          <div className="space-y-1.5">
            {sessions.map((session: any) => {
              const fm = session.frontmatter ?? {};
              const name = fm.name || session.name || session.path;
              const recordCount = fm.record_count ?? fm.records ?? 0;
              const date = fm.created || fm.date || session.created;
              return (
                <a
                  key={session.path}
                  href={`/dashboard/vault/${session.path}`}
                  className="flex items-center gap-3 rounded-sm px-3 py-2 transition-colors hover:bg-gold-dim/5"
                >
                  <FolderOpen className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs text-cream/80">{name}</p>
                    <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                      {recordCount} record{recordCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                  {date && (
                    <span className="flex-shrink-0 font-mono text-[0.55rem] text-muted-foreground/40">
                      {timeAgo(date)}
                    </span>
                  )}
                </a>
              );
            })}
          </div>
        )}
      </SpotlightCard>

      {/* Task Events Timeline */}
      <SpotlightCard title="Task Events">
        {tasksLoading ? (
          <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
            Loading task events...
          </p>
        ) : taskEvents.length === 0 ? (
          <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
            No task events yet
          </p>
        ) : (
          <div className="space-y-1.5">
            {taskEvents.map((event) => (
              <div
                key={event.id}
                className="flex items-center gap-3 rounded-sm px-3 py-2"
              >
                <Clock className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-cream/80">
                    {event.description}
                  </p>
                  <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                    {event.source}
                  </span>
                </div>
                {event.timestamp && (
                  <span className="flex-shrink-0 font-mono text-[0.55rem] text-muted-foreground/40">
                    {timeAgo(event.timestamp)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </SpotlightCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Workflows tab (#71) — Temporal schedules                           */
/* ------------------------------------------------------------------ */

function WorkflowsContent() {
  const { data, isLoading, error, refetch } = useQuery(getSchedules, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const [actioningId, setActioningId] = useState<string | null>(null);

  const schedules: any[] = data?.schedules ?? data?.items ?? (Array.isArray(data) ? data : []);

  const handleTrigger = async (id: string) => {
    setActioningId(`trigger-${id}`);
    try {
      await triggerSchedule({ id });
      refetch();
    } catch (err: any) {
      console.error("Trigger schedule failed:", err);
    } finally {
      setActioningId(null);
    }
  };

  const handlePause = async (id: string) => {
    setActioningId(`pause-${id}`);
    try {
      await pauseSchedule({ id });
      refetch();
    } catch (err: any) {
      console.error("Pause schedule failed:", err);
    } finally {
      setActioningId(null);
    }
  };

  const handleResume = async (id: string) => {
    setActioningId(`resume-${id}`);
    try {
      await resumeSchedule({ id });
      refetch();
    } catch (err: any) {
      console.error("Resume schedule failed:", err);
    } finally {
      setActioningId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8">
        <Loader2 className="h-5 w-5 animate-spin text-gold" />
        <span className="text-muted-foreground text-sm">Loading workflows...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 text-destructive rounded-sm p-4">
        <p>{error.message}</p>
      </div>
    );
  }

  if (schedules.length === 0) {
    return (
      <SpotlightCard>
        <div className="text-center py-4">
          <Settings className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
          <p className="font-mono text-sm text-muted-foreground">No scheduled workflows</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground/50">
            Temporal workflow schedules will appear here
          </p>
        </div>
      </SpotlightCard>
    );
  }

  return (
    <div className="space-y-2">
      {schedules.map((schedule: any) => {
        // D.2 fix: defensive shape extraction. Temporal's schedule list
        // returns workflowType as `{name: "..."}` not a string, and rendering
        // an object as a JSX child throws "Objects are not valid as a React
        // child". Same risk for any nested timestamp/state field. Coerce
        // every rendered value to a string here so a future Temporal
        // schema change can't crash the whole tab again.
        const id = String(
          schedule.scheduleId || schedule.id || schedule.name || "unknown",
        );

        // workflowType can be: a string (older APIs), {name: string} (current
        // Temporal Cloud SDK output), or undefined.
        const rawWorkflowType =
          schedule.workflowType ??
          schedule.workflow_type ??
          schedule.info?.workflowType ??
          null;
        const workflowType =
          typeof rawWorkflowType === "string"
            ? rawWorkflowType
            : rawWorkflowType?.name
              ? String(rawWorkflowType.name)
              : "Unknown";

        const isPaused = Boolean(schedule.paused ?? schedule.info?.paused ?? false);

        // futureActionTimes / recentActions are arrays; their elements may be
        // proto timestamps with seconds/nanos or already-stringified ISO. Coerce.
        const _coerceTime = (v: any): string | null => {
          if (!v) return null;
          if (typeof v === "string") return v;
          if (typeof v === "number") return new Date(v * 1000).toISOString();
          // Proto timestamp shape: {seconds: ..., nanos: ...}
          if (typeof v === "object" && typeof v.seconds === "number") {
            return new Date(v.seconds * 1000).toISOString();
          }
          // Already a Date-like object
          if (typeof v === "object" && typeof v.toISOString === "function") {
            try {
              return v.toISOString();
            } catch {
              return null;
            }
          }
          return null;
        };
        const nextRun = _coerceTime(
          schedule.nextActionTime ??
            schedule.next_run ??
            schedule.info?.nextActionTimes?.[0],
        );
        const lastRun = _coerceTime(
          schedule.lastActionTime ??
            schedule.last_run ??
            schedule.info?.recentActions?.[0]?.scheduledAt ??
            schedule.info?.recentActions?.[0]?.actualTime,
        );

        const name = String(schedule.name || schedule.scheduleId || id);

        return (
          <SpotlightCard key={id}>
            <div className="flex items-center gap-3">
              <CalendarClock className="h-4 w-4 flex-shrink-0 text-gold/60" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs font-medium text-cream">
                  {name}
                </p>
                <div className="flex flex-wrap items-center gap-3 mt-0.5">
                  <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                    {workflowType}
                  </span>
                  {isPaused && (
                    <Badge text="Paused" colorClass="border-amber-500/40 bg-amber-500/10 text-amber-400" />
                  )}
                  {!isPaused && (
                    <Badge text="Active" colorClass="border-emerald-500/40 bg-emerald-500/10 text-emerald-400" />
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-4 mt-1">
                  {nextRun && (
                    <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                      Next: {formatScheduleTime(nextRun)}
                    </span>
                  )}
                  {lastRun && (
                    <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                      Last: {formatScheduleTime(lastRun)}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleTrigger(id)}
                  disabled={actioningId === `trigger-${id}`}
                  className="flex items-center gap-1 rounded-sm border border-blue-500/30 bg-blue-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-blue-400 transition-colors hover:bg-blue-500/20 disabled:opacity-50"
                >
                  {actioningId === `trigger-${id}` ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )}
                  Trigger
                </button>
                {isPaused ? (
                  <button
                    type="button"
                    onClick={() => handleResume(id)}
                    disabled={actioningId === `resume-${id}`}
                    className="flex items-center gap-1 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    {actioningId === `resume-${id}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Play className="h-3 w-3" />
                    )}
                    Resume
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handlePause(id)}
                    disabled={actioningId === `pause-${id}`}
                    className="flex items-center gap-1 rounded-sm border border-amber-500/30 bg-amber-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
                  >
                    {actioningId === `pause-${id}` ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Pause className="h-3 w-3" />
                    )}
                    Pause
                  </button>
                )}
              </div>
            </div>
          </SpotlightCard>
        );
      })}
    </div>
  );
}

function formatScheduleTime(ts: string): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

/* ------------------------------------------------------------------ */
/*  Ledger section                                                     */
/* ------------------------------------------------------------------ */

function LedgerSection() {
  const { data, isLoading, error } = useQuery(getLedgerEntries, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const items: any[] = data?.results ?? [];

  if (isLoading) {
    return (
      <SpotlightCard title="Ledger" icon={<BookMarked className="h-4 w-4 text-gold" />}>
        <div className="flex items-center gap-2 py-4">
          <Loader2 className="h-4 w-4 animate-spin text-gold" />
          <span className="text-muted-foreground font-mono text-xs">Loading ledger entries...</span>
        </div>
      </SpotlightCard>
    );
  }

  if (error) {
    return (
      <SpotlightCard title="Ledger" icon={<BookMarked className="h-4 w-4 text-gold" />}>
        <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
          Ledger data not available
        </p>
      </SpotlightCard>
    );
  }

  return (
    <SpotlightCard title="Ledger" icon={<BookMarked className="h-4 w-4 text-gold" />}>
      {items.length === 0 ? (
        <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
          No ledger entries yet
        </p>
      ) : (
        <div className="space-y-1.5">
          {items.map((entry: any) => {
            const fm = entry.frontmatter ?? {};
            const name = fm.name || entry.name || entry.path;
            const outcome = fm.outcome || fm.result || entry.status || "\u2014";
            const date = fm.created || fm.date || entry.created;
            return (
              <a
                key={entry.path}
                href={`/dashboard/vault/${entry.path}`}
                className="flex items-center gap-3 rounded-sm px-3 py-2 transition-colors hover:bg-gold-dim/5"
              >
                <BookMarked className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-cream/80">{name}</p>
                  <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                    outcome: {outcome}
                  </span>
                </div>
                {date && (
                  <span className="flex-shrink-0 font-mono text-[0.55rem] text-muted-foreground/40">
                    {timeAgo(date)}
                  </span>
                )}
              </a>
            );
          })}
        </div>
      )}
    </SpotlightCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Quarantine                                                         */
/* ------------------------------------------------------------------ */

function QuarantineContent() {
  const { data, isLoading, error, refetch } = useQuery(getQuarantine, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const [actioningId, setActioningId] = useState<string | null>(null);

  const items: any[] = data?.items ?? [];

  const handleRetry = async (id: string) => {
    setActioningId(id);
    try {
      await retryQuarantine({ id });
      refetch();
    } catch (err: any) {
      console.error("Retry failed:", err);
    } finally {
      setActioningId(null);
    }
  };

  const handleDismiss = async (id: string) => {
    setActioningId(id);
    try {
      await dismissQuarantine({ id });
      refetch();
    } catch (err: any) {
      console.error("Dismiss failed:", err);
    } finally {
      setActioningId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8">
        <Loader2 className="h-5 w-5 animate-spin text-gold" />
        <span className="text-muted-foreground text-sm">Loading quarantined files...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 text-destructive rounded-sm p-4">
        <p>{error.message}</p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <SpotlightCard>
        <div className="text-center py-4">
          <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
          <p className="font-mono text-sm text-muted-foreground">No quarantined files</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground/50">
            Files that fail processing will appear here for review
          </p>
        </div>
      </SpotlightCard>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item: any) => {
        const filename = item.filename || item.name || item.id;
        const reason = item.reason || "Unknown reason";
        const date = item.quarantined_at || item.created || item.date;

        return (
          <div
            key={item.id}
            className="flex items-center gap-3 rounded-sm border border-gold-dim/20 bg-black/20 px-3 py-2.5"
          >
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-orange-400/60" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs font-medium text-cream">
                {filename}
              </p>
              <div className="flex items-center gap-3">
                <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                  {reason}
                </span>
                {date && (
                  <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                    {timeAgo(date)}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleRetry(item.id)}
                disabled={actioningId === item.id}
                className="flex items-center gap-1 rounded-sm border border-gold/30 bg-gold/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-gold transition-colors hover:bg-gold/20 disabled:opacity-50"
              >
                {actioningId === item.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                Retry
              </button>
              <button
                type="button"
                onClick={() => handleDismiss(item.id)}
                disabled={actioningId === item.id}
                className="flex items-center gap-1 rounded-sm border border-zinc-500/30 bg-zinc-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-zinc-400 transition-colors hover:bg-zinc-500/20 disabled:opacity-50"
              >
                {actioningId === item.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
                Dismiss
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
