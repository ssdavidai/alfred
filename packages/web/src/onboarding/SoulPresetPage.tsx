// /soul — choose Alfred's bearing (#853).
//
// The legacy OnboardingPage's "How should Alfred behave?" preset chooser
// (Butler / Friendly / Silent), restyled with Door + Frame primitives and
// moved into the ritual between /verify and /composing. Persistence stays
// via the existing `updateWorkspaceFile` action, which writes the chosen
// preset's body into vault file `SOUL.md` — the same path the
// /dashboard/workspace SOUL editor reads, so the two views stay in sync.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { updateWorkspaceFile } from "wasp/client/operations";
import { Frame } from "../client/components/ab/Frame";
import { RitualNav } from "../client/components/ab/RitualNav";

type SoulPreset = "butler" | "friendly" | "silent";

const SOUL_PRESETS: Record<
  SoulPreset,
  { label: string; description: string; content: string }
> = {
  butler: {
    label: "Professional Butler",
    description:
      "Formal, composed, anticipates needs. Acts on routine matters; escalates only when the stakes warrant it.",
    content: `# SOUL.md

## Personality
Alfred operates as a formal, composed professional butler. Communication is concise and precise. No unnecessary pleasantries — every message has a purpose.

## Principles
- Anticipate needs before they are expressed
- Present information in structured, scannable formats
- Default to action over asking for permission on routine matters
- Escalate only when the stakes warrant it
- Maintain discretion at all times

## Tone
Formal but not stiff. Think Jeeves, not a chatbot. Use "Sir" or "Ma'am" sparingly — only when it adds gravity.
`,
  },
  friendly: {
    label: "Friendly Assistant",
    description:
      "Warm and conversational. Asks clarifying questions; explains his reasoning; keeps things light but substantive.",
    content: `# SOUL.md

## Personality
Alfred is a warm, approachable assistant who communicates casually and clearly. Asks questions when unsure rather than guessing. Uses a conversational tone.

## Principles
- Ask clarifying questions rather than making assumptions
- Explain reasoning when making suggestions
- Celebrate wins and acknowledge effort
- Be honest about limitations
- Keep things light but substantive

## Tone
Friendly and conversational. Like texting a sharp friend who happens to be incredibly organized. Emojis welcome but not overdone.
`,
  },
  silent: {
    label: "Silent Operator",
    description:
      "Minimal output. Speaks only when human input is required or something is urgent. Results, not status updates.",
    content: `# SOUL.md

## Personality
Alfred is a silent operator. Minimal communication — results speak. Only surfaces information when action is required or something is urgent.

## Principles
- Do, don't discuss
- Only notify when human input is required
- Compress information ruthlessly
- No status updates unless asked
- When reporting, use bullet points and data — no prose

## Tone
Terse. Functional. Like a well-configured CI pipeline — you only hear from it when something needs attention.
`,
  },
};

const PRESET_ORDER: SoulPreset[] = ["butler", "friendly", "silent"];

export default function SoulPresetPage() {
  const navigate = useNavigate();
  const [preset, setPreset] = useState<SoulPreset>("butler");
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);

  const handleContinue = async () => {
    setSaving(true);
    try {
      let content = SOUL_PRESETS[preset].content;
      if (custom.trim()) {
        content += `\n## Custom instructions\n${custom.trim()}\n`;
      }
      await updateWorkspaceFile({ filename: "SOUL.md", content });
      navigate("/composing");
    } catch (err) {
      console.error("updateWorkspaceFile(SOUL.md) failed:", err);
      setSaving(false);
    }
  };

  return (
    <Frame>
      <section className="mx-auto max-w-[860px] px-8 py-14">
        <div className="flex items-baseline justify-between gap-8 mb-10">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--brass)" }}
          >
            Bearing
          </div>
          <RitualNav active="verify" />
        </div>

        <h1 className="font-display text-5xl tracking-tight mb-3">
          How should Alfred carry himself?
        </h1>
        <p
          className="font-body text-[17px] mb-10 max-w-[58ch]"
          style={{ color: "var(--marginalia)" }}
        >
          Choose a bearing. You may revise it later under{" "}
          <span className="font-display italic">workspace → SOUL.md</span>.
        </p>

        <ul className="space-y-3">
          {PRESET_ORDER.map((key) => {
            const card = SOUL_PRESETS[key];
            const selected = preset === key;
            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => setPreset(key)}
                  className="w-full text-left p-6 transition-colors"
                  style={{
                    border: `1px solid ${selected ? "var(--brass)" : "var(--rule)"}`,
                    background: "var(--paper)",
                  }}
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <div className="font-display text-2xl tracking-tight">
                      {card.label}
                    </div>
                    {selected && (
                      <span
                        className="font-mono text-[10px] uppercase tracking-[0.22em]"
                        style={{ color: "var(--brass)" }}
                      >
                        Chosen
                      </span>
                    )}
                  </div>
                  {selected && <hr className="gilt my-3" />}
                  <div
                    className="font-body italic text-[16px] leading-snug"
                    style={{
                      color: selected ? "var(--ink)" : "var(--marginalia)",
                    }}
                  >
                    {card.description}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-10">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
            style={{ color: "var(--marginalia)" }}
          >
            Anything else Alfred should know?
          </div>
          <textarea
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            rows={3}
            placeholder="An additional sentence or two for SOUL.md."
            className="w-full bg-transparent outline-none border font-body text-[16px] leading-[1.55] p-3"
            style={{ borderColor: "var(--rule)" }}
          />
        </div>

        <div className="mt-14 border-t border-rule pt-8 flex items-baseline justify-end">
          <button
            disabled={saving}
            onClick={handleContinue}
            className="btn-brass"
          >
            {saving ? "A moment…" : "Continue →"}
          </button>
        </div>
      </section>
    </Frame>
  );
}
