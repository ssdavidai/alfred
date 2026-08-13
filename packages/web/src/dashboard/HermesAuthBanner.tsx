// HermesAuthBanner — sticky banner that warns when Hermes can't reach its
// primary language-model provider (codex auth missing / expired).
//
// Passive signal: consumes the existing ``getOnboardingProgress`` query and
// reads ``progress.degraded_stages``, which Phase-4 ``_safe_stage_wrapper``
// stamps on ``onboard.json`` whenever an Opus-tier activity raises AuthError.
// Dismissal is per-session (sessionStorage) — on refresh, if auth is still
// bad, the banner returns. No new endpoints, no Wasp SDK regen.
//
// Auth flow (#565): operator clicks "Connect from browser" → polls
// getCodexAuthStatus every 2.5 s → shows user_code + link → on complete
// dispatches POST /hermes/restart → "Restarting…" (~30 s) → "Done."
//
// CLI fallback corrected: `hermes auth add openai-codex --type oauth`
// (`hermes auth login --provider openai-codex` does NOT exist on 0.19.0)

import { useEffect, useRef, useState } from "react";
import {
  useQuery,
  getOnboardingProgress,
  getCodexAuthStatus,
  startCodexAuth,
  restartHermes,
} from "wasp/client/operations";
import { deriveHermesHealthFromProgress } from "./hermesHealthCore";

const DISMISS_KEY = "hermes_auth_banner_dismissed_v1";
const POLL_MS = 30_000;
const CORRECT_CLI =
  "docker exec -it alfred-black-hermes-1 hermes auth add openai-codex --type oauth\n" +
  "docker compose restart hermes";

function readDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.sessionStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
}
function writeDismissed(): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.setItem(DISMISS_KEY, "1"); } catch { /* quota */ }
}

type CPhase = "idle"|"pending"|"show_code"|"restarting"|"done"|"failed"|"timeout";

export default function HermesAuthBanner() {
  const { data: progress } = useQuery(getOnboardingProgress, undefined, {
    refetchInterval: POLL_MS,
    retry: false,
  });
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed());
  useEffect(() => { setDismissed(readDismissed()); }, []);

  const [phase, setPhase] = useState<CPhase>("idle");
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verifyUri, setVerifyUri] = useState<string | null>(null);
  const [cErr, setCErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sentRestart = useRef(false);

  const polling = phase === "pending" || phase === "show_code";
  const { data: sData } = useQuery(getCodexAuthStatus, undefined, {
    refetchInterval: polling ? 2_500 : 60_000,
  });

  useEffect(() => {
    const s = (sData as any);
    if (!s) return;
    const st: string = s.status ?? "not_started";
    if (st === "awaiting_approval") {
      if (s.user_code && s.verification_uri) { setUserCode(s.user_code); setVerifyUri(s.verification_uri); setPhase("show_code"); }
      else setPhase("pending");
    } else if (st === "complete") {
      if (!sentRestart.current) {
        sentRestart.current = true;
        setPhase("restarting");
        (restartHermes as (a: Record<string, never>) => Promise<unknown>)({}).finally(() => setPhase("done"));
      }
    } else if (st === "failed") {
      setCErr(s.error ?? "hermes auth exited non-zero"); setPhase("failed");
    } else if (st === "timeout") {
      setPhase("timeout");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sData]);

  const health = deriveHermesHealthFromProgress(progress);
  if (health.healthy || dismissed) return null;

  async function onConnect() {
    setBusy(true); setCErr(null);
    try {
      await (startCodexAuth as (a: Record<string, never>) => Promise<unknown>)({});
      setPhase("pending");
    } catch (e: any) { setCErr(e?.message ?? "start failed"); }
    finally { setBusy(false); }
  }

  const stages = health.degradedStages.join(", ");
  return (
    <div role="alert" className="sticky top-0 z-30 border-b border-amber-500/40 bg-amber-950/90 px-6 py-4 backdrop-blur-md" style={{ color: "#FCE3A1" }}>
      <div className="mx-auto flex max-w-[1180px] items-start justify-between gap-6">
        <div className="flex-1">
          <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.22em] text-amber-300">
            Alfred can&apos;t reach the language model
          </div>
          {phase === "idle" && <>
            <div className="font-serif text-sm leading-relaxed">
              Deeper analysis finished with reduced fidelity{stages ? ` (${stages})` : ""}. Re-authenticate from this page, or from the host:
            </div>
            <pre className="mt-3 overflow-x-auto rounded-sm border border-amber-700/40 bg-black/40 px-3 py-2 font-mono text-[12px] leading-relaxed" style={{ color: "#E8E4DE" }}>{CORRECT_CLI}</pre>
            <div className="mt-3 flex items-center gap-3">
              <button type="button" onClick={onConnect} disabled={busy} className="border border-amber-500/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.22em] text-amber-200 transition-colors hover:border-amber-300 hover:text-white disabled:opacity-50">
                {busy ? "Starting…" : "Connect from browser"}
              </button>
              {cErr && <span className="font-serif text-[13px] text-red-300">{cErr}</span>}
            </div>
          </>}
          {phase === "pending" && <div className="font-serif text-sm text-amber-100">Waiting for device code…</div>}
          {phase === "show_code" && userCode && <div className="font-serif text-sm leading-relaxed">
            Visit <a href={verifyUri!} target="_blank" rel="noopener noreferrer" className="underline text-amber-200 hover:text-white">{verifyUri}</a> and enter:
            <div className="mt-2 font-mono text-2xl tracking-[0.3em] text-white">{userCode}</div>
            <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.18em] text-amber-300/70">Waiting for approval…</div>
          </div>}
          {phase === "restarting" && <div className="font-serif text-sm text-amber-100">Connected. Restarting Hermes to apply the credential — takes ~30 seconds.</div>}
          {phase === "done" && <div className="font-serif text-sm text-amber-100">Hermes is back online. Dismiss this banner.</div>}
          {phase === "failed" && <div className="font-serif text-sm">Authentication failed: {cErr}.{" "}
            <button type="button" onClick={onConnect} disabled={busy} className="underline hover:text-white">Retry</button></div>}
          {phase === "timeout" && <div className="font-serif text-sm">The code expired.{" "}
            <button type="button" onClick={onConnect} disabled={busy} className="underline hover:text-white">Retry</button> to start a new ceremony.</div>}
          <div className="mt-2 font-serif text-[13px] text-amber-200/80">Then retry onboarding. Existing data is preserved.</div>
        </div>
        <button
          type="button"
          onClick={() => { writeDismissed(); setDismissed(true); }}
          className="shrink-0 font-mono text-[10px] uppercase tracking-[0.22em] text-amber-300/80 transition-colors hover:text-amber-200"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
