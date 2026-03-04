import { useEffect, useRef, useState } from "react";
import { useQuery, getContainerLogs, getActivityFeed } from "wasp/client/operations";
import DashboardLayout from "./DashboardLayout";
import { Card, CardContent } from "../client/components/ui/card";
import { Button } from "../client/components/ui/button";
import { ScrollText, RefreshCw, Activity, AlertTriangle, CheckCircle2 } from "lucide-react";

const SERVICES = [
  { value: "alfred", label: "Alfred Worker" },
  { value: "openclaw", label: "OpenClaw" },
  { value: "temporal", label: "Temporal" },
];

interface ActivityItem {
  timestamp: string;
  tool: "curator" | "janitor" | "distiller" | "surveyor" | "system";
  level: "info" | "warning" | "error";
  event: string;
  message: string;
}

const TOOL_COLORS: Record<string, string> = {
  curator: "text-blue-400",
  janitor: "text-amber-400",
  distiller: "text-purple-400",
  surveyor: "text-emerald-400",
  system: "text-muted-foreground",
};

const TOOL_BG: Record<string, string> = {
  curator: "bg-blue-400/10",
  janitor: "bg-amber-400/10",
  distiller: "bg-purple-400/10",
  surveyor: "bg-emerald-400/10",
  system: "bg-muted/30",
};

function LevelIcon({ level }: { level: ActivityItem["level"] }) {
  switch (level) {
    case "error":
      return <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-red-400" />;
    case "warning":
      return <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-400" />;
    default:
      return <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/40" />;
  }
}

function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp.endsWith("Z") ? timestamp : timestamp + "Z");
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function ActivityView() {
  const { data, isLoading, error, refetch } = useQuery(getActivityFeed, undefined, {
    refetchInterval: 10_000,
  });
  const bottomRef = useRef<HTMLDivElement>(null);
  const items: ActivityItem[] = Array.isArray(data?.items) ? data.items : [];

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [items.length]);

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isLoading}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive mb-4 rounded-sm p-4">
          <p>{error.message}</p>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="bg-background max-h-[600px] overflow-auto rounded-sm p-4">
            {isLoading && items.length === 0 ? (
              <div className="text-muted-foreground flex items-center justify-center py-12">
                <RefreshCw className="mr-3 h-8 w-8 animate-spin" />
                <span>Loading activity...</span>
              </div>
            ) : items.length === 0 ? (
              <div className="text-muted-foreground flex items-center justify-center py-12">
                <Activity className="mr-3 h-8 w-8" />
                <span>No recent activity</span>
              </div>
            ) : (
              items.map((item, i) => (
                <div
                  key={i}
                  className="flex items-start gap-3 border-b border-white/5 px-2 py-2 last:border-b-0"
                >
                  <LevelIcon level={item.level} />
                  <span
                    className={`inline-block w-20 flex-shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-xs font-medium uppercase ${TOOL_COLORS[item.tool]} ${TOOL_BG[item.tool]}`}
                  >
                    {item.tool}
                  </span>
                  <span className="min-w-0 flex-1 font-mono text-sm leading-relaxed text-foreground/80">
                    {item.message}
                  </span>
                  <span className="flex-shrink-0 font-mono text-xs text-muted-foreground/50">
                    {formatTime(item.timestamp)}
                  </span>
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function RawLogsView() {
  const [service, setService] = useState("alfred");
  const [tail, setTail] = useState("200");
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, error, refetch } = useQuery(getContainerLogs, {
    service,
    tail,
  });

  const lines: string[] = data?.logs
    ? data.logs
        .split("\n")
        .filter((l: string) => l.trim() !== "")
    : [];

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines.length]);

  return (
    <>
      <div className="mb-4 flex justify-end gap-3">
        <select
          className="bg-background border-border text-foreground rounded-sm border px-3 py-1.5 text-sm"
          value={service}
          onChange={(e) => setService(e.target.value)}
        >
          {SERVICES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          className="bg-background border-border text-foreground rounded-sm border px-3 py-1.5 text-sm"
          value={tail}
          onChange={(e) => setTail(e.target.value)}
        >
          <option value="50">Last 50</option>
          <option value="100">Last 100</option>
          <option value="200">Last 200</option>
          <option value="500">Last 500</option>
        </select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isLoading}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive mb-4 rounded-sm p-4">
          <p>{error.message}</p>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="bg-background max-h-[600px] overflow-auto rounded-sm p-4 font-mono text-sm">
            {isLoading && lines.length === 0 ? (
              <div className="text-muted-foreground flex items-center justify-center py-12">
                <RefreshCw className="mr-3 h-8 w-8 animate-spin" />
                <span>Loading logs...</span>
              </div>
            ) : lines.length === 0 ? (
              <div className="text-muted-foreground flex items-center justify-center py-12">
                <ScrollText className="mr-3 h-8 w-8" />
                <span>No logs available for this service.</span>
              </div>
            ) : (
              lines.map((line, i) => (
                <div
                  key={i}
                  className="text-foreground border-border border-b py-1 last:border-b-0"
                >
                  <span className="text-muted-foreground mr-3 select-none">
                    {String(i + 1).padStart(4, " ")}
                  </span>
                  {line}
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </CardContent>
      </Card>
    </>
  );
}

export default function LogsPage() {
  const [mode, setMode] = useState<"activity" | "raw">("activity");

  return (
    <DashboardLayout>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-serif text-2xl font-light text-cream">Logs</h1>
        <div className="flex items-center rounded-sm border border-border">
          <button
            className={`px-4 py-1.5 text-sm transition-colors ${
              mode === "activity"
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setMode("activity")}
          >
            <Activity className="mr-1.5 inline-block h-3.5 w-3.5" />
            Activity
          </button>
          <button
            className={`px-4 py-1.5 text-sm transition-colors ${
              mode === "raw"
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setMode("raw")}
          >
            <ScrollText className="mr-1.5 inline-block h-3.5 w-3.5" />
            Raw
          </button>
        </div>
      </div>

      {mode === "activity" ? <ActivityView /> : <RawLogsView />}
    </DashboardLayout>
  );
}
