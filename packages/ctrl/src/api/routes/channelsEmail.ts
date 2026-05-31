// Email channel inbound handler.
//
// alfred-black ingress shape (post-SaaS-retirement):
//
//   AgentMail (their cloud, alfred@agent.szabostuban.com)
//      |  POST https://home.alfred.black/api/v1/channels/email/inbound?token=<SECRET>
//      v
//   Caddy apex (@public_webhooks matcher)
//      |  reverse_proxy ctrl-api:3100
//      v
//   ctrl-api  ← this handler
//      |  POST /v1/runs (Hermes main profile)
//      v
//   Hermes  → alfred-email-channel skill → reply via /api/v1/email/reply
//
// Auth: AgentMail does not sign its webhooks (no header documented), so we
// gate on a shared-secret `?token=` baked into the URL configured in the
// AgentMail console. The path itself is marked public in server.ts so the
// master AAS_API_KEY isn't required.
//
// Filters (matched against Hermes' native email adapter behaviour):
//   - drop emails from noreply@ / mailer-daemon@ / no-reply@ / bounce@
//   - drop Auto-Submitted (RFC 3834), Precedence: bulk|list|junk,
//     List-Unsubscribe — RFC-flagged automated mail
//   - drop self-loops (from == AGENTMAIL_INBOX_ADDRESS)
//
// Fire-and-forget: we respond 202 immediately and let the run proceed in
// the background. Failures to start are logged.
//
// Phase 2: calls Hermes `POST /v1/runs` natively against the Hermes API
// server's canonical port (the hermes-shim was retired in issue #40). The
// OpenClaw `sessions_spawn` `/tools/invoke` contract is retired.

import fs from "node:fs";

import { addRoute } from "../server.js";
import { sendJson, ValidationError } from "../errors.js";
import { getStateDb } from "../../db/state.js";
import {
  resolveProfileContextForChannel,
  resolveProfileForChannel,
  assertWritableProfile,
  bindChannel,
  listAllBindings,
  unbindChannel,
  resolveProfileEnvPath,
  type ProfileChannelContext,
} from "../../db/agentProfiles.js";
import {
  dockerExec,
  dockerExecWithStdin,
  HERMES_CONTAINER,
} from "../helpers.js";
import { appendAudit } from "./state.js";
import { restartProfile } from "../../hermes/supervisor.js";

// ── #206 Lane IV — per-(profile, channel_kind) identity override ──────────
//
// Lane I owns `packages/ctrl/src/db/channelIdentity.ts` and the helper
// `resolveChannelIdentity(db, profile_slug, channel_kind)`. When Lane I's
// PR lands, replace this stub block with:
//
//   import { resolveChannelIdentity } from "../../db/channelIdentity.js";
//
// Until then this typed stub returns null so the adapter no-ops on
// identity overrides — preserving pre-#206 behaviour exactly.
//
// **Email**: the From-header display name flows via AgentMail's
// `from_name` field on `/messages/send` (set when an override exists).
// Avatar is informational only for outbound email — recipients see
// whatever their mail client renders (Gmail / Outlook resolve avatars
// via Gravatar / sender domain). We log the avatar limitation; we do
// not attempt to upload anything to AgentMail.
type ResolvedChannelIdentity = {
  display_name: string | null;
  avatar_path: string | null;
  avatar_mime: string | null;
};
function resolveChannelIdentity(
  _db: unknown,
  _slug: string,
  _kind: string,
): ResolvedChannelIdentity | null {
  // TODO(#206 Lane I): replace with real import once Lane I merges.
  return null;
}

const RESERVED_PROFILES_FOR_IDENTITY: ReadonlySet<string> = new Set([
  "main",
  "workers",
  "heavy",
  "codex-builder",
]);

/**
 * Build the outbound AgentMail send payload, applying the per-profile
 * identity override (#206 Lane IV) when one is present.
 *
 *   - `display_name` sets `from_name` in the payload — AgentMail renders
 *     it as `"Display Name" <inbox-address>` on the From header.
 *   - `avatar_path` is informational only for email (no in-band
 *     attachment for sender-avatar); a warning is returned for the
 *     caller to log.
 *
 * Exported for the unit test — asserts the payload shape without firing
 * a real AgentMail request.
 */
export function buildEmailSendPayload(
  to: string,
  subject: string,
  text: string,
  override: ResolvedChannelIdentity | null,
  profileSlug?: string,
): { payload: Record<string, unknown>; avatar_warning: string | null } {
  const payload: Record<string, unknown> = { to: [to], subject, text };
  let avatarWarning: string | null = null;
  if (override && profileSlug && !RESERVED_PROFILES_FOR_IDENTITY.has(profileSlug)) {
    if (override.display_name) {
      payload.from_name = override.display_name;
    }
    if (override.avatar_path) {
      avatarWarning =
        `[channels-email] avatar override for profile '${profileSlug}' is ` +
        `informational only — recipients render the From-side avatar from ` +
        `their mail client (Gravatar / domain). avatar_path=${override.avatar_path}`;
    }
  }
  return { payload, avatar_warning: avatarWarning };
}

