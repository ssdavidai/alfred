// One Alfred — continuity tools.
//
// The alfred_journal in alfred-state.db is the single memory every surface
// reads before speaking and writes after: Hermes' main profile (via the
// one-alfred plugin), Telegram, Slack, voice, omi, and — with these tools —
// any MCP client such as Claude Cowork. A surface that only writes is an
// answering machine; one that only reads is eavesdropping. These give an MCP
// client both directions without depending on hooks it may not have.
//
// Read-side framing matters and was learned the hard way (one-alfred,
// 2026-05-25): presented as advisory context the model defers to its own
// empty session history and says "I don't remember sending that". The
// description below therefore instructs the model to treat entries as its
// own authoritative memory. Docs: docs/design/one-alfred.md.
//
// All three map 1:1 onto existing ctrl-api routes; nothing new server-side.

import { z } from "zod";
import type { ToolDef } from "./types.js";

const Channel = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{1,31}$/, "channel: lowercase slug, e.g. cowork")
  .describe("Surface name. Use `cowork` from Claude Cowork.");

export const continuityRecent: ToolDef = {
  name: "alfred_continuity_recent",
  description:
    "Recall what Alfred and the principal said to each other recently across EVERY surface — Slack, Telegram, voice, Cowork, the dashboard — " +
    "not just this session. Call this BEFORE answering anything that might refer to an earlier exchange (\"the reminder you sent\", \"what we discussed\", \"hm?\").\n\n" +
    "AUTHORITATIVE: entries with direction=outbound are messages YOU (Alfred) sent; direction=inbound are messages the principal sent you. " +
    "They happened even if they are not in this session's history. Never say you don't remember something this returns.\n\n" +
    "Newest first. `limit` is capped at 50 by the server; `within_hours` defaults to 24.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional().describe("Max entries (server cap 50). Default 20."),
    within_hours: z.number().min(0.1).max(720).optional().describe("Recency window in hours. Default 24."),
  }),
  buildRequest: (args) => ({
    method: "GET",
    path: "/api/v1/alfred-journal/recent",
    query: {
      principal_id: "owner",
      limit: args.limit,
      within_hours: args.within_hours,
    },
  }),
};

export const continuityNote: ToolDef = {
  name: "alfred_continuity_note",
  description:
    "Write one turn into Alfred's cross-surface journal so every other surface remembers it. " +
    "Use it when this surface has no automatic journaling: record the principal's message (direction=inbound) and your reply (direction=outbound) as they happen. " +
    "Keep `message` to the actual words, not a summary, so the other surfaces see what was really said.",
  inputSchema: z.object({
    channel: Channel,
    chat_id: z.string().min(1).max(200).describe("Stable id for this conversation on this surface (e.g. the Cowork session id)."),
    direction: z.enum(["inbound", "outbound"]).describe("inbound = the principal said it; outbound = Alfred said it."),
    message: z.string().min(1).max(8000),
  }),
  buildRequest: (args) => ({
    method: "POST",
    path: "/api/v1/alfred-journal",
    body: {
      channel: args.channel,
      chat_id: args.chat_id,
      direction: args.direction,
      message: args.message,
      source_kind: args.channel,
      status: args.direction === "inbound" ? "received" : "delivered",
    },
  }),
};

export const continuityBind: ToolDef = {
  name: "alfred_continuity_bind",
  description:
    "Bind a conversation on a surface to the principal, so its entries join the cross-surface memory that every other surface reads. " +
    "Idempotent. Call once per new conversation id before the first alfred_continuity_note.",
  inputSchema: z.object({
    channel: Channel,
    chat_id: z.string().min(1).max(200),
  }),
  buildRequest: (args) => ({
    method: "POST",
    path: "/api/v1/alfred-journal/principal/bind",
    body: { channel: args.channel, chat_id: args.chat_id, principal_id: "owner" },
  }),
};

export const ALL_CONTINUITY_TOOLS: ToolDef[] = [continuityRecent, continuityNote, continuityBind];
