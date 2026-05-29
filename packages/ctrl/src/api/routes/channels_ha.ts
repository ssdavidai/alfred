// /api/v1/channels/ha/* — Home Assistant channel routes.
//
// Issue #111 spec: docs/specs/issue-111-ha-conversation-agent.md.
//
// This PR (#111 PR1) ships ONLY the `/turn` route — the non-streaming
// inbound handler that translates one HA conversation turn into one
// Hermes-main `/v1/responses` call and returns HA's expected envelope.
//
// PRs #110 and later extend this file with the rest of the HA surface
// (token mint affordance on top of channel-tokens, /rooms upload, /health
// probe, /status card data). The "coordinate with #110 PR1" note in the
// PR description spells it out: whichever lane lands first creates the
// file minimally and the other ADDS to it. This file is the minimal
// shape.
//
// PR3 (#111 PR3, tool partitioning) will extend this file to forward
// HA-side tool calls in the response; for PR1 we return text only.
// PR4 (#111 PR4, curated MCP catalog) will inject the curator. PR5
// (voice-context primer + ha_room enrichment) will pre-fetch the primer.
// All of those are seams marked here for future PRs but NOT shipped.

import { addRoute } from "../server.js";
import { sendJson, ValidationError, ApiError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import { appendJournal } from "../../db/alfredJournal.js";
import { channelTokenBearer } from "../auth.js";
import fs from "node:fs";

const HERMES_MAIN_URL =
  process.env.HERMES_GATEWAY_URL ?? "http://hermes:18789";
const HERMES_TIMEOUT_MS = 90_000;

// Rate-limit per haInstanceId — 30 turns / sliding minute. In-memory
// sliding window. Spec §5.1 / §6.PR2 / O8.
const RATE_LIMIT_PER_MIN = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitBuckets = new Map<string, number[]>();

function checkRateLimit(haInstanceId: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const bucket = rateLimitBuckets.get(haInstanceId) ?? [];
  // Prune anything outside the window.
  const live = bucket.filter((ts) => ts > cutoff);
  if (live.length >= RATE_LIMIT_PER_MIN) {
    rateLimitBuckets.set(haInstanceId, live);
    return false;
  }
  live.push(now);
  rateLimitBuckets.set(haInstanceId, live);
  return true;
}

// Exported for tests so they can clear the in-memory window without
// reaching into private state. NOT part of the HTTP surface.
export function _resetHaRateLimitForTests(): void {
  rateLimitBuckets.clear();
}

// ── /turn body shape ──────────────────────────────────────────────────────
//
// Spec §3 minimum: text, conversation_id, language, agent_id, ha_install_id.
// We name fields camelCase consistently with the Paperclip channel; HA's
// custom component sends camelCase via Python's `aiohttp` body.

interface TurnBody {
  text: string;
  conversationId: string;
  language: string;
  agentId: string;
  haInstallId: string;
  /** Optional satellite device id (null when input is text-only). PR5+
   *  uses this for the deviceId → area lookup against the registry. */
  deviceId?: string | null;
}

function parseTurnBody(raw: unknown): TurnBody {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.text !== "string" || b.text.length === 0) {
    throw new ValidationError("text must be a non-empty string");
  }
  if (typeof b.conversationId !== "string" || b.conversationId.length === 0) {
    throw new ValidationError("conversationId must be a non-empty string");
  }
  if (typeof b.language !== "string" || b.language.length === 0) {
    throw new ValidationError("language must be a non-empty string");
  }
  if (typeof b.agentId !== "string" || b.agentId.length === 0) {
    throw new ValidationError("agentId must be a non-empty string");
  }
  if (typeof b.haInstallId !== "string" || b.haInstallId.length === 0) {
    throw new ValidationError("haInstallId must be a non-empty string");
  }
  let deviceId: string | null = null;
  if (b.deviceId !== undefined && b.deviceId !== null) {
    if (typeof b.deviceId !== "string") {
      throw new ValidationError("deviceId must be a string or null");
    }
    deviceId = b.deviceId;
  }
  return {
    text: b.text,
    conversationId: b.conversationId,
    language: b.language,
    agentId: b.agentId,
    haInstallId: b.haInstallId,
    deviceId,
  };
}

