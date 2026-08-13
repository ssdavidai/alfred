// ============================================================================
// alfredDeliver.ts — the unified "Alfred says X to Sir" delivery endpoint.
//
// THE PATTERN-A ENDPOINT
// ----------------------
// This is what every caller — `notify_principal` MCP, workers' delegate
// completion path, autonomous instinct dispatches — invokes when Alfred
// has something to say to Sir. ctrl-api owns the entire delivery:
//
//   1. Resolve channel + chat_id (auto-pick if not specified).
//   2. Append a `pending` outbound entry to alfred_journal (so the journal
//      is the source of truth even before the bytes go out).
//   3. Send the bytes to the channel via the channel-specific API.
//   4. Update the journal entry to `delivered` (or `failed`) with the
//      exact bytes Sir saw.
//
// COMPOSITION: it's the CALLER's responsibility to pass butler-voice text
// in `message`. The workers agent that completes a delegate composes its
// own reply in butler voice (its prompt frames it as Alfred — see
// packages/learn/src/activities/signal_actions.py `legacy_prompt` /
// `executor_prompt`). ctrl-api delivers verbatim. There is NO second
// "compose" pass here, no byte-echo cron job. The old "ROLE: deterministic
// message-relay job" approach has been retired entirely.
//
// CONTINUITY: the actual "one Alfred" UX promise comes from the journal
// itself, not from any composition magic. The Hermes one-alfred plugin's
// pre_gateway_dispatch hook reads recent journal entries on every inbound
// message from Sir and injects them as system context — so when Sir replies
// to a delegate outcome, main has full memory of what Alfred said earlier,
// regardless of WHICH internal session composed those bytes.
//
// THE PATTERN-A SURFACE
// ---------------------
//   POST /api/v1/alfred-deliver
//     body: { message: string, channel?: "auto"|"telegram"|"slack"|"email",
//             urgency?: "normal"|"high", to?: string,
//             source_kind?: string, source_ref?: string,
//             principal_note?: string, source_headline?: string, summary?: string,
//             metadata?: object }
//     returns: { ok, journal_id, channel, chat_id, message, journal }
//
//   POST /api/v1/delegate-outcomes
//     workers→ctrl-api hand-off; forwards summary to /alfred-deliver when
//     the delegate carried a Sir-facing principal_note.
//
// THE PATTERN-A INVARIANT
// -----------------------
// EVERY Alfred-to-Sir message — outbound on any channel, for any reason —
// goes through this endpoint. There is no parallel delivery path. Sir
// perceives one Alfred because there IS one delivery surface.
// ============================================================================

import fs from "node:fs";
import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import {
  appendJournal,
  bindPrincipalChannel,
  markJournalDelivered,
  resolvePrincipal,
} from "../../db/alfredJournal.js";
import { resolveProfileContextForChannel } from "../../db/agentProfiles.js";
import { resolveDeliveryTarget, resolveHomeChannelTarget } from "../hermes-sessions.js";
import { dockerExec } from "../helpers.js";
import { slackPostMessage } from "./slack.js";

// ── Channel resolution ─────────────────────────────────────────────────────
//
// channel=auto → resolveAutoTarget() → resolveHomeChannelTarget() (#498).
// resolveDeliveryTarget("last") is NOT safe as a fallback: it picks the
// most-recently-active Hermes session, which may be a group channel in a
// client workspace. Fail closed (424) when no home channel is declared.

function resolveAutoTarget(): { to: string; channel: string } | undefined {
  return resolveHomeChannelTarget();
}
function resolveRecipient(channel: string): string | undefined {
  return resolveDeliveryTarget(channel)?.to;
}

// ── Per-channel byte delivery ─────────────────────────────────────────────
//
// One adapter per channel. Each adapter is responsible for getting the
// exact bytes onto Sir's device using the channel's own API. Failure is
// surfaced as `{ ok: false, error: <reason> }` so the caller can journal
// truthfully — never a silent no-op.

interface DeliveryResult {
  ok: boolean;
  error?: string;
  // Hermes-side session reference, if we know it. Hermes' channel adapters
  // run inside the main profile and have already bound a session for Sir's
  // chat; we don't get the session_id from a bot-API send, so this is
  // typically null on the outbound path.
  hermes_session_id?: string | null;
}