const HERMES_GATEWAY_URL =
  process.env.HERMES_GATEWAY_URL ||
  process.env.OPENCLAW_GATEWAY_URL ||
  "http://hermes:18789";
const HERMES_HOST =
  (() => {
    try {
      return new URL(HERMES_GATEWAY_URL).hostname;
    } catch {
      return "hermes";
    }
  })();
const HERMES_PROTOCOL =
  (() => {
    try {
      return new URL(HERMES_GATEWAY_URL).protocol;
    } catch {
      return "http:";
    }
  })();
const GATEWAY_TOKEN_FILE =
  process.env.OPENCLAW_GATEWAY_TOKEN_FILE || "/alfred-data/.gateway-token";

/**
 * Resolve the Hermes token for a target profile. Precedence:
 *   1. The profile's API_SERVER_KEY read from /hermes-state/profiles/<slug>/.env
 *      (Lane IV — the only place Hermes' /v1 actually validates).
 *   2. HERMES_API_KEY / OPENCLAW_GATEWAY_TOKEN env (legacy main-only fallback).
 *   3. The gateway-token file (back-compat with openclaw-era deployments).
 */
function gatewayTokenFor(ctx: ProfileChannelContext): string {
  if (ctx.api_server_key) return ctx.api_server_key;
  const envToken = (
    process.env.HERMES_API_KEY || process.env.OPENCLAW_GATEWAY_TOKEN || ""
  ).trim();
  if (envToken) return envToken;
  try {
    return fs.readFileSync(GATEWAY_TOKEN_FILE, "utf-8").trim();
  } catch {
    return "";
  }
}

function hermesBaseUrlFor(ctx: ProfileChannelContext): string {
  return `${HERMES_PROTOCOL}//${HERMES_HOST}:${ctx.api_server_port}`;
}

/**
 * Resolve the target profile for an inbound email. The channel identity is
 * the principal-facing recipient address (the first entry in the AgentMail
 * `to` array — that's the inbox the email was actually delivered to). If
 * `to` is empty, falls back to the default email binding.
 */
function resolveEmailContext(message: any): ProfileChannelContext {
  const to = Array.isArray(message?.to) ? message.to : [];
  const identity =
    (typeof to[0] === "string" && to[0].trim().toLowerCase()) || null;
  return resolveProfileContextForChannel(getStateDb(), "email", identity);
}

function buildChannelPrompt(message: any): string {
  const from = Array.isArray(message?.from_) ? message.from_[0] : "";
  const to = Array.isArray(message?.to) ? message.to : [];
  const cc = Array.isArray(message?.cc) ? message.cc : [];
  const subject = typeof message?.subject === "string" ? message.subject : "";
  const bodyText =
    (typeof message?.text === "string" && message.text) ||
    (typeof message?.preview === "string" && message.preview) ||
    "";
  const threadId = message?.thread_id ?? "";
  const messageId = message?.message_id ?? "";
  const hasAttachments = Array.isArray(message?.attachments) && message.attachments.length > 0;

  // The prompt is intentionally light — the heavy reasoning lives in the
  // `alfred-email-channel` skill, which the agent auto-loads from workspace.
  return [
    "You are handling a NEW inbound email on the email channel.",
    "The sender is on the authorized-senders list, so treat this as a",
    "conversational channel event (like a Slack DM), not a stream event.",
    "",
    "Follow the `alfred-email-channel/SKILL.md` in your workspace for the",
    "decision policy (reply vs reply-all vs forward vs execute vs no-action).",
    "",
    "### Envelope",
    `From:       ${from}`,
    `To:         ${to.join(", ")}`,
    `Cc:         ${cc.join(", ")}`,
    `Subject:    ${subject}`,
    `Thread:     ${threadId}`,
    `Message-Id: ${messageId}`,
    hasAttachments
      ? `Attachments: ${message.attachments.length} file(s) — fetch via self({endpoint: "/api/v1/email/attachment/${messageId}/<aid>"})`
      : "Attachments: none",
    "",
    "### Body (full, including quoted history)",
    "```",
    bodyText,
    "```",
    "",
    "### What to do",
    "1. Read the body including quoted history — the full thread is",
    `   available via self({endpoint: "/api/v1/email/thread/${threadId}"}).`,
    "2. Search the vault for related matters/people before composing any",
    "   reply: self({endpoint: \"/api/v1/vault/search\", query: {q: \"...\"}}).",
    "3. Decide action per the skill. If you reply, use",
    `   self({endpoint: "/api/v1/email/reply", method: "POST", body: {`,
    `     message_id: "${messageId}", text: "...", reply_all: false|true`,
    "   }}).",
    "4. Do NOT send follow-up emails unless the user asked for them.",
    "",
    "When finished, emit a single final message summarizing what you did",
    "(one paragraph). Do not quote this prompt back in your final message.",
  ].join("\n");
}

