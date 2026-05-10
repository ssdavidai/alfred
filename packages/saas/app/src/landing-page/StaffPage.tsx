// /staff — the agents that work for you (#848).
//
// Adapted from /tmp/alfred-black-redesign/src/routes/staff.tsx. Static copy;
// no live data. Linked from LandingPage's footer index and from Frame's
// "More" → Staff dropdown.

import { Frame } from "../client/components/ab/Frame";

const STAFF: Array<{ name: string; role: string; body: string }> = [
  {
    name: "Alfred",
    role: "The Butler",
    body:
      "The agent you actually speak to. He orchestrates the staff, answers your questions, and runs your errands.",
  },
  {
    name: "The Curator",
    role: "Filing",
    body:
      "Receives anything you hand in — meeting notes, documents, screenshots — and files it as connected vault records.",
  },
  {
    name: "The Janitor",
    role: "Tending",
    body:
      "Walks the vault on a schedule, mending broken links and tidying inconsistencies before you notice.",
  },
  {
    name: "The Distiller",
    role: "Reading between lines",
    body:
      "Reads the existing records and surfaces the assumptions, decisions, constraints, and contradictions hidden there.",
  },
  {
    name: "The Surveyor",
    role: "Mapping",
    body:
      "Embeds records, clusters them by meaning, and quietly maps how your world fits together.",
  },
  {
    name: "The Clerk",
    role: "Short-form reasoning",
    body:
      "A stateless analyst, dispatched on demand for classification, extraction, and brief deductions.",
  },
  {
    name: "The Steward",
    role: "Watching the day",
    body:
      "Sifts the daily traffic for what matters — promotes signals to errands, attaches them to the right matter, and retires what is finished.",
  },
  {
    name: "Intuition",
    role: "Learning",
    body:
      "Observes how you route things. Over time, observations harden into patterns Alfred can act on without asking.",
  },
];

export default function StaffPage() {
  return (
    <Frame>
      <section className="mx-auto max-w-[1080px] px-8 py-14">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em] mb-3"
          style={{ color: "var(--brass)" }}
        >
          Staff
        </div>
        <h1 className="font-display text-5xl tracking-tight mb-3">
          The agents that work for you.
        </h1>
        <p
          className="font-body text-[17px] max-w-[60ch] mb-10"
          style={{ color: "var(--marginalia)" }}
        >
          Alfred is the one you speak to. Behind him, a small staff of specialists.
        </p>

        <ul className="border-t border-rule">
          {STAFF.map((s) => (
            <li
              key={s.name}
              className="grid grid-cols-[220px_1fr] gap-6 py-6 border-b border-rule items-baseline"
            >
              <div>
                <div className="font-display text-[26px]">{s.name}</div>
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.22em]"
                  style={{ color: "var(--brass)" }}
                >
                  {s.role}
                </div>
              </div>
              <p className="font-body text-[17px] leading-[1.55]">{s.body}</p>
            </li>
          ))}
        </ul>
      </section>
    </Frame>
  );
}
