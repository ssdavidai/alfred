import { Button } from "../../client/components/ui/button";
import { Card, CardContent } from "../../client/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../client/components/ui/dropdown-menu";
import {
  Pause,
  Play,
  MoreHorizontal,
  Trash2,
  RefreshCw,
  Copy,
  Loader2,
} from "lucide-react";

interface StreamCardProps {
  stream: {
    id: string;
    name: string;
    type: string;
    source: string;
    isSystem: boolean;
    enabled: boolean;
    status: string;
    webhookToken: string | null;
    lastEventAt: string | null;
    errorMessage: string | null;
    _count?: { events: number };
  };
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onRegenerateToken: (id: string) => void;
  onClick: (id: string) => void;
  actionLoading: string | null;
}

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

export default function StreamCard({
  stream,
  onPause,
  onResume,
  onDelete,
  onRegenerateToken,
  onClick,
  actionLoading,
}: StreamCardProps) {
  const isActive = stream.enabled && stream.status !== "paused";
  const isLoading = actionLoading === stream.id;
  const eventCount = stream._count?.events ?? 0;

  const copyWebhookUrl = () => {
    if (stream.webhookToken) {
      navigator.clipboard.writeText(
        `${window.location.origin}/webhooks/${stream.webhookToken}`,
      );
    }
  };

  return (
    <Card
      className="cursor-pointer transition-colors hover:border-gold-dim/60"
      onClick={() => onClick(stream.id)}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div
              className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${
                stream.status === "error"
                  ? "bg-red-500"
                  : isActive
                    ? "bg-green-500"
                    : "bg-[#8A8680]/40"
              }`}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-mono text-sm font-medium uppercase tracking-wide text-cream">
                  {stream.name}
                </p>
                {stream.isSystem && (
                  <span className="rounded-sm bg-gold/20 px-1.5 py-0.5 font-mono text-[0.5rem] font-medium uppercase tracking-wider text-gold">
                    System
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                  {stream.type}
                </span>
                {stream.type === "scheduled" && (
                  <span className="font-mono text-[0.6rem] text-muted-foreground/40">
                    every 5m
                  </span>
                )}
                {stream.lastEventAt && (
                  <>
                    <span className="text-muted-foreground/30">&middot;</span>
                    <span className="font-mono text-[0.6rem] text-muted-foreground/40">
                      last event {timeAgo(stream.lastEventAt)}
                    </span>
                  </>
                )}
                {eventCount > 0 && (
                  <>
                    <span className="text-muted-foreground/30">&middot;</span>
                    <span className="font-mono text-[0.6rem] text-muted-foreground/40">
                      {eventCount} events
                    </span>
                  </>
                )}
                {stream.status === "error" && stream.errorMessage && (
                  <>
                    <span className="text-muted-foreground/30">&middot;</span>
                    <span className="font-mono text-[0.6rem] text-red-400">
                      {stream.errorMessage}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {!stream.isSystem && (
            <div
              className="flex items-center gap-2"
              onClick={(e) => e.stopPropagation()}
            >
              {stream.type === "webhook" && stream.webhookToken && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2 font-mono text-[0.55rem]"
                  onClick={copyWebhookUrl}
                >
                  <Copy className="h-3 w-3" />
                  URL
                </Button>
              )}

              {isActive ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2 font-mono text-[0.55rem]"
                  disabled={isLoading}
                  onClick={() => onPause(stream.id)}
                >
                  {isLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Pause className="h-3 w-3" />
                  )}
                  Pause
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2 font-mono text-[0.55rem]"
                  disabled={isLoading}
                  onClick={() => onResume(stream.id)}
                >
                  {isLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )}
                  Resume
                </Button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="border-gold-dim bg-[#0A0A0A]"
                >
                  {stream.type === "webhook" && (
                    <DropdownMenuItem
                      onClick={() => onRegenerateToken(stream.id)}
                    >
                      <RefreshCw className="mr-2 h-3 w-3" />
                      Regenerate Token
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-red-400 focus:text-red-400"
                    onClick={() => onDelete(stream.id)}
                  >
                    <Trash2 className="mr-2 h-3 w-3" />
                    Delete Stream
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
