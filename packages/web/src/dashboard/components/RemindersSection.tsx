import { Card, CardContent, CardTitle } from "../../client/components/ui/card";
import { Bell } from "lucide-react";
import ComingSoonOverlay from "./ComingSoonOverlay";

const DUMMY_REMINDERS = [
  {
    name: "Take the bins out",
    schedule: "Monday 7:00 PM",
    nudge: true,
  },
  {
    name: "Take medications",
    schedule: "Daily 8:00 AM, 8:00 PM",
    nudge: true,
  },
  {
    name: "Water the plants",
    schedule: "Wednesday, Saturday 9:00 AM",
    nudge: false,
  },
  {
    name: "Submit timesheet",
    schedule: "Friday 4:00 PM",
    nudge: false,
  },
];

export default function RemindersSection() {
  return (
    <ComingSoonOverlay>
      <Card className="h-full">
        <CardContent className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <Bell className="h-4 w-4 text-gold" />
            <CardTitle className="font-serif text-base font-light text-cream">
              Reminders
            </CardTitle>
          </div>

          <div className="space-y-2">
            {DUMMY_REMINDERS.map((reminder, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-sm border border-gold-dim/20 bg-black/20 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-xs font-medium text-cream">
                    {reminder.name}
                  </p>
                  <p className="mt-0.5 font-mono text-[0.65rem] text-muted-foreground">
                    {reminder.schedule}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <div
                    className={`flex h-4 w-8 items-center rounded-full px-0.5 ${
                      reminder.nudge
                        ? "bg-gold/30 justify-end"
                        : "bg-muted/30 justify-start"
                    }`}
                  >
                    <div
                      className={`h-3 w-3 rounded-full ${
                        reminder.nudge ? "bg-gold" : "bg-muted-foreground/40"
                      }`}
                    />
                  </div>
                  <span
                    className={`font-mono text-[0.6rem] font-light uppercase tracking-[0.1em] ${
                      reminder.nudge
                        ? "text-gold/80"
                        : "text-muted-foreground/50"
                    }`}
                  >
                    Nudge
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
