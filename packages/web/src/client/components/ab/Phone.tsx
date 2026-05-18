import type { ReactNode } from "react";

// A CSS iPhone frame, so it scales crisply.
export function Phone({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="flex flex-col items-center gap-4">
      <div
        className="relative"
        style={{
          width: 360,
          height: 740,
          background: "var(--wool)",
          borderRadius: 56,
          padding: 12,
          boxShadow: "0 1px 0 oklch(1 0 0 / 0.08) inset, 0 30px 60px -30px oklch(0 0 0 / 0.5)",
        }}
      >
        <div
          className="absolute left-1/2 -translate-x-1/2 z-20"
          style={{
            top: 22,
            width: 110,
            height: 30,
            background: "#000",
            borderRadius: 18,
          }}
        />
        <div
          className="relative overflow-hidden"
          style={{
            width: "100%",
            height: "100%",
            borderRadius: 44,
            background: "var(--wool)",
          }}
        >
          {children}
        </div>
      </div>
      {label && (
        <div className="font-mono text-[10px] uppercase tracking-[0.22em]" style={{ color: "var(--marginalia)" }}>
          {label}
        </div>
      )}
    </div>
  );
}

export function StatusBar({ light = true }: { light?: boolean }) {
  const c = light ? "var(--paper)" : "var(--ink)";
  return (
    <div className="flex items-center justify-between px-7 pt-3 pb-1 font-mono text-[11px]" style={{ color: c }}>
      <span>9:41</span>
      <span className="flex items-center gap-1.5">
        <span style={{ width: 16, height: 8, borderRadius: 1, background: c, opacity: 0.85 }} />
        <span style={{ width: 4, height: 8, borderRadius: 1, background: c, opacity: 0.5 }} />
      </span>
    </div>
  );
}
