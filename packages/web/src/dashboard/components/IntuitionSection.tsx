import { Link } from "react-router-dom";
import { useQuery, getIntuitionStatus } from "wasp/client/operations";
import { Card, CardContent, CardTitle } from "../../client/components/ui/card";
import { Brain, ExternalLink, Target, Loader2 } from "lucide-react";

export default function IntuitionSection() {
  const { data: status, isLoading } = useQuery(getIntuitionStatus, undefined, {
    refetchInterval: 30_000,
  });

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-gold" />
            <CardTitle className="font-serif text-base font-light text-cream">
              Intuition
            </CardTitle>
          </div>
          <Link
            to="/dashboard/tasks"
            className="flex items-center gap-1 font-mono text-[0.6rem] text-muted-foreground transition-colors hover:text-gold"
          >
            Manage
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-gold" />
            <span className="font-mono text-xs text-muted-foreground">Loading...</span>
          </div>
        ) : !status ? (
          <div className="py-4 text-center">
            <p className="font-mono text-xs text-muted-foreground/50">
              Learning engine unavailable
            </p>
            <Link
              to="/dashboard/tasks"
              className="mt-1 inline-block font-mono text-[0.6rem] text-gold/60 transition-colors hover:text-gold"
            >
              Configure Intuition
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-sm border border-gold-dim/10 bg-[#0A0A0A] px-3 py-2 text-center">
                <p className="font-mono text-sm text-cream">{status.instinctCount ?? 0}</p>
                <p className="font-mono text-[0.55rem] text-muted-foreground/50">instincts</p>
              </div>
              <div className="rounded-sm border border-gold-dim/10 bg-[#0A0A0A] px-3 py-2 text-center">
                <p className="font-mono text-sm text-cream">{status.autoRouteRate ?? 0}%</p>
                <p className="font-mono text-[0.55rem] text-muted-foreground/50">auto-route</p>
              </div>
              <div className="rounded-sm border border-gold-dim/10 bg-[#0A0A0A] px-3 py-2 text-center">
                <p className="font-mono text-sm text-cream">{status.queueSize ?? 0}</p>
                <p className="font-mono text-[0.55rem] text-muted-foreground/50">awaiting</p>
              </div>
            </div>

            {status.enabled ? (
              <div className="flex items-center gap-2 rounded-sm px-1">
                <div className="h-2 w-2 rounded-full bg-green-500" />
                <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                  Learning active
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-sm px-1">
                <div className="h-2 w-2 rounded-full bg-muted-foreground/40" />
                <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                  Learning paused
                </span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
