import { Link } from "react-router-dom";
import { useQuery, getStreams } from "wasp/client/operations";
import { Card, CardContent, CardTitle } from "../../client/components/ui/card";
import { Radio, Pause, Play, ExternalLink } from "lucide-react";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function StreamsSection() {
  const { data: streams } = useQuery(getStreams, undefined, {
    refetchInterval: 30_000,
  });

  const displayStreams = streams?.slice(0, 4) ?? [];

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-gold" />
            <CardTitle className="font-serif text-base font-light text-cream">
              Streams
            </CardTitle>
          </div>
          <Link
            to="/dashboard/streams"
            className="flex items-center gap-1 font-mono text-[0.6rem] text-muted-foreground transition-colors hover:text-gold"
          >
            Manage
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>

        {displayStreams.length === 0 ? (
          <div className="py-4 text-center">
            <p className="font-mono text-xs text-muted-foreground/50">
              No streams configured
            </p>
            <Link
              to="/dashboard/streams"
              className="mt-1 inline-block font-mono text-[0.6rem] text-gold/60 transition-colors hover:text-gold"
            >
              + Add your first stream
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {displayStreams.map((stream: any) => {
              const isActive =
                stream.enabled && stream.status !== "paused";
              return (
                <div
                  key={stream.id}
                  className="flex items-center justify-between rounded-sm border border-gold-dim/20 bg-black/20 px-3 py-2.5"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div
                      className={`h-2 w-2 flex-shrink-0 rounded-full ${
                        stream.status === "error"
                          ? "bg-red-500"
                          : isActive
                            ? "bg-green-500"
                            : "bg-muted-foreground/40"
                      }`}
                    />
                    <div className="min-w-0">
                      <p className="font-mono text-xs font-medium text-cream">
                        {stream.name}
                      </p>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                          {stream.source}
                        </span>
                        {stream.lastEventAt && (
                          <span className="font-mono text-[0.6rem] text-muted-foreground/40">
                            {timeAgo(stream.lastEventAt)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {isActive ? (
                    <Pause className="h-3 w-3 text-muted-foreground/40" />
                  ) : (
                    <Play className="h-3 w-3 text-muted-foreground/40" />
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