// ── #120 Lane Vb2 — per-profile AgentMail provisioning ──────────────────────
//
// Lane V intentionally punted email to /channels (single-tenant). Sir's
// clarification: "email MUST be per profile." Each profile owns its own
// AgentMail inbox (e.g. `alfred@home.alfred.black` for main,
// `sentinel-<slug>@…` for Sentinel); inbound emails route to the right
// profile via the (email, <to-address>) channel binding.
//
// Provisioning calls AgentMail's API directly (POST /v0/pods/<podId>/inboxes
// + POST /v0/inboxes/<id>/api-keys). The master key lives in
// `AGENTMAIL_MASTER_API_KEY` (operator-set in /opt/alfred/.env); without it
// /provision returns 400 `master_key_missing` and the operator is told
// exactly which env var to set. The inbox-scoped key returned from minting
// is persisted into the profile's `.env` (Sentinel's outbound /api/v1/email/*
// then auths with HER inbox-scoped key, not main's).
//
// The webhook URL we register with AgentMail is the same shared SaaS
// receiver every other inbox already uses — `<SAAS_HOST>/webhooks/agentmail`
// — so we don't need per-inbox public DNS. The SaaS receiver forwards
// inbound emails back to this tenant's `/api/v1/channels/email/inbound`,
// where the to-address resolves which profile (binding row written at
// /provision time).

const AGENTMAIL_BASE_URL = (
  process.env.AGENTMAIL_BASE_URL || "https://api.agentmail.to/v0"
).replace(/\/$/, "");
const SAAS_HOST = (process.env.SAAS_HOST ?? "https://alfred.black").replace(
  /\/$/,
  "",
);
const AGENTMAIL_DOMAIN =
  process.env.AGENTMAIL_DOMAIN || "mail.alfred.black";
const AGENTMAIL_SHARED_POD_ID = (
  process.env.AGENTMAIL_SHARED_POD_ID || ""
).trim();
// Tenant-side webhook target. Matches deploy/agentmail-bootstrap.sh + the
// SaaS receiver pattern used by the single-tenant `email.ts` path.
const AGENTMAIL_TENANT_WEBHOOK_URL = `${SAAS_HOST}/webhooks/agentmail`;

type AgentMailResponse = { status: number; body: any };

