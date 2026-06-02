import type { VoiceCallOpts } from "./voice-call.js";

export function applyOutboundCustomParameters(
  opts: VoiceCallOpts,
  params: Record<string, unknown>,
): VoiceCallOpts {
  if (params.initiator !== "alfred") return opts;
  return {
    ...opts,
    initiator: "alfred",
    intent: typeof params.intent === "string" ? params.intent : opts.intent,
  };
}
