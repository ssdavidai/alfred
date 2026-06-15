// Lane I — Paperclip channel routes (/api/v1/channels/paperclip/*).
//
// Paperclip (paperclip.ing) is a company-simulation tool: a manager agent
// inside Paperclip files tasks, and an HTTP-adapter "employee" pings Alfred
// to take a turn at executing them. The wire shape is locked by Paperclip's
// HTTP adapter:
//
//   POST {webhook_url}
//   Headers:
//     X-Paperclip-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
//     Content-Type: application/json
//   Body:
//     { message, agentId, deliver, paperclip: { runId, paperclipAgentId, taskId } }
//
// The signed bytes are `<unix-ts>.<raw-body>` — same construction as Stripe
// and Slack v1. We require:
//
//   * |now - t| ≤ 300 seconds  (replay window — matches Paperclip's default
//                              replayWindowSec)
//   * constant-time HMAC compare via crypto.timingSafeEqual
//   * PAPERCLIP_HEARTBEAT_SECRET set in env (otherwise 503 — refusing
//     to validate without a secret is the right loud-failure)
//
// Translation
// -----------
// A verified heartbeat translates into one POST hermes:18789/v1/responses
// with X-Hermes-Session-Key=paperclip-<paperclipAgentId>. That keeps one
// persistent Hermes session per Paperclip employee so continuity across
// heartbeats is intact. `deliver: true` waits for the Hermes reply and
// returns it in `result`; `deliver: false` returns 202 immediately and
// continues Hermes-bound translation in the background (the Paperclip
// agent then comments via Paperclip's REST API once it has an answer —
// that's documented in the alfred-paperclip-operations skill).
//
// alfred_journal continuity
// -------------------------
// Each inbound heartbeat appends one direction="inbound" row to
// alfred_journal with channel="paperclip" and chat_id=paperclip-<id>; each
// Hermes reply appends one direction="outbound" row. The Hermes
// pre_gateway_dispatch hook reads this journal so cross-channel context
// (Telegram, Slack, Paperclip, …) flows on subsequent turns.
//
// recent_runs is in-memory (last 10) — operator-feedback, not durable
// state. The durable audit goes to alfred_journal.
//
// Self-test (/test) signs a synthetic heartbeat with the same secret and
// POSTs to the heartbeat endpoint on 127.0.0.1:AAS_PORT, so the round-trip
// proves the validator + translator + Hermes are all reachable. A
// X-Paperclip-Test:1 header lets the heartbeat handler skip the
// alfred_journal write for self-tests, avoiding log churn.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, ApiError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import { appendJournal } from "../../db/alfredJournal.js";
import {
  resolveProfileContextForChannel,
  resolveProfileForChannel,
  type ProfileChannelContext,
} from "../../db/agentProfiles.js";
import { appendAudit } from "./state.js";
import { restartProfile } from "../../hermes/supervisor.js";

// Legacy default base URL for the main profile. Used as a fallback when the
// profile registry hasn't been seeded (should not happen post-Lane-I) and
// for build-time docs. Per-request URLs are derived from the resolved
// profile's `api_server_port`.
const HERMES_DEFAULT_BASE =
  process.env.HERMES_GATEWAY_URL ?? "http://hermes:18789";
const HERMES_HOST =
  (() => {
    try {
      return new URL(HERMES_DEFAULT_BASE).hostname;
    } catch {
      return "hermes";
    }
  })();
const HERMES_PROTOCOL =
  (() => {
    try {
      return new URL(HERMES_DEFAULT_BASE).protocol;
    } catch {
      return "http:";
    }
  })();
const HERMES_TIMEOUT_MS = 90_000;
const REPLAY_WINDOW_SECS = 300;
const SELF_TEST_HEADER = "x-paperclip-test";

/** Construct the public URL Paperclip's HTTP adapter posts heartbeats to.
 *
 * Same env-var precedence as routes/apps.ts: $DOMAIN wins, then
 * $TENANT_DOMAIN, then the apex alfred.black so we never return a half-blank
 * URL the operator can't paste anywhere. */
function heartbeatUrl(): string {
  const domain =
    process.env.DOMAIN || process.env.TENANT_DOMAIN || "alfred.black";
  return `https://${domain}/api/v1/channels/paperclip/heartbeat`;
}

// ── in-memory ring of recent runs (operator feedback, not durable) ─────────

type RecentStatus =
  | "ok"
  | "auth_failed"
  | "translation_failed"
  | "hermes_unreachable"
  | "replay";

interface RecentRun {
  ts: string;
  run_id: string;
  paperclip_agent_id: string;
  task_id: string;
  status: RecentStatus;
  duration_ms: number;
}

const RECENT_CAPACITY = 10;
const recentRuns: RecentRun[] = [];
let lastHeartbeatAt: string | null = null;

function recordRun(entry: RecentRun): void {
  recentRuns.unshift(entry);
  if (recentRuns.length > RECENT_CAPACITY) recentRuns.length = RECENT_CAPACITY;
  lastHeartbeatAt = entry.ts;
}

// Exported for tests so they can assert ring state without reaching into the
// module's private bindings. NOT part of the HTTP surface.
export function _resetPaperclipMemoryForTests(): void {
  recentRuns.length = 0;
  lastHeartbeatAt = null;
}

// ── HMAC validation ────────────────────────────────────────────────────────

interface ParsedSignature {
  t: number; // unix seconds
  v1: Buffer; // raw HMAC bytes
}

