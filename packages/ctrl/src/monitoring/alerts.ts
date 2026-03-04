import type { HealthStatus } from "../data/types.js";

const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;
const WEBHOOK_TYPE = (process.env.ALERT_WEBHOOK_TYPE ?? "slack") as
  | "slack"
  | "discord";

function statusEmoji(status: HealthStatus): string {
  switch (status) {
    case "ok":
      return "\u2705";
    case "degraded":
      return "\u26a0\ufe0f";
    case "down":
      return "\ud83d\uded1";
    case "unreachable":
      return "\u2753";
  }
}

function formatSlackPayload(
  customerName: string,
  previousStatus: HealthStatus,
  newStatus: HealthStatus,
  ip: string | null
): object {
  return {
    text: `${statusEmoji(newStatus)} *${customerName}* health changed: \`${previousStatus}\` → \`${newStatus}\`${ip ? ` (${ip})` : ""}`,
  };
}

function formatDiscordPayload(
  customerName: string,
  previousStatus: HealthStatus,
  newStatus: HealthStatus,
  ip: string | null
): object {
  const color =
    newStatus === "ok"
      ? 0x22c55e
      : newStatus === "degraded"
        ? 0xeab308
        : newStatus === "down"
          ? 0xef4444
          : 0x6b7280;

  return {
    embeds: [
      {
        title: `${statusEmoji(newStatus)} ${customerName}`,
        description: `Health changed: \`${previousStatus}\` → \`${newStatus}\``,
        color,
        fields: ip ? [{ name: "IP", value: ip, inline: true }] : [],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export async function sendAlert(
  customerName: string,
  previousStatus: HealthStatus,
  newStatus: HealthStatus,
  ip: string | null
): Promise<void> {
  if (!WEBHOOK_URL) return;

  const payload =
    WEBHOOK_TYPE === "discord"
      ? formatDiscordPayload(customerName, previousStatus, newStatus, ip)
      : formatSlackPayload(customerName, previousStatus, newStatus, ip);

  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Silently fail — don't let alerting crash the health loop
  }
}
