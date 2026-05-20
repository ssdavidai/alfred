// /reading-the-room — the "Alfred is working" theatre (#852, narration #117).
//
// Driven entirely by the live `getOnboardingProgress` query:
//   • the act indicator (kicker + title) tracks the REAL pipeline stage, so the
//     principal sees where Alfred is — reading the post, taking their measure,
//     finding patterns, composing his soul, …
//   • the narration is the backend's stage-tagged butler one-liners (generated
//     per stage from real data, through Hermes). We drip them out one at a time
//     on a jittered ~5s timer (3-15s) so it feels organic and live, in a
//     sliding window of the most recent lines.
//   • Continue unlocks once the backend reports facts are ready.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, getOnboardingProgress } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { RitualNav } from "../client/components/ab/RitualNav";

type Narration = { stage?: string; line: string; domain?: string };

const TOTAL_DAYS = 100;
const TICK_MS = 80;
const FEED_WINDOW = 14; // how many recent lines stay on screen

// "Where Alfred is" — the act for each real pipeline stage.
const ACTS: Record<string, { kicker: string; title: string }> = {
  metadata: { kicker: "Reading the post", title: "Reading your last 100 days of email." },
  backfill: { kicker: "Reading the post", title: "Reading your last 100 days of email." },
  processing: { kicker: "Reading the post", title: "Reading your last 100 days of email." },
  facts: { kicker: "Taking your measure", title: "Working out who you are." },
  patterns: { kicker: "Noting the rhythms", title: "Finding the patterns in your days." },
  awaiting_verification: { kicker: "A moment", title: "Ready for your eyes." },
  brief: { kicker: "Pen to paper", title: "Drafting your first brief." },
  packs: { kicker: "Setting the table", title: "Filing your matters and instincts." },
  chores: { kicker: "Winding the clocks", title: "Writing your standing chores." },
  done: { kicker: "At your service", title: "Ready." },
};

// `personalize` is one backend stage but four acts — cycle through them.
const PERSONALIZE_ACTS = [
  { kicker: "Composing", title: "Composing my soul." },
  { kicker: "Writing", title: "Writing your profile." },
  { kicker: "Remembering", title: "Waking my memory." },
  { kicker: "Preparing", title: "Laying out my tools." },
];

const STAGE_LABEL: Record<string, string> = {
  email: "inbox",
  facts: "noticing",
  patterns: "pattern",
  personalize: "musing",
};

// ~5s average, organic 3-15s jitter (skewed toward the shorter end).
function nextDelay(): number {
  return 3000 + Math.floor(Math.random() * Math.random() * 12000);
}

export default function ReadingTheRoomPage() {
  const [day, setDay] = useState(0);
  const [revealed, setRevealed] = useState(0);
  const [pcycle, setPcycle] = useState(0);
  const navigate = useNavigate();

  const { data: progress } = useQuery(getOnboardingProgress, undefined, {
    refetchInterval: 4_000,
  });

  // Scan-bar animation (purely cosmetic motion while data streams in).
  useEffect(() => {
    if (day >= TOTAL_DAYS) return;
    const t = setTimeout(() => setDay(day + 1), TICK_MS);
    return () => clearTimeout(t);
  }, [day]);

  const stage = String(progress?.stage ?? "");
  const narration = (((progress as any)?.narration ?? []) as Narration[]).filter(
    (n) => n && n.line,
  );
  const messagesRead = ((progress as any)?.messages_read ??
    progress?.progress?.total_days ??
    0) as number;
  const factsCount = (progress?.facts_count ?? 0) as number;

  // Jittered drip — reveal one more line whenever the timer fires and there's
  // an unrevealed line waiting. Independent of the scan animation, so it keeps
  // flowing across the whole multi-minute run as new batches land.
  useEffect(() => {
    if (narration.length === 0 || revealed >= narration.length) return;
    const t = setTimeout(() => setRevealed((r) => r + 1), nextDelay());
    return () => clearTimeout(t);
  }, [narration.length, revealed]);

  // Cycle the personalize sub-acts.
  useEffect(() => {
    if (stage !== "personalize") return;
    const t = setInterval(
      () => setPcycle((c) => (c + 1) % PERSONALIZE_ACTS.length),
      7000,
    );
    return () => clearInterval(t);
  }, [stage]);

  const act =
    stage === "personalize"
      ? PERSONALIZE_ACTS[pcycle]
      : ACTS[stage] ?? ACTS.metadata;

  const animationDone = day >= TOTAL_DAYS;
  const backendReady =
    stage === "awaiting_verification" || stage === "brief" || stage === "done";
  const done = animationDone && backendReady;

  // Sliding window of the most recent revealed lines (oldest→newest).
  const feed = narration.slice(0, revealed).slice(-FEED_WINDOW);

  const shownMessages =
    messagesRead && narration.length
      ? Math.min(
          messagesRead,
          Math.floor(
            (Math.max(revealed, 1) / narration.length) * messagesRead,
          ),
        )
      : messagesRead
        ? Math.floor((day / TOTAL_DAYS) * messagesRead)
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
            {act.kicker}
          </div>
          <RitualNav active="read" />
        </div>

        <h1 className="font-display text-5xl tracking-tight mb-3">{act.title}</h1>
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

        {/* Live, drip-fed butler narration of the principal's real data. */}
        <ul className="space-y-3 min-h-[280px]">
          {feed.map((r, i) => {
            const isNewest = i === feed.length - 1;
            return (
              <li
                key={`${revealed}-${i}`}
                className="grid grid-cols-[120px_1fr] gap-4 font-mono text-[13px] items-baseline"
                style={{ opacity: isNewest ? 1 : Math.max(0.4, 1 - (feed.length - 1 - i) * 0.05) }}
              >
                <span
                  className="uppercase tracking-[0.16em] text-[10px] truncate"
                  style={{ color: "var(--marginalia)" }}
                  title={r.domain || r.stage}
                >
                  {r.domain || STAGE_LABEL[r.stage ?? ""] || "alfred"}
                </span>
                <span
                  className="font-display italic text-[18px]"
                  style={{ color: "var(--ink)" }}
                >
                  {r.line}
                </span>
              </li>
            );
          })}
          {narration.length === 0 && (
            <li
              className="font-body italic text-[15px]"
              style={{ color: "var(--marginalia)" }}
            >
              Settling in. Alfred is opening the post, one envelope at a time…
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
