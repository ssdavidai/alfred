import { useState } from "react";
import { useQuery, getTasks, getIntuitionQueue } from "wasp/client/operations";
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
  ClipboardList,
  BookOpen,
  Scale,
  Activity,
  Clock,
} from "lucide-react";

type IntelligenceTab = "tasks" | "learning" | "judgment" | "activity";

const TABS: { key: IntelligenceTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "tasks", label: "Tasks", icon: ClipboardList },
  { key: "learning", label: "Learning", icon: BookOpen },
  { key: "judgment", label: "Judgment", icon: Scale },
  { key: "activity", label: "Activity", icon: Activity },
];

export default function IntelligencePage() {
  const [activeTab, setActiveTab] = useState<IntelligenceTab>("tasks");

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
  const approvalCount = tasks.filter(
    (t: any) =>
      (t.frontmatter?.requires_approval || t.requires_approval) &&
      (t.status === "queued" || t.status === "todo"),
  ).length;
  const queueCount = queueData?.items?.length ?? 0;

  const tabBadge = (tab: IntelligenceTab): number | null => {
    if (tab === "tasks" && approvalCount > 0) return approvalCount;
    if (tab === "judgment" && queueCount > 0) return queueCount;
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
        Alfred&apos;s unified intelligence view — tasks, learning, judgment, and activity in one place.
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
      {activeTab === "tasks" && <TasksContent />}
      {activeTab === "learning" && <LearningContent />}
      {activeTab === "judgment" && <JudgmentContent />}
      {activeTab === "activity" && <ActivityTab />}
    </DashboardLayout>
  );
}

function ActivityTab() {
  const { data: tasksData, isLoading: tasksLoading } = useQuery(getTasks, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const tasks: any[] = tasksData?.results ?? [];

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

      {/* Task Events Timeline */}
      <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-4">
        <h2 className="mb-3 font-serif text-base font-light text-cream">Task Events</h2>
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
      </div>
    </div>
  );
}
