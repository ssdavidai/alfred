import { useState } from "react";
import { useQuery, getStreamEvents } from "wasp/client/operations";
import { Button } from "../../client/components/ui/button";
import { Card, CardContent } from "../../client/components/ui/card";
import { X, ChevronDown, ChevronRight, Loader2 } from "lucide-react";

interface EventLogProps {
  streamId: string;
  streamName: string;
  onClose: () => void;
}

export default function EventLog({
  streamId,
  streamName,
  onClose,
}: EventLogProps) {
  const { data: events, isLoading } = useQuery(getStreamEvents, { streamId }, {
    refetchInterval: 10_000,
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <Card className="border-gold-dim/40">
      <CardContent className="p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-mono text-sm font-medium uppercase tracking-wide text-cream">
            {streamName} — Events
          </h3>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-gold" />
            <span className="text-muted-foreground text-sm">
              Loading events...
            </span>
          </div>
        )}

        {events && events.length === 0 && (
          <p className="py-4 text-center font-mono text-xs text-muted-foreground">
            No events yet
          </p>
        )}

        {events && events.length > 0 && (
          <div className="max-h-[400px] space-y-1 overflow-y-auto">
            {events.map((event: any) => {
              const isExpanded = expandedId === event.id;
              return (
                <div
                  key={event.id}
                  className="rounded-sm border border-gold-dim/10 bg-black/20"
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left"
                    onClick={() =>
                      setExpandedId(isExpanded ? null : event.id)
                    }
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                    )}
                    <span className="font-mono text-[0.6rem] text-muted-foreground/50">
                      {new Date(event.receivedAt).toLocaleString()}
                    </span>
                    <span className="font-mono text-[0.6rem] text-gold/60">
                      {event.type}
                    </span>
                    {event.summary && (
                      <span className="truncate font-mono text-[0.6rem] text-cream/70">
                        {event.summary}
                      </span>
                    )}
                  </button>
                  {isExpanded && (
                    <div className="border-t border-gold-dim/10 px-3 py-2">
                      <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap font-mono text-[0.6rem] text-muted-foreground">
                        {JSON.stringify(event.raw, null, 2)}
                      </pre>
                      {event.sourceRef && (
                        <p className="mt-1 font-mono text-[0.55rem] text-muted-foreground/40">
                          ref: {event.sourceRef}
                        </p>
                      )}
                    </div>
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
