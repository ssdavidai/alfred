import { useState, useEffect } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "wasp/client/auth";
import Terminal from "./components/Terminal";
import { TerminalSquare, Download, Copy, Check } from "lucide-react";
import { Button } from "../client/components/ui/button";

function SSHAccess() {
  const { data: user } = useAuth();
  const [sshInfo, setSSHInfo] = useState<any>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const sessionId = (() => {
      try { return JSON.parse(localStorage.getItem("wasp:sessionId") || "null"); } catch { return null; }
    })();
    if (!sessionId) return;
    fetch("/api/ssh-info", { headers: { Authorization: `Bearer ${sessionId}` } })
      .then(r => r.json())
      .then(setSSHInfo)
      .catch(() => {});
  }, [user]);

  const downloadKey = () => {
    const sessionId = (() => {
      try { return JSON.parse(localStorage.getItem("wasp:sessionId") || "null"); } catch { return null; }
    })();
    if (!sessionId) return;
    window.location.href = `/api/ssh-key?token=${encodeURIComponent(sessionId)}`;
  };

  const copyCommand = () => {
    if (!sshInfo?.hostname) return;
    navigator.clipboard.writeText(`ssh -i alfred-*.pem deploy@${sshInfo.hostname}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!sshInfo?.available) return null;

  return (
    <div className="mt-6 rounded-sm border border-gold-dim/40 bg-black/20 p-4">
      <h3 className="mb-3 font-serif text-lg font-light text-cream">SSH Access</h3>
      <p className="mb-4 font-sans text-xs text-muted-foreground/70">
        Direct terminal access to your Alfred instance. Use this for{" "}
        <code className="font-mono text-muted-foreground">openclaw configure</code>{" "}
        and other interactive commands.
      </p>

      <div className="flex items-center gap-3 mb-4">
        <Button variant="outline" size="sm" className="gap-1.5 font-mono text-xs" onClick={downloadKey}>
          <Download className="h-3.5 w-3.5" />
          Download SSH Key
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5 font-mono text-xs" onClick={copyCommand}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy Command"}
        </Button>
      </div>

      <div className="rounded-sm bg-black/40 p-3 font-mono text-[0.65rem] text-cream/80 space-y-1">
        {sshInfo.instructions?.map((line: string, i: number) => (
          <p key={i}>{line}</p>
        ))}
      </div>
    </div>
  );
}

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

      <SSHAccess />
    </>
  );
}

export default function TerminalPage() {
  return <Navigate to="/dashboard/settings?tab=terminal" replace />;
}
