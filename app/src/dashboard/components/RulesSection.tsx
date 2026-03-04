import { Card, CardContent, CardTitle } from "../../client/components/ui/card";
import { GitBranch } from "lucide-react";
import ComingSoonOverlay from "./ComingSoonOverlay";

const DUMMY_RULES = [
  "For each meeting that needs travel, check traffic 2 hours prior and set a reminder to call the user to leave in time",
  "When an invoice arrives via email, extract the amount and due date, create a task to review it 3 days before due",
  "If calendar shows back-to-back meetings for 3+ hours, send a reminder to take a 15-minute break",
];

export default function RulesSection() {
  return (
    <ComingSoonOverlay>
      <Card className="h-full">
        <CardContent className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-gold" />
            <CardTitle className="font-serif text-base font-light text-cream">
              Rules
            </CardTitle>
          </div>

          <div className="space-y-2">
            {DUMMY_RULES.map((rule, i) => (
              <div
                key={i}
                className="flex items-start justify-between gap-3 rounded-sm border border-gold-dim/20 bg-black/20 px-3 py-2.5"
              >
                <p className="min-w-0 flex-1 font-mono text-[0.65rem] leading-relaxed text-cream/90">
                  {rule}
                </p>
                <span className="flex-shrink-0 rounded-sm bg-green-500/10 px-2 py-0.5 font-mono text-[0.6rem] font-light uppercase tracking-[0.15em] text-green-500/80">
                  Active
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </ComingSoonOverlay>
  );
}