async function agentMailFetch(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<AgentMailResponse> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${AGENTMAIL_BASE_URL}${path}`, init);
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

function masterKey(): string | null {
  const k = (process.env.AGENTMAIL_MASTER_API_KEY || "").trim();
  return k || null;
}

// Sanity: a prefix becomes the inbox local-part. Lowercase alnum + dashes +
// dots, 2..40 chars. Mirrors AgentMail's username acceptance.
const _PREFIX_RE = /^[a-z][a-z0-9.-]{1,39}$/;

function validatePrefix(p: unknown, slug: string): string {
  if (typeof p === "string" && p.trim()) {
    const candidate = p.trim().toLowerCase();
    if (!_PREFIX_RE.test(candidate)) {
      throw new ValidationError(
        `prefix '${candidate}' must match ${_PREFIX_RE.source}`,
      );
    }
    return candidate;
  }
  // Default: derive from slug. `alfred.<slug>` so it sorts next to the
  // SaaS-side default and the principal sees the profile name in the
  // address.
  const candidate = `alfred.${slug}`.toLowerCase();
  if (!_PREFIX_RE.test(candidate)) {
    throw new ValidationError(
      `derived prefix '${candidate}' is invalid; pass an explicit prefix`,
    );
  }
  return candidate;
}

// ─ per-profile .env (lives INSIDE the hermes container volume) ────────────
//
// Reuses the docker-exec pattern Telegram/Slack/SMS use — hermes_data is a
// named volume bind-mounted into ctrl-api too (HERMES_CONFIG_DIR), but
// writes go through `docker exec hermes ...` so the file's owner/perm match
// the runtime container's view (hermes UID 10000). Reads work either way;
// we use docker-exec for both for symmetry.

const AGENTMAIL_ENV_KEYS = [
  "AGENTMAIL_INBOX_ID",
  "AGENTMAIL_INBOX_ADDRESS",
  "AGENTMAIL_API_KEY",
] as const;
type AgentMailEnvKey = (typeof AGENTMAIL_ENV_KEYS)[number];

interface ProfileEmailPaths {
  profileSlug: string;
  profileDir: string;
  envPath: string;
}

function pathsForEmailProfile(slug: string): ProfileEmailPaths {
  const envPath = resolveProfileEnvPath(slug);
  return {
    profileSlug: slug,
    profileDir: envPath.replace(/\/\.env$/, ""),
    envPath,
  };
}

async function readProfileEmailEnv(
  paths: ProfileEmailPaths,
): Promise<Record<string, string>> {
  const raw = await dockerExec(HERMES_CONTAINER, [
    "sh",
    "-c",
    `cat ${paths.envPath} 2>/dev/null || true`,
  ]);
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.replace(/^﻿/, "");
    if (!t || t.trimStart().startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1);
    if (v.endsWith("\r")) v = v.slice(0, -1);
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

async function writeProfileEmailEnvKeys(
  paths: ProfileEmailPaths,
  updates: Partial<Record<AgentMailEnvKey, string | null>>,
): Promise<void> {
  const raw = await dockerExec(HERMES_CONTAINER, [
    "sh",
    "-c",
    `cat ${paths.envPath} 2>/dev/null || true`,
  ]);
  const lines = raw === "" ? [] : raw.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const t = line.replace(/^﻿/, "");
    const eq = t.indexOf("=");
    const key = eq > 0 ? t.slice(0, eq).trim() : "";
    if (key && key in updates) {
      seen.add(key);
      const v = updates[key as AgentMailEnvKey];
      if (v === null || v === undefined) continue; // drop
      out.push(`${key}=${v}`);
      continue;
    }
    out.push(line);
  }
  for (const k of AGENTMAIL_ENV_KEYS) {
    if (seen.has(k)) continue;
    if (!(k in updates)) continue;
    const v = updates[k];
    if (v === null || v === undefined) continue;
    out.push(`${k}=${v}`);
  }
  const content = out.join("\n") + "\n";
  const tmp = `${paths.envPath}.tmp.${process.pid}.${Date.now()}`;
  await dockerExecWithStdin(
    HERMES_CONTAINER,
    [
      "sh",
      "-c",
      `mkdir -p ${paths.profileDir} && cat > ${tmp} && mv ${tmp} ${paths.envPath}`,
    ],
    content,
    30_000,
  );
}

// Find the ULID binding row for this profile + email address so we can
// surface it in /status + drop it on /inbox DELETE. The seeded
// 'binding-default-email' row is for the per-kind default (channel_identity
// IS NULL); we never touch it from here.
function findEmailBindingFor(
  slug: string,
  address: string,
): { id: string } | null {
  const all = listAllBindings(getStateDb());
  const match = all.find(
    (b) =>
      b.channel_kind === "email" &&
      b.profile_slug === slug &&
      (b.channel_identity || "").toLowerCase() === address.toLowerCase() &&
      !b.id.startsWith("binding-default-"),
  );
  return match ? { id: match.id } : null;
}

// Match RFC 2822 local-parts (case-insensitive) that indicate an automated
// sender — Hermes' native email adapter drops these silently. The address
// is parsed by `extractLocalPart`, so we match on local-part alone.
const AUTOMATED_LOCAL_PARTS = new Set([
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "do_not_reply",
  "mailer-daemon",
  "mailerdaemon",
  "postmaster",
  "bounce",
  "bounces",
  "notification",
  "notifications",
]);

function extractLocalPart(addr: string): string {
  // Accept either `user@host` or `Display Name <user@host>` shapes.
  const m = addr.match(/<([^>]+)>/);
  const email = (m ? m[1] : addr).trim().toLowerCase();
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

function isAutomatedSender(from: string): boolean {
  if (!from) return false;
  return AUTOMATED_LOCAL_PARTS.has(extractLocalPart(from));
}

function hasBulkHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers || typeof headers !== "object") return false;
  // Normalize header lookup (RFC headers are case-insensitive).
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") lower[k.toLowerCase()] = v;
  }
  // RFC 3834 Auto-Submitted: anything other than "no" means automated.
  const autoSub = (lower["auto-submitted"] || "").toLowerCase();
  if (autoSub && autoSub !== "no") return true;
  // Precedence: bulk | list | junk
  const prec = (lower["precedence"] || "").toLowerCase();
  if (prec === "bulk" || prec === "list" || prec === "junk") return true;
  // List-Unsubscribe present at all → mailing list
  if (lower["list-unsubscribe"]) return true;
  return false;
}

function isSelfLoop(from: string): boolean {
  // Self-loop check now considers both the main-profile tenant-wide address
  // (`AGENTMAIL_INBOX_ADDRESS`, unchanged) AND every per-profile inbox that
  // has a (channel_kind=email, channel_identity=<address>) binding row in
  // state.db. The binding is the canonical source of "addresses Alfred
  // currently owns" — if the from-address matches one, it's our own
  // outbound landing back in the inbox and gets dropped.
  const m = from.match(/<([^>]+)>/);
  const fromEmail = (m ? m[1] : from).trim().toLowerCase();
  if (!fromEmail) return false;
  const envAddr = (process.env.AGENTMAIL_INBOX_ADDRESS || "")
    .trim()
    .toLowerCase();
  if (envAddr && fromEmail === envAddr) return true;
  try {
    const bindings = listAllBindings(getStateDb());
    for (const b of bindings) {
      if (b.channel_kind !== "email") continue;
      const id = (b.channel_identity || "").trim().toLowerCase();
      if (id && id === fromEmail) return true;
    }
  } catch {
    // best-effort — if state.db is unavailable, fall back to env-only.
  }
  return false;
}

export function registerChannelsEmailRoutes(): void {
  addRoute("POST", "/api/v1/channels/email/inbound", async ({ res, body, query }) => {
    // Shared-secret token: AgentMail doesn't sign its webhooks, so the public
    // path is gated by a `?token=` query param we configure in their console.
    // When AGENTMAIL_WEBHOOK_TOKEN is unset, the endpoint reverts to internal-
    // only (refuses every call) — fail closed.
    const expected = (process.env.AGENTMAIL_WEBHOOK_TOKEN || "").trim();
    const provided = (query.get("token") || "").trim();
    if (!expected) {
      console.warn(
        "[channels-email] AGENTMAIL_WEBHOOK_TOKEN unset — rejecting inbound (fail-closed)",
      );
      sendJson(res, 403, { error: { code: "WEBHOOK_TOKEN_NOT_CONFIGURED" } });
      return;
    }
    if (!provided || provided !== expected) {
      console.warn("[channels-email] webhook token mismatch — rejecting");
      sendJson(res, 401, { error: { code: "INVALID_WEBHOOK_TOKEN" } });
      return;
    }

    const b = (body ?? {}) as {
      message?: any;
      event_id?: string;
    };
    if (!b.message || typeof b.message !== "object") {
      throw new ValidationError("`message` required");
    }

    // Resolve from-address (AgentMail emits `from_` as a single-element array).
    const fromAddr: string = Array.isArray(b.message.from_)
      ? String(b.message.from_[0] ?? "")
      : String(b.message.from ?? b.message.from_ ?? "");

    // Filter 1: automated/noreply senders. Silent drop, 202 to keep AgentMail happy.
    if (isAutomatedSender(fromAddr)) {
      console.log(`[channels-email] drop automated sender: ${fromAddr}`);
      sendJson(res, 202, { accepted: false, reason: "automated_sender" });
      return;
    }
    // Filter 2: bulk/list mail via RFC headers.
    if (hasBulkHeader(b.message.headers)) {
      console.log(`[channels-email] drop bulk/list mail from: ${fromAddr}`);
      sendJson(res, 202, { accepted: false, reason: "bulk_or_list" });
      return;
    }
    // Filter 3: self-loop (Alfred's own outbound landing back in the inbox).
    if (isSelfLoop(fromAddr)) {
      console.log(`[channels-email] drop self-loop from: ${fromAddr}`);
      sendJson(res, 202, { accepted: false, reason: "self_loop" });
      return;
    }

    // Lane IV — resolve which profile owns this recipient address.
    const profileCtx = resolveEmailContext(b.message);
    const token = gatewayTokenFor(profileCtx);
    if (!token) {
      throw new ValidationError(
        "Hermes gateway token not available — cannot start run",
      );
    }

    const prompt = buildChannelPrompt(b.message);

    // Fire-and-forget Hermes run on the resolved profile. We intentionally
    // don't await the response — the run takes tens of seconds to minutes and
    // AgentMail has a 5s webhook budget upstream. `session_id` correlates the
    // run to the email thread + profile so cross-profile replies on the same
    // thread don't accidentally collide (a Sentinel-bound recipient and a
    // main-bound recipient on different inboxes get different sessions).
    const sessionId =
      `agent:${profileCtx.slug}:email-${b.message?.thread_id ?? b.message?.message_id ?? b.event_id ?? Date.now()}`;
    const run = fetch(`${hermesBaseUrlFor(profileCtx)}/v1/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: prompt,
        session_id: sessionId,
        instructions:
          "You are the principal-facing Alfred handling an inbound email " +
          "channel event. Follow the alfred-email-channel skill.",
      }),
    }).catch((err) => {
      console.warn(
        "[channels-email] POST /v1/runs failed:",
        err instanceof Error ? err.message : String(err),
      );
    });

    // Don't await — let it run in the background.
    void run;

    sendJson(res, 202, {
      accepted: true,
      message_id: b.message?.message_id ?? null,
      profile: profileCtx.slug,
    });
  });

  // GET /resolve?to=<address> — Lane IV debug surface.
  addRoute(
    "GET",
    "/api/v1/channels/email/resolve",
    async ({ res, query }) => {
      const to = query.get("to")?.trim().toLowerCase() || null;
      const ctx = resolveProfileContextForChannel(getStateDb(), "email", to);
      sendJson(res, 200, {
        channel_kind: "email",
        channel_identity: to,
        profile: ctx.slug,
        bound_profile: ctx.bound_slug,
        cascaded: ctx.cascaded,
        api_server_port: ctx.api_server_port,
        api_server_key_present: ctx.api_server_key != null,
        profile_dir: ctx.profile_dir,
        journal_scope: ctx.journal_scope_key,
        gateway_url: hermesBaseUrlFor(ctx),
      });
    },
  );

  // ── #120 Lane Vb2 — per-profile email inbox routes ──────────────────────

  // GET /api/v1/channels/email/status?profile=<slug>
  // Per-profile inbox state. Mirrors the Telegram /status fail-soft shape:
  // never 5xx — the UI polls it. Reads the per-profile .env to see whether
  // an inbox has been provisioned; if AGENTMAIL_MASTER_API_KEY is unset
  // surfaces { provision_available: false, reason } so the UI can show the
  // honest "operator action required" hint.
  addRoute(
    "GET",
    "/api/v1/channels/email/status",
    async ({ res, query }) => {
      const slug =
        (query.get("profile") || "").trim() ||
        resolveProfileForChannel(getStateDb(), "email", null);
      const paths = pathsForEmailProfile(slug);
      let envMap: Record<string, string> = {};
      let envErr: string | null = null;
      try {
        envMap = await readProfileEmailEnv(paths);
      } catch (e) {
        envErr = e instanceof Error ? e.message : String(e);
      }
      const inboxAddress = envMap.AGENTMAIL_INBOX_ADDRESS ?? null;
      const inboxId = envMap.AGENTMAIL_INBOX_ID ?? null;
      const configured = Boolean(inboxAddress && inboxId);
      const provisionAvailable = masterKey() !== null;
      const binding =
        inboxAddress != null ? findEmailBindingFor(slug, inboxAddress) : null;
      sendJson(res, 200, {
        configured,
        profile: slug,
        inbox_address: inboxAddress,
        inbox_id: inboxId,
        binding_id: binding?.id ?? null,
        provision_available: provisionAvailable,
        provision_unavailable_reason: provisionAvailable
          ? null
          : "AGENTMAIL_MASTER_API_KEY not set on this tenant — operator must set it in /opt/alfred/.env before per-profile inboxes can be provisioned",
        env_error: envErr,
      });
    },
  );

  // POST /api/v1/channels/email/provision?profile=<slug>
  // The load-bearing route. Calls AgentMail's API to (a) create a new inbox
  // in the tenant's shared pod, (b) mint an inbox-scoped API key, then
  // persists the credentials into the profile's .env and writes the
  // (email, <address>) → <slug> channel binding so inbound mail to that
  // address routes here.
  //
  // Body: { prefix?: string }      — explicit local-part; defaults to
  //                                  `alfred.<slug>`.
  // Returns { ok, address, inbox_id, binding_id, restart_scope }.
  addRoute(
    "POST",
    "/api/v1/channels/email/provision",
    async ({ res, body, query }) => {
      const slug = (query.get("profile") || "").trim();
      if (!slug) {
        throw new ValidationError("query ?profile=<slug> is required");
      }
      try {
        assertWritableProfile(getStateDb(), slug);
      } catch (e) {
        throw new ValidationError(e instanceof Error ? e.message : String(e));
      }
      const mkey = masterKey();
      if (!mkey) {
        sendJson(res, 400, {
          ok: false,
          code: "master_key_missing",
          error:
            "AGENTMAIL_MASTER_API_KEY is not set on this tenant. " +
            "Set it in /opt/alfred/.env (operator step) and restart ctrl-api.",
        });
        return;
      }
      if (!AGENTMAIL_SHARED_POD_ID) {
        sendJson(res, 400, {
          ok: false,
          code: "pod_id_missing",
          error:
            "AGENTMAIL_SHARED_POD_ID is not set on this tenant. Set it in /opt/alfred/.env alongside AGENTMAIL_MASTER_API_KEY.",
        });
        return;
      }

      const b = (body ?? {}) as Record<string, unknown>;
      const prefix = validatePrefix(b.prefix, slug);
      const displayName =
        typeof b.display_name === "string" && b.display_name.trim()
          ? b.display_name.trim()
          : `Alfred · ${slug}`;
      // client_id de-duplicates a retry into the same inbox — make it
      // profile-scoped so two slugs don't collide on the same prefix.
      const clientId = `profile-${slug}`;

      // 1. Create the inbox.
      const created = await agentMailFetch(mkey, "POST", `/pods/${encodeURIComponent(AGENTMAIL_SHARED_POD_ID)}/inboxes`, {
        username: prefix,
        domain: AGENTMAIL_DOMAIN,
        display_name: displayName,
        client_id: clientId,
      });
      if (created.status < 200 || created.status >= 300) {
        sendJson(res, 502, {
          ok: false,
          code: "agentmail_create_failed",
          error: `AgentMail inbox create failed (status=${created.status})`,
          upstream_status: created.status,
          upstream_body: created.body,
        });
        return;
      }
      const inboxId: string | undefined = created.body?.inbox_id;
      const inboxAddress: string | undefined = created.body?.email;
      if (!inboxId || !inboxAddress) {
        sendJson(res, 502, {
          ok: false,
          code: "agentmail_create_invalid_response",
          error: "AgentMail returned no inbox_id/email",
          upstream_body: created.body,
        });
        return;
      }

      // 2. Mint an inbox-scoped API key. AgentMail returns the plaintext
      //    key exactly once — persist it immediately.
      const keyRes = await agentMailFetch(mkey, "POST", `/inboxes/${encodeURIComponent(inboxId)}/api-keys`, {
        name: `${clientId}-${Date.now()}`,
      });
      if (
        keyRes.status < 200 ||
        keyRes.status >= 300 ||
        !keyRes.body?.api_key
      ) {
        sendJson(res, 502, {
          ok: false,
          code: "agentmail_api_key_failed",
          error: `AgentMail api-key mint failed (status=${keyRes.status})`,
          upstream_status: keyRes.status,
          upstream_body: keyRes.body,
        });
        return;
      }
      const inboxApiKey: string = keyRes.body.api_key;

      // 3. Best-effort: register the tenant webhook for this inbox so AgentMail
      //    delivers inbound mail to the shared SaaS receiver. Mirrors the
      //    single-tenant /api/v1/email/provision pattern; failure here is a
      //    warning, not a hard error (the SaaS-side master webhook also
      //    catches messages).
      let webhookRegistered = false;
      try {
        const existing = await agentMailFetch(inboxApiKey, "GET", "/webhooks");
        const list = Array.isArray(existing.body?.webhooks)
          ? existing.body.webhooks
          : [];
        const match = list.some(
          (h: any) => h?.url === AGENTMAIL_TENANT_WEBHOOK_URL,
        );
        if (match) {
          webhookRegistered = true;
        } else {
          const create = await agentMailFetch(
            inboxApiKey,
            "POST",
            "/webhooks",
            {
              url: AGENTMAIL_TENANT_WEBHOOK_URL,
              event_types: ["message.received"],
              inbox_ids: [inboxId],
            },
          );
          webhookRegistered = create.status >= 200 && create.status < 300;
        }
      } catch (err) {
        console.warn(
          `[channels-email] webhook register failed for ${inboxAddress}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // 4. Persist creds to the profile's .env (the file Hermes' inbox-scoped
      //    outbound and the channel-email handler both read at runtime).
      const paths = pathsForEmailProfile(slug);
      await writeProfileEmailEnvKeys(paths, {
        AGENTMAIL_INBOX_ID: inboxId,
        AGENTMAIL_INBOX_ADDRESS: inboxAddress,
        AGENTMAIL_API_KEY: inboxApiKey,
      });

      // 5. Write the channel binding so inbound mail to this address routes
      //    to this profile. Idempotent — re-provisioning the same prefix
      //    on the same slug rebinds the existing row.
      let bindingId: string;
      try {
        const binding = bindChannel(getStateDb(), {
          channel_kind: "email",
          channel_identity: inboxAddress.toLowerCase(),
          profile_slug: slug,
        });
        bindingId = binding.id;
      } catch (e) {
        // The inbox is already provisioned at AgentMail's end; refuse to
        // claim success when the binding write failed (otherwise inbound
        // routing would silently fall back to main).
        sendJson(res, 500, {
          ok: false,
          code: "binding_write_failed",
          error: `failed to write channel binding: ${e instanceof Error ? e.message : String(e)}`,
          inbox_address: inboxAddress,
          inbox_id: inboxId,
          provisioned_at_agentmail: true,
        });
        return;
      }

      // 6. Audit the mutation with the profile slug + channel identity.
      appendAudit({
        action_type: "channel_email_inbox_provisioned",
        actor: "principal",
        source: "channels/email/provision",
        target_path: "channels/email/provision",
        target_kind: "channel",
        subject_ref: slug,
        summary: `AgentMail inbox '${inboxAddress}' provisioned on profile '${slug}'`,
        payload: {
          profile_slug: slug,
          channel_kind: "email",
          inbox_id: inboxId,
          inbox_address: inboxAddress,
          binding_id: bindingId,
          webhook_registered: webhookRegistered,
        },
      });

      // 7. Restart scope. The new .env keys are read at request time by the
      //    /api/v1/email/* routes — no Hermes restart strictly required for
      //    outbound to work. We still drop a per-profile flag-file via
      //    restartProfile so any future Hermes-side adapter that loads its
      //    inbox config at boot will pick it up on the next reconcile.
      const restart = restartProfile(slug, { allowComposeFallback: false });

      sendJson(res, 200, {
        ok: true,
        profile: slug,
        address: inboxAddress,
        inbox_address: inboxAddress,
        inbox_id: inboxId,
        binding_id: bindingId,
        webhook_registered: webhookRegistered,
        restart_scope: restart.scope,
        restart_warning: restart.warning,
      });
    },
  );

  // DELETE /api/v1/channels/email/inbox?profile=<slug>
  // Releases the AgentMail inbox (best-effort), wipes the profile's email
  // env keys, and removes the channel binding so inbound mail to the freed
  // address falls back to main.
  addRoute(
    "DELETE",
    "/api/v1/channels/email/inbox",
    async ({ res, query }) => {
      const slug = (query.get("profile") || "").trim();
      if (!slug) {
        throw new ValidationError("query ?profile=<slug> is required");
      }
      try {
        assertWritableProfile(getStateDb(), slug);
      } catch (e) {
        throw new ValidationError(e instanceof Error ? e.message : String(e));
      }

      const paths = pathsForEmailProfile(slug);
      let envMap: Record<string, string> = {};
      try {
        envMap = await readProfileEmailEnv(paths);
      } catch {
        /* tolerated — DELETE is idempotent */
      }
      const inboxId = envMap.AGENTMAIL_INBOX_ID ?? null;
      const inboxAddress = envMap.AGENTMAIL_INBOX_ADDRESS ?? null;

      // Best-effort: tell AgentMail to release the inbox. AgentMail's
      // delete-inbox endpoint requires the master key (inbox-scoped keys
      // can't delete the inbox they're for). If the master key is unset we
      // skip the upstream call and let the orphan inbox sit — the binding
      // write below is what actually breaks routing.
      let upstreamReleased: "ok" | "skipped" | "failed" = "skipped";
      let upstreamStatus: number | null = null;
      const mkey = masterKey();
      if (mkey && inboxId) {
        try {
          const del = await agentMailFetch(
            mkey,
            "DELETE",
            `/inboxes/${encodeURIComponent(inboxId)}`,
          );
          upstreamStatus = del.status;
          upstreamReleased =
            del.status >= 200 && del.status < 300 ? "ok" : "failed";
        } catch (err) {
          console.warn(
            `[channels-email] AgentMail inbox release failed for ${inboxId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          upstreamReleased = "failed";
        }
      }

      // Wipe the profile's .env keys (or no-op when the dir is missing).
      try {
        await writeProfileEmailEnvKeys(paths, {
          AGENTMAIL_INBOX_ID: null,
          AGENTMAIL_INBOX_ADDRESS: null,
          AGENTMAIL_API_KEY: null,
        });
      } catch (err) {
        console.warn(
          `[channels-email] failed to wipe profile .env for ${slug}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Drop the binding row so future inbound mail to this address falls
      // back to the default (main).
      let bindingRemoved = false;
      if (inboxAddress) {
        const found = findEmailBindingFor(slug, inboxAddress);
        if (found) {
          try {
            unbindChannel(getStateDb(), found.id);
            bindingRemoved = true;
          } catch (err) {
            console.warn(
              `[channels-email] unbindChannel(${found.id}) failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      appendAudit({
        action_type: "channel_email_inbox_released",
        actor: "principal",
        source: "channels/email/inbox",
        target_path: "channels/email/inbox",
        target_kind: "channel",
        subject_ref: slug,
        summary: `AgentMail inbox '${inboxAddress ?? "<unknown>"}' released on profile '${slug}'`,
        payload: {
          profile_slug: slug,
          channel_kind: "email",
          inbox_id: inboxId,
          inbox_address: inboxAddress,
          binding_removed: bindingRemoved,
          upstream_released: upstreamReleased,
          upstream_status: upstreamStatus,
        },
      });

      const restart = restartProfile(slug, { allowComposeFallback: false });

      sendJson(res, 200, {
        ok: true,
        profile: slug,
        inbox_address: inboxAddress,
        inbox_id: inboxId,
        binding_removed: bindingRemoved,
        upstream_released: upstreamReleased,
        restart_scope: restart.scope,
        restart_warning: restart.warning,
      });
    },
  );

  // POST /api/v1/channels/email/test?profile=<slug>
  // Send a test email from this profile's inbox via AgentMail. Target
  // defaults to the operator's verified address surfaced in the body
  // (`{ to?: string }`); otherwise sends to the SaaS operator email when
  // available.
  addRoute(
    "POST",
    "/api/v1/channels/email/test",
    async ({ res, body, query }) => {
      const slug = (query.get("profile") || "").trim();
      if (!slug) {
        throw new ValidationError("query ?profile=<slug> is required");
      }
      try {
        assertWritableProfile(getStateDb(), slug);
      } catch (e) {
        throw new ValidationError(e instanceof Error ? e.message : String(e));
      }
      const b = (body ?? {}) as Record<string, unknown>;
      const to =
        typeof b.to === "string" && b.to.trim() ? b.to.trim() : null;
      if (!to) {
        sendJson(res, 400, {
          ok: false,
          code: "missing_recipient",
          error:
            "pass body.to=<recipient> — no fallback operator address configured",
        });
        return;
      }

      const paths = pathsForEmailProfile(slug);
      const envMap = await readProfileEmailEnv(paths).catch(
        () => ({}) as Record<string, string>,
      );
      const inboxId = envMap.AGENTMAIL_INBOX_ID ?? "";
      const inboxApiKey = envMap.AGENTMAIL_API_KEY ?? "";
      const inboxAddress = envMap.AGENTMAIL_INBOX_ADDRESS ?? "";
      if (!inboxId || !inboxApiKey) {
        sendJson(res, 400, {
          ok: false,
          code: "not_configured",
          error: `profile '${slug}' has no AgentMail inbox provisioned`,
        });
        return;
      }
      const subject =
        typeof b.subject === "string" && b.subject.trim()
          ? b.subject.trim()
          : `Test from ${inboxAddress || slug}`;
      const text =
        typeof b.text === "string" && b.text.trim()
          ? b.text.trim()
          : `Test email from profile '${slug}' (${inboxAddress}). ` +
            "If you see this, per-profile outbound is working.";

      // #206 Lane IV — apply per-(profile, channel_kind) identity override
      // (from_name on the AgentMail send payload). Avatar is informational
      // only for email; we log the limitation if avatar_path is set.
      const emailOverride = resolveChannelIdentity(getStateDb(), slug, "email");
      const { payload: sendPayload, avatar_warning } = buildEmailSendPayload(
        to,
        subject,
        text,
        emailOverride,
        slug,
      );
      if (avatar_warning) console.warn(avatar_warning);
      const send = await agentMailFetch(
        inboxApiKey,
        "POST",
        `/inboxes/${encodeURIComponent(inboxId)}/messages/send`,
        sendPayload,
      );
      if (send.status < 200 || send.status >= 300) {
        sendJson(res, 502, {
          ok: false,
          code: "send_failed",
          error: `AgentMail send failed (status=${send.status})`,
          upstream_status: send.status,
          upstream_body: send.body,
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        profile: slug,
        from: inboxAddress,
        to,
        message_id: send.body?.message_id ?? null,
      });
    },
  );
}
