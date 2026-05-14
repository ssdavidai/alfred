// /reading-the-room — second ritual step (#852).
//
// Adapted from /tmp/alfred-black-redesign/src/routes/reading-the-room.tsx and
// wired to the live `getOnboardingProgress` query. Until the backend reports
// `stage === "awaiting_verification"` (or "done"), the canned scan animation
// keeps cycling. Once the backend signals enough has been read, the user can
// advance to /verify.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, getOnboardingProgress } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { RitualNav } from "../client/components/ab/RitualNav";

const RECORDS_LOG: Array<{ type: string; title: string }> = [
  { type: "Person", title: "Karen Porter" },
  { type: "Organisation", title: "Carter & Co." },
  { type: "Project", title: "The Carter Sprint" },
  { type: "Person", title: "Margaret Holloway" },
  { type: "Organisation", title: "Holloway & Stone" },
  { type: "Person", title: "Junichi Ito" },
  { type: "Event", title: "Brutto — 23 May" },
  { type: "Person", title: "Eliza Vance" },
  { type: "Project", title: "Eliza's Wedding" },
  { type: "Organisation", title: "Smythson" },
  { type: "Task", title: "Smythson Invoice — May" },
  { type: "Conversation", title: "Carter Sprint Standup — 11 May" },
  { type: "Observation", title: "Sister rings on Sunday evenings" },
  { type: "Assumption", title: "Karen prefers Thursday afternoons" },
];

const TOTAL_DAYS = 100;
const TICK_MS = 50;

export default function ReadingTheRoomPage() {
  const [day, setDay] = useState(0);
  const navigate = useNavigate();

  const { data: progress } = useQuery(getOnboardingProgress, undefined, {
    refetchInterval: 5_000,
  });

  useEffect(() => {
    if (day >= TOTAL_DAYS) return;
    const t = setTimeout(() => setDay(day + 1), TICK_MS);
    return () => clearTimeout(t);
  }, [day]);

  const animationDone = day >= TOTAL_DAYS;
  const stage = (progress?.stage ?? null) as string | null;
  const factsCount = (progress?.progress?.facts_count ?? 0) as number;
  const backendReady =
    stage === "awaiting_verification" || stage === "brief" || stage === "done";
  const done = animationDone && backendReady;

  const visible = RECORDS_LOG.slice(
    0,
    Math.min(
      RECORDS_LOG.length,
      Math.floor((day / TOTAL_DAYS) * RECORDS_LOG.length) + 1,
    ),
  );
  const messages = Math.floor((day / TOTAL_DAYS) * 14_812);

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
          — the people, the projects, the patterns. Nothing leaves your wallet.
        </p>

        <div className="border-t border-rule pt-6 mb-10">
          <div className="font-mono text-[12px] flex items-baseline justify-between">
            <span>
              Day {String(day).padStart(3, "0")} of {TOTAL_DAYS} ·{" "}
              {messages.toLocaleString()} messages read
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
                transition: "width 60ms linear",
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

        <ul className="space-y-2">
          {visible.map((r, i) => (
            <li
              key={i}
              className="grid grid-cols-[110px_1fr] gap-4 font-mono text-[13px] items-baseline"
            >
              <span
                className="uppercase tracking-[0.18em] text-[10px]"
                style={{ color: "var(--marginalia)" }}
              >
                {r.type}
              </span>
              <span
                className="font-display italic text-[18px]"
                style={{ color: "var(--ink)" }}
              >
                {r.title}
              </span>
            </li>
          ))}
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
