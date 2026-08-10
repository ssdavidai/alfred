// ============================================================================
// Native Hermes session enumeration.
//
// Replaces the hermes-shim `POST /tools/invoke` `sessions_list` tool (issue
// #39). The shim used to keep its own SQLite "run registry", populated by
// best-effort mirroring of `POST /v1/runs` creates — a reverse-engineered
// surface that never observed inbound channel DMs at all.
//
// Hermes already persists its gateway sessions natively. Its SessionManager
// writes a per-profile `sessions/sessions.json` index under HERMES_HOME — the
// same file Hermes' own `gateway/channel_directory.py:_build_from_sessions()`
// reads to resolve delivery targets. ctrl-api mounts the Hermes data volume
// (`hermes_data` → `/hermes-state`, `HERMES_CONFIG_DIR=/hermes-state/profiles`),
// so this index is a plain local file read — no shim, no docker exec, no
// network round-trip.
//
// Each entry in `sessions.json` is a Hermes `SessionEntry` (see Hermes
// `gateway/session.py`). The fields this module consumes:
//
//   platform     — the channel ("slack" | "telegram" | "discord" | …)
//   updated_at   — ISO-8601 timestamp of last activity (most-recent sort key)
//   chat_type    — "dm" | "group" | "channel" | "thread"
//   origin       — a SessionSource: { platform, chat_id, user_id, … }
//
// The delivery recipient is `origin.chat_id` — the canonical routing target
// Hermes itself uses to send a message back to a chat. This is strictly more
// accurate than the old shim registry, which only ever recorded outbound run
// creations.
// ============================================================================

import fs from "node:fs";
import path from "node:path";

// Hermes profile config root. ctrl-api sees the hermes_data volume here; the
// per-profile session index lives at <dir>/<profile>/sessions/sessions.json.
// Mirrors HERMES_CONFIG_DIR usage in routes/hermes.ts and routes/agents.ts.
const HERMES_CONFIG_DIR = process.env.HERMES_CONFIG_DIR ?? "/hermes-state/profiles";

/** A delivery-resolvable Hermes session, normalised for ctrl-api callers. */
export interface HermesSession {
  /** Hermes session id. */
  sessionId: string;
  /** Messaging channel / platform — "slack", "telegram", "discord", …. */
  channel: string;
  /** Canonical delivery recipient: the chat id Hermes routes replies to. */
  to: string;
  /** "dm" | "group" | "channel" | "thread". */
  chatType: string;
  /** Epoch ms of last activity — most-recent-first sort key. */
  updatedAt: number;
}

/**
 * Read the native Hermes gateway session index for a profile.
 *
 * Returns every session that has a usable delivery target (a channel +
 * recipient), most-recent first. Fails soft: a missing / unreadable /
 * malformed index yields an empty list — callers degrade exactly as they did
 * when the old shim `sessions_list` returned nothing.
 *
 * @param profile Hermes profile to enumerate. The user-facing channels live
 *                on `main`; that is the default.
 */
export function listHermesSessions(profile: string = "main"): HermesSession[] {
  const sessionsFile = path.join(HERMES_CONFIG_DIR, profile, "sessions", "sessions.json");

  let raw: string;
  try {
    raw = fs.readFileSync(sessionsFile, "utf-8");
  } catch {
    // No session index yet (fresh tenant) or volume not mounted — caller
    // treats an empty list as "no recipient on record", same as before.
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const sessions: HermesSession[] = [];
  // sessions.json is keyed by session_key → SessionEntry.
  for (const entry of Object.values(parsed as Record<string, any>)) {
    if (!entry || typeof entry !== "object") continue;

    const origin = (entry.origin && typeof entry.origin === "object")
      ? (entry.origin as Record<string, any>)
      : null;

    // Channel: prefer the entry-level platform, fall back to the origin's.
    const channel = String(entry.platform ?? origin?.platform ?? "").trim();
    if (!channel) continue;

    // Delivery recipient: the chat id Hermes routes replies to. Without it
    // the session cannot be a delivery target, so skip it.
    const to = origin?.chat_id != null ? String(origin.chat_id).trim() : "";
    if (!to) continue;

    // chat_type lives on either the entry or its origin.
    const chatType = String(entry.chat_type ?? origin?.chat_type ?? "dm").trim() || "dm";

    // updated_at is ISO-8601; fall back to created_at, then 0.
    let updatedAt = 0;
    const ts = entry.updated_at ?? entry.created_at;
    if (typeof ts === "string" && ts) {
      const ms = Date.parse(ts);
      if (Number.isFinite(ms)) updatedAt = ms;
    }

    sessions.push({
      sessionId: String(entry.session_id ?? entry.session_key ?? ""),
      channel,
      to,
      chatType,
      updatedAt,
    });
  }

  // Most-recent activity first — callers pick the freshest matching session.
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

/**
 * Read SLACK_HOME_CHANNEL and TELEGRAM_HOME_CHANNEL from the Hermes profile
 * `.env` file (same hermes_data volume mount used to read sessions.json).
 *
 * Fails soft: returns null values when the file is absent or unreadable.
 */
function readHomeChannelsFromProfileEnv(profile: string = "main"): {
  slack: string | null;
  telegram: string | null;
} {
  const envPath = path.join(HERMES_CONFIG_DIR, profile, ".env");
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf-8");
  } catch {
    return { slack: null, telegram: null };
  }
  let slack: string | null = null;
  let telegram: string | null = null;
  for (const line of raw.split("\n")) {
    const t = line.replace(/^﻿/, "").trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1);
    if (v.endsWith("\r")) v = v.slice(0, -1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k === "SLACK_HOME_CHANNEL" && v) slack = v;
    if (k === "TELEGRAM_HOME_CHANNEL" && v) telegram = v;
  }
  return { slack, telegram };
}

