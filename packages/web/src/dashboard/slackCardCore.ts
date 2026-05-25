// slackCardCore — pure shape derivation for the /channels Slack card.
// Mirrors telegramCardCore.ts; import-free (no React/Wasp) so the four
// derived states unit-test under node:test.
//
// The states map 1:1 to ctrl-api's GET /api/v1/channels/slack/status
// `state` field. Lane I owns the endpoint; this derivation is the only
// thing the UI needs to know about the state machine.

export type SlackState =
  | "unconfigured"
  | "configured_starting"
  | "configured_running"
  | "error";

export interface SlackWorkspace {
  team: string | null;
  team_id: string | null;
  bot_user: string | null;
  bot_user_id: string | null;
  url: string | null;
}

export interface SlackStatus {
  configured: boolean;
  state: SlackState;
  error: string | null;
  workspace: SlackWorkspace;
  allowed_users: string;
  home_channel: string;
  allowed_channels: string;
}

export interface SlackCardState {
  state: SlackState;
  heading: string;
  description: string;
  workspace: SlackWorkspace;
  /** Are there configured Phase-2 options (home_channel, allowed_users, allowed_channels)? */
  hasOptions: boolean;
  /** Pretty status pill. */
  pill: "active" | "available" | "starting" | "error";
}

const NULL_STATUS: SlackStatus = {
  configured: false,
  state: "unconfigured",
  error: null,
  workspace: {
    team: null,
    team_id: null,
    bot_user: null,
    bot_user_id: null,
    url: null,
  },
  allowed_users: "",
  home_channel: "",
  allowed_channels: "",
};

export function deriveSlackCardState(args: {
  status: SlackStatus | null | undefined;
}): SlackCardState {
  const status = args.status ?? NULL_STATUS;
  const hasOptions = Boolean(
    status.allowed_users || status.home_channel || status.allowed_channels,
  );

  switch (status.state) {
    case "configured_starting":
      return {
        state: "configured_starting",
        heading: "Picking up the new tokens",
        description: "Hermes is restarting with the tokens you just saved.",
        workspace: status.workspace,
        hasOptions,
        pill: "starting",
      };

    case "configured_running": {
      const bot = status.workspace.bot_user
        ? status.workspace.bot_user.startsWith("@")
          ? status.workspace.bot_user
          : `@${status.workspace.bot_user}`
        : "your bot";
      const team = status.workspace.team ?? "your workspace";
      return {
        state: "configured_running",
        heading: `Connected as ${bot}`,
        description: `Running in ${team}. Mention the bot in any channel it's been added to, or DM it directly.`,
        workspace: status.workspace,
        hasOptions,
        pill: "active",
      };
    }

    case "error":
      return {
        state: "error",
        heading: "Slack needs attention",
        description:
          status.error?.trim() ||
          "Hermes couldn't start the Slack adapter. Check the tokens and try again.",
        workspace: status.workspace,
        hasOptions,
        pill: "error",
      };

    case "unconfigured":
    default:
      return {
        state: "unconfigured",
        heading: "Set up Slack",
        description:
          "Create a Slack app from the manifest below, then paste the two tokens. " +
          "Same idea as Telegram — once it's connected, Alfred sees DMs and mentions on Slack.",
        workspace: NULL_STATUS.workspace,
        hasOptions: false,
        pill: "available",
      };
  }
}

// Slack token validators. Both prefixes are canonical; the tail accepts any
// length of [A-Za-z0-9_-] because Slack itself varies the secret length.
// Mirrored on the ctrl-api side as BOT_TOKEN_RE / APP_TOKEN_RE in
// packages/ctrl/src/api/routes/slack.ts — they must stay in sync.
const BOT_TOKEN_RE = /^xoxb-[0-9A-Za-z_-]{8,}$/;
const APP_TOKEN_RE = /^xapp-[0-9A-Za-z_-]{8,}$/;

export function isProbablyValidSlackBotToken(s: string): boolean {
  if (typeof s !== "string") return false;
  return BOT_TOKEN_RE.test(s.trim());
}

export function isProbablyValidSlackAppToken(s: string): boolean {
  if (typeof s !== "string") return false;
  return APP_TOKEN_RE.test(s.trim());
}
