import { Link } from "react-router-dom";

const STEPS = [
  { key: "consent", label: "Sign in", to: "/" },
  { key: "provision", label: "Setup", to: "/awaken" },
  { key: "read", label: "Scan", to: "/reading-the-room" },
  { key: "verify", label: "Confirm", to: "/verify" },
  { key: "brief", label: "First email", to: "/first-brief" },
  { key: "serve", label: "Today", to: "/desk" },
] as const;

export type RitualStep = typeof STEPS[number]["key"];

export function RitualNav({ active }: { active: RitualStep }) {
  const activeIndex = STEPS.findIndex((s) => s.key === active);
  return (
    <div className="flex flex-col gap-2 min-w-[360px]">
      <div className="flex items-center gap-1.5">
        {STEPS.map((s, i) => {
          const done = i < activeIndex;
          const here = i === activeIndex;
          const bg = here ? "var(--brass)" : done ? "color-mix(in oklab, var(--brass) 55%, transparent)" : "var(--rule)";
          return (
            <div key={s.key} className="flex-1 h-[3px]" style={{ background: bg }} />
          );
        })}
      </div>
      <div className="font-mono text-[9px] uppercase tracking-[0.28em] flex flex-wrap gap-x-3 gap-y-1">
        {STEPS.map((s, i) => {
          const here = s.key === active;
          return (
            <span key={s.key} className="flex items-baseline gap-1.5">
              <span style={{ color: here ? "var(--brass)" : "var(--marginalia)", fontWeight: here ? 800 : 400 }}>
                {String(i + 1).padStart(2, "0")}
              </span>
              <Link to={s.to} style={{ color: here ? "currentColor" : "var(--marginalia)", fontWeight: here ? 800 : 400 }}>
                {s.label}
              </Link>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function HairlineFill({ ms = 4000 }: { ms?: number }) {
  return (
    <div className="relative w-full h-px overflow-hidden" style={{ background: "var(--rule)" }}>
      <div
        className="absolute inset-y-0 left-0"
        style={{
          background: "var(--brass)",
          width: "100%",
          transformOrigin: "left center",
          animation: `ab-fill ${ms}ms linear forwards`,
        }}
      />
      <style>{`@keyframes ab-fill { from { transform: scaleX(0) } to { transform: scaleX(1) } }`}</style>
    </div>
  );
}
