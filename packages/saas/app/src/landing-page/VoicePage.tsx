// /voice — the travel-day briefing, by telephone (#849).
//
// Adapted from /tmp/alfred-black-redesign/src/routes/voice.tsx. A telephone
// mock with a live-typing transcript. Static copy.

import { useEffect, useState } from "react";
import { Frame } from "../client/components/ab/Frame";
import { Phone, StatusBar } from "../client/components/ab/Phone";

const TRANSCRIPT: Array<{ t: string; who: string; line: string }> = [
  { t: "06:30:02", who: "Alfred", line: "Good morning, sir. The car will be at the door at seven." },
  {
    t: "06:30:09",
    who: "Alfred",
    line:
      "Your flight to Zurich departs at nine; the gate is currently A24, but they have moved it twice already this week, so I shall watch.",
  },
  {
    t: "06:30:21",
    who: "Alfred",
    line:
      "Your hotel is the Storchen, as you preferred last March. I have asked them to keep room 304.",
  },
  {
    t: "06:30:33",
    who: "Alfred",
    line:
      "One matter. M. Holloway would like a quarter-hour at six this evening, your local time. I have provisionally said yes; reply 'no' and I shall undo it.",
  },
  {
    t: "06:30:48",
    who: "Alfred",
    line: "That is everything pressing. I shall ring again at landing only if I must.",
  },
];

export default function VoicePage() {
  const [secs, setSecs] = useState(0);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const i = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    if (shown >= TRANSCRIPT.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), 1800);
    return () => clearTimeout(t);
  }, [shown]);

  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");

  return (
    <Frame dark>
      <section className="mx-auto max-w-[1200px] px-8 py-16 grid md:grid-cols-[420px_1fr] gap-16 items-start">
        <Phone label="Incoming · 06:30">
          <div
            className="h-full"
            style={{
              background: "linear-gradient(180deg, #1a1a1a 0%, #050505 100%)",
              borderRadius: 44,
            }}
          >
            <StatusBar />
            <div className="text-center mt-12" style={{ color: "var(--paper)" }}>
              <div className="font-mono text-[10px] uppercase tracking-[0.28em] opacity-60">
                Calling — encrypted
              </div>
              <div
                className="mt-10 mx-auto"
                style={{
                  width: 140,
                  height: 140,
                  borderRadius: 999,
                  background: "var(--wool)",
                  border: "1px solid oklch(1 0 0 / 0.15)",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <div
                  className="font-display italic text-[64px]"
                  style={{ color: "var(--brass)", fontWeight: 700 }}
                >
                  A
                </div>
              </div>
              <div className="font-display text-[34px] mt-8">Alfred</div>
              <div className="font-mono text-[12px] uppercase tracking-[0.22em] opacity-60 mt-1">
                {mm}:{ss}
              </div>

              <div className="mt-12 grid grid-cols-3 gap-4 px-10 font-mono text-[9px] uppercase tracking-[0.2em] opacity-80">
                <Btn label="Mute" />
                <Btn label="Speaker" />
                <Btn label="Keypad" />
              </div>
              <button
                className="mt-10 mx-auto block px-7 py-3 font-mono text-[10px] uppercase tracking-[0.22em]"
                style={{ background: "#7a1a1a", color: "var(--paper)", borderRadius: 999 }}
              >
                End
              </button>
            </div>
          </div>
        </Phone>

        <div>
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--brass)" }}
          >
            № VI — Voice
          </div>
          <h1
            className="font-display text-5xl tracking-tight mt-2 mb-4"
            style={{ color: "var(--paper)" }}
          >
            The travel-day briefing.
          </h1>
          <p
            className="font-body italic text-[17px] max-w-[60ch]"
            style={{ color: "oklch(0.85 0.01 80 / 0.7)" }}
          >
            Alfred speaks in the voice of a person who has read the morning's
            correspondence and decided what is worth saying aloud. He stops
            when there is nothing more to say.
          </p>

          <div
            className="mt-10 border-t pt-6"
            style={{ borderColor: "oklch(1 0 0 / 0.12)" }}
          >
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em] mb-4"
              style={{ color: "var(--brass)" }}
            >
              Transcript — live
            </div>
            <ol className="space-y-4">
              {TRANSCRIPT.slice(0, shown).map((l, i) => (
                <li key={i} className="grid grid-cols-[80px_1fr] gap-5">
                  <span
                    className="font-mono text-[11px] mt-1"
                    style={{ color: "oklch(0.85 0.01 80 / 0.45)" }}
                  >
                    {l.t}
                  </span>
                  <span
                    className="font-body italic text-[18px] leading-snug"
                    style={{ color: "var(--paper)" }}
                  >
                    {l.line}
                  </span>
                </li>
              ))}
              {shown < TRANSCRIPT.length && (
                <li
                  className="font-mono text-[11px] caret"
                  style={{ color: "var(--brass)" }}
                >
                  …
                </li>
              )}
            </ol>
          </div>
        </div>
      </section>
    </Frame>
  );
}

function Btn({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 999,
          background: "oklch(1 0 0 / 0.10)",
        }}
      />
      <span>{label}</span>
    </div>
  );
}
