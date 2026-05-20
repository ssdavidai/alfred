// /sms — short, time-sensitive judgment calls (#849).
//
// Adapted from /tmp/alfred-black-redesign/src/routes/sms.tsx.

import { useState } from "react";
import { Frame } from "../client/components/ab/Frame";
import { Phone, StatusBar } from "../client/components/ab/Phone";

type Msg = { who: "alfred" | "you"; text: string; at: string };

const THREAD: Msg[] = [
  {
    who: "alfred",
    text: "Karen has moved the Tuesday call to Thursday at four. Shall I confirm?",
    at: "06:48",
  },
  { who: "you", text: "Yes.", at: "06:49" },
  {
    who: "alfred",
    text: "Done. I have also moved the gym to Friday so the day reads cleanly.",
    at: "06:49",
  },
  {
    who: "alfred",
    text:
      "The porter has the Example Co delivery. I shall have it on your desk by lunch.",
    at: "11:12",
  },
];

export default function SmsPage() {
  const [thread, setThread] = useState<Msg[]>(THREAD);

  return (
    <Frame>
      <section className="mx-auto max-w-[1200px] px-8 py-16 grid md:grid-cols-[420px_1fr] gap-16 items-start">
        <Phone label="Alfred · +44 20 7946 0188">
          <div
            className="h-full paper flex flex-col"
            style={{ borderRadius: 44 }}
          >
            <StatusBar light={false} />
            <div className="px-5 py-3 border-b border-rule flex items-center gap-3">
              <div
                className="w-9 h-9 grid place-items-center"
                style={{
                  background: "var(--wool)",
                  color: "var(--paper)",
                  borderRadius: 999,
                }}
              >
                <span
                  className="font-display italic"
                  style={{ color: "var(--brass)", fontWeight: 700 }}
                >
                  A
                </span>
              </div>
              <div>
                <div className="font-display italic text-[16px]">Alfred</div>
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.2em]"
                  style={{ color: "var(--marginalia)" }}
                >
                  by appointment
                </div>
              </div>
            </div>
            <div className="flex-1 px-4 py-4 space-y-3 overflow-auto">
              {thread.map((m, i) => (
                <div
                  key={i}
                  className={`flex ${m.who === "you" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className="max-w-[78%] px-3 py-2"
                    style={{
                      background:
                        m.who === "you"
                          ? "var(--ink)"
                          : "oklch(0.22 0.004 60 / 0.06)",
                      color: m.who === "you" ? "var(--paper)" : "var(--ink)",
                      borderRadius:
                        m.who === "you"
                          ? "14px 14px 4px 14px"
                          : "14px 14px 14px 4px",
                      border:
                        m.who === "alfred" ? "1px solid var(--rule)" : "none",
                    }}
                  >
                    <div
                      className={
                        m.who === "alfred"
                          ? "font-body italic text-[14px] leading-snug"
                          : "font-body text-[14px]"
                      }
                    >
                      {m.text}
                    </div>
                    <div className="font-mono text-[9px] uppercase tracking-[0.2em] mt-1 opacity-60">
                      {m.at}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-rule p-3 grid grid-cols-3 gap-2 font-mono text-[10px] uppercase tracking-[0.2em]">
              <button
                onClick={() =>
                  setThread([...thread, { who: "you", text: "Yes.", at: "now" }])
                }
                className="py-3"
                style={{ background: "var(--ink)", color: "var(--paper)" }}
              >
                Yes
              </button>
              <button
                onClick={() =>
                  setThread([...thread, { who: "you", text: "Not yet.", at: "now" }])
                }
                className="py-3 border border-rule"
              >
                Not yet
              </button>
              <button
                className="py-3 border border-rule"
                style={{ color: "var(--brass)" }}
              >
                Call A.
              </button>
            </div>
          </div>
        </Phone>

        <div>
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--brass)" }}
          >
            № V — Telephone
          </div>
          <h1 className="font-display text-5xl tracking-tight mt-2 mb-4">
            Short. Considered. Rare.
          </h1>
          <p className="font-body text-[18px] max-w-[58ch] leading-relaxed">
            SMS is for the time-sensitive judgment call: a moved meeting, a
            porter at the door, a question that wants a single word in reply.
            The thread reads like a short note slipped under the door, not a
            chat.
          </p>
          <hr className="rule my-8" />
          <div className="grid grid-cols-2 gap-6 font-mono text-[11px] uppercase tracking-[0.2em]">
            <div>
              <div style={{ color: "var(--brass)" }}>Permitted</div>
              <div
                className="font-body normal-case text-[15px] tracking-normal mt-1"
                style={{ color: "var(--ink)" }}
              >
                Schedule changes. Deliveries. One-line confirmations.
              </div>
            </div>
            <div>
              <div style={{ color: "var(--brass)" }}>Forbidden</div>
              <div
                className="font-body normal-case text-[15px] tracking-normal mt-1"
                style={{ color: "var(--ink)" }}
              >
                Family matters. Long discussion. Anything wanting a paragraph.
              </div>
            </div>
          </div>
        </div>
      </section>
    </Frame>
  );
}
