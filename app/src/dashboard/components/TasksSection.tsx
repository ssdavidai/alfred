import { Link } from "react-router-dom";
import { useQuery, getTasks } from "wasp/client/operations";
import { Card, CardContent, CardTitle } from "../../client/components/ui/card";
import { ClipboardList, Loader2, ArrowRight, Zap } from "lucide-react";

const STATUS_COLORS: Record<string, string> = {
  todo: "border-zinc-500/40 bg-zinc-500/10 text-zinc-400",
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

export default function TasksSection() {
  const { data, isLoading, error } = useQuery(getTasks, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const allTasks: any[] = data?.results ?? [];

  // Show top 3 actionable tasks (todo/active/blocked), sorted by priority then due date
  const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
  const actionable = allTasks
    .filter((t: any) => t.status === "todo" || t.status === "active" || t.status === "blocked")
    .sort((a: any, b: any) => {
      const pa = priorityOrder[a.frontmatter?.priority ?? a.priority ?? "low"] ?? 3;
      const pb = priorityOrder[b.frontmatter?.priority ?? b.priority ?? "low"] ?? 3;
      if (pa !== pb) return pa - pb;
      if (!a.due && !b.due) return 0;
      if (!a.due) return 1;
      if (!b.due) return -1;
      return new Date(a.due).getTime() - new Date(b.due).getTime();
    })
    .slice(0, 3);

  return (
    <Card className="h-full">
      <CardContent className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-gold" />
            <CardTitle className="font-serif text-base font-light text-cream">
              Tasks
            </CardTitle>
          </div>
          <Link
            to="/dashboard/tasks"
            className="flex items-center gap-1 font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground transition-colors hover:text-gold"
          >
            View all
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-gold" />
            <span className="font-mono text-xs text-muted-foreground">Loading...</span>
          </div>
        )}

        {error && (
          <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
            Unable to load tasks
          </p>
        )}

        {data && !isLoading && actionable.length === 0 && (
          <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
            No active tasks
          </p>
        )}

        {data && !isLoading && actionable.length > 0 && (
          <div className="space-y-3">
            {actionable.map((task: any) => {
              const fm = task.frontmatter ?? {};
              const statusClass = STATUS_COLORS[task.status] ?? STATUS_COLORS.todo;
              const priority = fm.priority || task.priority;
              const priorityClass = priority ? PRIORITY_COLORS[priority] : null;
              const hasAlfredInstructions = !!(fm.alfred_instructions || task.alfred_instructions);

              return (
                <div
                  key={task.path}
                  className="rounded-sm border border-gold-dim/20 bg-black/20 px-3 py-2.5"
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {hasAlfredInstructions && (
                        <Zap className="h-3 w-3 flex-shrink-0 text-gold/70" />
                      )}
                      <p className="truncate font-mono text-xs font-medium text-cream">
                        {fm.name || task.name}
                      </p>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-1.5">
                      {priorityClass && (
                        <span
                          className={`rounded-sm border px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider ${priorityClass}`}
                        >
                          {priority}
                        </span>
                      )}
                      <span
                        className={`rounded-sm border px-1.5 py-0.5 font-mono text-[0.55rem] uppercase tracking-wider ${statusClass}`}
                      >
                        {task.status}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-muted-foreground">
                    {(fm.due || task.due) && (
                      <span className="font-mono text-[0.6rem]">
                        {fm.due || task.due}
                      </span>
                    )}
                    {(fm.project || task.project) && (
                      <span className="font-mono text-[0.6rem] text-muted-foreground/50">
                        {String(fm.project || task.project).replace(/^\[\[|\]\]$/g, "")}
                      </span>
                    )}
                  </div>
                  {hasAlfredInstructions && (
                    <p className="mt-1.5 truncate rounded-sm border border-gold/10 bg-gold/[0.03] px-2 py-1 font-mono text-[0.6rem] text-gold/60">
                      {fm.alfred_instructions || task.alfred_instructions}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
