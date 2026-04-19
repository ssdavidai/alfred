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
  ExternalLink,
  Puzzle,
} from "lucide-react";
import { Link } from "react-router-dom";

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
    tenantBaseUrl?: string | null;
    _count?: { events: number };
    // Composio-backed stream fields (synthesized server-side; see getStreams)
    isComposio?: boolean;
    composioAction?: string | null;
    composioConnectionId?: string | null;
    composioToolkit?: string | null;
    composioLabel?: string | null;
    composioIconUrl?: string | null;
  };
  sourceIcon?: React.ComponentType<{ className?: string }>;
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
  sourceIcon: SourceIcon,
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

  const getWebhookUrl = (): string => {
    if (!stream.webhookToken) return "";
    // Omi streams use a special audio endpoint on the tenant, not the SaaS webhook
    if (stream.source === "omi" && stream.tenantBaseUrl) {
      return `${stream.tenantBaseUrl}/api/v1/streams/omi/audio?token=${stream.webhookToken}&uid=omi-device`;
    }
    return `${window.location.origin}/webhooks/${stream.webhookToken}`;
  };

  const copyWebhookUrl = () => {
    const url = getWebhookUrl();
    if (url) navigator.clipboard.writeText(url);
  };

  return (
    <Card
      className="cursor-pointer transition-colors hover:border-gold-dim/60"
      onClick={() => onClick(stream.id)}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {SourceIcon && (
              <SourceIcon className="h-4 w-4 flex-shrink-0 text-gold/60" />
            )}
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
                {stream.isComposio && stream.composioIconUrl ? (
                  <img
                    src={stream.composioIconUrl}
                    alt=""
                    className="h-4 w-4 flex-shrink-0 rounded-sm object-contain"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : null}
                <p className="font-mono text-sm font-medium uppercase tracking-wide text-cream">
                  {stream.name}
                </p>
                {stream.isSystem && (
                  <span className="rounded-sm bg-gold/20 px-1.5 py-0.5 font-mono text-[0.5rem] font-medium uppercase tracking-wider text-gold">
                    System
                  </span>
                )}
                {stream.isComposio && (
                  <span className="inline-flex items-center gap-1 rounded-sm bg-[#C9A84C]/10 px-1.5 py-0.5 font-mono text-[0.5rem] font-medium uppercase tracking-wider text-[#C9A84C]">
                    <Puzzle className="h-2.5 w-2.5" />
                    {stream.composioLabel || stream.composioToolkit || "Composio"}
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

          {stream.isComposio ? (
            // Composio streams are managed from the Integrations page — link
            // there rather than exposing pause/delete here, since their
            // lifecycle is tied to the Composio connection.
            <div
              className="flex items-center gap-2"
              onClick={(e) => e.stopPropagation()}
            >
              <Link
                to="/dashboard/integrations"
                className="inline-flex h-7 items-center gap-1 rounded-sm border border-[#C9A84C]/30 bg-[#C9A84C]/5 px-2 font-mono text-[0.55rem] text-[#C9A84C] transition hover:bg-[#C9A84C]/10"
              >
                <ExternalLink className="h-3 w-3" />
                Manage
              </Link>
            </div>
          ) : !stream.isSystem && (
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
                    Disconnect Integration
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
