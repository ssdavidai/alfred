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

export interface PairedChat {
  id: string | number;
  name: string | null;
  type: string | null;
}

export interface TelegramStatus {
  configured: boolean;
  bot_handle: string | null;
  state: TelegramState;
  error: string | null;
  /**
   * Chats currently authorised to talk to the bot — sourced from Hermes'
   * `channel_directory.json`. Empty array when configured but no chat has
   * messaged the bot yet.
   */
  paired_chats: PairedChat[];
}

export interface TelegramCardState {
  /** The visual state — drives which block of UI renders. */
  state: TelegramState;
  /** One-line headline above the card body. */
  heading: string;
  /** Italic marginalia under the headline. */
  description: string;
  /** Whether to render the paired-chats list in the body. */
  showChatList: boolean;
  /** The paired-chats list, normalised + name-defaulted for rendering. */
  pairedChats: PairedChat[];
  /** True when the card should render the @BotFather setup hint. */
  showBotFatherHint: boolean;
  /** Pretty status pill ("Connected" / "Not connected" / "Starting" / "Error"). */
  pill: "active" | "available" | "starting" | "error";
}

const NULL_STATUS: TelegramStatus = {
  configured: false,
  bot_handle: null,
  state: "unconfigured",
  error: null,
  paired_chats: [],
};

function normalisePairedChats(raw: unknown): PairedChat[] {
  if (!Array.isArray(raw)) return [];
  const out: PairedChat[] = [];
  for (const it of raw) {
    if (typeof it !== "object" || it === null) continue;
    const r = it as Record<string, unknown>;
    const id = (r.id ?? r.chat_id) as string | number | undefined;
    if (id === undefined || id === null || id === "") continue;
    const name =
      typeof r.name === "string" && r.name.trim()
        ? r.name.trim()
        : typeof r.title === "string" && r.title.trim()
          ? r.title.trim()
          : `chat ${id}`;
    const type = typeof r.type === "string" ? r.type : null;
    out.push({ id, name, type });
  }
  return out;
}

export function deriveTelegramCardState(args: {
  status: TelegramStatus | null | undefined;
}): TelegramCardState {
  const status = args.status ?? NULL_STATUS;
  const pairedChats = normalisePairedChats(status.paired_chats);

  switch (status.state) {
    case "configured_starting":
      return {
        state: "configured_starting",
        heading: "Picking up the new token",
        description: "Hermes is restarting with the token you just saved.",
        showChatList: false,
        pairedChats,
        showBotFatherHint: false,
        pill: "starting",
      };

    case "configured_running": {
      const handle = status.bot_handle
        ? status.bot_handle.startsWith("@")
          ? status.bot_handle
          : `@${status.bot_handle}`
        : "your bot";
      const description =
        pairedChats.length === 0
          ? `DM ${handle} once from your phone — once it sees you, you'll appear here.`
          : pairedChats.length === 1
            ? `Authorised for 1 chat. DM ${handle} from any other chat to add it.`
            : `Authorised for ${pairedChats.length} chats. DM ${handle} from any other chat to add it.`;
      return {
        state: "configured_running",
        heading: `Connected as ${handle}`,
        description,
        showChatList: pairedChats.length > 0,
        pairedChats,
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
        showChatList: false,
        pairedChats,
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
        showChatList: false,
        pairedChats,
        showBotFatherHint: true,
        pill: "available",
      };
  }
}

// Telegram bot tokens look like `123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`.
// The original BotFather format was 8-12 digits + exactly 35 chars after the
// colon; Telegram has since expanded both halves and modern tokens commonly
// run longer. Hermes' own setup wizard validates `^\d+:[A-Za-z0-9_-]{30,}$`
// (hermes_cli/setup.py) — we mirror that floor so a token Hermes accepts is
// one our UI accepts. The ctrl-api side (telegram.ts BOT_TOKEN_RE) carries
// the SAME regex; they must stay in sync. 2026-05-25 relaxed from the
// 35-exact rule after Sir's real token rejected as malformed.
const BOT_TOKEN_RE = /^\d{8,15}:[A-Za-z0-9_-]{30,}$/;

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