/**
 * Telegram delivery — direct Bot API call (api.telegram.org).
 *
 * The bot token lives in the hermes container's per-profile .env
 * (`$HERMES_HOME/profiles/<slug>/.env` — TELEGRAM_BOT_TOKEN), where <slug>
 * is the profile bound to (`telegram`, chat_id) per the channel_profile_binding
 * registry. Lane I default seed keeps every channel pointing at `main` until
 * Lane III's UI rebinds explicitly. We read via `docker exec hermes cat`.
 * Telegram receives the bytes on the chat_id; from Sir's phone it looks like
 * the bot sent the message — same as inbound replies.
 */
async function deliverTelegram(
  profile: string,
  chatId: string,
  text: string,
): Promise<DeliveryResult> {
  // Lazy-read the token. Cache for 60s per profile — restart-bouncing the
  // hermes container shouldn't slow every send.
  const token = await getTelegramBotToken(profile);
  if (!token) {
    return {
      ok: false,
      error: `no TELEGRAM_BOT_TOKEN in hermes ${profile} profile .env`,
    };
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
    };
    if (j?.ok) return { ok: true };
    return {
      ok: false,
      error: j?.description ?? `Telegram returned HTTP ${r.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// One bot-token cache per profile slug. The map is unbounded but each entry
// is a (string, number) — 6 user-facing + 4 infra profiles is a hard cap, so
// memory is bounded by the registry's port range.
const _tgTokenCache: Map<string, { value: string; at: number }> = new Map();
const TG_TOKEN_TTL_MS = 60_000;

async function getTelegramBotToken(profile: string): Promise<string | null> {
  const now = Date.now();
  const cached = _tgTokenCache.get(profile);
  if (cached && now - cached.at < TG_TOKEN_TTL_MS) {
    return cached.value || null;
  }
  try {
    const stdout = await dockerExec("hermes", [
      "sh",
      "-c",
      `grep ^TELEGRAM_BOT_TOKEN= $HERMES_HOME/profiles/${profile}/.env 2>/dev/null | cut -d= -f2-`,
    ]);
    const token = stdout.trim().replace(/^["']|["']$/g, "");
    _tgTokenCache.set(profile, { value: token, at: now });
    return token || null;
  } catch (e) {
    console.warn(
      `[alfred-deliver] failed to read telegram bot token (${profile}):`,
      e,
    );
    return null;
  }
}

/**
 * Slack delivery — direct chat.postMessage call.
 *
 * The bot token lives in the hermes container's per-profile .env
 * (`$HERMES_HOME/profiles/<slug>/.env` — `SLACK_BOT_TOKEN`), where <slug>
 * is the profile bound to (`slack`, chat_id) per the channel_profile_binding
 * registry. We read it via `docker exec hermes cat` (60s cache, same shape as
 * the Telegram adapter). Slack receives the bytes on `chat_id` (channel id,
 * user id for DM-to-self, or group id); the bot must already be a member of
 * the channel for posts to land. Failure surfaces as `{ ok: false, error }`
 * so the journal records the truth.
 */
async function deliverSlack(
  profile: string,
  chatId: string,
  text: string,
): Promise<DeliveryResult> {
  const token = await getSlackBotToken(profile);
  if (!token) {
    return {
      ok: false,
      error: `no SLACK_BOT_TOKEN in hermes ${profile} profile .env`,
    };
  }
  const r = await slackPostMessage(token, chatId, text);
  if (r.ok) return { ok: true };
  return { ok: false, error: r.error };
}

const _slackTokenCache: Map<string, { value: string; at: number }> = new Map();
const SLACK_TOKEN_TTL_MS = 60_000;

async function getSlackBotToken(profile: string): Promise<string | null> {
  const now = Date.now();
  const cached = _slackTokenCache.get(profile);
  if (cached && now - cached.at < SLACK_TOKEN_TTL_MS) {
    return cached.value || null;
  }
  try {
    const stdout = await dockerExec("hermes", [
      "sh",
      "-c",
      `grep ^SLACK_BOT_TOKEN= $HERMES_HOME/profiles/${profile}/.env 2>/dev/null | cut -d= -f2-`,
    ]);
    const token = stdout.trim().replace(/^["']|["']$/g, "");
    _slackTokenCache.set(profile, { value: token, at: now });
    return token || null;
  } catch (e) {
    console.warn(
      `[alfred-deliver] failed to read slack bot token (${profile}):`,
      e,
    );
    return null;
  }
}

async function deliverEmail(
  _profile: string,
  _chatId: string,
  _text: string,
): Promise<DeliveryResult> {
  return {
    ok: false,
    error: "email delivery not wired yet — see packages/ctrl/docs/design/one-alfred.md",
  };
}

async function deliverByChannel(
  channel: string,
  profile: string,
  chatId: string,
  text: string,
): Promise<DeliveryResult> {
  switch (channel) {
    case "telegram":
      return deliverTelegram(profile, chatId, text);
    case "slack":
      return deliverSlack(profile, chatId, text);
    case "email":
      return deliverEmail(profile, chatId, text);
    case "webchat":
      return {
        ok: false,
        error:
          "channel=webchat is not a deliverable messaging platform — webchat is the in-dashboard chat, not a push surface",
      };
    default:
      return {
        ok: false,
        error: `channel=${channel} has no delivery adapter yet`,
      };
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

export function registerAlfredDeliverRoutes(): void {
  // POST /api/v1/alfred-deliver — Alfred says X to Sir.
  //
  // This is the ONLY outbound surface. notify_principal MCP and any other
  // delivery caller route through here. The journal entry is created
  // BEFORE the channel send, then updated to delivered|failed with the
  // exact bytes — so a network blip mid-send produces an audit trail
  // (journal entry with status=pending OR status=failed + delivery_error),
  // not a silent no-op.
  addRoute("POST", "/api/v1/alfred-deliver", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;

    const message =
      typeof b.message === "string" ? b.message.trim() : "";
    if (!message) {
      throw new ValidationError("message is required");
    }

    const urgency =
      typeof b.urgency === "string" && (b.urgency === "high" || b.urgency === "normal")
        ? b.urgency
        : "normal";
    const channelHint =
      typeof b.channel === "string" && b.channel.length > 0
        ? b.channel
        : "auto";
    const explicitTo =
      typeof b.to === "string" && b.to.length > 0 ? (b.to as string) : undefined;

    // ── Channel + recipient resolution.
    let channel: string;
    let to: string | undefined;
    if (channelHint === "auto") {
      const auto = resolveAutoTarget();
      if (!auto) {
        sendJson(res, 424, {
          ok: false,
          error:
            "channel=auto requires a configured home channel — set SLACK_HOME_CHANNEL or " +
            "TELEGRAM_HOME_CHANNEL in the hermes main profile .env (via /channels in the dashboard), " +
            "or pass channel + to explicitly.",
        });
        return;
      }
      channel = auto.channel;
      to = explicitTo ?? auto.to;
    } else {
      channel = channelHint;
      to = explicitTo ?? resolveRecipient(channel);
    }

    if (!to) {
      sendJson(res, 424, {
        ok: false,
        error: `no recipient on channel=${channel} — pass body.to explicitly or have Sir send at least one inbound message first`,
      });
      return;
    }

    // ── Journal as pending BEFORE attempting delivery. If the deploy crashes
    // mid-flight, the journal records "we tried to send X but didn't confirm".
    const db = getStateDb();

    // Lazy-bind (channel, chat_id) → owner principal on first outbound.
    // Sir is the only principal today; future household members will need
    // a different policy here (and ideally a UI for picking principal).
    if (!resolvePrincipal(db, channel, to)) {
      try {
        bindPrincipalChannel(db, channel, to, "owner");
      } catch (e) {
        console.warn(
          `[alfred-deliver] auto-bind ${channel}:${to} → owner failed:`,
          e,
        );
      }
    }

    // Lane IV — resolve the target Hermes profile for this (channel, chat_id).
    // The default-binding seeds in 0017_agent_profiles keep every channel
    // pointing at 'main' until Lane III's UI rebinds explicitly. After
    // rebinding, an outbound to a bound chat_id reads tokens from THAT
    // profile's .env and journal entries scope to THAT profile.
    const profileCtx = resolveProfileContextForChannel(db, channel, to);

    // solicited: the caller must pass 0 or 1 explicitly when it knows.
    // Callers that cannot determine provenance omit the field → null (unknown).
    // We only accept 0/1 integers to guard against truthy-string inflation.
    const solicitedRaw = b.solicited;
    const solicited =
      solicitedRaw === 0 ? 0 : solicitedRaw === 1 ? 1 : null;

    const pending = appendJournal(db, {
      channel,
      chat_id: to,
      direction: "outbound",
      message,
      status: "pending",
      source_kind: typeof b.source_kind === "string" ? b.source_kind : null,
      source_ref: typeof b.source_ref === "string" ? b.source_ref : null,
      hermes_profile: profileCtx.journal_scope_key,
      solicited,
      metadata: {
        urgency,
        principal_note:
          typeof b.principal_note === "string" ? b.principal_note : null,
        source_headline:
          typeof b.source_headline === "string" ? b.source_headline : null,
        summary: typeof b.summary === "string" ? b.summary : null,
        ...(typeof b.metadata === "object" && b.metadata
          ? (b.metadata as Record<string, unknown>)
          : {}),
      },
    });

    // ── Deliver the bytes via the channel adapter.
    const result = await deliverByChannel(
      channel,
      profileCtx.slug,
      to,
      message,
    );

    if (!result.ok) {
      const updated = markJournalDelivered(db, pending.id, {
        status: "failed",
        delivery_error: result.error ?? "unknown delivery error",
      });
      sendJson(res, 502, {
        ok: false,
        journal_id: pending.id,
        channel,
        chat_id: to,
        error: result.error ?? "delivery failed",
        journal: updated,
      });
      return;
    }

    // Success — finalise the journal entry. The bytes Sir saw ARE the
    // message we delivered (no recomposition), so we don't override the
    // message field on the way through.
    const updated = markJournalDelivered(db, pending.id, {
      status: "delivered",
      hermes_session_id: result.hermes_session_id ?? null,
    });

    sendJson(res, 200, {
      ok: true,
      journal_id: pending.id,
      channel,
      chat_id: to,
      message,
      journal: updated,
    });
  });

  // POST /api/v1/delegate-outcomes — workers→ctrl-api hand-off.
  //
  // Workers does the work, then POSTs the structured outcome here. When a
  // principal_note is present (Sir explicitly asked for a Sir-facing
  // result, e.g. "remind me on Telegram"), we forward the agent's summary
  // text to /alfred-deliver as the message body. No second composition —
  // the agent's summary IS the butler-voice text (its prompt frames it
  // as Alfred). See packages/learn/src/activities/signal_actions.py.
  addRoute("POST", "/api/v1/delegate-outcomes", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const decisionId =
      typeof b.decision_id === "string" ? b.decision_id : "";
    const principalNote =
      typeof b.principal_note === "string" ? b.principal_note : "";
    const sourceHeadline =
      typeof b.source_headline === "string" ? b.source_headline : "";
    const summary = typeof b.summary === "string" ? b.summary : "";
    const channelHint =
      typeof b.channel === "string" ? b.channel : "auto";

    if (!decisionId || !summary) {
      throw new ValidationError("decision_id and summary are required");
    }

    if (!principalNote.trim()) {
      sendJson(res, 200, {
        ok: true,
        delivered: false,
        reason:
          "no principal_note on the delegate — outcome recorded but no Sir-facing delivery",
      });
      return;
    }

    // Forward to /alfred-deliver. Same-process self-call keeps the entire
    // resolve+journal+deliver logic in one place.
    const aas = process.env.AAS_API_KEY || "";
    const port = process.env.AAS_PORT || "3100";
    const deliverBody = {
      message: summary,
      channel: channelHint,
      source_kind: "delegate",
      source_ref: decisionId,
      principal_note: principalNote,
      source_headline: sourceHeadline,
      summary,
      // Delegate outcomes: Sir explicitly asked for a Sir-facing result when
      // delegating (principal_note is set — the check above guards this path).
      // The delivery is a reply to Sir's original delegation turn → solicited.
      solicited: 1,
    };
    let resp: Response;
    try {
      resp = await fetch(`http://127.0.0.1:${port}/api/v1/alfred-deliver`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aas}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(deliverBody),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      sendJson(res, 502, {
        ok: false,
        delivered: false,
        error: `alfred-deliver self-call failed: ${errMsg}`,
      });
      return;
    }
    const respBody = await resp.text().catch(() => "");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(respBody);
    } catch {
      /* leave parsed = {} */
    }
    sendJson(res, resp.status, {
      ok: resp.ok,
      delivered: Boolean(parsed.ok),
      decision_id: decisionId,
      delivery: parsed,
    });
  });
}

// Mark `fs` as referenced — kept in scope for future channel adapters that
// need to read from disk (e.g. email send via a queue file). The `_` prefix
// would be more idiomatic but tsc's noUnusedLocals doesn't see imports.
void fs;
