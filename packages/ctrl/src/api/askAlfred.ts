// A surface asks Alfred. ctrl-api owns continuity (migration 0002), so the
// exchange is journaled here — inbound before the call, outbound after — and
// the principal's recent cross-surface memory is put in front of the model
// the way the Hermes plugin does for gateway turns. /v1/responses calls do
// not pass through that hook, so without this a Mac menu bar would talk to
// an Alfred with amnesia.
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { appendJournal, queryRecentJournal, type JournalEntry } from "../db/alfredJournal.js";

const HERMES_HOME = process.env.HERMES_HOME ?? "/hermes-state";
const HERMES_CONFIG_DIR = process.env.HERMES_CONFIG_DIR ?? `${HERMES_HOME}/profiles`;
const HERMES_MAIN_URL = process.env.HERMES_GATEWAY_URL ?? "http://hermes:18789";
const HERMES_TIMEOUT_MS = 120_000;
const MEMORY_LIMIT = 20;
const MEMORY_HOURS = 24;

export type HermesCall = (input: string, sessionKey: string) => Promise<unknown>;

/** Walk a /v1/responses body and concatenate the assistant text. */
export function extractHermesText(resp: unknown): string {
  if (typeof resp !== "object" || resp === null) return "";
  const r = resp as Record<string, unknown>;
  if (typeof r.output_text === "string") return r.output_text;
  const out = r.output;
  if (typeof out === "string") return out;
  const items = Array.isArray(out) ? out : out && typeof out === "object" ? [out] : [];
  const acc: string[] = [];
  for (const item of items) {
    const parts = (item as Record<string, unknown>)?.content;
    if (typeof parts === "string") { acc.push(parts); continue; }
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (typeof p === "string") acc.push(p);
      else if (p && typeof p === "object" && typeof (p as any).text === "string") acc.push((p as any).text);
    }
  }
  return acc.filter((s) => s.length > 0).join("\n");
}

/** The same block the Hermes plugin injects on gateway turns (newest-in → oldest-first). */
export function formatContinuityBlock(entries: JournalEntry[]): string {
  if (entries.length === 0) return "";
  const lines = [...entries].reverse().map((e) => {
    const who = e.direction === "outbound" ? "YOU → principal" : "principal → YOU";
    const msg = e.message.replace(/\s+/g, " ").trim();
    return `  [${e.ts.slice(0, 19)}] ${who} on ${e.channel}: ${msg.length > 400 ? msg.slice(0, 397) + "…" : msg}`;
  });
  return [
    "[ALFRED-CONTINUITY — authoritative]",
    "The following are messages YOU (Alfred) sent to the principal, and messages the principal sent you, across surfaces — including ones delivered outside this session. These DID happen. Treat them as your own memory.",
    ...lines,
    "[/ALFRED-CONTINUITY]",
  ].join("\n");
}

function readMainApiKey(): string | null {
  try {
    const env = fs.readFileSync(`${HERMES_CONFIG_DIR}/main/.env`, "utf8");
    const m = env.match(/^API_SERVER_KEY=(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch { return null; }
}

const defaultCall: HermesCall = async (input, sessionKey) => {
  const key = readMainApiKey();
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Hermes-Session-Key": sessionKey };
  if (key) headers.Authorization = `Bearer ${key}`;
  const resp = await fetch(`${HERMES_MAIN_URL}/v1/responses`, {
    method: "POST", headers, body: JSON.stringify({ input }), signal: AbortSignal.timeout(HERMES_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Hermes returned HTTP ${resp.status}`);
  return resp.json();
};

export async function askAlfred(
  db: DatabaseSync,
  args: { message: string; channel: string; chat_id: string; memory?: boolean },
  deps: { callHermes?: HermesCall } = {},
): Promise<{ reply: string; inbound_id: string; outbound_id: string }> {
  const inbound = appendJournal(db, {
    channel: args.channel, chat_id: args.chat_id, direction: "inbound", message: args.message,
    source_kind: args.channel, status: "received",
  });
  let input = args.message;
  if (args.memory !== false && inbound.principal_id) {
    const recent = queryRecentJournal(db, { principal_id: inbound.principal_id }, { limit: MEMORY_LIMIT, within_hours: MEMORY_HOURS })
      .filter((e) => e.id !== inbound.id);
    const block = formatContinuityBlock(recent);
    if (block) input = `${block}\n\n${args.message}`;
  }
  const raw = await (deps.callHermes ?? defaultCall)(input, `${args.channel}:${args.chat_id}`);
  const reply = extractHermesText(raw).trim();
  if (!reply) throw new Error("Alfred gave no reply (empty /v1/responses output)");
  const outbound = appendJournal(db, {
    channel: args.channel, chat_id: args.chat_id, direction: "outbound", message: reply,
    source_kind: "reply", status: "delivered", solicited: 1, metadata: { via: "alfred-ask" },
  });
  return { reply, inbound_id: inbound.id, outbound_id: outbound.id };
}
