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
// and Slack v1 (matches our existing Vexa webhook handler at
// routes/webhooks/vexa.ts). We require:
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
import { addRoute } from "../server.js";
import { sendJson, ValidationError, ApiError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import { appendJournal } from "../../db/alfredJournal.js";

const HERMES_MAIN_URL =
  process.env.HERMES_GATEWAY_URL ?? "http://hermes:18789";
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

/** Read API_SERVER_KEY for the main Hermes profile out of its rendered
 *  .env. Matches the pattern in hermes.ts `readHermesApiKey()` — the
 *  per-profile key is the one Hermes' gateway actually validates against;
 *  /opt/alfred/.env's HERMES_API_SERVER_KEY is a *seed* for first-boot
 *  but Hermes regenerates it per profile if absent (we observed a
 *  mismatch live: opt/.env=64 chars, profile/.env=43 chars). The .env
 *  file is the source of truth at runtime. ctrl-api has hermes_data
 *  bind-mounted at /hermes-state.
 *
 *  Override via HERMES_CONFIG_DIR for tests (mirrors hermes.ts:387). */
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
  // Hermes' /v1/responses validates the Bearer against
  // /hermes-state/profiles/main/.env's API_SERVER_KEY — NOT /opt/alfred/
  // .env's HERMES_API_SERVER_KEY. Same key-resolution pattern as
  // hermes.ts `readHermesApiKey()`.
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

function journalIn(
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
      hermes_session_id: `paperclip-${paperclipAgentId}`,
      hermes_profile: "main",
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
      hermes_session_id: `paperclip-${paperclipAgentId}`,
      hermes_profile: "main",
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
  const sessionKey = `paperclip-${body.paperclip.paperclipAgentId}`;

  if (!opts.skipJournal) {
    journalIn(body.paperclip.paperclipAgentId, body.message, body.paperclip.runId);
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
      const result = await callHermes(sessionKey, body.message);
      if (!opts.skipJournal) {
        if (result.ok) {
          journalOut(
            body.paperclip.paperclipAgentId,
            result.text,
            body.paperclip.runId,
            "delivered",
          );
        } else {
          journalOut(
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
  const result = await callHermes(sessionKey, body.message);
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

// ── Routes ────────────────────────────────────────────────────────────────

export function registerPaperclipChannelRoutes(): void {
  // GET /status — always 200; operator card needs every field populated.
  addRoute("GET", "/api/v1/channels/paperclip/status", async ({ res }) => {
    const configured = Boolean(process.env.PAPERCLIP_API_KEY);
    const hasSecret = Boolean(process.env.PAPERCLIP_HEARTBEAT_SECRET);
    sendJson(res, 200, {
      configured,
      heartbeat_url: heartbeatUrl(),
      has_signing_secret: hasSecret,
      last_heartbeat_at: lastHeartbeatAt,
      recent_runs: recentRuns.slice(),
    });
  });

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
