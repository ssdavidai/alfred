import { useState } from "react";
import {
  useQuery,
  getIntuitionStatus,
  getIntuitionInstincts,
  getIntuitionQueue,
  routeInput,
  enableIntuition,
  disableIntuition,
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
import { Brain, Loader2, Power, PowerOff, Eye, Zap, Clock, Target } from "lucide-react";

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
  } = useQuery(getIntuitionInstincts, undefined, {
    refetchInterval: 30_000,
    retry: false,
    enabled: !statusError,
  });

  const [toggling, setToggling] = useState(false);

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
                        {instinct.confidenceScore != null && (
                          <span className="font-mono text-[0.6rem] text-gold/60">
                            score: {instinct.confidenceScore}
                          </span>
                        )}
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

export default function IntuitionPage() {
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
