import { useState } from "react";
import { useQuery, getTasks, getIntuitionQueue, getTriage, getMatters, updateTask, getQuarantine, retryQuarantine, dismissQuarantine, getSessions, getLedgerEntries, promoteTriage, createVaultRecord } from "wasp/client/operations";
import DashboardLayout from "../dashboard/DashboardLayout";
import { TasksContent } from "../tasks/TasksPage";
import {
  LearningContent,
  JudgmentContent,
  IntuitionActivityContent,
  timeAgo,
} from "../intuition/IntuitionPage";
import {
  Brain,
  ClipboardCheck,
  BookOpen,
  Scale,
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
} from "lucide-react";
import SpotlightCard from "../components/ui/SpotlightCard";

type IntelligenceTab = "errands" | "triage" | "matters" | "learning" | "judgment" | "activity" | "quarantine";

const TABS: { key: IntelligenceTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "errands", label: "Errands", icon: ClipboardCheck },
  { key: "triage", label: "Triage", icon: Inbox },
  { key: "matters", label: "Matters", icon: Briefcase },
  { key: "learning", label: "Learning", icon: BookOpen },
  { key: "judgment", label: "Judgment", icon: Scale },
  { key: "activity", label: "Activity", icon: Activity },
  { key: "quarantine", label: "Quarantine", icon: AlertTriangle },
];

export default function IntelligencePage() {
  const [activeTab, setActiveTab] = useState<IntelligenceTab>("errands");

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
    if (tab === "errands" && approvalCount > 0) return approvalCount;
    if (tab === "triage" && triageCount > 0) return triageCount;
    if (tab === "matters" && mattersOpenCount > 0) return mattersOpenCount;
    if (tab === "judgment" && queueCount > 0) return queueCount;
    if (tab === "quarantine" && quarantineCount > 0) return quarantineCount;
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
      <div className="mb-6 flex border-b border-gold-dim/20">
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

      {/* Tab Content */}
      {activeTab === "errands" && (
        <div className="space-y-6">
          <CreateErrandForm />
          <TasksContent />
          <LedgerSection />
        </div>
      )}
      {activeTab === "triage" && <TriageContent />}
      {activeTab === "matters" && <MattersContent />}
      {activeTab === "learning" && <LearningContent />}
      {activeTab === "judgment" && <JudgmentContent />}
      {activeTab === "activity" && <ActivityTab />}
      {activeTab === "quarantine" && <QuarantineContent />}
    </DashboardLayout>
  );
}

/* ------------------------------------------------------------------ */
/*  Create Errand inline form                                         */
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
/*  Priority colors (shared)                                          */
/* ------------------------------------------------------------------ */

const PRIORITY_COLORS: Record<string, string> = {
  low: "border-zinc-500/40 bg-zinc-500/10 text-zinc-400",
  medium: "border-gold/40 bg-gold/10 text-gold",
  high: "border-orange-500/40 bg-orange-500/10 text-orange-400",
  urgent: "border-red-500/40 bg-red-500/10 text-red-400",
};

/* ------------------------------------------------------------------ */
/*  Triage with "Convert to Errand" button                            */
/* ------------------------------------------------------------------ */

function TriageContent() {
  const { data, isLoading, error, refetch } = useQuery(getTriage, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const [dismissingPath, setDismissingPath] = useState<string | null>(null);
  const [convertingPath, setConvertingPath] = useState<string | null>(null);

  const items: any[] = data?.results ?? [];

  const handleDismiss = async (path: string) => {
    setDismissingPath(path);
    try {
      await updateTask({ path, set: { status: "dismissed" } });
      refetch();
    } catch (err: any) {
      console.error("Dismiss failed:", err);
    } finally {
      setDismissingPath(null);
    }
  };

  const handleConvertToErrand = async (path: string) => {
    setConvertingPath(path);
    try {
      await promoteTriage({ triagePath: path, owner: "human" });
      refetch();
    } catch (err: any) {
      console.error("Convert to errand failed:", err);
    } finally {
      setConvertingPath(null);
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

        return (
          <div
            key={item.path}
            className="flex items-center gap-3 rounded-sm border border-gold-dim/20 bg-black/20 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
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
                onClick={() => handleConvertToErrand(item.path)}
                disabled={isActioning}
                className="flex items-center gap-1 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-emerald-400 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
              >
                {convertingPath === item.path ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <ArrowRight className="h-3 w-3" />
                )}
                Convert to Errand
              </button>
              <button
                type="button"
                onClick={() => handleDismiss(item.path)}
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
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Matters — with Create, detail accordion, linked errands           */
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

  const STATUS_COLORS: Record<string, string> = {
    open: "border-blue-500/40 bg-blue-500/10 text-blue-400",
    resolved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  };

  return (
    <div className="space-y-4">
      <CreateMatterForm />

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
            const statusClass = STATUS_COLORS[status] ?? STATUS_COLORS.open;
            const isExpanded = expandedPath === item.path;
            const created = fm.created || item.created;

            // Linked errands: filter tasks whose matter field includes this matter's name
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
                    {linkedErrands.length > 0 && (
                      <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                        {linkedErrands.length} linked errand{linkedErrands.length > 1 ? "s" : ""}
                      </span>
                    )}
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
                    {/* Matter metadata */}
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
/*  Create Matter inline form                                         */
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
/*  Activity tab                                                      */
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
/*  Ledger section                                                    */
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
/*  Quarantine                                                        */
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
