import { useState } from "react";
import { Navigate } from "react-router-dom";
import {
  useQuery,
  getIntuitionStatus,
  getIntuitionInstincts,
  getIntuitionQueue,
  getObservations,
  getRecentJudgments,
  routeInput,
  enableIntuition,
  disableIntuition,
  updateInstinct,
} from "wasp/client/operations";
import DashboardLayout from "../dashboard/DashboardLayout";
import { Button } from "../client/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../client/components/ui/select";
import { Link } from "react-router-dom";
import { Brain, Loader2, Power, PowerOff, Eye, Zap, Clock, Target, ArrowRight, GitBranch, Pencil, Save, X } from "lucide-react";

const ROUTE_OPTIONS = [
  { value: "task", label: "Task" },
  { value: "event", label: "Event" },
  { value: "note", label: "Note" },
  { value: "inbox", label: "Inbox" },
  { value: "discard", label: "Discard" },
];

export function timeAgo(dateStr: string): string {
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  } catch {
    return "";
  }
}

export function LearningContent() {
  const {
    data: status,
    isLoading: statusLoading,
    error: statusError,
  } = useQuery(getIntuitionStatus, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });
  const {
    data: instincts,
    isLoading: instinctsLoading,
    refetch: refetchInstincts,
  } = useQuery(getIntuitionInstincts, undefined, {
    refetchInterval: 30_000,
    retry: false,
    enabled: !statusError,
  });
  const {
    data: observations,
    isLoading: observationsLoading,
  } = useQuery(getObservations, undefined, {
    refetchInterval: 30_000,
    retry: false,
    enabled: !statusError,
  });

  const [toggling, setToggling] = useState(false);
  const [editingInstinct, setEditingInstinct] = useState<string | null>(null);
  const [editThreshold, setEditThreshold] = useState<string>("");
  const [editStatus, setEditStatus] = useState<string>("active");
  const [savingInstinct, setSavingInstinct] = useState(false);

  const handleToggle = async () => {
    setToggling(true);
    try {
      if (status?.enabled) {
        await disableIntuition();
      } else {
        await enableIntuition();
      }
    } catch (err: any) {
      console.error("Toggle failed:", err);
    } finally {
      setToggling(false);
    }
  };

  const handleEditInstinct = (instinct: any) => {
    setEditingInstinct(instinct.path || instinct.id || instinct.name);
    setEditThreshold(String(instinct.discretionThreshold ?? 0.5));
    setEditStatus(instinct.status || "active");
  };

  const handleSaveInstinct = async (instinct: any) => {
    const path = instinct.path || instinct.id;
    if (!path) return;
    setSavingInstinct(true);
    try {
      await updateInstinct({
        path,
        set: {
          discretion_threshold: parseFloat(editThreshold),
          status: editStatus,
        },
      });
      setEditingInstinct(null);
      refetchInstincts();
    } catch (err: any) {
      console.error("Update instinct failed:", err);
    } finally {
      setSavingInstinct(false);
    }
  };

  const notAvailable = !!statusError;
  const isLoading = statusLoading && !statusError;

  return (
    <>
      {status && (
        <div className="mb-4 flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 font-mono text-xs"
            onClick={handleToggle}
            disabled={toggling || statusLoading}
          >
            {toggling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : status?.enabled ? (
              <PowerOff className="h-3.5 w-3.5" />
            ) : (
              <Power className="h-3.5 w-3.5" />
            )}
            {status?.enabled ? "Disable" : "Enable"}
          </Button>
        </div>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 py-8">
          <Loader2 className="h-5 w-5 animate-spin text-gold" />
          <span className="text-muted-foreground text-sm">Loading learning data...</span>
        </div>
      )}

      {notAvailable && (
        <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-8 text-center">
          <Brain className="mx-auto mb-4 h-10 w-10 text-muted-foreground/30" />
          <h2 className="mb-2 font-serif text-lg font-light text-cream">
            Learning Engine Not Yet Active
          </h2>
          <p className="mx-auto max-w-md font-mono text-xs text-muted-foreground/60">
            The learning engine has not been deployed to your instance yet. Once active, Alfred will
            begin observing your data streams and developing routing instincts.
          </p>
        </div>
      )}

      {status && (
        <div className="space-y-6">
          {/* Status Bar */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatusCard
              icon={<Zap className="h-4 w-4 text-gold" />}
              label="Processed Today"
              value={status.processedToday ?? 0}
            />
            <StatusCard
              icon={<Eye className="h-4 w-4 text-gold" />}
              label="Observations"
              value={typeof status.observations === "object" ? status.observations?.total ?? 0 : status.observations ?? 0}
            />
            <StatusCard
              icon={<Brain className="h-4 w-4 text-gold" />}
              label="Instincts"
              value={typeof status.instincts === "object" ? status.instincts?.active ?? 0 : status.instinctCount ?? 0}
            />
            <StatusCard
              icon={<Target className="h-4 w-4 text-gold" />}
              label="Auto-Route Rate"
              value={`${status.autoRouteRate ?? 0}%`}
            />
          </div>

          {/* Instincts */}
          <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-4">
            <h2 className="mb-3 font-serif text-base font-light text-cream">Instincts</h2>
            {instinctsLoading && !instincts ? (
              <div className="flex items-center gap-2 py-4">
                <Loader2 className="h-4 w-4 animate-spin text-gold" />
                <span className="text-muted-foreground font-mono text-xs">
                  Loading instincts...
                </span>
              </div>
            ) : !instincts?.items?.length ? (
              <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
                No instincts formed yet. Alfred learns from your routing decisions.
              </p>
            ) : (
              <div className="space-y-2">
                {instincts.items.map((instinct: any) => {
                  const instinctKey = instinct.path || instinct.id || instinct.name;
                  const isEditing = editingInstinct === instinctKey;
                  return (
                    <div
                      key={instinctKey}
                      className="rounded-sm border border-gold-dim/10 bg-[#0A0A0A] px-3 py-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="font-mono text-xs font-medium text-cream">{instinct.name}</p>
                          {/* Show description from B.3 Opus instincts (frontmatter.description is the one-liner) */}
                          {(instinct.frontmatter?.description || instinct.description) && (
                            <p className="mt-0.5 text-[0.65rem] text-muted-foreground/70 line-clamp-2">
                              {String(instinct.frontmatter?.description || instinct.description).replace(/^['"]|['"]$/g, "")}
                            </p>
                          )}
                          {/* Show body preview (rationale + examples) when available */}
                          {instinct.body && (
                            <details className="mt-1.5">
                              <summary className="cursor-pointer font-mono text-[0.55rem] text-gold/50 hover:text-gold/80">
                                View rationale &amp; examples
                              </summary>
                              <div className="mt-2 rounded-sm bg-black/30 p-2.5">
                                <p className="whitespace-pre-line text-[0.65rem] leading-relaxed text-cream/60">
                                  {String(instinct.body).replace(/^#[^\n]*\n+/, "").replace(/^>[^\n]*\n+/, "").slice(0, 1200)}
                                </p>
                              </div>
                            </details>
                          )}
                          <div className="mt-1 flex flex-wrap items-center gap-3">
                            <span className="font-mono text-[0.55rem] text-muted-foreground/50">
                              threshold: {instinct.frontmatter?.discretion_threshold ?? instinct.discretionThreshold ?? "\u2014"}
                            </span>
                            {(instinct.frontmatter?.confidence_score ?? instinct.confidenceScore) != null && (
                              <span className="font-mono text-[0.55rem] text-gold/50">
                                confidence: {instinct.frontmatter?.confidence_score ?? instinct.confidenceScore}
                              </span>
                            )}
                            {instinct.status && instinct.status !== "active" && (
                              <span className="inline-flex rounded-sm border border-orange-500/30 bg-orange-500/10 px-1 py-0.5 font-mono text-[0.5rem] uppercase tracking-wider text-orange-400">
                                {instinct.status}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="text-right">
                            <p className="font-mono text-xs text-gold">{instinct.matchCount ?? 0}</p>
                            <p className="font-mono text-[0.55rem] text-muted-foreground/40">matches</p>
                          </div>
                          {!isEditing && (
                            <button
                              type="button"
                              onClick={() => handleEditInstinct(instinct)}
                              className="ml-2 flex items-center gap-1 rounded-sm border border-gold-dim/20 bg-black/30 px-1.5 py-1 font-mono text-[0.6rem] text-muted-foreground transition-colors hover:border-gold/30 hover:text-gold"
                            >
                              <Pencil className="h-2.5 w-2.5" />
                              Edit
                            </button>
                          )}
                        </div>
                      </div>
                      {isEditing && (
                        <div className="mt-2 flex items-center gap-3 border-t border-gold-dim/10 pt-2">
                          <div className="flex items-center gap-1.5">
                            <label className="font-mono text-[0.6rem] text-muted-foreground">Threshold</label>
                            <input
                              type="number"
                              min="0"
                              max="1"
                              step="0.05"
                              value={editThreshold}
                              onChange={(e) => setEditThreshold(e.target.value)}
                              className="h-6 w-16 rounded-sm border border-gold-dim/20 bg-black/40 px-1.5 font-mono text-[0.6rem] text-cream outline-none focus:border-gold/40"
                            />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <label className="font-mono text-[0.6rem] text-muted-foreground">Status</label>
                            <select
                              value={editStatus}
                              onChange={(e) => setEditStatus(e.target.value)}
                              className="h-6 rounded-sm border border-gold-dim/20 bg-black/40 px-1.5 font-mono text-[0.6rem] text-cream outline-none focus:border-gold/40"
                            >
                              <option value="active">active</option>
                              <option value="deprecated">deprecated</option>
                            </select>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleSaveInstinct(instinct)}
                            disabled={savingInstinct}
                            className="flex items-center gap-1 rounded-sm border border-gold/30 bg-gold/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-gold transition-colors hover:bg-gold/20 disabled:opacity-50"
                          >
                            {savingInstinct ? (
                              <Loader2 className="h-2.5 w-2.5 animate-spin" />
                            ) : (
                              <Save className="h-2.5 w-2.5" />
                            )}
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingInstinct(null)}
                            className="flex items-center gap-1 rounded-sm border border-zinc-500/30 bg-zinc-500/10 px-2 py-1 font-mono text-[0.6rem] uppercase tracking-wider text-zinc-400 transition-colors hover:bg-zinc-500/20"
                          >
                            <X className="h-2.5 w-2.5" />
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent Observations */}
          <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-4">
            <h2 className="mb-3 font-serif text-base font-light text-cream">Recent Observations</h2>
            {observationsLoading && !observations ? (
              <div className="flex items-center gap-2 py-4">
                <Loader2 className="h-4 w-4 animate-spin text-gold" />
                <span className="text-muted-foreground font-mono text-xs">
                  Loading observations...
                </span>
              </div>
            ) : !observations?.results?.length ? (
              <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
                No observations recorded yet.
              </p>
            ) : (
              <div className="space-y-2">
                {observations.results.map((obs: any) => (
                  <Link
                    key={obs.path || obs.name}
                    to={`/dashboard/vault/${encodeURIComponent(obs.path)}`}
                    className="flex items-center justify-between rounded-sm border border-gold-dim/10 bg-[#0A0A0A] px-3 py-2.5 transition-colors hover:border-gold-dim/30"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs font-medium text-cream">
                        {obs.input_type || obs.name || "Observation"}
                      </p>
                      <div className="flex items-center gap-3">
                        {obs.routing_decision && (
                          <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                            routed to {obs.routing_decision}
                          </span>
                        )}
                        {obs.confidence != null && (
                          <span className="font-mono text-[0.6rem] text-gold/60">
                            confidence: {typeof obs.confidence === "number" ? `${Math.round(obs.confidence * 100)}%` : obs.confidence}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {obs.date && (
                        <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                          {timeAgo(obs.date)}
                        </span>
                      )}
                      <ArrowRight className="h-3 w-3 text-muted-foreground/30" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export function JudgmentContent() {
  const {
    error: statusError,
  } = useQuery(getIntuitionStatus, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });
  const {
    data: queue,
    isLoading: queueLoading,
    refetch: refetchQueue,
  } = useQuery(getIntuitionQueue, undefined, {
    refetchInterval: 15_000,
    retry: false,
    enabled: !statusError,
  });
  const {
    data: recentJudgments,
    isLoading: judgmentsLoading,
  } = useQuery(getRecentJudgments, undefined, {
    refetchInterval: 30_000,
    retry: false,
    enabled: !statusError,
  });

  const [routingId, setRoutingId] = useState<string | null>(null);

  const handleRoute = async (inputId: string, destination: string) => {
    setRoutingId(inputId);
    try {
      await routeInput({ input_id: inputId, destination });
      refetchQueue();
    } catch (err: any) {
      console.error("Route failed:", err);
    } finally {
      setRoutingId(null);
    }
  };

  const notAvailable = !!statusError;

  // Filter to only observations that have been routed (have routed_by set)
  const routedItems = (recentJudgments?.results ?? []).filter(
    (obs: any) => obs.routed_by || obs.routing_decision,
  );

  if (notAvailable) {
    return (
      <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-8 text-center">
        <Brain className="mx-auto mb-4 h-10 w-10 text-muted-foreground/30" />
        <h2 className="mb-2 font-serif text-lg font-light text-cream">
          Judgment Not Yet Active
        </h2>
        <p className="mx-auto max-w-md font-mono text-xs text-muted-foreground/60">
          The learning engine has not been deployed to your instance yet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-4">
        <h2 className="mb-3 font-serif text-base font-light text-cream">Awaiting Judgment</h2>
        <p className="text-muted-foreground mb-4 text-xs">
          Inputs that haven&apos;t been auto-routed yet. Route each item to its destination.
        </p>
        {queueLoading && !queue ? (
          <div className="flex items-center gap-2 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-gold" />
            <span className="text-muted-foreground font-mono text-xs">Loading queue...</span>
          </div>
        ) : !queue?.items?.length ? (
          <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
            No inputs awaiting judgment
          </p>
        ) : (
          <div className="space-y-2">
            {queue.items.map((item: any) => (
              <div
                key={item.id}
                className="flex items-center justify-between rounded-sm border border-gold-dim/10 bg-[#0A0A0A] px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs font-medium text-cream">
                    {item.summary || item.type || "Unknown input"}
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                      {item.source ?? "stream"}
                    </span>
                    {item.receivedAt && (
                      <span className="font-mono text-[0.6rem] text-muted-foreground/40">
                        {timeAgo(item.receivedAt)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="ml-3 flex items-center gap-2">
                  <Select
                    onValueChange={(val) => handleRoute(item.id, val)}
                    disabled={routingId === item.id}
                  >
                    <SelectTrigger className="h-7 w-28 font-mono text-[0.6rem]">
                      <SelectValue placeholder="Route to..." />
                    </SelectTrigger>
                    <SelectContent className="border-gold-dim bg-[#0A0A0A]">
                      {ROUTE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {routingId === item.id && (
                    <Loader2 className="h-3 w-3 animate-spin text-gold" />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Routing Decisions */}
      <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-4">
        <div className="mb-3 flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-gold" />
          <h2 className="font-serif text-base font-light text-cream">Recent Routing Decisions</h2>
        </div>
        {judgmentsLoading && !recentJudgments ? (
          <div className="flex items-center gap-2 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-gold" />
            <span className="text-muted-foreground font-mono text-xs">Loading history...</span>
          </div>
        ) : !routedItems.length ? (
          <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
            No routing decisions recorded yet.
          </p>
        ) : (
          <div className="space-y-2">
            {routedItems.map((item: any) => {
              const isAutoRouted = item.routed_by === "alfred" || item.routed_by === "auto";
              return (
                <Link
                  key={item.path || item.name}
                  to={`/dashboard/vault/${encodeURIComponent(item.path)}`}
                  className="flex items-center justify-between rounded-sm border border-gold-dim/10 bg-[#0A0A0A] px-3 py-2.5 transition-colors hover:border-gold-dim/30"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs font-medium text-cream">
                      {item.input_type || item.name || "Input"}
                    </p>
                    <div className="flex items-center gap-3">
                      {item.routing_decision && (
                        <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                          routed to {item.routing_decision}
                        </span>
                      )}
                      <span
                        className={`font-mono text-[0.6rem] ${
                          isAutoRouted
                            ? "text-emerald-500/70"
                            : "text-amber-400/70"
                        }`}
                      >
                        {isAutoRouted ? "auto (alfred)" : `human${item.routed_by ? ` (${item.routed_by})` : ""}`}
                      </span>
                      {item.confidence != null && (
                        <span className="font-mono text-[0.6rem] text-gold/60">
                          {typeof item.confidence === "number" ? `${Math.round(item.confidence * 100)}%` : item.confidence}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.date && (
                      <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                        {timeAgo(item.date)}
                      </span>
                    )}
                    <ArrowRight className="h-3 w-3 text-muted-foreground/30" />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function IntuitionActivityContent() {
  const {
    data: status,
    isLoading: statusLoading,
    error: statusError,
  } = useQuery(getIntuitionStatus, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });

  const notAvailable = !!statusError;
  const isLoading = statusLoading && !statusError;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8">
        <Loader2 className="h-5 w-5 animate-spin text-gold" />
        <span className="text-muted-foreground text-sm">Loading activity...</span>
      </div>
    );
  }

  if (notAvailable) {
    return (
      <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
        Activity data not available yet.
      </p>
    );
  }

  return (
    <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-4">
      <h2 className="mb-3 font-serif text-base font-light text-cream">Recent Activity</h2>
      {!status?.recentActivity?.length ? (
        <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
          No recent activity
        </p>
      ) : (
        <div className="space-y-1.5">
          {(status.recentActivity ?? []).map((event: any, i: number) => (
            <div
              key={event.id || i}
              className="flex items-center gap-3 rounded-sm px-3 py-2"
            >
              <Clock className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs text-cream/80">
                  {event.description || event.type}
                </p>
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
  );
}

// M4 #860 — /dashboard/intuition redirects to /instincts. The legacy
// implementation is preserved as LegacyIntuitionPage so the cutover can
// be reverted with one line.
export default function IntuitionPage() {
  return <Navigate to="/instincts" replace />;
}

function LegacyIntuitionPage() {
  const {
    data: status,
    isLoading: statusLoading,
    error: statusError,
  } = useQuery(getIntuitionStatus, undefined, {
    refetchInterval: 30_000,
    retry: false,
  });
  const {
    data: instincts,
    isLoading: instinctsLoading,
  } = useQuery(getIntuitionInstincts, undefined, {
    refetchInterval: 30_000,
    retry: false,
    enabled: !statusError,
  });
  const {
    data: queue,
    isLoading: queueLoading,
    refetch: refetchQueue,
  } = useQuery(getIntuitionQueue, undefined, {
    refetchInterval: 15_000,
    retry: false,
    enabled: !statusError,
  });
  const {
    data: observations,
    isLoading: observationsLoading,
  } = useQuery(getObservations, undefined, {
    refetchInterval: 30_000,
    retry: false,
    enabled: !statusError,
  });
  const {
    data: recentJudgments,
    isLoading: judgmentsLoading,
  } = useQuery(getRecentJudgments, undefined, {
    refetchInterval: 30_000,
    retry: false,
    enabled: !statusError,
  });

  const [routingId, setRoutingId] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const handleRoute = async (inputId: string, destination: string) => {
    setRoutingId(inputId);
    try {
      await routeInput({ input_id: inputId, destination });
      refetchQueue();
    } catch (err: any) {
      console.error("Route failed:", err);
    } finally {
      setRoutingId(null);
    }
  };

  const handleToggle = async () => {
    setToggling(true);
    try {
      if (status?.enabled) {
        await disableIntuition();
      } else {
        await enableIntuition();
      }
    } catch (err: any) {
      console.error("Toggle failed:", err);
    } finally {
      setToggling(false);
    }
  };

  // Tenant doesn't have alfred-learn deployed yet
  const notAvailable = !!statusError;
  const isLoading = statusLoading && !statusError;

  // Filter to only observations that have been routed
  const routedItems = (recentJudgments?.results ?? []).filter(
    (obs: any) => obs.routed_by || obs.routing_decision,
  );

  return (
    <DashboardLayout>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Brain className="h-5 w-5 text-gold" />
          <h1 className="font-serif text-2xl font-light text-cream">Intuition</h1>
        </div>
        {status && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 font-mono text-xs"
            onClick={handleToggle}
            disabled={toggling || statusLoading}
          >
            {toggling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : status?.enabled ? (
              <PowerOff className="h-3.5 w-3.5" />
            ) : (
              <Power className="h-3.5 w-3.5" />
            )}
            {status?.enabled ? "Disable" : "Enable"}
          </Button>
        )}
      </div>

      <p className="text-muted-foreground mb-6 text-sm">
        Alfred&apos;s learning engine. Observes patterns in your data streams and develops instincts
        for automatic routing.
      </p>

      {isLoading && (
        <div className="flex items-center gap-2 py-8">
          <Loader2 className="h-5 w-5 animate-spin text-gold" />
          <span className="text-muted-foreground text-sm">Loading intuition data...</span>
        </div>
      )}

      {notAvailable && (
        <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-8 text-center">
          <Brain className="mx-auto mb-4 h-10 w-10 text-muted-foreground/30" />
          <h2 className="mb-2 font-serif text-lg font-light text-cream">
            Intuition Not Yet Active
          </h2>
          <p className="mx-auto max-w-md font-mono text-xs text-muted-foreground/60">
            The learning engine has not been deployed to your instance yet. Once active, Alfred will
            begin observing your data streams and developing routing instincts.
          </p>
        </div>
      )}

      {status && (
        <div className="space-y-6">
          {/* Section 1: Status Bar */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatusCard
              icon={<Zap className="h-4 w-4 text-gold" />}
              label="Processed Today"
              value={status.processedToday ?? 0}
            />
            <StatusCard
              icon={<Eye className="h-4 w-4 text-gold" />}
              label="Observations"
              value={typeof status.observations === "object" ? status.observations?.total ?? 0 : status.observations ?? 0}
            />
            <StatusCard
              icon={<Brain className="h-4 w-4 text-gold" />}
              label="Instincts"
              value={typeof status.instincts === "object" ? status.instincts?.active ?? 0 : status.instinctCount ?? 0}
            />
            <StatusCard
              icon={<Target className="h-4 w-4 text-gold" />}
              label="Auto-Route Rate"
              value={`${status.autoRouteRate ?? 0}%`}
            />
          </div>

          {/* Section 2: Awaiting Judgment */}
          <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-4">
            <h2 className="mb-3 font-serif text-base font-light text-cream">Awaiting Judgment</h2>
            {queueLoading && !queue ? (
              <div className="flex items-center gap-2 py-4">
                <Loader2 className="h-4 w-4 animate-spin text-gold" />
                <span className="text-muted-foreground font-mono text-xs">Loading queue...</span>
              </div>
            ) : !queue?.items?.length ? (
              <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
                No inputs awaiting judgment
              </p>
            ) : (
              <div className="space-y-2">
                {queue.items.map((item: any) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between rounded-sm border border-gold-dim/10 bg-[#0A0A0A] px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs font-medium text-cream">
                        {item.summary || item.type || "Unknown input"}
                      </p>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                          {item.source ?? "stream"}
                        </span>
                        {item.receivedAt && (
                          <span className="font-mono text-[0.6rem] text-muted-foreground/40">
                            {timeAgo(item.receivedAt)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="ml-3 flex items-center gap-2">
                      <Select
                        onValueChange={(val) => handleRoute(item.id, val)}
                        disabled={routingId === item.id}
                      >
                        <SelectTrigger className="h-7 w-28 font-mono text-[0.6rem]">
                          <SelectValue placeholder="Route to..." />
                        </SelectTrigger>
                        <SelectContent className="border-gold-dim bg-[#0A0A0A]">
                          {ROUTE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {routingId === item.id && (
                        <Loader2 className="h-3 w-3 animate-spin text-gold" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section 2b: Recent Routing Decisions */}
          <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-4">
            <div className="mb-3 flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-gold" />
              <h2 className="font-serif text-base font-light text-cream">Recent Routing Decisions</h2>
            </div>
            {judgmentsLoading && !recentJudgments ? (
              <div className="flex items-center gap-2 py-4">
                <Loader2 className="h-4 w-4 animate-spin text-gold" />
                <span className="text-muted-foreground font-mono text-xs">Loading history...</span>
              </div>
            ) : !routedItems.length ? (
              <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
                No routing decisions recorded yet.
              </p>
            ) : (
              <div className="space-y-2">
                {routedItems.map((item: any) => {
                  const isAutoRouted = item.routed_by === "alfred" || item.routed_by === "auto";
                  return (
                    <Link
                      key={item.path || item.name}
                      to={`/dashboard/vault/${encodeURIComponent(item.path)}`}
                      className="flex items-center justify-between rounded-sm border border-gold-dim/10 bg-[#0A0A0A] px-3 py-2.5 transition-colors hover:border-gold-dim/30"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs font-medium text-cream">
                          {item.input_type || item.name || "Input"}
                        </p>
                        <div className="flex items-center gap-3">
                          {item.routing_decision && (
                            <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                              routed to {item.routing_decision}
                            </span>
                          )}
                          <span
                            className={`font-mono text-[0.6rem] ${
                              isAutoRouted
                                ? "text-emerald-500/70"
                                : "text-amber-400/70"
                            }`}
                          >
                            {isAutoRouted ? "auto (alfred)" : `human${item.routed_by ? ` (${item.routed_by})` : ""}`}
                          </span>
                          {item.confidence != null && (
                            <span className="font-mono text-[0.6rem] text-gold/60">
                              {typeof item.confidence === "number" ? `${Math.round(item.confidence * 100)}%` : item.confidence}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {item.date && (
                          <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                            {timeAgo(item.date)}
                          </span>
                        )}
                        <ArrowRight className="h-3 w-3 text-muted-foreground/30" />
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          {/* Section 3: Instincts */}
          <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-4">
            <h2 className="mb-3 font-serif text-base font-light text-cream">Instincts</h2>
            {instinctsLoading && !instincts ? (
              <div className="flex items-center gap-2 py-4">
                <Loader2 className="h-4 w-4 animate-spin text-gold" />
                <span className="text-muted-foreground font-mono text-xs">
                  Loading instincts...
                </span>
              </div>
            ) : !instincts?.items?.length ? (
              <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
                No instincts formed yet. Alfred learns from your routing decisions.
              </p>
            ) : (
              <div className="space-y-2">
                {instincts.items.map((instinct: any) => (
                  <div
                    key={instinct.id || instinct.name}
                    className="flex items-center justify-between rounded-sm border border-gold-dim/10 bg-[#0A0A0A] px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-xs font-medium text-cream">{instinct.name}</p>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                          {instinct.observationCount ?? 0} observations
                        </span>
                        <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                          threshold: {instinct.discretionThreshold ?? "—"}
                        </span>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-xs text-gold">{instinct.matchCount ?? 0}</p>
                      <p className="font-mono text-[0.55rem] text-muted-foreground/40">matches</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section 3b: Recent Observations */}
          <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-4">
            <h2 className="mb-3 font-serif text-base font-light text-cream">Recent Observations</h2>
            {observationsLoading && !observations ? (
              <div className="flex items-center gap-2 py-4">
                <Loader2 className="h-4 w-4 animate-spin text-gold" />
                <span className="text-muted-foreground font-mono text-xs">
                  Loading observations...
                </span>
              </div>
            ) : !observations?.results?.length ? (
              <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
                No observations recorded yet.
              </p>
            ) : (
              <div className="space-y-2">
                {observations.results.map((obs: any) => (
                  <Link
                    key={obs.path || obs.name}
                    to={`/dashboard/vault/${encodeURIComponent(obs.path)}`}
                    className="flex items-center justify-between rounded-sm border border-gold-dim/10 bg-[#0A0A0A] px-3 py-2.5 transition-colors hover:border-gold-dim/30"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs font-medium text-cream">
                        {obs.input_type || obs.name || "Observation"}
                      </p>
                      <div className="flex items-center gap-3">
                        {obs.routing_decision && (
                          <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                            routed to {obs.routing_decision}
                          </span>
                        )}
                        {obs.confidence != null && (
                          <span className="font-mono text-[0.6rem] text-gold/60">
                            confidence: {typeof obs.confidence === "number" ? `${Math.round(obs.confidence * 100)}%` : obs.confidence}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {obs.date && (
                        <span className="font-mono text-[0.55rem] text-muted-foreground/40">
                          {timeAgo(obs.date)}
                        </span>
                      )}
                      <ArrowRight className="h-3 w-3 text-muted-foreground/30" />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Section 4: Recent Activity */}
          <div className="rounded-sm border border-gold-dim/20 bg-black/20 p-4">
            <h2 className="mb-3 font-serif text-base font-light text-cream">Recent Activity</h2>
            {!status.recentActivity?.length ? (
              <p className="py-4 text-center font-mono text-xs text-muted-foreground/50">
                No recent activity
              </p>
            ) : (
              <div className="space-y-1.5">
                {(status.recentActivity ?? []).map((event: any, i: number) => (
                  <div
                    key={event.id || i}
                    className="flex items-center gap-3 rounded-sm px-3 py-2"
                  >
                    <Clock className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs text-cream/80">
                        {event.description || event.type}
                      </p>
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
      )}
    </DashboardLayout>
  );
}

function StatusCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-sm border border-gold-dim/20 bg-black/20 px-4 py-3">
      <div className="mb-1.5 flex items-center gap-2">
        {icon}
        <span className="font-mono text-[0.6rem] uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <p className="font-mono text-lg font-light text-cream">{value}</p>
    </div>
  );
}
