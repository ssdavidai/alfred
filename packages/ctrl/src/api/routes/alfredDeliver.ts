// ============================================================================
// alfredDeliver.ts — the unified "Alfred says X to Sir" delivery endpoint.
//
// THE PATTERN-A ENDPOINT
// ----------------------
// This is what every caller — `notify_principal` MCP, workers' delegate
// completion, autonomous instinct dispatches — invokes when Alfred has
// something to say to Sir. ctrl-api owns the entire delivery:
//
//   1. Resolve channel + chat_id (auto-pick if not specified, exactly like
//      the old notify_principal flow).
//   2. Append a `pending` outbound entry to alfred_journal (so the journal
//      is the source of truth even before the bytes go out).
//   3. Compose a butler-voice prompt via the Hermes main-profile webhook
//      subscription `alfred-deliver` (registered lazily on first call). The
//      webhook prompt template is the "butler getting a slip" pattern Sir
//      asked for — main composes IN ITS VOICE, no byte-echo.
//   4. Wait for the webhook to acknowledge delivery.
//   5. Update the journal entry to `delivered` (or `failed`) with the bytes
//      Sir actually saw.
//
// Why a webhook subscription on main and not just calling /v1/runs directly?
// Because Hermes' `/v1/runs` route uses the api_server toolset that
// DELIBERATELY EXCLUDES `send_message` — a top-level API run has no way to
// reach a channel. Webhook subscriptions with `--deliver=<platform>:<chat_id>`
// DO have that delivery path. See notifications.ts module comments for the
// full archaeology (issue #45 + Hermes v2026.5.16 source).
//
// THE PATTERN-A SURFACE
// ---------------------
//   POST /api/v1/alfred-deliver
//     body: { message: string, channel?: "auto"|"telegram"|"slack"|"email",
//             urgency?: "normal"|"high", to?: string,
//             source_kind?: string, source_ref?: string,
//             metadata?: object }
//     returns: { ok, journal_id, channel, chat_id, delivered_bytes }
//
// THE PATTERN-A INVARIANT
// -----------------------
// EVERY Alfred-to-Sir message — outbound on any channel, for any reason —
// goes through this endpoint. There are no parallel delivery paths. Sir
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
import { resolveDeliveryTarget } from "../hermes-sessions.js";

// ── Config ────────────────────────────────────────────────────────────────

const GATEWAY_URL =
  process.env.HERMES_GATEWAY_URL ||
  process.env.OPENCLAW_GATEWAY_URL ||
  "http://hermes:18789";

const WEBHOOK_BASE =
  process.env.HERMES_WEBHOOK_BASE ||
  process.env.HERMES_GATEWAY_URL ||
  "http://hermes:18789";

const GATEWAY_TOKEN_PATHS = [
  "/alfred-data/.gateway-token",
  "/mnt/encrypted/alfred/.gateway-token",
  "/app/data/.gateway-token",
];

function getGatewayToken(): string {
  for (const p of GATEWAY_TOKEN_PATHS) {
    try {
      const t = fs.readFileSync(p, "utf-8").trim();
      if (t) return t;
    } catch {
      /* try next */
    }
  }
  return process.env.HERMES_API_KEY || process.env.OPENCLAW_GATEWAY_TOKEN || "";
}

// The webhook secret. Same value as the gateway token — these are internal
// network calls inside the compose namespace.
function getWebhookSecret(): string {
  return getGatewayToken() || "alfred-deliver-noauth-dev";
}

const WEBHOOK_ROUTE_NAME = "alfred-deliver";

// ── Auto-target resolution (mirrors notifications.ts) ─────────────────────

function resolveAutoTarget(): { to: string; channel: string } | undefined {
  return resolveDeliveryTarget("last");
}
function resolveRecipient(channel: string): string | undefined {
  return resolveDeliveryTarget(channel)?.to;
}

// ── Butler-voice webhook prompt ───────────────────────────────────────────
//
// This replaces the "ROLE: You are a deterministic message-relay job"
// byte-echo from notifications.ts:189. Sir explicitly asked for the OPPOSITE:
// "the butler gets a slip and says 'Sir, here's the reminder you asked me to
// do'". So main's prompt now frames it that way.
//
// The template uses Hermes' {dot.notation} payload reference. ctrl-api POSTs
// the payload + auth, the webhook handler renders the template into the
// prompt for main's agent, main composes the message in its voice, the
// Telegram adapter delivers.
const BUTLER_PROMPT_TEMPLATE = `You are Alfred — the principal's butler. A background process has just
finished work the principal asked you to do, and is handing you a slip.
You are the SAME Alfred the principal has been talking to on this channel;
do not introduce yourself.

The slip:
  - The principal's original ask: "{principal_note}"
  - What you were investigating / handling: "{source_headline}"
  - The result: "{summary}"

Deliver this to the principal on {channel} in your voice. Keep it tight —
one or two sentences. Do not list steps, do not preamble. Treat this as a
single message in an ongoing conversation: warm, deferential, specific.
You are NOT writing a status report; you are speaking to a person who
asked you for something a few minutes ago.`;