/**
 * Resolve the principal's declared home channel for proactive background
 * delivery (chore digests, briefing pushes, spawn_alfred_task announces).
 *
 * Returns SLACK_HOME_CHANNEL or TELEGRAM_HOME_CHANNEL (Slack preferred) from
 * the hermes main profile .env, or undefined if neither is configured. Use
 * this instead of resolveDeliveryTarget("last") — "last" picks the most-recent
 * session regardless of chat type and can land in a client group channel (#498).
 */
export function resolveHomeChannelTarget(
  profile: string = "main",
): { to: string; channel: string } | undefined {
  const { slack, telegram } = readHomeChannelsFromProfileEnv(profile);
  if (slack) return { to: slack, channel: "slack" };
  if (telegram) return { to: telegram, channel: "telegram" };
  return undefined;
}

/**
 * Resolve the delivery recipient for an agent-initiated message.
 *
 * Picks the most-recently-active Hermes session whose channel matches, and
 * returns its native delivery target (`origin.chat_id`).
 *
 * @param channel  A concrete channel ("slack" | "telegram" | …), or "last"
 *                 to mean "the most-recent delivery-capable channel session,
 *                 excluding webchat".
 * @param profile  Hermes profile to enumerate (default "main").
 * @returns The recipient id and the channel it was found on, or `undefined`
 *          when no session on record can be delivered to.
 */
export function resolveDeliveryTarget(
  channel: string,
  profile: string = "main",
): { to: string; channel: string } | undefined {
  const sessions = listHermesSessions(profile);

  // For Telegram, "notify the principal" must mean the principal directly —
  // never broadcast into a group just because that group was the most-recent
  // session. Telegram group/supergroup chat_ids are negative; DM ids are
  // positive. We additionally have Hermes' own chat_type, so prefer either
  // signal that says "this is a 1:1 DM".
  const isPrincipalDm = (s: HermesSession): boolean => {
    if (s.channel !== "telegram") return true; // no-op outside Telegram
    if (s.chatType === "dm") return true;
    if (s.chatType === "group" || s.chatType === "channel") return false;
    // chat_type unknown — fall back to the chat_id sign heuristic.
    return !s.to.startsWith("-");
  };

  const matches = channel === "last"
    ? sessions.filter((s) => s.channel && s.channel !== "webchat")
    : sessions.filter((s) => s.channel === channel);

  // DM sessions first, then everything else — preserving most-recent order
  // within each group (listHermesSessions already sorted by updatedAt).
  const dmFirst = [
    ...matches.filter(isPrincipalDm),
    ...matches.filter((s) => !isPrincipalDm(s)),
  ];

  const top = dmFirst[0];
  if (!top) return undefined;

  // Hermes' send path stores Slack recipients as a bare channel/IM id in
  // origin.chat_id already (no "user:" envelope — that was an OpenClaw-ism),
  // so no prefix-stripping is needed. Strip defensively if a legacy index
  // still carries one.
  const to = top.to.startsWith("user:") ? top.to.slice("user:".length) : top.to;
  return { to, channel: top.channel };
}
