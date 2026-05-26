// smsCardCore — pure shape derivation for the /channels SMS card.
// Mirrors slackCardCore.ts / telegramCardCore.ts; import-free (no React/Wasp)
// so the four derived states unit-test under node:test.
//
// The states map 1:1 to ctrl-api's GET /api/v1/channels/sms/status `state`
// field. Lane I owns the endpoint; this derivation is the only thing the
// UI needs to know about the state machine.

export type SmsState =
  | "unconfigured"
  | "configured_starting"
  | "configured_running"
  | "error";

export interface SmsStatus {
  configured: boolean;
  state: SmsState;
  error: string | null;
  /** Twilio-owned number, E.164. Null until configured. */
  phone_number: string | null;
  /** Account SID with most of it masked — display-only, never the live SID. */
  account_sid_masked: string | null;
  /** Comma-separated allowlist of E.164 numbers permitted to text the bot. */
  allowed_users: string;
  /** True when any sender is allowed (default-open policy, no env var set). */
  allow_all: boolean;
}

export interface SmsCardState {
  state: SmsState;
  heading: string;
  description: string;
  phoneNumber: string | null;
  accountSidMasked: string | null;
  /** Are there configured Phase-2 options (allowed_users)? */
  hasOptions: boolean;
  /** Pretty status pill. */
  pill: "active" | "available" | "starting" | "error";
}

const NULL_STATUS: SmsStatus = {
  configured: false,
  state: "unconfigured",
  error: null,
  phone_number: null,
  account_sid_masked: null,
  allowed_users: "",
  allow_all: true,
};

/**
 * Format a NANP E.164 number for the card heading.
 * "+15550100" → "+1 555 0100" (synthetic fixture shape: 7-digit NANPA
 * reserved-for-fiction block). "+15551234567" → "+1 555 123 4567" for
 * real-shape 10-digit NANP numbers. Non-NANP numbers (UK / EU / etc.)
 * pass through untouched — we'd rather show the raw E.164 than mis-space
 * a foreign grouping.
 */
export function formatPhoneNumber(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  const trimmed = raw.trim();
  // 10-digit NANP: +1 NXX NXX XXXX.
  const ten = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(trimmed);
  if (ten) return `+1 ${ten[1]} ${ten[2]} ${ten[3]}`;
  // 7-digit NANP (synthetic / test-fixture shape): +1 NXX NXXX.
  const seven = /^\+1(\d{3})(\d{4})$/.exec(trimmed);
  if (seven) return `+1 ${seven[1]} ${seven[2]}`;
  return trimmed;
}

export function deriveSmsCardState(args: {
  status: SmsStatus | null | undefined;
}): SmsCardState {
  const status = args.status ?? NULL_STATUS;
  const hasOptions = Boolean(status.allowed_users);

  switch (status.state) {
    case "configured_starting":
      return {
        state: "configured_starting",
        heading: "Picking up the new credentials",
        description: "Hermes is restarting with the credentials you just saved.",
        phoneNumber: status.phone_number,
        accountSidMasked: status.account_sid_masked,
        hasOptions,
        pill: "starting",
      };

    case "configured_running": {
      const pretty = formatPhoneNumber(status.phone_number);
      const display = pretty || "your Twilio number";
      return {
        state: "configured_running",
        heading: `Connected as ${display}`,
        description:
          "Alfred sees SMS to this number. Replies arrive in the same butler voice; allowlisted senders only.",
        phoneNumber: status.phone_number,
        accountSidMasked: status.account_sid_masked,
        hasOptions,
        pill: "active",
      };
    }

    case "error":
      return {
        state: "error",
        heading: "SMS needs attention",
        description:
          status.error?.trim() ||
          "Hermes couldn't start the SMS adapter. Check the credentials and try again.",
        phoneNumber: status.phone_number,
        accountSidMasked: status.account_sid_masked,
        hasOptions,
        pill: "error",
      };

    case "unconfigured":
    default:
      return {
        state: "unconfigured",
        heading: "Set up SMS via Twilio",
        description:
          "Paste your Twilio Account SID + Auth Token + phone number. " +
          "Alfred sees SMS from your number, replies in the same butler voice.",
        phoneNumber: null,
        accountSidMasked: null,
        hasOptions: false,
        pill: "available",
      };
  }
}

// Twilio identifier validators. Both must stay in sync with the ctrl-api
// side (packages/ctrl/src/api/routes/sms.ts: ACCOUNT_SID_RE / AUTH_TOKEN_RE).
//   • Account SID: literal "AC" + 32 lowercase hex chars.
//   • Auth Token : 32 lowercase hex chars.
const ACCOUNT_SID_RE = /^AC[a-f0-9]{32}$/;
const AUTH_TOKEN_RE = /^[a-f0-9]{32}$/;

export function isProbablyValidTwilioAccountSid(s: string): boolean {
  if (typeof s !== "string") return false;
  return ACCOUNT_SID_RE.test(s.trim());
}

export function isProbablyValidTwilioAuthToken(s: string): boolean {
  if (typeof s !== "string") return false;
  return AUTH_TOKEN_RE.test(s.trim());
}
