import { Card, CardContent, CardTitle } from "../../client/components/ui/card";
import { RotateCw } from "lucide-react";
import ComingSoonOverlay from "./ComingSoonOverlay";

const DUMMY_CHORES = [
  {
    name: "Daily Briefing",
    schedule: "Every day 5:00 AM",
    channel: "SMS + Email",
    status: "Active",
  },
  {
    name: "Weekly Grocery List",
    schedule: "Every Sunday 9:00 AM",
    channel: "Email",
    status: "Active",
  },
  {
    name: "Expense Report Summary",
    schedule: "1st of every month",
    channel: "Email",
    status: "Active",
  },
];

export default function ChoresSection() {
  return (
    <ComingSoonOverlay>
      <Card className="h-full">
        <CardContent className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <RotateCw className="h-4 w-4 text-gold" />
            <CardTitle className="font-serif text-base font-light text-cream">
              Chores
            </CardTitle>
          </div>

          <div className="space-y-2">
            {DUMMY_CHORES.map((chore, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-sm border border-gold-dim/20 bg-black/20 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-xs font-medium text-cream">
                    {chore.name}
                  </p>
                  <div className="mt-1 flex items-center gap-3">
                    <span className="font-mono text-[0.65rem] text-muted-foreground">
                      {chore.schedule}
                    </span>
                    <span className="font-mono text-[0.6rem] text-muted-foreground/60">
                      via {chore.channel}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <div className="h-1.5 w-1.5 rounded-full bg-green-500" />
                  <span className="font-mono text-[0.6rem] font-light uppercase tracking-[0.15em] text-green-500/80">
                    {chore.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </ComingSoonOverlay>
  );
}
