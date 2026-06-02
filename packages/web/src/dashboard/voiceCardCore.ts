// voiceCardCore — pure shape derivation for the /channels Voice card.
// Mirror of smsCardCore.ts; import-free (no React/Wasp) so the four
// derived states unit-test under node:test.
//
// Phase 2 (voice-bridge promotion, 2026-05-25): voice is a real compose
// service alongside the SMS adapter.
//
// 2026-05-26 (OPENAI_API_KEY inline): voice has ONE operator-facing
// setting after all — OPENAI_API_KEY drives gpt-realtime on the Twilio
// Media Streams socket. When `openai_key_set=false` the card surfaces an
// inline password input (same shape as OmiCard's needs_groq_key state),
// so the operator can paste the key without context-switching to
// /study#credentials. Twilio credentials still reuse the SMS section.
//
// The states map 1:1 to ctrl-api's GET /api/v1/channels/voice/status
// `state` field. Lane I owns the endpoint; this derivation is the only
// thing the UI needs to know about the state machine.

import { formatPhoneNumber } from "./smsCardCore";

// Re-export the NANP formatter so callers have one import surface for
// "anything voice-card-shaped". The implementation lives in
// smsCardCore — never duplicate it here.
export { formatPhoneNumber };

export type VoiceState =
  | "unconfigured"
  | "configured_starting"
  | "configured_running"
  | "error";

export interface VoiceStatus {
  configured: boolean;
  state: VoiceState;
  error: string | null;
  /** Twilio number the voice-bridge answers on, E.164. Null until configured. */
  calling_number: string | null;
  /** True when the voice-bridge compose service is present on this VM. */
  compose_service_exists: boolean;
  /** True when OPENAI_API_KEY is set in the profile's .env (#120 Lane Vb). */
  openai_key_set: boolean;
  /** True when OPENAI_API_KEY is set in the compose-level .env. Main-only. */
  openai_key_set_compose?: boolean;
  /** Masked Twilio Account SID — "AC********…<last4>". Null when unset. */
  account_sid_masked?: string | null;
  /** Comma-separated E.164 numbers permitted to call the bridge. "" if unset. */
  allowed_callers: string;
  /** True when any caller is allowed (default-open policy, no env vars set). */
  allow_all: boolean;
  /** The "A call comes in" webhook URL for THIS profile. Sir pastes this
   *  into the profile's Twilio number in the Twilio Console. Null when
   *  DOMAIN isn't set (single-VM bring-up). #120 Lane Vb. */
  webhook_url?: string | null;
  /** Resolved profile slug. Echoes the ?profile=<slug> query the route
   *  was called with, or the default binding for voice. #120 Lane Vb. */
  profile_slug?: string;
}

export interface VoiceCardState {
  state: VoiceState;
  heading: string;
  description: string;
  callingNumber: string | null;
  pill: "active" | "available" | "starting" | "error";
  /** True when the operator needs to set up SMS first (voice reuses Twilio creds). */
  needsSmsFirst: boolean;
  /** True when OPENAI_API_KEY is missing — UI shows the inline paste box. */
  needsOpenaiKey: boolean;
}

const NULL_STATUS: VoiceStatus = {
  configured: false,
  state: "unconfigured",
  error: null,
  calling_number: null,
  compose_service_exists: false,
  openai_key_set: false,
  allowed_callers: "",
  allow_all: true,
};

export function deriveVoiceCardState(args: {
  status: VoiceStatus | null | undefined;
}): VoiceCardState {
  const status = args.status ?? NULL_STATUS;

  switch (status.state) {
    case "configured_starting":
      return {
        state: "configured_starting",
        heading: "Picking up the new credentials",
        description:
          "The voice bridge is restarting with the latest credentials. " +
          "This usually takes a few seconds.",
        callingNumber: status.calling_number,
        pill: "starting",
        needsSmsFirst: false,
        needsOpenaiKey: false,
      };

    case "configured_running":
      return {
        state: "configured_running",
        heading: "Voice calls active",
        description:
          "Calls to your Twilio number are bridged through gpt-realtime. " +
          "Alfred answers in the same butler voice he speaks in over text.",
        callingNumber: formatPhoneNumber(status.calling_number) || null,
        pill: "active",
        needsSmsFirst: false,
        needsOpenaiKey: false,
      };

    case "error":
      return {
        state: "error",
        heading: "Voice bridge needs attention",
        description:
          status.error?.trim() ||
          "The voice bridge service is not healthy. Check the container logs.",
        callingNumber: status.calling_number,
        pill: "error",
        needsSmsFirst: false,
        needsOpenaiKey: false,
      };

    case "unconfigured":
    default:
      // Three unconfigured shapes (resolved by ctrl-api in this order):
      //   • compose_service_exists=false   → voice-bridge not deployed yet
      //   • compose_service_exists=true  && !configured            → SMS not set up
      //   • compose_service_exists=true  && configured && !openai → operator owes us the OpenAI key
      if (!status.compose_service_exists) {
        return {
          state: "unconfigured",
          heading: "Voice not deployed",
          description:
            "Voice calls are powered by a separate bridge service. It hasn't " +
            "been deployed to this VM yet — re-run `docker compose up -d`.",
          callingNumber: null,
          pill: "available",
          needsSmsFirst: false,
          needsOpenaiKey: false,
        };
      }
      if (!status.configured) {
        return {
          state: "unconfigured",
          heading: "Set up SMS first",
          description:
            "Voice calls reuse your Twilio phone number — finish the SMS " +
            "setup above and voice becomes available automatically.",
          callingNumber: null,
          pill: "available",
          needsSmsFirst: true,
          needsOpenaiKey: false,
        };
      }
      // Configured + deployed, missing OpenAI key — the inline-input case.
      // #120 Lane Vb: per-profile contexts inherit main's compose-level
      // OPENAI key when their own is blank. `openai_key_set_compose=true`
      // means "main has the instance key" — non-main profiles without their
      // own key fall back to that, so they're NOT in the needsOpenaiKey
      // state; they're just configured-running.
      const hasOpenaiFallback =
        status.openai_key_set === true ||
        status.openai_key_set_compose === true;
      return {
        state: "unconfigured",
        heading: "Add your OpenAI key",
        description:
          "Voice calls route audio through gpt-realtime, so the voice bridge " +
          "needs an OpenAI API key. Paste yours below — it's stored in this " +
          "VM's .env and never leaves the box.",
        callingNumber: formatPhoneNumber(status.calling_number) || null,
        pill: "available",
        needsSmsFirst: false,
        needsOpenaiKey: !hasOpenaiFallback,
      };
  }
}
