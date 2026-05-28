// Build the OpenAI Realtime `session.update` instructions string.
//
// Ordering (the OpenAI cookbook ordering — Role → Personality → Context →
// Tools → Instructions → Safety LAST so the last thing the model sees before
// the conversation begins is the guardrail that prevents hallucinated tool
// results / fabricated "unavailable" claims):
//
//   1. PERSONA — identity, accent, speech rules, greetings (the SKILL.md
//      body, or BASELINE_PERSONA fallback). Includes everything except the
//      guardrails block.
//   2. CALLER LINE — Sir's E.164 number for SMS callbacks.
//   3. CONTEXT PRIMER — MEMORY.md + open matters + open tasks + recent
//      sessions + per-MCP-server skill cheatsheets.
//   4. VOICE GUARDRAILS — the recency-weighted rule block. "Before claiming
//      a tool/service is unavailable you MUST have invoked the tool" + the
//      negative "never invent tool-result content." OpenAI's prompting guide
//      explicitly recommends safety/escalation rules go LAST so they
//      override what came before (recency-weighted attention). Pre-fix this
//      block lived at position ~4 of 11 inside SKILL.md, BEFORE 7.7 KB of
//      primer — the primer dominated and the model deflected with
//      "unavailable" without first calling the tool. See H4 discovery
//      memo for the full reasoning.

import type { VoiceContextBundle } from "./tenant.js";

export interface InstructionContext {
  tenantPhoneNumber: string | null;
  // Caller E.164 number, as passed by SaaS via <Parameter name="from"> in
  // the TwiML <Stream>. Without this, the agent routinely hallucinates
  // placeholders like "your-number" when Sir asks to receive an SMS.
  callerNumber?: string | null;
  initiator?: "user" | "alfred";
  intent?: string;
  voiceContext?: VoiceContextBundle | null;
}

const BASELINE_PERSONA = [
  "You are Alfred, a precise English butler answering Sir's phone call.",
  // Accent is a hard requirement, not a stylistic preference. gpt-realtime-2
  // is multilingual and will drift toward General American if not explicitly
  // anchored — keep this line near the top so it overrides the default voice.
  "Speak in Received Pronunciation — the King's English, an Oxbridge-educated British butler's accent. Crisp consonants, no rhoticity, no American or transatlantic drift. Hold the accent for the entire call, including tool-call latency phrases.",
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
    // Same accent anchor as the inbound persona — RP all the way through.
    "Speak in Received Pronunciation — the King's English, an Oxbridge-educated British butler's accent. No American drift.",
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

  if (bundle.skills?.length) {
    // Per-MCP-server skill cheatsheets. The OpenAI Realtime session already
    // has all 150 `<server>__<tool>` schemas in its tools list (wired by
    // voice-bridge's MCP client — see mcp-clients.ts); this block teaches the
    // model WHEN to reach for each server, using the SKILL.md description +
    // H1 intro. v1 of this section dumped every Composio action by name and
    // description (~3 KB of English noise) — that diluted the persona against
    // a Hungarian-flavoured MEMORY.md and let the model code-switch. The new
    // shape keeps the persona dominant and the primer small.
    const blocks = bundle.skills.map((s) => {
      const head = `### ${s.name}\n\n_${s.description}_`;
      return s.body ? `${head}\n\n${s.body}` : head;
    });
    sections.push(
      `## Connected tools\n\nYou have 150 MCP tools across five servers (\`alfred__*\`, \`sure__*\`, \`plane__*\`, \`vaultwarden__*\`, \`execute__*\`) — call them by name. The skill notes below tell you WHEN to reach for each server; per-tool detail is in the tool schemas.\n\n${blocks.join("\n\n")}`,
    );
  }

  if (sections.length === 0) return "";
  return `\n\n# Cross-channel context\n\n${sections.join("\n\n")}`;
}

/**
 * Voice guardrails block — appended LAST so recency-weighted attention
 * favours these rules over earlier persona/primer content. The negative
 * "never invent" rule paired with the positive "tool-must-precede-claim"
 * enforcement that converts a known-weak pattern (negation) into a
 * known-stronger one (must-do).
 *
 * Keep this block tight (a few hundred tokens at most) — it is the last
 * thing the model reads before the user's first turn lands. Every line
 * here is one the model is expected to honour.
 */
const VOICE_GUARDRAILS = [
  "",
  "## Voice guardrails — read these last",
  "",
  "These rules override everything earlier in the prompt if they conflict.",
  "",
  "1. **Tool must precede claim.** If you say something is done — scheduled, sent, updated, found, looked up — you MUST have called the tool that does it and seen a successful return FIRST. Don't claim \"scheduled\" / \"sent\" / \"updated\" / \"on your calendar\" until the tool actually returned ok.",
  "",
  "2. **Never invent unavailability.** Before claiming a service / tool is unavailable, you MUST have called the tool and received an error (4xx, 5xx, network failure, or empty result with an error envelope). If you haven't invoked the tool, you don't know whether it's available. The default response when you're not sure is \"One moment, sir.\" followed by the tool call — NEVER \"the X service is unavailable\" without trying.",
  "",
  "3. **Speak only what the tool returned.** Names in the primer (MEMORY.md, open matters, recent sessions) are background context, NOT tool output. Don't weave them into a tool-grounded answer unless the tool result actually mentions them.",
  "",
  "4. **Tool-call failure narration.** If a tool call fails, tell Sir what failed in plain words — \"the schedule rejected the request because it needs a prompt field\" — not a vague \"the service is unavailable.\" Only say \"unavailable\" if the failure was a real connection / 5xx outage.",
  "",
  "5. **Empty result is not failure.** If the tool returns an empty array / no items, say so honestly: \"There's nothing on your calendar for that window, sir.\" Do NOT fabricate items to fill the silence.",
  "",
  "6. **Truncated result.** If you see `\"...[truncated NNNb]...\"` in a tool result, say \"I have the first few — shall I pull the rest, sir?\" — do NOT invent the missing items from primer context.",
].join("\n");

export function buildInstructions(ctx: InstructionContext): string {
  const persona =
    ctx.initiator === "alfred"
      ? outboundIntent(ctx.intent)
      : (ctx.voiceContext?.voiceSkill?.trim() || BASELINE_PERSONA);

  const primer = ctx.voiceContext ? formatContextPrimer(ctx.voiceContext) : "";

  // Include caller identity inline at the top of the primer so the model
  // always sees it. Used when Sir asks for an SMS back — prevents the
  // `"your-number"` placeholder bug (see alfred-voice/SKILL.md § Caller
  // number handling).
  const callerLine = ctx.callerNumber
    ? `\n\nCaller: ${ctx.callerNumber} (use this number for any SMS the caller asks you to send).`
    : "";

  // Order matters — guardrails LAST so recency-weighted attention favours
  // them over the (also-load-bearing-but-not-as-load-bearing) primer.
  return `${persona}${callerLine}${primer}\n${VOICE_GUARDRAILS}`;
}
