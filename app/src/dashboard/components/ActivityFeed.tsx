import { useEffect, useRef } from "react";
import { useQuery, getActivityFeed } from "wasp/client/operations";
import { Card, CardContent, CardTitle } from "../../client/components/ui/card";
import { Activity, AlertTriangle, CheckCircle2 } from "lucide-react";

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
      return <AlertTriangle className="h-3 w-3 flex-shrink-0 text-red-400" />;
    case "warning":
      return <AlertTriangle className="h-3 w-3 flex-shrink-0 text-amber-400" />;
    default:
      return <CheckCircle2 className="h-3 w-3 flex-shrink-0 text-muted-foreground/40" />;
  }
}

function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp.endsWith("Z") ? timestamp : timestamp + "Z");
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function ActivityFeed() {
  const { data, isLoading, error } = useQuery(getActivityFeed, undefined, {
    refetchInterval: 10_000,
  });

  const scrollRef = useRef<HTMLDivElement>(null);

  const items: ActivityItem[] = Array.isArray(data?.items) ? data.items : [];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items.length]);

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-3 flex items-center gap-2">
          <Activity className="h-4 w-4 text-gold" />
          <CardTitle className="font-serif text-base font-light text-cream">
            Activity
          </CardTitle>
        </div>

        {isLoading && items.length === 0 && (
          <p className="font-mono text-xs text-muted-foreground">Loading...</p>
        )}

        {error && items.length === 0 && (
          <p className="font-mono text-xs text-muted-foreground/60">
            Unable to load activity feed
          </p>
        )}

        {items.length === 0 && !isLoading && !error && (
          <p className="font-mono text-xs text-muted-foreground/60">
            No recent activity
          </p>
        )}

        {items.length > 0 && (
          <div
            ref={scrollRef}
            className="max-h-[280px] overflow-y-auto rounded-sm bg-black/30 p-2"
          >
            {items.map((item: ActivityItem, i: number) => (
              <div
                key={i}
                className="flex items-start gap-2 border-b border-white/5 px-2 py-1.5 last:border-b-0"
              >
                <LevelIcon level={item.level} />
                <span
                  className={`inline-block w-16 flex-shrink-0 rounded px-1 py-0.5 text-center font-mono text-[0.6rem] font-medium uppercase ${TOOL_COLORS[item.tool]} ${TOOL_BG[item.tool]}`}
                >
                  {item.tool}
                </span>
                <span className="min-w-0 flex-1 font-mono text-[0.65rem] leading-relaxed text-foreground/80">
                  {item.message}
                </span>
                <span className="flex-shrink-0 font-mono text-[0.6rem] text-muted-foreground/50">
                  {formatTime(item.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
