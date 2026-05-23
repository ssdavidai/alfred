// HermesAuthBanner — sticky banner that warns when Hermes can't reach its
// primary language-model provider (codex auth missing / expired).
//
// Passive signal: consumes the existing ``getOnboardingProgress`` query and
// reads ``progress.degraded_stages``, which Phase-4 ``_safe_stage_wrapper``
// stamps on ``onboard.json`` whenever an Opus-tier activity raises AuthError.
// Dismissal is per-session (sessionStorage) — on refresh, if auth is still
// bad, the banner returns. No new endpoints, no Wasp SDK regen.

import { useEffect, useState } from "react";
import { useQuery, getOnboardingProgress } from "wasp/client/operations";
import { deriveHermesHealthFromProgress } from "./hermesHealthCore";

const DISMISS_KEY = "hermes_auth_banner_dismissed_v1";
const POLL_MS = 30_000;

function readDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* ignore quota errors */
  }
}

export default function HermesAuthBanner() {
  const { data: progress } = useQuery(getOnboardingProgress, undefined, {
    refetchInterval: POLL_MS,
    retry: false,
  });
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed());
  useEffect(() => { setDismissed(readDismissed()); }, []);

  const health = deriveHermesHealthFromProgress(progress);
  if (health.healthy || dismissed) return null;

  const stages = health.degradedStages.join(", ");
  return (
    <div
      role="alert"
      className="sticky top-0 z-30 border-b border-amber-500/40 bg-amber-950/90 px-6 py-4 backdrop-blur-md"
      style={{ color: "#FCE3A1" }}
    >
      <div className="mx-auto flex max-w-[1180px] items-start justify-between gap-6">
        <div className="flex-1">
          <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.22em] text-amber-300">
            Alfred can&apos;t reach the language model
          </div>
          <div className="font-serif text-sm leading-relaxed">
            Deeper analysis finished with reduced fidelity{stages ? ` (${stages})` : ""}.
            Hermes needs a re-authentication. From the host:
          </div>
          <pre
            className="mt-3 overflow-x-auto rounded-sm border border-amber-700/40 bg-black/40 px-3 py-2 font-mono text-[12px] leading-relaxed"
            style={{ color: "#E8E4DE" }}
          >
            {"docker exec -it alfred-black-hermes-1 hermes auth login --provider openai-codex\n" +
              "docker compose restart hermes"}
          </pre>
          <div className="mt-2 font-serif text-[13px] text-amber-200/80">
            Then retry onboarding. Existing data is preserved.
          </div>
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
