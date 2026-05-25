// telegramCardCore — pure shape derivation for the /channels Telegram
// card. Import-free (no React/Wasp) so it unit-tests under node:test the
// same way terminalCardCore / hermesHealthCore / apiKeysCore do.
//
// The four states map 1:1 to the ctrl-api `state` field returned by
// GET /api/v1/channels/telegram/status. Lane I owns the endpoint; the
// derivation here is the only thing the UI needs to know about the
// state machine.

export type TelegramState =
  | "unconfigured"
  | "configured_starting"
  | "configured_running"
  | "error";

export interface TelegramStatus {
  configured: boolean;
  bot_handle: string | null;
  last_message_at: string | null;
  state: TelegramState;
  error: string | null;
}

export interface TelegramCardState {
  /** The visual state — drives which block of UI renders. */
  state: TelegramState;
  /** One-line headline above the card body. */
  heading: string;
  /** Italic marginalia under the headline. */
  description: string;
  /** Label for the primary action; null when there is none in this state. */
  primaryAction: string | null;
  /** Secondary actions (e.g. "Test connection", "Disconnect"). */
  secondaryActions: string[];
  /** True when the card should render the @BotFather setup hint. */
  showBotFatherHint: boolean;
  /** Pretty status pill ("Connected" / "Not connected" / "Starting" / "Error"). */
  pill: "active" | "available" | "starting" | "error";
}

const NULL_STATUS: TelegramStatus = {
  configured: false,
  bot_handle: null,
  last_message_at: null,
  state: "unconfigured",
  error: null,
};

export function deriveTelegramCardState(args: {
  status: TelegramStatus | null | undefined;
}): TelegramCardState {
  const status = args.status ?? NULL_STATUS;

  switch (status.state) {
    case "configured_starting":
      return {
        state: "configured_starting",
        heading: "Picking up the new token",
        description: "Hermes is restarting with the token you just saved.",
        primaryAction: null,
        secondaryActions: [],
        showBotFatherHint: false,
        pill: "starting",
      };

    case "configured_running": {
      const handle = status.bot_handle
        ? status.bot_handle.startsWith("@")
          ? status.bot_handle
          : `@${status.bot_handle}`
        : "your bot";
      const last = status.last_message_at
        ? relativeTimeFromIso(status.last_message_at)
        : null;
      return {
        state: "configured_running",
        heading: `Connected as ${handle}`,
        description: last
          ? `Last message ${last}.`
          : "No messages yet — pair this chat to wake the bot up.",
        primaryAction: "Pair this chat",
        secondaryActions: ["Test connection", "Disconnect"],
        showBotFatherHint: false,
        pill: "active",
      };
    }

    case "error":
      return {
        state: "error",
        heading: "Telegram needs attention",
        description:
          status.error?.trim() ||
          "Hermes couldn't start the Telegram adapter. Try the token again.",
        primaryAction: "Try again",
        secondaryActions: ["Disconnect"],
        showBotFatherHint: false,
        pill: "error",
      };

    case "unconfigured":
    default:
      return {
        state: "unconfigured",
        heading: "Set up Telegram",
        description:
          "Paste a bot token below — Hermes will pick it up on the next message.",
        primaryAction: "Save token",
        secondaryActions: [],
        showBotFatherHint: true,
        pill: "available",
      };
  }
}

// Telegram bot tokens look like `123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`.
// Bot IDs are 8-12 digits today; the secret is 35 chars of [A-Za-z0-9_-].
// The pattern is documented at core.telegram.org/bots/api#authorizing-your-bot.
const BOT_TOKEN_RE = /^\d{8,12}:[A-Za-z0-9_-]{35}$/;

export function isProbablyValidBotToken(s: string): boolean {
  if (typeof s !== "string") return false;
  return BOT_TOKEN_RE.test(s.trim());
}

// Relative-time helper for last_message_at. Kept local so the card never
// needs to drag in a date lib (Wasp's bundle is already heavy).
export function relativeTimeFromIso(
  iso: string,
  now: Date = new Date(),
): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const deltaSec = Math.max(0, Math.round((now.getTime() - t) / 1000));

  if (deltaSec < 45) return "just now";
  const min = Math.round(deltaSec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(deltaSec / 3600);
  if (hr < 24) return `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
  const day = Math.round(deltaSec / 86400);
  return `${day} ${day === 1 ? "day" : "days"} ago`;
}