// ── Hermes call ───────────────────────────────────────────────────────────
//
// Same pattern as channels_paperclip.ts — read per-profile API_SERVER_KEY
// from /hermes-state/profiles/main/.env, POST /v1/responses with
// X-Hermes-Session-Key. The Hermes' own response shape (`output: [...]`) is
// flattened down to a single string for PR1; tool partitioning lands in
// PR3.

interface HermesCallResult {
  ok: true;
  text: string;
}
interface HermesCallFailure {
  ok: false;
  code: "HERMES_UNREACHABLE" | "HERMES_TIMEOUT";
  detail: string;
}

function extractHermesText(resp: unknown): string {
  if (typeof resp !== "object" || resp === null) return "";
  const r = resp as Record<string, unknown>;
  const out = r.output;

  const partsToText = (parts: unknown): string => {
    if (typeof parts === "string") return parts;
    if (!Array.isArray(parts)) return "";
    const acc: string[] = [];
    for (const p of parts) {
      if (typeof p === "string") {
        acc.push(p);
      } else if (typeof p === "object" && p !== null) {
        const pp = p as Record<string, unknown>;
        if (typeof pp.text === "string") acc.push(pp.text);
        else if (typeof pp.content === "string") acc.push(pp.content);
      }
    }
    return acc.filter((s) => s.length > 0).join("\n");
  };

  if (Array.isArray(out)) {
    let messageText = "";
    for (const item of out) {
      if (typeof item !== "object" || item === null) continue;
      const it = item as Record<string, unknown>;
      if (it.type === "message") {
        const t = partsToText(it.content);
        if (t) messageText = t;
      }
    }
    if (messageText) return messageText;
    return partsToText(out);
  }
  if (typeof out === "string") return out;
  if (typeof out === "object" && out !== null) {
    const o = out as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.content === "string") return o.content;
  }
  const fallback = r.output_text;
  if (typeof fallback === "string") return fallback;
  return "";
}

/** Same .env-driven key resolution as channels_paperclip.ts — Hermes' main
 *  gateway validates Bearer against /hermes-state/profiles/main/.env's
 *  API_SERVER_KEY at runtime (the /opt/alfred/.env HERMES_API_SERVER_KEY
 *  is a *seed*; once Hermes regenerates per-profile, the file is
 *  authoritative). Test override: HERMES_CONFIG_DIR. */
function readHermesMainApiKey(): string | null {
  const baseDir = process.env.HERMES_CONFIG_DIR ?? "/hermes-state/profiles";
  const envPath = `${baseDir}/main/.env`;
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf-8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    if (t.slice(0, eq).trim() === "API_SERVER_KEY") {
      return t.slice(eq + 1).trim();
    }
  }
  return null;
}

async function callHermes(
  sessionKey: string,
  input: string,
): Promise<HermesCallResult | HermesCallFailure> {
  const url = `${HERMES_MAIN_URL}/v1/responses`;
  const apiKey = readHermesMainApiKey() ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Hermes-Session-Key": sessionKey,
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(HERMES_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout =
      (err as Error)?.name === "TimeoutError" ||
      (err as Error)?.name === "AbortError" ||
      /timeout/i.test(msg);
    return {
      ok: false,
      code: isTimeout ? "HERMES_TIMEOUT" : "HERMES_UNREACHABLE",
      detail: msg,
    };
  }
  if (!resp.ok) {
    return {
      ok: false,
      code: "HERMES_UNREACHABLE",
      detail: `Hermes returned HTTP ${resp.status}`,
    };
  }
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    return {
      ok: false,
      code: "HERMES_UNREACHABLE",
      detail: "Hermes returned a non-JSON body",
    };
  }
  return { ok: true, text: extractHermesText(json) };
}

// ── alfred_journal helpers ────────────────────────────────────────────────
//
// One row per direction. channel = "ha-conversation" (distinct from the
// future "ha-voice" from #112), chat_id = "ha-<haInstallId>" — same shape
// as the Hermes session key so the journal pivots cleanly.
//
// Per spec §3.5: source_kind splits inbound ("ha-conversation-turn") from
// outbound ("ha-conversation-reply"); source_ref is "<haInstallId>/<convId>"
// so the audit can group by either dimension.

