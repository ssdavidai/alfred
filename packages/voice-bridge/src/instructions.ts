// Build the OpenAI Realtime `session.update` instructions string.
//
// Layered:
//   1. baseline persona (greetings, speech rules, latency masking, tool surface)
//   2. alfred-voice SKILL.md body (replaces baseline if available — same content
//      but the skill is the canonical source)
//   3. cross-channel context primer (MEMORY.md + open matters + open tasks +
//      recent sessions) — fetched per-call, falls back gracefully if missing

import type { VoiceContextBundle } from "./tenant.js";

export interface InstructionContext {
  tenantPhoneNumber: string | null;
  initiator?: "user" | "alfred";
  intent?: string;
  voiceContext?: VoiceContextBundle | null;
}

const BASELINE_PERSONA = [
  "You are Alfred, a precise English butler answering Sir's phone call.",
  'Greet exactly with: "Yes, sir?" — nothing more. Then wait.',
  "Maximum 1–2 sentences per reply. No markdown. No spelled-out IDs or URLs.",
  'Speak numbers in full ("twelve thousand euros", not "12,000 EUR").',
  "If you don't understand, ask one short clarifying question.",
  'Say goodbye with: "Good day, sir."',
  "",
  "## Tools",
  "- `self({endpoint, method?, body?, query?})` — call this tenant's ctrl-api for vault, streams, learning, workflows, schedules, workers, admin, and phone outbound ops.",
  "- `composio_execute({action, arguments})` — third-party app actions (Gmail, Calendar, GitHub, Notion, Slack, Drive).",
  "",
  '**Latency masking**: before EVERY tool call, say exactly "One moment, sir." — nothing else — then invoke the tool. After the tool returns, deliver the answer in 1–2 sentences. Never read raw tool output.',
].join("\n");

function outboundIntent(intent: string | undefined): string {
  const text = intent?.trim() || "Sir, you wanted to talk.";
  return [
    "You are Alfred, on a phone call you initiated.",
    `Open with: "${text}". Speak it warmly, then wait for Sir to respond.`,
    "Maximum 1–2 sentences per turn. No markdown, no IDs, no URLs.",
    'Say goodbye with: "Good day, sir."',
  ].join("\n");
}

function formatContextPrimer(bundle: VoiceContextBundle): string {
  const sections: string[] = [];

  if (bundle.memoryMd?.trim()) {
    sections.push(`## What you remember about Sir\n\n${bundle.memoryMd.trim()}`);
  }

  if (bundle.openMatters?.length) {
    const lines = bundle.openMatters
      .slice(0, 10)
      .map(
        (m) =>
          `- ${m.name}${m.summary ? ` — ${m.summary.slice(0, 140)}` : ""}`,
      );
    sections.push(`## Open matters\n\n${lines.join("\n")}`);
  }

  if (bundle.openTasks?.length) {
    const lines = bundle.openTasks
      .slice(0, 10)
      .map(
        (t) =>
          `- ${t.name}${t.due ? ` (due ${t.due})` : ""}${t.summary ? ` — ${t.summary.slice(0, 140)}` : ""}`,
      );
    sections.push(`## Open tasks\n\n${lines.join("\n")}`);
  }

  if (bundle.recentSessions?.length) {
    const lines = bundle.recentSessions
      .slice(-10)
      .map((s) => `- [${s.at.slice(0, 16)} ${s.channel}] ${s.summary}`);
    sections.push(`## Recent conversations across channels\n\n${lines.join("\n")}`);
  }

  if (sections.length === 0) return "";
  return `\n\n# Cross-channel context\n\n${sections.join("\n\n")}`;
}

export function buildInstructions(ctx: InstructionContext): string {
  const persona =
    ctx.initiator === "alfred"
      ? outboundIntent(ctx.intent)
      : (ctx.voiceContext?.voiceSkill?.trim() || BASELINE_PERSONA);

  const primer = ctx.voiceContext ? formatContextPrimer(ctx.voiceContext) : "";

  return `${persona}${primer}`;
}
