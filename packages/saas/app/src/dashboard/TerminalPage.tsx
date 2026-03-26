import { Navigate } from "react-router-dom";
import Terminal from "./components/Terminal";
import { TerminalSquare } from "lucide-react";

/** Inner content — used by the unified Settings page */
export function TerminalContent() {
  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <TerminalSquare className="h-5 w-5 text-gold" />
          <h2 className="font-serif text-2xl font-light text-cream">Terminal</h2>
        </div>
        <span className="font-mono text-[0.58rem] uppercase tracking-[0.3em] text-muted-foreground">
          OpenClaw Shell
        </span>
      </div>

      <div className="overflow-hidden rounded-sm border border-gold-dim">
        <Terminal />
      </div>

      <p className="mt-3 font-sans text-xs font-light text-muted-foreground/60">
        Interactive shell into your OpenClaw container. Run{" "}
        <code className="font-mono text-muted-foreground">openclaw --help</code>{" "}
        to get started. Session times out after 15 minutes of inactivity.
      </p>
    </>
  );
}

export default function TerminalPage() {
  return <Navigate to="/dashboard/settings?tab=terminal" replace />;
}
