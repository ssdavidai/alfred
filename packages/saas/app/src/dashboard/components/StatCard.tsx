import { Card, CardContent } from "../../client/components/ui/card";

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  subtext?: string;
}

export default function StatCard({ icon, label, value, subtext }: StatCardProps) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-6">
        {icon}
        <div>
          <p className="font-mono text-[0.62rem] font-light uppercase tracking-[0.3em] text-muted-foreground">
            {label}
          </p>
          <p className="mt-1 font-serif text-lg font-light text-cream">
            {value}
          </p>
          {subtext && (
            <p className="mt-0.5 font-mono text-[0.55rem] font-light text-muted-foreground">
              {subtext}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
