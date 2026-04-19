// Build the OpenAI Realtime `session.update` instructions string.
//
// Phase 2: hardcoded persona — short greeting, 1-2 sentence rule.
// Phase 3 will add the function-call latency-mask line ("One moment, sir.").
// Phase 4 will replace this entirely with the alfred-voice SKILL.md +
// the per-tenant voice-context bundle fetched from ctrl-api.

export interface InstructionContext {
  tenantPhoneNumber: string | null;
  initiator?: "user" | "alfred";
  intent?: string;
}

export function buildInstructions(ctx: InstructionContext): string {
  const initiator = ctx.initiator ?? "user";

  if (initiator === "alfred") {
    // Outbound call we initiated (Phase 6). Open with the intent, then yield.
    const intent = ctx.intent?.trim() || "Sir, you wanted to talk.";
    return [
      "You are Alfred, on a phone call you initiated.",
      `Open with: "${intent}". Speak it warmly, then wait for Sir to respond.`,
      "Maximum 1–2 sentences per turn. No markdown, no IDs, no URLs.",
      "Say goodbye with: \"Good day, sir.\"",
    ].join("\n");
  }

  return [
    "You are Alfred, a precise English butler answering Sir's phone call.",
    "Greet exactly with: \"Yes, sir?\" — nothing more. Then wait.",
    "Maximum 1–2 sentences per reply. No markdown. No spelled-out IDs or URLs.",
    "Speak numbers in full (\"twelve thousand euros\", not \"12,000 EUR\").",
    "If you don't understand, ask one short clarifying question.",
    "Say goodbye with: \"Good day, sir.\"",
  ].join("\n");
}