function parsePaperclipSignature(
  header: string | string[] | undefined,
): ParsedSignature | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || typeof raw !== "string") return null;
  let t: number | null = null;
  let v1: Buffer | null = null;
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") {
      if (!/^\d+$/.test(v)) return null;
      t = Number.parseInt(v, 10);
      if (!Number.isFinite(t)) return null;
    } else if (k === "v1") {
      if (!/^[0-9a-fA-F]+$/.test(v) || v.length === 0) return null;
      try {
        v1 = Buffer.from(v, "hex");
      } catch {
        return null;
      }
    }
  }
  if (t === null || v1 === null) return null;
  return { t, v1 };
}

function verifyHmac(
  rawBody: Buffer,
  parsed: ParsedSignature,
  secret: string,
): boolean {
  // Stripe/Slack-style signed content: `<ts>.<raw-body>`.
  const signedContent = Buffer.concat([
    Buffer.from(`${parsed.t}.`, "utf-8"),
    rawBody,
  ]);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedContent)
    .digest();
  if (expected.length !== parsed.v1.length) return false;
  try {
    return crypto.timingSafeEqual(expected, parsed.v1);
  } catch {
    return false;
  }
}

function withinReplayWindow(t: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - t) <= REPLAY_WINDOW_SECS;
}

// ── heartbeat body shape ───────────────────────────────────────────────────

interface HeartbeatBody {
  message: string;
  agentId: string;
  deliver: boolean;
  paperclip: {
    runId: string;
    paperclipAgentId: string;
    taskId: string;
  };
}

function parseHeartbeatBody(raw: unknown): HeartbeatBody {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.message !== "string" || b.message.length === 0) {
    throw new ValidationError("message must be a non-empty string");
  }
  if (typeof b.agentId !== "string" || b.agentId.length === 0) {
    throw new ValidationError("agentId must be a non-empty string");
  }
  if (typeof b.deliver !== "boolean") {
    throw new ValidationError("deliver must be a boolean");
  }
  const pc = b.paperclip;
  if (typeof pc !== "object" || pc === null) {
    throw new ValidationError("paperclip must be an object");
  }
  const p = pc as Record<string, unknown>;
  if (typeof p.runId !== "string" || p.runId.length === 0) {
    throw new ValidationError("paperclip.runId must be a non-empty string");
  }
  if (
    typeof p.paperclipAgentId !== "string" ||
    p.paperclipAgentId.length === 0
  ) {
    throw new ValidationError(
      "paperclip.paperclipAgentId must be a non-empty string",
    );
  }
  if (typeof p.taskId !== "string" || p.taskId.length === 0) {
    throw new ValidationError("paperclip.taskId must be a non-empty string");
  }
  return {
    message: b.message,
    agentId: b.agentId,
    deliver: b.deliver,
    paperclip: {
      runId: p.runId,
      paperclipAgentId: p.paperclipAgentId,
      taskId: p.taskId,
    },
  };
}

// ── Hermes call ────────────────────────────────────────────────────────────

interface HermesCallResult {
  ok: true;
  text: string;
}
interface HermesCallFailure {
  ok: false;
  code: "HERMES_UNREACHABLE" | "HERMES_TIMEOUT";
  detail: string;
}

/** Walk the Hermes /v1/responses output and concatenate the assistant text.
 *
 * Canonical shape (Hermes _extract_output_items):
 *   { output: [..., {type:"message", role:"assistant",
 *                    content:[{type:"output_text", text:"..."}]}] }
 *
 * Tolerates a top-level `output_text` string, `output` being a string, or
 * `output` being a single dict — these have appeared in older/mocked
 * transports (matches learn/clerk.py::_response_output_text). */
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

/**
 * Resolve the target Hermes profile for a Paperclip heartbeat. Lane I keys
 * paperclip bindings by `channel_identity = paperclipAgentId` (the same
 * value Paperclip's HTTP adapter uses to identify the employee). Until a
 * principal rebinds via Lane III's UI, every binding resolves to `main`.
 */
function resolvePaperclipContext(
  paperclipAgentId: string | null,
): ProfileChannelContext {
  return resolveProfileContextForChannel(
    getStateDb(),
    "paperclip",
    paperclipAgentId,
  );
}

/** Build the Hermes /v1 base URL for a resolved profile.
 *
 * 'sibling' profiles run in their OWN container (e.g. cratchit at the
 * `hermes-cratchit` network alias), NOT inside the main `hermes` container,
 * so addressing them at HERMES_HOST would POST to the wrong container.
 * Supervised/core profiles keep HERMES_HOST (port-varied). */
function hermesBaseUrlFor(ctx: ProfileChannelContext): string {
  const host =
    ctx.deployment_shape === "sibling" ? `hermes-${ctx.slug}` : HERMES_HOST;
  return `${HERMES_PROTOCOL}//${host}:${ctx.api_server_port}`;
}

