// /reading-the-room — second ritual step (#852).
//
// Wired to the live `getOnboardingProgress` query. The message count and the
// scrolling log are now REAL: the backend (alfred-learn) reads the principal's
// inbox, and a cheap pass through Hermes writes dry butler one-liners about the
// actual mail into `onboard.json["narration"]`. We reveal those progressively,
// paced by the scan animation, so it feels like Alfred is reading and
// commenting on the inbox live. Until the backend reports
// `stage === "awaiting_verification"` (or later), the scan keeps cycling; once
// it's read enough, the user can advance to /verify.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, getOnboardingProgress } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { RitualNav } from "../client/components/ab/RitualNav";

type Narration = { line: string; domain?: string };

const TOTAL_DAYS = 100;
const TICK_MS = 80;

export default function ReadingTheRoomPage() {
  const [day, setDay] = useState(0);
  const [revealed, setRevealed] = useState(0);
  const navigate = useNavigate();

  const { data: progress } = useQuery(getOnboardingProgress, undefined, {
    refetchInterval: 4_000,
  });

  useEffect(() => {
    if (day >= TOTAL_DAYS) return;
    const t = setTimeout(() => setDay(day + 1), TICK_MS);
    return () => clearTimeout(t);
  }, [day]);

  const stage = (progress?.stage ?? null) as string | null;
  const factsCount = (progress?.facts_count ??
    progress?.progress?.facts_count ??
    0) as number;
  const narration = (((progress as any)?.narration ?? []) as Narration[]).filter(
    (n) => n && n.line,
  );
  const messagesRead = ((progress as any)?.messages_read ??
    progress?.progress?.total_days ??
    0) as number;

  // Drip-reveal the narration on its OWN timer, starting when the lines
  // arrive. The backend generates them only after the multi-minute email
  // fetch — long after the 8s scan animation ends — so pacing the reveal off
  // `day` dumped them all at once. This reveals one line at a time as they land.
  useEffect(() => {
    if (narration.length === 0 || revealed >= narration.length) return;
    const t = setTimeout(() => setRevealed((r) => r + 1), 1600);
    return () => clearTimeout(t);
  }, [narration.length, revealed]);
  const visible = narration.slice(0, revealed);

  const animationDone = day >= TOTAL_DAYS;
  const backendReady =
    stage === "awaiting_verification" || stage === "brief" || stage === "done";
  const done = animationDone && backendReady;

  // Message counter ramps with the reveal once narration is present (in step
  // with the drip); before the lines arrive it tracks the scan animation.
  const shownMessages = messagesRead
    ? narration.length
      ? Math.floor((revealed / narration.length) * messagesRead)
      : Math.floor((day / TOTAL_DAYS) * messagesRead)
    : 0;

  useEffect(() => {
    if (!done) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") navigate("/verify");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [done, navigate]);

  return (
    <Frame>
      <section className="mx-auto max-w-[860px] px-8 py-16">
        <div className="flex items-baseline justify-between gap-8 mb-10">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--brass)" }}
          >
            Scan inbox
          </div>
          <RitualNav active="read" />
        </div>

        <h1 className="font-display text-5xl tracking-tight mb-3">
          Reading your last 100 days of email.
        </h1>
        <p
          className="font-body text-[17px] mb-10 max-w-[58ch]"
          style={{ color: "var(--marginalia)" }}
        >
          Alfred is learning the shape of your life so he can serve you best
          — the people, the projects, the patterns. Nothing leaves your VM.
        </p>

        <div className="border-t border-rule pt-6 mb-10">
          <div className="font-mono text-[12px] flex items-baseline justify-between">
            <span>
              {messagesRead
                ? `${shownMessages.toLocaleString()} of ${messagesRead.toLocaleString()} messages read`
                : "Opening the post…"}
            </span>
            <span style={{ color: "var(--marginalia)" }}>
              {Math.round((day / TOTAL_DAYS) * 100)}%
            </span>
          </div>
          <div
            className="relative h-px mt-3"
            style={{ background: "var(--rule)" }}
          >
            <div
              className="absolute inset-y-0 left-0"
              style={{
                background: "var(--brass)",
                width: `${(day / TOTAL_DAYS) * 100}%`,
                transition: "width 80ms linear",
              }}
            />
          </div>
          {factsCount > 0 && (
            <div
              className="mt-3 font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--marginalia)" }}
            >
              {factsCount} facts surfaced
            </div>
          )}
        </div>

        {/* Live butler narration of the principal's real inbox. */}
        <ul className="space-y-3">
          {visible.map((r, i) => (
            <li
              key={i}
              className="grid grid-cols-[150px_1fr] gap-4 font-mono text-[13px] items-baseline"
            >
              <span
                className="uppercase tracking-[0.16em] text-[10px] truncate"
                style={{ color: "var(--marginalia)" }}
                title={r.domain}
              >
                {r.domain || "inbox"}
              </span>
              <span
                className="font-display italic text-[18px]"
                style={{ color: "var(--ink)" }}
              >
                {r.line}
              </span>
            </li>
          ))}
          {narration.length === 0 && (
            <li
              className="font-body italic text-[15px]"
              style={{ color: "var(--marginalia)" }}
            >
              Alfred is opening the post, one envelope at a time…
            </li>
          )}
        </ul>

        {animationDone && !backendReady && (
          <p
            className="mt-12 font-body italic text-[15px]"
            style={{ color: "var(--marginalia)" }}
          >
            A moment. Alfred is finishing his read.
          </p>
        )}

        {done && (
          <div className="mt-16 border-t border-rule pt-8">
            <button onClick={() => navigate("/verify")} className="btn-brass">
              Continue →
            </button>
          </div>
        )}
      </section>
    </Frame>
  );
}
