// /voice-and-tone — courteous, precise, lightly old-fashioned (#849).
//
// Adapted from /tmp/alfred-black-redesign/src/routes/voice-and-tone.tsx.

import { Frame } from "../client/components/ab/Frame";

const RULES: Array<[string, string]> = [
  ["Address the user as 'you'.", "Plain second person. No 'Sir', no 'hey'."],
  [
    "Alfred speaks of himself in the third person.",
    "In headings and copy. First person is acceptable inside Alfred's own quoted lines.",
  ],
  ["No emoji.", "Ever. Not in app, email, SMS, voice transcripts, or marketing."],
  ["No exclamation points.", "Except in direct quotation of someone else."],
  ["No twee.", "Old-fashioned, not whimsical. A butler, not a mascot."],
  [
    "Records are kept, not saved.",
    "Files are filed. Records are connected, not tagged.",
  ],
];

const PAIRS: Array<[string, string]> = [
  [
    "Karen has moved the Tuesday call to Thursday at four. Shall Alfred confirm?",
    "Hey! Karen moved your meeting — wanna confirm?",
  ],
  [
    "Alfred is sorry — the post office has not opened. He shall try again at the hour.",
    "Oops! Something went wrong.",
  ],
  ["Nothing requires you. — A.", "You're all caught up!"],
  ["A moment.", "Loading..."],
  ["Alfred has drafted a reply for your consideration.", "Smart Reply ready"],
];

export default function VoiceAndTonePage() {
  return (
    <Frame>
      <section className="mx-auto max-w-[1100px] px-8 py-16">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em]"
          style={{ color: "var(--brass)" }}
        >
          Voice & Tone
        </div>
        <h1 className="font-display text-5xl tracking-tight mt-2">
          Courteous, precise, lightly old-fashioned.
        </h1>

        <div className="grid md:grid-cols-2 gap-12 mt-14">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] mb-4">
              House rules
            </div>
            <ol className="border-t border-rule">
              {RULES.map(([k, v], i) => (
                <li
                  key={i}
                  className="grid grid-cols-[40px_1fr] gap-4 py-5 border-b border-rule items-baseline"
                >
                  <span
                    className="font-mono text-[11px]"
                    style={{ color: "var(--marginalia)" }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <div className="font-display italic text-[20px]">{k}</div>
                    <div
                      className="font-body text-[15px]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      {v}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] mb-4">
              Right vs. wrong
            </div>
            <ul className="space-y-4">
              {PAIRS.map(([right, wrong], i) => (
                <li key={i} className="border border-rule p-5">
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.22em] mb-1"
                    style={{ color: "var(--brass)" }}
                  >
                    Yes
                  </div>
                  <div className="font-body italic text-[18px] leading-snug">
                    {right}
                  </div>
                  <hr className="rule my-3" />
                  <div
                    className="font-mono text-[10px] uppercase tracking-[0.22em] mb-1"
                    style={{ color: "var(--marginalia)" }}
                  >
                    No
                  </div>
                  <div className="struck font-body text-[16px]">{wrong}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <hr className="rule mt-16 mb-8" />
        <div
          className="grid md:grid-cols-3 gap-8 font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ color: "var(--marginalia)" }}
        >
          <div>
            <div style={{ color: "var(--brass)" }}>Address</div>
            <div
              className="font-body normal-case text-[15px] tracking-normal mt-2"
              style={{ color: "var(--ink)" }}
            >
              You. Plain second person, captured at sign-up.
            </div>
          </div>
          <div>
            <div style={{ color: "var(--brass)" }}>Sign-off</div>
            <div
              className="font-body normal-case text-[15px] tracking-normal mt-2"
              style={{ color: "var(--ink)" }}
            >
              <span className="font-display italic">— Alfred.</span> One em-dash,
              full stop.
            </div>
          </div>
          <div>
            <div style={{ color: "var(--brass)" }}>The em-dash</div>
            <div
              className="font-body normal-case text-[15px] tracking-normal mt-2"
              style={{ color: "var(--ink)" }}
            >
              Spaced — like this — and used freely. The rhythm of a person
              thinking.
            </div>
          </div>
        </div>
      </section>
    </Frame>
  );
}