// ── Webhook lifecycle — register the subscription once, idempotently ──────

interface WebhookSubscriptionRecord {
  ready: boolean;
  lastCheck: number;
}
const _webhookState: WebhookSubscriptionRecord = { ready: false, lastCheck: 0 };

async function ensureWebhookSubscription(): Promise<void> {
  // Skip if we've verified recently.
  if (_webhookState.ready && Date.now() - _webhookState.lastCheck < 60_000) {
    return;
  }
  const token = getGatewayToken();
  if (!token) {
    throw new Error(
      "no gateway token available — cannot create Hermes webhook subscription",
    );
  }
  // GET /webhooks (list) — see if the route already exists.
  const r = await fetch(`${GATEWAY_URL}/api/webhooks`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok && r.status !== 404) {
    throw new Error(`hermes /api/webhooks list returned ${r.status}`);
  }
  const list = (r.ok ? await r.json() : { subscriptions: [] }) as {
    subscriptions?: Array<{ name?: string }>;
  };
  const subs = Array.isArray(list?.subscriptions) ? list.subscriptions : [];
  const exists = subs.some((s) => s?.name === WEBHOOK_ROUTE_NAME);
  if (exists) {
    _webhookState.ready = true;
    _webhookState.lastCheck = Date.now();
    return;
  }
  // Create it. The schema mirrors `hermes webhook subscribe`:
  //   name, prompt, deliver, deliver-chat-id (per-call), secret
  const createBody = {
    name: WEBHOOK_ROUTE_NAME,
    prompt: BUTLER_PROMPT_TEMPLATE,
    description:
      "alfred-deliver — the single outbound surface from ctrl-api to Sir's channel. Butler-voice composition by main; delivery via the configured Telegram/Slack adapter. See packages/ctrl/src/api/routes/alfredDeliver.ts.",
    secret: getWebhookSecret(),
    // We pass deliver per-call via the payload (cross-platform via
    // {deliver_chat_id} so the same route handles Telegram + Slack + Email).
    deliver: "{deliver}",
    deliver_chat_id: "{deliver_chat_id}",
  };
  const c = await fetch(`${GATEWAY_URL}/api/webhooks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createBody),
    signal: AbortSignal.timeout(15_000),
  });
  if (!c.ok) {
    const txt = await c.text().catch(() => "");
    throw new Error(
      `hermes webhook subscribe failed: ${c.status} ${txt.slice(0, 200)}`,
    );
  }
  _webhookState.ready = true;
  _webhookState.lastCheck = Date.now();
}

import crypto from "node:crypto";

async function invokeWebhook(
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: string }> {
  const secret = getWebhookSecret();
  const bodyJson = JSON.stringify(payload);
  // HMAC-SHA256 over the raw body — same scheme Hermes' webhook handler
  // validates with (`_validate_signature` in gateway/platforms/webhook.py).
  const sig = crypto
    .createHmac("sha256", secret)
    .update(bodyJson)
    .digest("hex");

  const r = await fetch(`${WEBHOOK_BASE}/webhooks/${WEBHOOK_ROUTE_NAME}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": `sha256=${sig}`,
      "X-Request-ID": `alfred-deliver-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    },
    body: bodyJson,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text().catch(() => "");
  return { ok: r.ok, status: r.status, body: text };
}

// ── Route ─────────────────────────────────────────────────────────────────

export function registerAlfredDeliverRoutes(): void {
  // POST /api/v1/alfred-deliver — Alfred says X to Sir.
  //
  // This is the ONLY outbound surface. notify_principal (MCP) and any other
  // delivery caller now route through here.
  addRoute("POST", "/api/v1/alfred-deliver", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;

    // Validate the message text — non-empty string.
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

    // Resolve channel + chat_id.
    let channel: string;
    let to: string | undefined;
    if (channelHint === "auto") {
      const auto = resolveAutoTarget();
      if (!auto) {
        sendJson(res, 424, {
          ok: false,
          error:
            "channel=auto could not resolve a deliverable channel — no inbound session on record. Pass channel + to explicitly, or have Sir send one message first.",
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

    if (channel === "webchat") {
      sendJson(res, 424, {
        ok: false,
        error: "channel=webchat is not a Hermes-deliverable messaging platform",
      });
      return;
    }

    // ── Journal as pending. We do this BEFORE attempting delivery so the
    // journal is durable even if delivery itself fails.
    const db = getStateDb();
    // Lazy-bind the (channel, chat_id) → owner principal on first outbound.
    // Sir is the only principal today; future household members will need a
    // different policy here.
    const existingPrincipal = resolvePrincipal(db, channel, to);
    if (!existingPrincipal) {
      try {
        bindPrincipalChannel(db, channel, to, "owner");
      } catch (e) {
        console.warn(
          `[alfred-deliver] auto-bind ${channel}:${to} → owner failed:`,
          e,
        );
      }
    }
    const pending = appendJournal(db, {
      channel,
      chat_id: to,
      direction: "outbound",
      message, // initial; will be overwritten with composed bytes on delivery
      status: "pending",
      source_kind:
        typeof b.source_kind === "string" ? b.source_kind : null,
      source_ref:
        typeof b.source_ref === "string" ? b.source_ref : null,
      metadata: {
        urgency,
        original_message: message,
        principal_note:
          typeof b.principal_note === "string" ? b.principal_note : null,
        source_headline:
          typeof b.source_headline === "string" ? b.source_headline : null,
        summary: typeof b.summary === "string" ? b.summary : message,
        ...(typeof b.metadata === "object" && b.metadata
          ? (b.metadata as Record<string, unknown>)
          : {}),
      },
    });

    // ── Make sure the webhook subscription is registered.
    try {
      await ensureWebhookSubscription();
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      markJournalDelivered(db, pending.id, {
        status: "failed",
        delivery_error: `webhook subscription unavailable: ${errMsg}`,
      });
      sendJson(res, 502, {
        ok: false,
        journal_id: pending.id,
        error: `hermes webhook subscription unavailable: ${errMsg}`,
      });
      return;
    }

    // ── Fire the webhook. The payload's {dot.notation} fields populate the
    // butler-voice template; deliver / deliver_chat_id route the response.
    const payload = {
      deliver: channel,
      deliver_chat_id: to,
      channel,
      principal_note:
        typeof b.principal_note === "string"
          ? b.principal_note
          : "(no note)",
      source_headline:
        typeof b.source_headline === "string"
          ? b.source_headline
          : "(no headline)",
      summary: typeof b.summary === "string" ? b.summary : message,
    };

    let result: { ok: boolean; status: number; body: string };
    try {
      result = await invokeWebhook(payload);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      markJournalDelivered(db, pending.id, {
        status: "failed",
        delivery_error: errMsg,
      });
      sendJson(res, 502, {
        ok: false,
        journal_id: pending.id,
        error: errMsg,
      });
      return;
    }

    if (!result.ok) {
      markJournalDelivered(db, pending.id, {
        status: "failed",
        delivery_error: `webhook returned ${result.status}: ${result.body.slice(0, 200)}`,
      });
      sendJson(res, 502, {
        ok: false,
        journal_id: pending.id,
        error: `webhook returned ${result.status}`,
        detail: result.body.slice(0, 500),
      });
      return;
    }

    // The webhook response includes the delivered text + status. Parse what
    // we can; on any parse error fall back to "best effort" — the bytes did
    // go out, we just don't know exactly what.
    let deliveredBytes = message;
    try {
      const parsed = JSON.parse(result.body) as {
        delivered_text?: string;
        response?: string;
      };
      deliveredBytes = parsed.delivered_text ?? parsed.response ?? message;
    } catch {
      /* fall back to the requested message */
    }

    const updated = markJournalDelivered(db, pending.id, {
      status: "delivered",
      message: deliveredBytes,
    });

    sendJson(res, 200, {
      ok: true,
      journal_id: pending.id,
      channel,
      chat_id: to,
      delivered_bytes: deliveredBytes,
      journal: updated,
    });
  });

  // POST /api/v1/delegate-outcomes — workers→ctrl-api hand-off.
  //
  // Workers does the work, then POSTs the structured outcome here. This
  // endpoint:
  //   1. Records the outcome (TODO: separate audit table; for now use the
  //      journal metadata).
  //   2. If the delegate carried a principal_note asking to be pinged,
  //      forwards the summary to alfred-deliver.
  //   3. Returns delivery status so the workers caller can stamp it on the
  //      decision side-effects.
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
      throw new ValidationError(
        "decision_id and summary are required",
      );
    }

    // No principal_note → no Sir-facing delivery. Workers should still
    // record the audit, but Alfred has nothing to say.
    if (!principalNote.trim()) {
      sendJson(res, 200, {
        ok: true,
        delivered: false,
        reason:
          "no principal_note on the delegate — outcome recorded but no Sir-facing delivery",
      });
      return;
    }

    // Forward to alfred-deliver. Same-process, just call the route handler's
    // logic by issuing a synthetic POST. Simpler: duplicate the small bit
    // of resolve+deliver code inline rather than HTTP-self-call.
    //
    // For now: best-effort fetch to localhost. Same machine, same process,
    // no overhead worth dodging.
    const aas = process.env.AAS_API_KEY || "";
    const port = process.env.AAS_PORT || "3100";
    const deliverBody = {
      message: summary, // initial; main will compose butler-voice from template
      channel: channelHint,
      source_kind: "delegate",
      source_ref: decisionId,
      principal_note: principalNote,
      source_headline: sourceHeadline,
      summary,
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
        signal: AbortSignal.timeout(70_000),
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