async function callHermes(
  ctx: ProfileChannelContext,
  sessionKey: string,
  input: string,
): Promise<HermesCallResult | HermesCallFailure> {
  const url = `${hermesBaseUrlFor(ctx)}/v1/responses`;
  // Hermes' /v1/responses validates the Bearer against
  // /hermes-state/profiles/<slug>/.env's API_SERVER_KEY — NOT /opt/alfred/
  // .env's HERMES_API_SERVER_KEY (live-observed mismatch 64 vs 43 chars).
  // The per-profile key is read in resolveProfileContextForChannel via
  // readHermesProfileApiKey (src/db/agentProfiles.ts).
  const apiKey = ctx.api_server_key ?? "";
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
    // AbortSignal.timeout fires a DOMException with name "TimeoutError"
    // (or "AbortError" on some Node builds). Discriminate so the caller
    // can return 504 vs 502 honestly.
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

// ── alfred_journal helpers ─────────────────────────────────────────────────
//
// Direction the journal helper accepts is "inbound" / "outbound" (not
// "in"/"out"). chat_id = paperclip-<paperclipAgentId>, matching the
// X-Hermes-Session-Key so the journal pivots cleanly off the session.

function paperclipSessionId(ctx: ProfileChannelContext, paperclipAgentId: string): string {
  return ctx.slug === "main"
    ? `paperclip-${paperclipAgentId}`
    : `agent:${ctx.slug}:paperclip:${paperclipAgentId}`;
}

function journalIn(
  ctx: ProfileChannelContext,
  paperclipAgentId: string,
  message: string,
  runId: string,
): void {
  try {
    appendJournal(getStateDb(), {
      channel: "paperclip",
      chat_id: `paperclip-${paperclipAgentId}`,
      direction: "inbound",
      message,
      source_kind: "paperclip-heartbeat",
      source_ref: runId,
      hermes_session_id: paperclipSessionId(ctx, paperclipAgentId),
      hermes_profile: ctx.journal_scope_key,
      status: "received",
    });
  } catch (e) {
    console.warn(
      "[paperclip] alfred_journal inbound append failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

function journalOut(
  ctx: ProfileChannelContext,
  paperclipAgentId: string,
  message: string,
  runId: string,
  status: "delivered" | "failed",
  deliveryError: string | null = null,
): void {
  try {
    appendJournal(getStateDb(), {
      channel: "paperclip",
      chat_id: `paperclip-${paperclipAgentId}`,
      direction: "outbound",
      message,
      source_kind: "paperclip-reply",
      source_ref: runId,
      hermes_session_id: paperclipSessionId(ctx, paperclipAgentId),
      hermes_profile: ctx.journal_scope_key,
      status,
      delivery_error: deliveryError,
    });
  } catch (e) {
    console.warn(
      "[paperclip] alfred_journal outbound append failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

// ── shared heartbeat processing path ───────────────────────────────────────

interface HeartbeatProcessOutcome {
  status: number;
  body: Record<string, unknown>;
  recent: RecentRun;
}

/** Translate one validated heartbeat into a Hermes call, append journal
 * rows, and produce the operator-facing response payload + a recent_runs
 * row. The pure inner of the heartbeat handler — used by both the public
 * route and the /test self-call so they cannot diverge. */
async function processHeartbeat(
  body: HeartbeatBody,
  opts: { skipJournal: boolean },
): Promise<HeartbeatProcessOutcome> {
  const started = Date.now();
  // Lane IV — resolve which Hermes profile owns this paperclip agent. The
  // session-key shape carries the profile slug ONLY when we're routing to a
  // non-main profile, so an existing main-bound paperclip employee keeps
  // its `paperclip-<id>` session (no Hermes session migration needed). A
  // newly-bound Sentinel paperclip employee gets `agent:sentinel:paperclip:<id>`.
  const ctx = resolvePaperclipContext(body.paperclip.paperclipAgentId);
  const sessionKey =
    ctx.slug === "main"
      ? `paperclip-${body.paperclip.paperclipAgentId}`
      : `agent:${ctx.slug}:paperclip:${body.paperclip.paperclipAgentId}`;

  if (!opts.skipJournal) {
    journalIn(ctx, body.paperclip.paperclipAgentId, body.message, body.paperclip.runId);
  }

  if (!body.deliver) {
    // Async mode: 202 immediately, then continue translating in background.
    const ts = new Date().toISOString();
    const recent: RecentRun = {
      ts,
      run_id: body.paperclip.runId,
      paperclip_agent_id: body.paperclip.paperclipAgentId,
      task_id: body.paperclip.taskId,
      status: "ok",
      duration_ms: Date.now() - started,
    };
    recordRun(recent);
    // Fire-and-forget Hermes call. We swallow errors here because the
    // caller has already been told the heartbeat was accepted (202).
    void (async () => {
      const result = await callHermes(ctx, sessionKey, body.message);
      if (!opts.skipJournal) {
        if (result.ok) {
          journalOut(
            ctx,
            body.paperclip.paperclipAgentId,
            result.text,
            body.paperclip.runId,
            "delivered",
          );
        } else {
          journalOut(
            ctx,
            body.paperclip.paperclipAgentId,
            "",
            body.paperclip.runId,
            "failed",
            result.detail,
          );
        }
      }
    })();
    return {
      status: 202,
      body: { ok: true, run_id: body.paperclip.runId, queued: true },
      recent,
    };
  }

  // Sync mode: await Hermes and ship its text back to Paperclip.
  const result = await callHermes(ctx, sessionKey, body.message);
  if (!result.ok) {
    const status = result.code === "HERMES_TIMEOUT" ? 504 : 502;
    const recent: RecentRun = {
      ts: new Date().toISOString(),
      run_id: body.paperclip.runId,
      paperclip_agent_id: body.paperclip.paperclipAgentId,
      task_id: body.paperclip.taskId,
      status: "hermes_unreachable",
      duration_ms: Date.now() - started,
    };
    recordRun(recent);
    if (!opts.skipJournal) {
      journalOut(
        ctx,
        body.paperclip.paperclipAgentId,
        "",
        body.paperclip.runId,
        "failed",
        result.detail,
      );
    }
    return {
      status,
      body: {
        error: {
          code: result.code,
          // Don't leak the heartbeat body in error responses — comments /
          // task content could be private to the company. Hermes' own
          // detail string is safe (transport-level only).
          message: result.detail,
        },
      },
      recent,
    };
  }

  if (!opts.skipJournal) {
    journalOut(
      ctx,
      body.paperclip.paperclipAgentId,
      result.text,
      body.paperclip.runId,
      "delivered",
    );
  }
  const recent: RecentRun = {
    ts: new Date().toISOString(),
    run_id: body.paperclip.runId,
    paperclip_agent_id: body.paperclip.paperclipAgentId,
    task_id: body.paperclip.taskId,
    status: "ok",
    duration_ms: Date.now() - started,
  };
  recordRun(recent);
  return {
    status: 200,
    body: {
      ok: true,
      result: result.text,
      run_id: body.paperclip.runId,
    },
    recent,
  };
}

// ── auth-failure helpers ───────────────────────────────────────────────────
//
// Auth failures must not record into alfred_journal (we never trusted the
// body) but we DO want them in recent_runs so the operator card can warn
// "your signing secret is wrong on the Paperclip side". For an unparsable
// body we don't know the run/agent/task ids — synthesise placeholders.

function recordAuthFailure(body: unknown, kind: "auth_failed" | "replay"): void {
  let runId = "<unknown>";
  let agentId = "<unknown>";
  let taskId = "<unknown>";
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    const pc = b.paperclip;
    if (typeof pc === "object" && pc !== null) {
      const p = pc as Record<string, unknown>;
      if (typeof p.runId === "string") runId = p.runId;
      if (typeof p.paperclipAgentId === "string") agentId = p.paperclipAgentId;
      if (typeof p.taskId === "string") taskId = p.taskId;
    }
  }
  recordRun({
    ts: new Date().toISOString(),
    run_id: runId,
    paperclip_agent_id: agentId,
    task_id: taskId,
    status: kind,
    duration_ms: 0,
  });
}

// ── Paperclip setup-state probe ───────────────────────────────────────────
//
// `setup_state` drives which sub-card the UI renders:
//   * "ready"              — Paperclip is fully seeded by paperclip-init:
//                            PAPERCLIP_AGENT_TOKEN is in the host .env,
//                            company "Alfred" + CEO agent "hermes" exist
//                            in Paperclip. The principal NEVER sees the
//                            wizard — the card shows "Open Paperclip →"
//                            with the company/agent labels inline.
//                            (Added 2026-05-27 in the full-seed PR.)
//   * "needs_admin_signup" — Paperclip's `paperclip-init` one-shot has
//                            written /alfred-data/paperclip-ceo-invite.txt
//                            but no admin user has accepted yet. Paperclip's
//                            /sign-in page returns the "Instance setup
//                            required" wall. The card surfaces the invite
//                            URL as `admin_invite_url` so the principal
//                            clicks once and signs up — zero CLI.
//                            (Fallback path when the headless seed in steps
//                            6–11 of bootstrap-paperclip.sh failed partway.)
//   * "needs_api_key"      — Paperclip is reachable AND past its
//                            instance-setup wall but our PAPERCLIP_API_KEY
//                            is blank → tell the principal to paste a
//                            Settings → API keys value from Paperclip.
//   * "configured"         — Legacy: PAPERCLIP_API_KEY set and Paperclip
//                            accepts it. Pre-dates the full-seed flow;
//                            kept for tenants who pasted a key by hand
//                            before the headless seed shipped.
//   * "auth_failed"        — key set but Paperclip rejects → key likely
//                            expired/revoked; prompt for a new one.
//   * "unreachable"        — paperclip:3100 not responding → container down /
//                            not deployed.
type PaperclipSetupState =
  | "ready"
  | "needs_admin_signup"
  | "needs_api_key"
  | "configured"
  | "auth_failed"
  | "unreachable";

// Where paperclip-init writes the captured "Invite URL: …" from
// `pnpm paperclipai auth bootstrap-ceo`. Bind-mounted into ctrl-api as
// /alfred-data already (matches the other /alfred-data files we read here).
const PAPERCLIP_INVITE_PATH = "/alfred-data/paperclip-ceo-invite.txt";

/** Read the captured CEO invite URL written by the paperclip-init
 *  bootstrap script. Returns null when the file is missing/empty/garbage
 *  — the caller decides whether that means "still onboarding" or "old
 *  tenant pre-paperclip-init". */
function readPaperclipInviteUrl(): string | null {
  // Override for tests — same pattern as HERMES_CONFIG_DIR above.
  const p = process.env.PAPERCLIP_INVITE_FILE ?? PAPERCLIP_INVITE_PATH;
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  const url = raw.trim();
  if (!url) return null;
  // Defensive: only surface http(s) URLs — if the file is corrupted with
  // a stray banner line, hide it rather than render garbage as a link.
  if (!/^https?:\/\//.test(url)) return null;
  return url;
}

const PAPERCLIP_URL = "http://paperclip:3100";

interface SetupProbeResult {
  state: PaperclipSetupState;
  admin_invite_url: string | null;
  /** When state === "ready", the company name + id from the headless seed
   *  (e.g. "Alfred" / "449a5cf9-…"). Used by the card to show the inline
   *  "Alfred · hermes (CEO)" label. Null on all other states. */
  seed_company_name: string | null;
  seed_company_id: string | null;
  seed_agent_name: string | null;
  seed_agent_id: string | null;
}

// Pre-mounted file path for /alfred-data/paperclip-seed-credentials.json
// (mode 0600) — written by step 11a of bootstrap-paperclip.sh. Used to
// surface the seed metadata (company/agent names, ids) on the /channels
// card. The password is intentionally NOT exposed via /status; the
// principal can read the file directly on the host if they need to.
const PAPERCLIP_SEED_CREDENTIALS_PATH = "/alfred-data/paperclip-seed-credentials.json";

/** Read non-sensitive seed metadata (no password, no token). Returns null
 *  when the file is missing/malformed — callers fall back to env vars. */
function readSeedMetadata(): {
  company_name: string | null;
  company_id: string | null;
  agent_name: string | null;
  agent_id: string | null;
} | null {
  const p =
    process.env.PAPERCLIP_SEED_CREDENTIALS_FILE ??
    PAPERCLIP_SEED_CREDENTIALS_PATH;
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    return {
      company_name: typeof j.company === "string" ? j.company : null,
      company_id: typeof j.company_id === "string" ? j.company_id : null,
      agent_name: typeof j.agent === "string" ? j.agent : null,
      agent_id: typeof j.agent_id === "string" ? j.agent_id : null,
    };
  } catch {
    return null;
  }
}

async function probeSetupState(): Promise<SetupProbeResult> {
  // ── ready: headless seed completed (bootstrap-paperclip.sh steps 6–11) ──
  // PAPERCLIP_AGENT_TOKEN in env is the authoritative "fully seeded"
  // marker — step 11b writes it to /opt/alfred/.env, which compose loads
  // into ctrl-api via env_file. The seed-credentials.json carries the
  // human-readable company + agent names for the card label; we read it
  // best-effort and fall back to env defaults if missing.
  //
  // We do NOT roundtrip against paperclip:3100 here to confirm the
  // company/agent still exist — that would make every /status response
  // hit the upstream and slow the dashboard, and the seed is meant to
  // be durable (the principal would have to manually delete the agent
  // in Paperclip's UI for this to be wrong).
  if (process.env.PAPERCLIP_AGENT_TOKEN?.trim()) {
    const meta = readSeedMetadata();
    return {
      state: "ready",
      admin_invite_url: null,
      seed_company_name:
        meta?.company_name ?? process.env.PAPERCLIP_SEED_COMPANY ?? "Alfred",
      seed_company_id:
        meta?.company_id ?? process.env.PAPERCLIP_COMPANY_ID ?? null,
      seed_agent_name:
        meta?.agent_name ?? process.env.PAPERCLIP_SEED_AGENT_NAME ?? "hermes",
      seed_agent_id: meta?.agent_id ?? process.env.PAPERCLIP_AGENT_ID ?? null,
    };
  }

  const apiKey = process.env.PAPERCLIP_API_KEY?.trim();
  // Paperclip's better-auth checks Host header against PAPERCLIP_PUBLIC_URL —
  // same trusted-origins quirk apps.ts already handles. Use the public host.
  const host = `paperclip.${
    process.env.DOMAIN ?? process.env.TENANT_DOMAIN ?? "alfred.black"
  }`;
  // Reach the compose-internal address but spoof Host. Node fetch drops
  // manual Host; fall back to node:http (same trick as apps.ts).
  function probe(
    path: string,
    withAuth: boolean,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve) => {
      const headers: Record<string, string> = { Host: host };
      if (withAuth && apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const req = http.request(
        {
          method: "GET",
          hostname: "paperclip",
          port: 3100,
          path,
          headers,
          timeout: 3000,
        },
        (resp) => {
          const chunks: Buffer[] = [];
          // Cap body capture so a misbehaving Paperclip can't blow up
          // ctrl-api memory. 64 KB is more than enough for the
          // "Instance setup required" sentinel which lives in the first
          // ~2 KB of the HTML response.
          const LIMIT = 64 * 1024;
          let total = 0;
          let truncated = false;
          resp.on("data", (c: Buffer) => {
            if (truncated) return;
            total += c.length;
            if (total > LIMIT) {
              truncated = true;
              chunks.push(c.subarray(0, c.length - (total - LIMIT)));
              resp.resume(); // drain remainder without buffering
              return;
            }
            chunks.push(c);
          });
          resp.on("end", () => {
            resolve({
              status: resp.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf-8"),
            });
          });
        },
      );
      req.on("error", () => resolve({ status: 0, body: "" }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ status: 0, body: "" });
      });
      req.end();
    });
  }
  // Shared "no seed metadata" tail so the non-ready branches don't have
  // to re-spell the seed_* nulls (they only matter on `ready`).
  const noSeed = {
    seed_company_name: null,
    seed_company_id: null,
    seed_agent_name: null,
    seed_agent_id: null,
  } as const;

  if (!apiKey) {
    // Confirm Paperclip is at least reachable.
    const ping = await probe("/sign-in", false);
    if (ping.status === 0) {
      return { state: "unreachable", admin_invite_url: null, ...noSeed };
    }
    // Heuristic: when `paperclip-init` has captured an invite URL into
    // /alfred-data/paperclip-ceo-invite.txt, the principal is presumed to
    // be in admin-signup. Note that we cannot reliably probe Paperclip's
    // live "has an admin signed up yet?" state — Paperclip's /sign-in is
    // a React SPA whose 'Instance setup required' string is rendered
    // client-side and never lands in the SSR HTML we can see from here
    // (live-confirmed on joe + home 2026-05-27). The invite file is the
    // best proxy: it exists iff paperclip-init has run.
    //
    // The card's UI accommodates the ambiguity by offering BOTH
    // affordances on needs_admin_signup — the click-through invite link
    // (for tenants that genuinely haven't signed up yet) AND a secondary
    // "I've already signed up — paste my API key" path. The principal
    // can drive the card to `configured` from either branch.
    const inviteUrl = readPaperclipInviteUrl();
    if (inviteUrl) {
      return {
        state: "needs_admin_signup",
        admin_invite_url: inviteUrl,
        ...noSeed,
      };
    }
    // No invite captured — legacy fallback. Either paperclip-init hasn't
    // run yet (rare; service runs once at compose-up), the bootstrap
    // failed (caller can re-run), or this is an old deploy that never
    // had paperclip-init. The existing PR #73 paste-API-key panel handles
    // this gracefully.
    return { state: "needs_api_key", admin_invite_url: null, ...noSeed };
  }
  const probed = await probe("/api/companies", true);
  if (probed.status === 0) {
    return { state: "unreachable", admin_invite_url: null, ...noSeed };
  }
  if (probed.status === 401 || probed.status === 403) {
    return { state: "auth_failed", admin_invite_url: null, ...noSeed };
  }
  // 200 = configured. 404 etc. would be unexpected — treat as auth_failed
  // so the UI prompts for a fresh key.
  if (probed.status >= 200 && probed.status < 300) {
    return { state: "configured", admin_invite_url: null, ...noSeed };
  }
  return { state: "auth_failed", admin_invite_url: null, ...noSeed };
}

// ── Routes ────────────────────────────────────────────────────────────────

export function registerPaperclipChannelRoutes(): void {
  // GET /resolve?paperclip_agent_id=<id> — Lane IV debug surface.
  addRoute(
    "GET",
    "/api/v1/channels/paperclip/resolve",
    async ({ res, query }) => {
      const id = query.get("paperclip_agent_id")?.trim() || null;
      const ctx = resolvePaperclipContext(id);
      sendJson(res, 200, {
        channel_kind: "paperclip",
        channel_identity: id,
        profile: ctx.slug,
        bound_profile: ctx.bound_slug,
        cascaded: ctx.cascaded,
        api_server_port: ctx.api_server_port,
        api_server_key_present: ctx.api_server_key != null,
        profile_dir: ctx.profile_dir,
        journal_scope: ctx.journal_scope_key,
        gateway_url: hermesBaseUrlFor(ctx),
        session_key_prefix:
          ctx.slug === "main"
            ? "paperclip-"
            : `agent:${ctx.slug}:paperclip:`,
      });
    },
  );

  // GET /status — always 200; operator card needs every field populated.
  // setup_state extends the original P2 contract (configured/has_signing_secret
  // stay for back-compat); the card uses setup_state to drive the new
  // click-through flow. paperclip_origin is the public URL the principal
  // signs up at — pre-derived here so the card doesn't re-do hostname math.
  addRoute("GET", "/api/v1/channels/paperclip/status", async ({ res }) => {
    const configured = Boolean(process.env.PAPERCLIP_API_KEY);
    const hasSecret = Boolean(process.env.PAPERCLIP_HEARTBEAT_SECRET);
    const probe = await probeSetupState();
    const domain =
      process.env.DOMAIN ?? process.env.TENANT_DOMAIN ?? "alfred.black";
    const payload: Record<string, unknown> = {
      configured,
      heartbeat_url: heartbeatUrl(),
      has_signing_secret: hasSecret,
      last_heartbeat_at: lastHeartbeatAt,
      recent_runs: recentRuns.slice(),
      setup_state: probe.state,
      paperclip_origin: `https://paperclip.${domain}`,
    };
    // Only surface admin_invite_url when we actually need the principal to
    // click through it. Other states must NOT leak it — once they've signed
    // up the invite is stale and surfacing it would be confusing.
    if (probe.state === "needs_admin_signup" && probe.admin_invite_url) {
      payload.admin_invite_url = probe.admin_invite_url;
    }
    // Surface seed metadata only when state === "ready" so the dashboard
    // card can render "Alfred · hermes (CEO)" inline. We intentionally do
    // not leak company/agent ids on other states — they're only meaningful
    // once the headless seed has actually landed the records.
    if (probe.state === "ready") {
      if (probe.seed_company_name) {
        payload.seed_company_name = probe.seed_company_name;
      }
      if (probe.seed_company_id) {
        payload.seed_company_id = probe.seed_company_id;
      }
      if (probe.seed_agent_name) {
        payload.seed_agent_name = probe.seed_agent_name;
      }
      if (probe.seed_agent_id) {
        payload.seed_agent_id = probe.seed_agent_id;
      }
    }
    sendJson(res, 200, payload);
  });

  // POST /api-key — the principal pastes their freshly-generated Paperclip
  // API key here. We validate it round-trips against Paperclip, then write
  // it to BOTH locations Hermes reads:
  //   * /srv/alfred-black/.env (== host /opt/alfred/.env) — durable across
  //     re-init, the canonical operator-facing env file
  //   * /hermes-state/profiles/main/.env — what the running Hermes gateway
  //     reads at boot; we update this so a `docker compose restart hermes`
  //     picks up the new key without waiting for a full init re-render
  //
  // Then we restart hermes-main's gateway process (via docker exec) so the
  // paperclip MCP server picks up PAPERCLIP_API_KEY immediately. The full
  // container doesn't need to restart — just the gateway.
  addRoute(
    "POST",
    "/api/v1/channels/paperclip/api-key",
    async ({ res, body, query }) => {
      const b = (body ?? {}) as { api_key?: unknown };
      if (typeof b.api_key !== "string" || !b.api_key.trim()) {
        throw new ValidationError("api_key (string) is required");
      }
      const key = b.api_key.trim();
      // #120 Lane V — per-profile binding. ?profile=<slug> targets that
      // profile's .env; default = main (back-compat with existing UI).
      const profileSlug =
        query?.get("profile")?.trim() ||
        resolveProfileForChannel(getStateDb(), "paperclip", null);
      try {
        const { assertWritableProfile: assertWritable } = await import(
          "../../db/agentProfiles.js"
        );
        assertWritable(getStateDb(), profileSlug);
      } catch (e) {
        throw new ValidationError(e instanceof Error ? e.message : String(e));
      }
      // Validate by round-tripping against Paperclip /api/companies.
      const host = `paperclip.${
        process.env.DOMAIN ?? process.env.TENANT_DOMAIN ?? "alfred.black"
      }`;
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.request(
          {
            method: "GET",
            hostname: "paperclip",
            port: 3100,
            path: "/api/companies",
            headers: { Host: host, Authorization: `Bearer ${key}` },
            timeout: 5000,
          },
          (resp) => {
            resp.resume();
            const code = resp.statusCode ?? 0;
            resolve(code >= 200 && code < 300);
          },
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });
      if (!ok) {
        throw new ApiError(
          400,
          "INVALID_KEY",
          "Paperclip rejected this API key. Generate a new one in Paperclip → Settings → API keys and try again.",
        );
      }
      // Atomic .env update — read existing, set/replace PAPERCLIP_API_KEY,
      // write back. Mirrors the secret-set pattern used by other channel
      // routes.
      function upsertEnvKey(path: string, k: string, v: string): void {
        let raw = "";
        try {
          raw = fs.readFileSync(path, "utf-8");
        } catch {
          // file may not exist on a partially-bootstrapped tenant —
          // create it
        }
        const lines = raw.split("\n");
        let found = false;
        for (let i = 0; i < lines.length; i++) {
          const t = lines[i].trim();
          if (!t || t.startsWith("#")) continue;
          const eq = t.indexOf("=");
          if (eq < 0) continue;
          if (t.slice(0, eq).trim() === k) {
            lines[i] = `${k}=${v}`;
            found = true;
            break;
          }
        }
        if (!found) {
          if (raw.length > 0 && !raw.endsWith("\n")) lines.push("");
          lines.push(`${k}=${v}`);
        }
        const out = lines.join("\n");
        fs.writeFileSync(path, out.endsWith("\n") ? out : out + "\n", {
          mode: 0o600,
        });
      }
      // 1. /opt/alfred/.env (durable) — only for main, so the compose env
      //    keeps a single PAPERCLIP_API_KEY when only main is configured.
      //    Non-main profiles only write their per-profile .env so they
      //    don't clobber Main's durable value.
      if (profileSlug === "main") {
        upsertEnvKey("/srv/alfred-black/.env", "PAPERCLIP_API_KEY", key);
      }
      // 2. /hermes-state/profiles/<slug>/.env (immediate)
      upsertEnvKey(
        `${process.env.HERMES_CONFIG_DIR ?? "/hermes-state/profiles"}/${profileSlug}/.env`,
        "PAPERCLIP_API_KEY",
        key,
      );
      // 3. process.env in this container — only for main; non-main
      //    profiles have their own per-profile .env that the gateway reads
      //    at boot. Updating process.env here would falsely report the
      //    secondary profile's key on /status?profile=main.
      if (profileSlug === "main") {
        process.env.PAPERCLIP_API_KEY = key;
      }
      // 4. Audit row.
      appendAudit({
        action_type: "channel_token_set",
        actor: "principal",
        source: "channels/paperclip/api-key",
        target_path: "channels/paperclip/api-key",
        target_kind: "channel",
        subject_ref: profileSlug,
        summary: `Paperclip API key set on profile '${profileSlug}'`,
        payload: { profile_slug: profileSlug, channel_kind: "paperclip" },
      });
      // 5. Scoped restart for the target profile.
      const restart = restartProfile(profileSlug, {
        allowComposeFallback: true,
      });
      // Best-effort kick of the gateway process (back-compat path used by
      // existing main-profile tenants — same shape Lane III used).
      if (profileSlug === "main") {
        try {
          const { execSync } = await import("node:child_process");
          execSync(
            `docker exec alfred-black-hermes-1 pkill -f "main gateway run" || true`,
            { stdio: "ignore", timeout: 5000 },
          );
        } catch {
          /* best-effort */
        }
      }
      sendJson(res, 200, {
        ok: true,
        setup_state: "configured" as PaperclipSetupState,
        profile: profileSlug,
        restart_scope: restart.scope,
        restart_warning: restart.warning,
      });
    },
  );

  // POST /heartbeat — Paperclip's HTTP adapter target. Public-facing; the
  // X-Paperclip-Signature header is the only auth. The route is registered
  // here at the API surface; server.ts must list it in isPublic so the
  // bearer-auth gate doesn't pre-empt our HMAC check. Lane V's Caddy
  // @public_webhooks matcher already passes /api/v1/channels/paperclip/*
  // through to ctrl-api.
  addRoute(
    "POST",
    "/api/v1/channels/paperclip/heartbeat",
    async ({ req, res, body }) => {
      const secret = process.env.PAPERCLIP_HEARTBEAT_SECRET ?? "";
      if (!secret) {
        // We cannot validate without the secret — refusing is the right
        // loud-failure. NOT recorded as auth_failed because there is no
        // signature to evaluate; this is a config error on our side.
        throw new ApiError(
          503,
          "NOT_CONFIGURED",
          "PAPERCLIP_HEARTBEAT_SECRET is not set on this tenant",
        );
      }

      // Self-test bypass: the /test handler self-POSTs to this route with a
      // X-Paperclip-Test:1 header so the journal-write side-effect doesn't
      // log on every operator click.
      const isSelfTest =
        req.headers && req.headers[SELF_TEST_HEADER] === "1";

      // Parse signature header BEFORE the body so a malformed/missing
      // header trips a 401 without ever inspecting the body bytes.
      const parsed = parsePaperclipSignature(
        req.headers?.["x-paperclip-signature"],
      );
      if (!parsed) {
        recordAuthFailure(body, "auth_failed");
        throw new ApiError(
          401,
          "AUTH_FAILED",
          "missing or malformed X-Paperclip-Signature",
        );
      }

      // Replay window. Constant-time-irrelevant — the timestamp itself isn't
      // a secret; the HMAC over it is. Reject early to avoid the HMAC work.
      if (!withinReplayWindow(parsed.t)) {
        recordAuthFailure(body, "replay");
        throw new ApiError(
          401,
          "AUTH_FAILED",
          "X-Paperclip-Signature timestamp outside the 5-minute replay window",
        );
      }

      // HMAC over `<ts>.<raw-body>`. We don't have the raw bytes here
      // (server.ts parsed JSON for us); reconstruct from the parsed body
      // — Paperclip serialises with JSON.stringify, so a canonical
      // re-stringify matches byte-for-byte. If a deployment ever lands a
      // body shape that doesn't round-trip we'll see auth_failed in
      // recent_runs and can switch the route to the isRawBody whitelist
      // in server.ts. For the locked Paperclip shape (5 fields,
      // primitives + one nested object of 3 strings) this is safe.
      const rawBody = Buffer.from(JSON.stringify(body ?? {}), "utf-8");
      if (!verifyHmac(rawBody, parsed, secret)) {
        recordAuthFailure(body, "auth_failed");
        throw new ApiError(
          401,
          "AUTH_FAILED",
          "X-Paperclip-Signature did not validate",
        );
      }

      // Body validation (after HMAC — never trust an unsigned shape).
      const hb = parseHeartbeatBody(body);
      const outcome = await processHeartbeat(hb, {
        skipJournal: Boolean(isSelfTest),
      });
      sendJson(res, outcome.status, outcome.body);
    },
  );

  // POST /test — operator-triggered smoke test from the /channels card.
  // Synthesise a heartbeat, sign with our own secret, POST to our own
  // heartbeat endpoint on 127.0.0.1:AAS_PORT (so the network round-trip is
  // exercised but the request never leaves the box). Tag with
  // X-Paperclip-Test:1 so the heartbeat handler skips the journal write.
  addRoute("POST", "/api/v1/channels/paperclip/test", async ({ res }) => {
    const secret = process.env.PAPERCLIP_HEARTBEAT_SECRET ?? "";
    if (!secret) {
      throw new ApiError(
        503,
        "NOT_CONFIGURED",
        "PAPERCLIP_HEARTBEAT_SECRET is not set on this tenant",
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const runId = `test-${now}`;
    const heartbeat: HeartbeatBody = {
      message: "Paperclip heartbeat smoke test from /channels card",
      agentId: "test",
      deliver: true,
      paperclip: {
        runId,
        paperclipAgentId: "test",
        taskId: "test",
      },
    };
    const rawBody = Buffer.from(JSON.stringify(heartbeat), "utf-8");
    const signedContent = Buffer.concat([
      Buffer.from(`${now}.`, "utf-8"),
      rawBody,
    ]);
    const v1 = crypto
      .createHmac("sha256", secret)
      .update(signedContent)
      .digest("hex");

    const host = process.env.AAS_HOST ?? "127.0.0.1";
    const port = process.env.AAS_PORT ?? "3100";
    const url = `http://${host}:${port}/api/v1/channels/paperclip/heartbeat`;

    const t0 = Date.now();
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Paperclip-Signature": `t=${now},v1=${v1}`,
          "X-Paperclip-Test": "1",
        },
        body: rawBody,
        signal: AbortSignal.timeout(HERMES_TIMEOUT_MS + 5_000),
      });
    } catch (err) {
      sendJson(res, 200, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const latencyMs = Date.now() - t0;
    let bodyText = "";
    try {
      bodyText = await upstream.text();
    } catch {
      bodyText = "";
    }
    let parsed: unknown = null;
    if (bodyText) {
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = bodyText;
      }
    }
    // Best-effort sample of the Hermes reply (sync mode). Truncate to 200
    // chars so the dashboard card never holds an outsized blob.
    let sampleResponse: string | null = null;
    if (
      parsed &&
      typeof parsed === "object" &&
      "result" in (parsed as Record<string, unknown>) &&
      typeof (parsed as Record<string, unknown>).result === "string"
    ) {
      const s = (parsed as Record<string, unknown>).result as string;
      sampleResponse = s.length > 200 ? s.slice(0, 200) : s;
    }
    sendJson(res, 200, {
      ok: upstream.ok,
      status: upstream.status,
      latency_ms: latencyMs,
      sample_response: sampleResponse,
    });
  });
}
