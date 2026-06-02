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
  "- `files__list` / `files__search` / `files__stat` / `files__read_text` — read-only access to the files Sir has uploaded to /files. Text files up to 32 KB are inlined; larger or binary files return only metadata (with a `too_large` flag) so you can tell Sir to open them on the dashboard. You cannot delete or create files from a call — that's MCP / dashboard only.",
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
  "",
  "7. **Files: respect `too_large`.** If `files__read_text` returns `{too_large: true, ...}`, the file's contents are NOT in your context. Tell Sir the file is too large to read aloud (or that it's binary) and offer the dashboard — never recite contents you didn't actually receive.",
].join("\n");

/**
 * Build a per-call current-time anchor string that tells the Realtime model
 * the exact local time in the principal's IANA timezone. Called on every
 * `buildInstructions` invocation so the time is never stale from a cached
 * bundle (the bundle's 60s TTL would make a baked timestamp wrong).
 *
 * `now` is injectable for deterministic testing — pass a fixed Date in tests,
 * omit in production to get `new Date()`.
 *
 * DST is handled automatically by `Intl.DateTimeFormat`. Do NOT hardcode
 * offsets — Europe/Budapest is UTC+01:00 in winter (CET) and UTC+02:00 in
 * summer (CEST). Intl picks the correct one for the given instant.
 *
 * Exported so tests can call it directly without building a full context.
 */
export function buildTimeAnchor(timeZone: string, now: Date = new Date()): string {
  // Resolve DST-correct offset via Intl. We use "longOffset" (e.g.
  // "GMT+02:00") and strip the "GMT" prefix to get "+02:00".
  const offsetFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    timeZoneName: "longOffset",
  });
  const offsetParts = offsetFmt.formatToParts(now);
  const rawOffset =
    offsetParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  // "GMT+02:00" → "+02:00"; "GMT" alone (UTC) → "+00:00"
  const utcOffset = rawOffset === "GMT" ? "+00:00" : rawOffset.replace("GMT", "");

  // Current local time formatted as ISO-ish with the offset
  const localTimeFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const timeParts = Object.fromEntries(
    localTimeFmt.formatToParts(now).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const localIso =
    `${timeParts.year}-${timeParts.month}-${timeParts.day}` +
    `T${timeParts.hour}:${timeParts.minute}:${timeParts.second}${utcOffset}`;

  // Today's and tomorrow's weekday+date in the principal's zone
  const dayFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const todayStr = dayFmt.format(now);
  const tomorrowStr = dayFmt.format(new Date(now.getTime() + 86_400_000));

  // Display name for UTC zones: keep "UTC" when offset is +00:00, otherwise
  // show the IANA name.
  const zoneDisplay = timeZone === "UTC" ? "UTC" : timeZone;

  return [
    `Current time: ${localIso} (${zoneDisplay}, UTC${utcOffset}).`,
    `Today is ${todayStr}; tomorrow is ${tomorrowStr}.`,
    "When calling calendar/email tools, build time ranges in this timezone and report times in it.",
  ].join("\n");
}

export function buildInstructions(ctx: InstructionContext, now: Date = new Date()): string {
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

  // #226 — per-call timezone anchor. Computed fresh every call (not cached
  // with the bundle) so it's always accurate. Falls back to UTC when the
  // bundle doesn't carry a timeZone (pre-Lane-I deploys, or cache miss).
  const timeZone = ctx.voiceContext?.timeZone || "UTC";
  const timeAnchor = buildTimeAnchor(timeZone, now);

  // Order matters — guardrails LAST so recency-weighted attention favours
  // them over the (also-load-bearing-but-not-as-load-bearing) primer.
  // Time anchor goes right after persona / caller line so the model always
  // sees the current time before the context primer and guardrails.
  return `${persona}${callerLine}\n\n## Current time\n\n${timeAnchor}${primer}\n${VOICE_GUARDRAILS}`;
}
