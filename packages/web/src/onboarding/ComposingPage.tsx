// /composing — interstitial while the brief is generated (#852).
//
// Adapted from /tmp/alfred-black-redesign/src/routes/composing.tsx. Polls
// `getOnboardingProgress` for the brief and advances to /first-brief when
// the brief field is populated. Falls through after a max wait window so a
// stuck workflow never traps the user.

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, getOnboardingProgress } from "wasp/client/operations";
import { RitualNav, HairlineFill } from "../client/components/ab/RitualNav";

const FALLBACK_MS = 60_000; // give up the polling-based gate after 60s

export default function ComposingPage() {
  const navigate = useNavigate();
  const { data: progress } = useQuery(getOnboardingProgress, undefined, {
    refetchInterval: 4_000,
  });

  const briefReady =
    progress?.stage === "done" ||
    (typeof progress?.brief === "string" && progress.brief.length > 0);

  // Advance ONLY when the brief is actually written — never on a bare timer
  // (the old unconditional fallback dumped the user on an empty /first-brief
  // while the brief was still composing).
  useEffect(() => {
    if (briefReady) {
      navigate("/first-brief");
    }
  }, [briefReady, navigate]);

  // Safety net: if the brief is genuinely stuck for a long time, return to the
  // Desk (NOT an empty brief) so the user is never trapped on this interstitial.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!briefReady) navigate("/desk");
    }, 600_000);
    return () => clearTimeout(t);
  }, [briefReady, navigate]);

  return (
    <div className="paper min-h-screen flex flex-col">
      <header className="px-8 py-6 flex items-baseline justify-between border-b border-rule">
        <div className="font-display text-xl tracking-tight">
          Alfred<span style={{ color: "var(--brass)" }}>·</span>Black
        </div>
        <RitualNav active="brief" />
      </header>
      <main className="flex-1 flex items-center">
        <div className="mx-auto max-w-[640px] w-full px-8 text-center">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em] mb-6"
            style={{ color: "var(--brass)" }}
          >
            A moment, sir
          </div>
          <h1 className="font-display italic text-5xl tracking-tight mb-10">
            Composing your first Brief.
          </h1>
          <HairlineFill ms={FALLBACK_MS} />
          <p
            className="font-body italic mt-8"
            style={{ color: "var(--marginalia)" }}
          >
            Alfred is drafting only what is true; the rest can wait.
          </p>
        </div>
      </main>
    </div>
  );
}