function journalIn(
  haInstallId: string,
  conversationId: string,
  message: string,
  metadata: Record<string, unknown>,
): void {
  try {
    appendJournal(getStateDb(), {
      channel: "ha-conversation",
      chat_id: `ha-${haInstallId}`,
      direction: "inbound",
      message,
      source_kind: "ha-conversation-turn",
      source_ref: `${haInstallId}/${conversationId}`,
      hermes_session_id: `ha-${haInstallId}`,
      hermes_profile: "main",
      status: "received",
      metadata,
    });
  } catch (e) {
    console.warn(
      "[channels_ha] alfred_journal inbound append failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

function journalOut(
  haInstallId: string,
  conversationId: string,
  message: string,
  status: "delivered" | "failed",
  metadata: Record<string, unknown>,
  deliveryError: string | null = null,
): void {
  try {
    appendJournal(getStateDb(), {
      channel: "ha-conversation",
      chat_id: `ha-${haInstallId}`,
      direction: "outbound",
      message,
      source_kind: "ha-conversation-reply",
      source_ref: `${haInstallId}/${conversationId}`,
      hermes_session_id: `ha-${haInstallId}`,
      hermes_profile: "main",
      status,
      delivery_error: deliveryError,
      metadata,
    });
  } catch (e) {
    console.warn(
      "[channels_ha] alfred_journal outbound append failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

export function registerHaChannelRoutes(): void {
  // POST /turn — the HA-conversation inbound handler.
  //
  // Auth: `channelTokenBearer("ha-conversation")`. The scoped bearer for
  // the HA install is the only thing that can call this — a leaked token
  // cannot reach any other surface.
  //
  // Rate-limit: 30 turns/min per haInstanceId (in-memory sliding window).
  // 403 RATE_LIMITED on exceed.
  //
  // Hermes: session key = `ha-<haInstallId>` (per spec §3.3 — per-install
  // continuity, NOT per-conversation_id).
  //
  // Response shape: HA's standard `ConversationEntity` envelope so the
  // custom component can hand it straight to its chat_log.
  addRoute("POST", "/api/v1/channels/ha/turn", async ({ req, res, body }) => {
    const started = Date.now();

    // Auth FIRST — never touch the body until the bearer is valid. Throws
    // AuthError → 401 if absent / revoked / mismatched-channel.
    channelTokenBearer(req, "ha-conversation");

    // Validate the body shape.
    const parsed = parseTurnBody(body);

    // Rate-limit per HA installation. Returns 403 with RATE_LIMITED on
    // exceed — the custom component surfaces this as a HA error result
    // ("Alfred is busy, try again in a moment" per spec §5.1).
    if (!checkRateLimit(parsed.haInstallId)) {
      throw new ApiError(
        403,
        "RATE_LIMITED",
        `more than ${RATE_LIMIT_PER_MIN} turns/min for haInstallId=${parsed.haInstallId}`,
      );
    }

    const sessionKey = `ha-${parsed.haInstallId}`;
    const inboundMetadata: Record<string, unknown> = {
      conversationId: parsed.conversationId,
      language: parsed.language,
      agentId: parsed.agentId,
    };
    if (parsed.deviceId) inboundMetadata.deviceId = parsed.deviceId;

    journalIn(parsed.haInstallId, parsed.conversationId, parsed.text, inboundMetadata);

    const hermesStarted = Date.now();
    const result = await callHermes(sessionKey, parsed.text);
    const hermesMs = Date.now() - hermesStarted;

    if (!result.ok) {
      const status = result.code === "HERMES_TIMEOUT" ? 504 : 502;
      journalOut(
        parsed.haInstallId,
        parsed.conversationId,
        "",
        "failed",
        { conversationId: parsed.conversationId, hermes_ms: hermesMs },
        result.detail,
      );
      throw new ApiError(status, result.code, result.detail);
    }

    journalOut(
      parsed.haInstallId,
      parsed.conversationId,
      result.text,
      "delivered",
      { conversationId: parsed.conversationId, hermes_ms: hermesMs },
    );

    // HA's `ConversationEntity` envelope. The custom component lifts
    // `response.speech.plain.speech` for TTS. `conversation_id` echoes
    // back so HA can correlate. `hermesSessionId` + `timing` are extras
    // the custom component logs but ignores for user-facing rendering.
    sendJson(res, 200, {
      response: {
        speech: {
          plain: {
            speech: result.text,
          },
        },
      },
      conversation_id: parsed.conversationId,
      hermesSessionId: sessionKey,
      timing: {
        hermes_ms: hermesMs,
        total_ms: Date.now() - started,
      },
    });
  });
}
